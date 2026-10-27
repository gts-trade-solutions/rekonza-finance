import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { reverseJournal } from '@/lib/server/services/journals';
import { saveJournal } from '@/lib/server/services/held-journals';
import '@/lib/server/jobs/boot';

const ListQuery = z.object({
  /** One entry, by id — what a document's "Journal" tab asks for. */
  entryId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sourceType: z.string().optional(),
  accountId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The raw journal: entries with their lines.
 *
 * Every other report is a view over this. Two queries rather than a join with
 * repeated headers — an entry with six lines would otherwise arrive six times
 * and have to be regrouped in JavaScript anyway.
 */
export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db.selectFrom('journal_entries').where('org_id', '=', orgId);
    if (q.entryId) base = base.where('id', '=', Number(q.entryId));
    if (q.from) base = base.where('entry_date', '>=', q.from);
    if (q.to) base = base.where('entry_date', '<=', q.to);
    if (q.sourceType && q.sourceType !== 'all') {
      const kinds = q.sourceType.split(',').map((x) => x.trim()).filter(Boolean);
      base = kinds.length === 1
        ? base.where('source_type', '=', kinds[0])
        : base.where('source_type', 'in', kinds);
    }
    if (q.search) base = base.where('memo', 'like', `%${q.search}%`);

    // Only entries that touch the chosen account, when one is given.
    if (q.accountId) {
      const ids = await db
        .selectFrom('journal_lines')
        .select('entry_id')
        .distinct()
        .where('org_id', '=', orgId)
        .where('account_id', '=', Number(q.accountId))
        .execute();
      const entryIds = ids.map((r) => r.entry_id);
      base = entryIds.length ? base.where('id', 'in', entryIds) : base.where('id', '=', -1);
    }

    const [entries, totals] = await Promise.all([
      base
        .select([
          'id', 'entry_no', 'entry_date', 'memo', 'source_type', 'source_id',
          'reversal_of_entry_id', 'total_debit', 'total_credit', 'posted_at',
        ])
        .orderBy('entry_date', 'desc')
        .orderBy('entry_no', 'desc')
        .limit(q.limit)
        .offset(q.offset)
        .execute(),
      base
        .select([
          sql<string>`COUNT(*)`.as('count'),
          sql<string>`COALESCE(SUM(total_debit), 0)`.as('debit'),
        ])
        .executeTakeFirst(),
    ]);

    const ids = entries.map((e) => e.id);
    const lines = ids.length
      ? await db
          .selectFrom('journal_lines')
          .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
          .leftJoin('contacts', 'contacts.id', 'journal_lines.contact_id')
          .select([
            'journal_lines.entry_id', 'journal_lines.line_no', 'journal_lines.debit',
            'journal_lines.credit', 'journal_lines.description',
            'accounts.id as account_id', 'accounts.code', 'accounts.name',
            'contacts.display_name as contact_name',
          ])
          .where('journal_lines.entry_id', 'in', ids)
          .orderBy('journal_lines.line_no')
          .execute()
      : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      const list = linesByEntry.get(l.entry_id) ?? [];
      list.push(l);
      linesByEntry.set(l.entry_id, list);
    }

    return {
      entries: entries.map((e) => ({
        id: asId(e.id),
        entryNo: e.entry_no,
        date: e.entry_date,
        memo: e.memo,
        sourceType: e.source_type,
        sourceId: e.source_id ? asId(e.source_id) : null,
        // A reversal is a correction posted alongside the original, never a
        // rewrite of it — showing the link is what makes that visible.
        reversalOf: e.reversal_of_entry_id ? asId(e.reversal_of_entry_id) : null,
        totalDebitPaise: toPaiseFromSql(e.total_debit),
        totalCreditPaise: toPaiseFromSql(e.total_credit),
        postedAt: e.posted_at,
        lines: (linesByEntry.get(e.id) ?? []).map((l) => ({
          lineNo: l.line_no,
          accountId: asId(l.account_id),
          accountCode: l.code,
          accountName: l.name,
          description: l.description,
          contactName: l.contact_name,
          debitPaise: toPaiseFromSql(l.debit),
          creditPaise: toPaiseFromSql(l.credit),
        })),
      })),
      summary: {
        count: Number(totals?.count ?? 0),
        totalDebitPaise: toPaiseFromSql(totals?.debit ?? '0'),
      },
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const CreateInput = z.object({
  /** Defaults to the branch the request is acting in. */
  branchId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  memo: z.string().min(1, 'Say what this entry is for.'),
  lines: z
    .array(
      z.object({
        accountId: z.string(),
        debitPaise: z.number().int().nonnegative().optional(),
        creditPaise: z.number().int().nonnegative().optional(),
        description: z.string().nullish(),
        contactId: z.string().nullish(),
        /** The cost centre of an income or expense line. */
        costCentreId: z.string().nullish(),
        // Against Ref: which of the party's documents this line settles.
        against: z.array(z.object({
          targetType: z.enum(['invoice', 'bill', 'opening']),
          targetId: z.string(),
          amountPaise: z.number().int().positive(),
        })).optional(),
      }),
    )
    .min(2, 'A journal entry needs at least two lines.'),
  /** Reverse the whole entry automatically on this date. */
  reverseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** Post now, keep as an optional voucher, or let the scheduler post it on its date. */
  mode: z.enum(['post', 'optional', 'post_dated']).default('post'),
});

/**
 * Post a manual journal.
 *
 * The only route by which somebody hand-writes an entry. It goes through the
 * same posting engine as everything else, so the balance rule and the period
 * lock apply exactly as they do to an invoice.
 */
export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);

    const saved = await transaction(async (trx) =>
      saveJournal(trx, orgId, user.userId, {
        branchId: input.branchId ? Number(input.branchId) : branchId,
        date: input.date,
        memo: input.memo,
        reverseOn: input.reverseOn ?? null,
        lines: input.lines.map((l) => ({
          accountId: Number(l.accountId),
          debitPaise: l.debitPaise ?? 0,
          creditPaise: l.creditPaise ?? 0,
          description: l.description,
          contactId: l.contactId ? Number(l.contactId) : null,
          costCentreId: l.costCentreId ? Number(l.costCentreId) : null,
          against: l.against?.map((a) => ({ ...a, targetId: Number(a.targetId) })),
        })),
      }, input.mode),
    );

    if (saved.held) {
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'held_journal', targetId: saved.id, targetLabel: `Held entry H-${saved.id}`,
        detail: `${saved.kind === 'approval' ? `Held for ${saved.approverRole} approval` : saved.kind === 'optional' ? 'Saved as optional' : `Post-dated to ${input.date}`}: ${input.memo}`,
        ...auditMeta(req),
      });
      return { held: true as const, heldId: asId(saved.id), kind: saved.kind, approverRole: saved.approverRole ?? null };
    }
    const posted = saved.entry;

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'journal_entry',
      targetId: posted.id,
      targetLabel: `Entry ${posted.entryNo}`,
      detail: input.memo,
      ...auditMeta(req),
    });

    return {
      held: false as const,
      id: asId(posted.id),
      entryNo: posted.entryNo,
      totalDebitPaise: posted.totalDebit,
    };
  },
  { permission: { module: 'accountant', action: 'create' } },
);

const ReverseInput = z.object({
  entryId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(500).optional(),
});

/** Reverse an entry. Corrections are posted, never edited in place. */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ReverseInput);
    const entryId = Number(input.entryId);
    if (!Number.isInteger(entryId)) throw badRequest('Invalid entry.');

    // Whatever the entry settled is owed again once it is reversed.
    const reversal = await transaction(async (trx) =>
      reverseJournal(trx, orgId, user.userId, entryId, { date: input.date, memo: input.memo }),
    );

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'void',
      targetType: 'journal_entry',
      targetId: entryId,
      detail: `Reversed by entry ${reversal.entryNo}`,
      ...auditMeta(req),
    });

    return { id: asId(reversal.id), entryNo: reversal.entryNo };
  },
  { permission: { module: 'accountant', action: 'void' } },
);
