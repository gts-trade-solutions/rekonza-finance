import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql, toSqlFromPaise } from '@/lib/server/money-sql';
import { runRecurringJournal } from '@/lib/server/services/recurring';
import '@/lib/server/jobs/boot';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring journals: entries that repeat unchanged month after month —
// depreciation, prepaid rent amortisation, accrued salaries.
//
// A profile is a template, not a posting. Nothing reaches the ledger until it
// is run, and running it goes through the same posting engine as everything
// else, so a locked period refuses it exactly as it would refuse a hand-typed
// entry. That is deliberate: an automation that could quietly post into a
// closed month would be worse than no automation at all.
// ─────────────────────────────────────────────────────────────────────────────

const FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;

export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('recurring_journals as r')
      .innerJoin('accounts as dr', 'dr.id', 'r.debit_account_id')
      .innerJoin('accounts as cr', 'cr.id', 'r.credit_account_id')
      .select([
        'r.id', 'r.name', 'r.frequency', 'r.next_run', 'r.end_date', 'r.amount',
        'r.memo', 'r.is_active', 'r.last_posted_at', 'r.branch_id', 'r.auto_run', 'r.last_error',
        'r.debit_account_id', 'r.credit_account_id',
        'dr.code as debit_code', 'dr.name as debit_name',
        'cr.code as credit_code', 'cr.name as credit_name',
      ])
      .where('r.org_id', '=', orgId)
      .orderBy('r.next_run')
      .execute();

    const today = new Date().toISOString().slice(0, 10);

    return {
      profiles: rows.map((r) => ({
        id: asId(r.id),
        name: r.name,
        frequency: r.frequency,
        nextRun: String(r.next_run).slice(0, 10),
        endDate: r.end_date ? String(r.end_date).slice(0, 10) : null,
        debitAccountId: asId(r.debit_account_id),
        debitCode: r.debit_code,
        debitName: r.debit_name,
        creditAccountId: asId(r.credit_account_id),
        creditCode: r.credit_code,
        creditName: r.credit_name,
        amountPaise: toPaiseFromSql(r.amount),
        memo: r.memo,
        isActive: !!r.is_active,
        /** Posted by the scheduler on its date, without anyone pressing Run. */
        autoRun: !!r.auto_run,
        lastError: r.last_error,
        lastPostedAt: r.last_posted_at ? String(r.last_posted_at).slice(0, 10) : null,
        /** Overdue profiles are the ones somebody needs to look at today. */
        isDue: !!r.is_active && String(r.next_run).slice(0, 10) <= today,
      })),
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const ProfileInput = z.object({
  name: z.string().trim().min(1, 'Give the profile a name.').max(200),
  frequency: z.enum(FREQUENCIES),
  nextRun: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a yyyy-mm-dd date.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  debitAccountId: z.union([z.string(), z.number()]),
  creditAccountId: z.union([z.string(), z.number()]),
  amountPaise: z.number().int().positive('An entry needs an amount above zero.'),
  memo: z.string().trim().max(500).nullish(),
  autoRun: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, ProfileInput);
    const dr = Number(input.debitAccountId);
    const cr = Number(input.creditAccountId);

    if (dr === cr) {
      throw badRequest('The debit and credit sides must be different accounts, or nothing moves.');
    }

    const found = await db
      .selectFrom('accounts').select(['id'])
      .where('org_id', '=', orgId).where('id', 'in', [dr, cr]).execute();
    if (found.length !== 2) throw badRequest('One of those accounts does not exist.');

    const inserted = await db
      .insertInto('recurring_journals')
      .values({
        org_id: orgId,
        branch_id: branchId,
        name: input.name,
        frequency: input.frequency,
        next_run: input.nextRun,
        end_date: input.endDate ?? null,
        debit_account_id: dr,
        credit_account_id: cr,
        amount: toSqlFromPaise(input.amountPaise),
        memo: input.memo ?? null,
        is_active: 1,
        auto_run: input.autoRun ? 1 : 0,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_journal', targetId: id, targetLabel: input.name,
      detail: `${input.frequency} profile for ${(input.amountPaise / 100).toFixed(2)}, next ${input.nextRun}`,
      ...auditMeta(req),
    });

    return { id: asId(id), name: input.name };
  },
  { permission: { module: 'accountant', action: 'create' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run'),
    id: z.union([z.string(), z.number()]),
    /** Post on this date instead of the profile's scheduled one. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    action: z.literal('toggle'),
    id: z.union([z.string(), z.number()]),
    isActive: z.boolean(),
  }),
  z.object({
    action: z.literal('auto'),
    id: z.union([z.string(), z.number()]),
    autoRun: z.boolean(),
  }),
]);

/**
 * Run a profile, pause it, or let the scheduler post it.
 *
 * Running posts one entry and rolls the schedule forward. It does not catch up
 * on missed periods: silently posting six months of depreciation because
 * nobody opened the screen since March is not a favour to anyone.
 */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const id = Number(input.id);

    const profile = await db
      .selectFrom('recurring_journals')
      .select(['id', 'name'])
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');

    if (input.action === 'toggle' || input.action === 'auto') {
      await db
        .updateTable('recurring_journals')
        .set(input.action === 'toggle' ? { is_active: input.isActive ? 1 : 0 } : { auto_run: input.autoRun ? 1 : 0, last_error: null })
        .where('id', '=', id)
        .execute();
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'recurring_journal', targetId: id, targetLabel: profile.name,
        detail: input.action === 'toggle' ? (input.isActive ? 'Resumed' : 'Paused')
          : input.autoRun ? 'Posted automatically on its dates' : 'Posted only when run by hand',
        ...auditMeta(req),
      });
      return { id: asId(id) };
    }

    const run = await transaction((trx) => runRecurringJournal(trx, orgId, user.userId, id, input.date));

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_journal', targetId: id, targetLabel: run.name,
      detail: `Posted JE #${run.entry.entryNo} for ${(run.amountPaise / 100).toFixed(2)} on ${run.runDate}`,
      ...auditMeta(req),
    });

    return { id: asId(id), entryId: asId(run.entry.id), entryNo: run.entry.entryNo, postedOn: run.runDate };
  },
  { permission: { module: 'accountant', action: 'create' } },
);

/** Delete a profile. The entries it already posted stay — they are real. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.string() }));
    const numeric = Number(id);

    const profile = await db
      .selectFrom('recurring_journals').select(['id', 'name'])
      .where('id', '=', numeric).where('org_id', '=', orgId).executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');

    await db.deleteFrom('recurring_journals').where('id', '=', numeric).where('org_id', '=', orgId).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'recurring_journal', targetId: numeric, targetLabel: profile.name,
      detail: 'Profile deleted. Entries it already posted are unaffected.', ...auditMeta(req),
    });

    return { id: asId(numeric) };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
