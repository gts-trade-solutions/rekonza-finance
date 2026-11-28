import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteStatementLine, editStatementLine } from '@/lib/server/services/banking-changes';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { findMatches, linksOf } from '@/lib/server/services/bank-match';

// One bank line, as Zoho's side panel shows it: Best Matches and Possible
// Matches (bank-match.ts), a search over everything else open in the books,
// what a matched line is matched to, and a party's open documents and
// unused advances for the Categorize Manually forms.

const Query = z.object({
  /** Search for more: any of these narrows the list. */
  type: z.enum(['invoice', 'bill', 'payment', 'expense', 'transfer', 'journal']).optional(),
  contactId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  min: z.coerce.number().int().nonnegative().optional(),
  max: z.coerce.number().int().nonnegative().optional(),
  q: z.string().max(100).optional(),
  search: z.enum(['1']).optional(),
  /** A party's open invoices or bills and unused advances, for the category forms. */
  party: z.string().optional(),
});

export const GET = route(
  async ({ orgId, params, req }) => {
    const txnId = idParam(params);
    const q = query(req, Query);
    const searching = q.search === '1' || !!(q.type || q.contactId || q.from || q.to || q.min != null || q.max != null || q.q);
    const found = await findMatches(db, orgId, txnId, searching ? {
      type: q.type ?? null, contactId: q.contactId ?? null, from: q.from ?? null, to: q.to ?? null,
      minPaise: q.min ?? null, maxPaise: q.max ?? null, q: q.q ?? null,
    } : undefined);
    const line = found.line;

    let party: null | {
      documents: { id: string; number: string; date: string; dueDate: string; totalPaise: number; balancePaise: number }[];
      advances: { id: string; number: string; date: string; unusedPaise: number }[];
    } = null;
    if (q.party) {
      const contactId = Number(q.party);
      const docs = line.direction === 'in'
        ? await db.selectFrom('invoices').select(['id', 'number', 'invoice_date as date', 'due_date', 'total', 'amount_paid'])
          .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('currency', '=', 'INR')
          .where('status', 'in', ['approved', 'sent', 'overdue', 'partially_paid']).orderBy('due_date').orderBy('id').execute()
        : await db.selectFrom('bills').select(['id', 'internal_no as number', 'bill_date as date', 'due_date', 'total', 'amount_paid'])
          .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('currency', '=', 'INR')
          .where('status', 'in', ['open', 'overdue', 'partially_paid']).orderBy('due_date').orderBy('id').execute();
      // A refund goes out of an advance: money in refunds a vendor's, money out a customer's.
      const advances = await db.selectFrom('payments').select(['id', 'number', 'payment_date', 'unapplied_amount'])
        .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('status', '<>', 'void')
        .where('kind', '=', line.direction === 'in' ? 'made' : 'received').where('unapplied_amount', '>', '0')
        .orderBy('payment_date').execute();
      party = {
        documents: docs.map((d) => ({
          id: asId(d.id), number: d.number, date: String(d.date).slice(0, 10), dueDate: String(d.due_date).slice(0, 10),
          totalPaise: toPaiseFromSql(d.total), balancePaise: toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid),
        })).filter((d) => d.balancePaise > 0),
        advances: advances.map((a) => ({ id: asId(a.id), number: a.number, date: String(a.payment_date).slice(0, 10), unusedPaise: toPaiseFromSql(a.unapplied_amount) })),
      };
    }

    return {
      line: {
        id: asId(line.id), date: line.date, narration: line.narration, reference: line.reference ?? null,
        amountPaise: line.amountPaise, direction: line.direction, bankAccountId: asId(line.bankAccountId), bankName: line.bankName, status: line.status,
      },
      best: found.best,
      possible: found.possible,
      groups: found.groups,
      results: found.results,
      links: line.status === 'matched' ? await linksOf(db, orgId, txnId) : [],
      party,
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const LineInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  narration: z.string().trim().min(1, 'Give the line its narration.').max(500),
  reference: z.string().trim().max(100).nullish(),
  depositPaise: z.number().int().min(0),
  withdrawalPaise: z.number().int().min(0),
});

/**
 * Correct an uncategorised statement line: its date, narration, reference or
 * amount (services/banking-changes.ts). A categorised one is refused until
 * its categorisation is undone.
 */
export const PATCH = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, LineInput);
    await transaction(async (trx) => {
      const r = await editStatementLine(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bank_txn', targetId: id,
        detail: `Statement line edited: ${input.date}, ${input.narration.slice(0, 80)}`, payload: { before: r.before, after: r.after }, ...auditMeta(req),
      });
    });
    return { id: asId(id) };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

/** Delete one uncategorised or excluded statement line (imported by mistake). */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    await transaction(async (trx) => {
      const gone = await deleteStatementLine(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'bank_txn', targetId: id,
        detail: `Deleted the statement line of ${gone.date}: ${gone.narration.slice(0, 80)}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
    });
    return { deleted: true };
  },
  { permission: { module: 'banking', action: 'void' } },
);
