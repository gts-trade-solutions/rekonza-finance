import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import {
  categoriseTransaction, matchToPayment, unmatchTransaction, applyRules, matchInvoicePayments, matchEnteredPayments,
} from '@/lib/server/services/banking';
import { acceptSuggestions, bulkCategorise, deleteLines, setExcluded, suggestCategories } from '@/lib/server/services/bank-bulk';
import { logAudit, auditMeta } from '@/lib/server/audit';

const ListQuery = z.object({
  bankAccountId: z.string().optional(),
  status: z.enum(['unmatched', 'matched', 'excluded', 'manually_added', 'all']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** The lines of one import (Undo import, and the bulk screen's filter). */
  importId: z.string().optional(),
  /** Also suggest a category for each uncategorised line, learnt from past ones (bank-bulk.ts). */
  suggest: z.enum(['1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db
      .selectFrom('bank_transactions')
      .innerJoin('bank_accounts', 'bank_accounts.id', 'bank_transactions.bank_account_id')
      .where('bank_transactions.org_id', '=', orgId);

    if (q.bankAccountId) base = base.where('bank_transactions.bank_account_id', '=', Number(q.bankAccountId));
    if (q.status && q.status !== 'all') base = base.where('bank_transactions.status', '=', q.status);
    if (q.from) base = base.where('bank_transactions.txn_date', '>=', q.from);
    if (q.to) base = base.where('bank_transactions.txn_date', '<=', q.to);
    if (q.importId) base = base.where('bank_transactions.import_batch_id', '=', Number(q.importId));

    const [rows, counts] = await Promise.all([
      base
        .select([
          'bank_transactions.id', 'bank_transactions.txn_date', 'bank_transactions.narration',
          'bank_transactions.reference', 'bank_transactions.deposit', 'bank_transactions.withdrawal',
          'bank_transactions.status', 'bank_transactions.matched_type', 'bank_transactions.matched_id',
          'bank_transactions.applied_rule_id', 'bank_transactions.bank_account_id',
          'bank_accounts.name as bank_name',
        ])
        .orderBy('bank_transactions.txn_date', 'desc')
        .orderBy('bank_transactions.id', 'desc')
        .limit(q.limit).offset(q.offset).execute(),
      base
        .select([
          sql<string>`COUNT(*)`.as('count'),
          sql<string>`SUM(bank_transactions.status = 'unmatched')`.as('unmatched'),
          sql<string>`COALESCE(SUM(bank_transactions.deposit), 0)`.as('deposits'),
          sql<string>`COALESCE(SUM(bank_transactions.withdrawal), 0)`.as('withdrawals'),
        ])
        .executeTakeFirst(),
    ]);

    // Suggestions for the unmatched lines: payments of the same amount and
    // direction, within a few days. Offered, never applied — a wrong automatic
    // match is invisible until somebody reconciles the account by hand.
    const unmatchedRows = rows.filter((r) => r.status === 'unmatched');
    const suggestions: Record<string, { id: string; number: string; date: string; amountPaise: number }[]> = {};

    if (unmatchedRows.length) {
      // Payments already reconciled against some other line are not candidates.
      // Fetched separately rather than as a NOT IN subquery: the two lists are
      // small, and a correlated subquery here reads worse than it performs.
      const [candidates, alreadyMatched] = await Promise.all([
        db
          .selectFrom('payments')
          .select(['id', 'number', 'kind', 'payment_date', 'amount', 'bank_account_id'])
          .where('org_id', '=', orgId)
          .where('status', '=', 'cleared')
          .execute(),
        db
          .selectFrom('bank_transactions')
          .select('matched_id')
          .where('org_id', '=', orgId)
          .where('matched_type', '=', 'payment')
          .where('matched_id', 'is not', null)
          .execute(),
      ]);
      const taken = new Set(alreadyMatched.map((m) => m.matched_id));

      for (const t of unmatchedRows) {
        const amount = toPaiseFromSql(t.deposit) || toPaiseFromSql(t.withdrawal);
        const wantKind = toPaiseFromSql(t.deposit) > 0 ? 'received' : 'made';
        const near = candidates.filter(
          (p) =>
            !taken.has(p.id) &&
            p.kind === wantKind &&
            p.bank_account_id === t.bank_account_id &&
            toPaiseFromSql(p.amount) === amount &&
            Math.abs(
              new Date(p.payment_date).getTime() - new Date(t.txn_date).getTime(),
            ) <= 7 * 86_400_000,
        );
        if (near.length) {
          suggestions[String(t.id)] = near.slice(0, 3).map((p) => ({
            id: asId(p.id),
            number: p.number,
            date: p.payment_date,
            amountPaise: toPaiseFromSql(p.amount),
          }));
        }
      }
    }

    const categories = q.suggest
      ? await suggestCategories(db, orgId, unmatchedRows.map((r) => ({ id: r.id, narration: r.narration, inflow: toPaiseFromSql(r.deposit) > 0 })))
      : null;

    return {
      ...(categories ? { categorySuggestions: Object.fromEntries([...categories].map(([id, c]) => [String(id), c])) } : {}),
      transactions: rows.map((r) => ({
        id: asId(r.id),
        date: r.txn_date,
        narration: r.narration,
        reference: r.reference,
        depositPaise: toPaiseFromSql(r.deposit),
        withdrawalPaise: toPaiseFromSql(r.withdrawal),
        status: r.status,
        matchedType: r.matched_type,
        matchedId: r.matched_id ? asId(r.matched_id) : null,
        suggestedRuleId: r.applied_rule_id ? asId(r.applied_rule_id) : null,
        bankAccountId: asId(r.bank_account_id),
        bankName: r.bank_name,
      })),
      suggestions,
      summary: {
        count: Number(counts?.count ?? 0),
        unmatched: Number(counts?.unmatched ?? 0),
        depositsPaise: toPaiseFromSql(counts?.deposits ?? '0'),
        withdrawalsPaise: toPaiseFromSql(counts?.withdrawals ?? '0'),
      },
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('categorise'),
    transactionId: z.string(),
    accountId: z.string(),
    contactId: z.string().nullish(),
    description: z.string().nullish(),
  }),
  z.object({
    action: z.literal('match'),
    transactionId: z.string(),
    paymentId: z.string(),
  }),
  z.object({
    action: z.literal('unmatch'),
    transactionId: z.string(),
  }),
  // Run the automatic matching again over lines already imported: rules,
  // invoice numbers in the narration, and payments already entered.
  z.object({
    action: z.literal('auto_match'),
    bankAccountId: z.string(),
  }),
  // In bulk, as Zoho's banking list allows (bank-bulk.ts).
  z.object({
    action: z.literal('bulk_categorise'),
    transactionIds: z.array(z.string()).min(1).max(500),
    accountId: z.string(),
    contactId: z.string().nullish(),
    description: z.string().max(300).nullish(),
  }),
  z.object({
    action: z.literal('accept_suggestions'),
    picks: z.array(z.object({ transactionId: z.string(), accountId: z.string() })).min(1).max(500),
  }),
  z.object({ action: z.literal('exclude'), transactionIds: z.array(z.string()).min(1).max(500) }),
  z.object({ action: z.literal('include'), transactionIds: z.array(z.string()).min(1).max(500) }),
  z.object({ action: z.literal('delete'), transactionIds: z.array(z.string()).min(1).max(500) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    if (input.action === 'auto_match') {
      const bankAccountId = Number(input.bankAccountId);
      const matched = await transaction(async (trx) => await applyRules(trx, orgId, user.userId, bankAccountId)
        + await matchInvoicePayments(trx, orgId, user.userId, bankAccountId)
        + await matchEnteredPayments(trx, orgId, user.userId, bankAccountId));
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'match', targetType: 'bank_account', targetId: bankAccountId,
        detail: `Automatic matching: ${matched} statement line${matched === 1 ? '' : 's'} matched`, ...auditMeta(req),
      });
      return { matched };
    }

    if (input.action === 'bulk_categorise' || input.action === 'accept_suggestions' || input.action === 'exclude' || input.action === 'include' || input.action === 'delete') {
      const ids = input.action === 'accept_suggestions' ? input.picks.map((x) => Number(x.transactionId)) : input.transactionIds.map(Number);
      const action = input.action;
      const result = await transaction(async (trx) => {
        if (input.action === 'bulk_categorise') {
          return bulkCategorise(trx, orgId, user.userId, ids, {
            accountId: Number(input.accountId), contactId: input.contactId ? Number(input.contactId) : null, description: input.description,
          });
        }
        if (input.action === 'accept_suggestions') {
          return { categorised: await acceptSuggestions(trx, orgId, user.userId, input.picks.map((x) => ({ id: Number(x.transactionId), accountId: Number(x.accountId) }))) };
        }
        if (input.action === 'delete') return deleteLines(trx, orgId, ids);
        return { changed: await setExcluded(trx, orgId, ids, input.action === 'exclude') };
      });
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name,
        action: action === 'delete' ? 'void' : action === 'exclude' || action === 'include' ? 'update' : 'match',
        targetType: 'bank_txn', targetId: ids[0], targetLabel: `${ids.length} bank line(s)`,
        detail: `Bulk ${action.replace('_', ' ')} on ${ids.length} statement line(s): ${JSON.stringify(result)}`,
        ...auditMeta(req),
      });
      return result;
    }

    const txnId = Number(input.transactionId);

    const result = await transaction(async (trx) => {
      if (input.action === 'categorise') {
        const entryId = await categoriseTransaction(trx, orgId, user.userId, txnId, {
          accountId: Number(input.accountId),
          contactId: input.contactId ? Number(input.contactId) : null,
          description: input.description,
        });
        return { journalEntryId: asId(entryId) };
      }
      if (input.action === 'match') {
        await matchToPayment(trx, orgId, user.userId, txnId, Number(input.paymentId));
        return { journalEntryId: null };
      }
      await unmatchTransaction(trx, orgId, user.userId, txnId);
      return { journalEntryId: null };
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name,
      action: input.action === 'unmatch' ? 'update' : 'match',
      targetType: 'bank_txn', targetId: txnId,
      detail: `Bank line ${input.action}`,
      ...auditMeta(req),
    });

    return { id: asId(txnId), ...result };
  },
  { permission: { module: 'banking', action: 'edit' } },
);
