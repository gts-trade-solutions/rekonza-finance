import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import {
  categoriseTransaction, matchToPayment, unmatchTransaction, applyRules, matchInvoicePayments, matchEnteredPayments,
} from '@/lib/server/services/banking';
import { acceptSuggestions, bulkCategorise, deleteLines, setExcluded, suggestCategories } from '@/lib/server/services/bank-bulk';
import { bestMatchesFor, categoriseAs, matchLine } from '@/lib/server/services/bank-match';
import { BANK_CATEGORIES } from '@/lib/bank-categories';
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

    // Zoho's "match found" on a row: each unmatched line's confident matches
    // in the books (bank-match.ts). Offered, never applied without a click.
    const unmatchedRows = rows.filter((r) => r.status === 'unmatched');
    const best = await bestMatchesFor(db, orgId, unmatchedRows.map((r) => r.id));
    const suggestions = Object.fromEntries([...best].map(([id, list]) => [String(id), list]));

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
  // Zoho's Match: one line to one or more things in the books (bank-match.ts).
  z.object({
    action: z.literal('match_many'),
    transactionId: z.string(),
    picks: z.array(z.object({
      type: z.enum(['invoice', 'bill', 'payment', 'expense', 'transfer', 'journal']),
      id: z.string(),
      amountPaise: z.number().int().positive().optional(),
    })).min(1).max(50),
    differenceAccountId: z.string().nullish(),
  }),
  // Zoho's Categorize Manually, by its categories (lib/bank-categories.ts).
  z.object({
    action: z.literal('categorise_as'),
    transactionId: z.string(),
    category: z.enum(BANK_CATEGORIES.map((c) => c.key) as [string, ...string[]]),
    contactId: z.string().nullish(),
    allocations: z.array(z.object({ targetId: z.string(), amountPaise: z.number().int().nonnegative() })).max(100).optional(),
    bankChargesPaise: z.number().int().nonnegative().optional(),
    tdsPaise: z.number().int().nonnegative().optional(),
    otherBankAccountId: z.string().nullish(),
    accountId: z.string().nullish(),
    gstRatePct: z.number().min(0).max(40).nullish(),
    itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
    paymentId: z.string().nullish(),
    reference: z.string().max(100).nullish(),
    notes: z.string().max(500).nullish(),
  }),
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

    if (input.action === 'match_many' || input.action === 'categorise_as') {
      const txnId = Number(input.transactionId);
      const result = await transaction(async (trx) => {
        if (input.action === 'match_many') {
          return matchLine(trx, orgId, user.userId, txnId,
            input.picks.map((p) => ({ type: p.type, id: Number(p.id), amountPaise: p.amountPaise })),
            { differenceAccountId: input.differenceAccountId ? Number(input.differenceAccountId) : null });
        }
        return categoriseAs(trx, orgId, user.userId, txnId, {
          category: input.category as never,
          contactId: input.contactId ? Number(input.contactId) : null,
          allocations: input.allocations?.map((a) => ({ targetId: Number(a.targetId), amountPaise: a.amountPaise })),
          bankChargesPaise: input.bankChargesPaise, tdsPaise: input.tdsPaise,
          otherBankAccountId: input.otherBankAccountId ? Number(input.otherBankAccountId) : null,
          accountId: input.accountId ? Number(input.accountId) : null,
          gstRatePct: input.gstRatePct ?? null, itcEligibility: input.itcEligibility,
          paymentId: input.paymentId ? Number(input.paymentId) : null,
          reference: input.reference, notes: input.notes,
        });
      });
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'match', targetType: 'bank_txn', targetId: txnId,
        detail: input.action === 'match_many'
          ? `Bank line matched to ${input.picks.map((p) => `${p.type} ${p.id}`).join(', ')}${input.differenceAccountId ? ' (difference posted)' : ''}`
          : `Bank line categorised as ${BANK_CATEGORIES.find((c) => c.key === input.category)?.label}`,
        ...auditMeta(req),
      });
      return { id: asId(txnId), ...result };
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
