import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The "Possible duplicate bills" register (status review 7, item 8).
//
// A supplier's invoice that was saved although it looked like one already in
// the books (bill-duplicates.ts) is listed here with what it looked like, why,
// the reason the person who saved it gave, and who that was. An accountant
// then clears it (not a duplicate, with a note) or confirms it (a duplicate:
// the document is to be voided, and the register says so until it is).
// Nothing here is deleted: the register is the evidence that the check ran
// and that someone looked, which is what an auditor reads it for.
//
// "Scan for duplicates" looks over the bills already entered (before this
// check existed, or imported) for pairs the check would flag now.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { billKey, billNumberKey, NEAR_DAYS } from './bill-duplicates';

type DocType = 'bill' | 'expense' | 'goods_receipt' | 'invoice';

export interface DuplicateReviewRow {
  id: string;
  status: 'open' | 'cleared' | 'confirmed';
  why: string;
  enteredReason: string | null;
  enteredBy: string | null;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  doc: DocView;
  twin: DocView;
}
interface DocView { type: DocType; id: string; number: string; reference: string | null; party: string; date: string; totalPaise: number; status: string; href: string }

const HREF: Record<DocType, (id: number) => string> = {
  bill: (id) => `/purchases/bills/${id}`,
  expense: (id) => `/purchases/expenses?open=${id}`,
  goods_receipt: (id) => `/purchases/goods-receipts?open=${id}`,
  invoice: (id) => `/sales/invoices/${id}`,
};

async function views(ex: Executor, orgId: number, want: { type: DocType; id: number }[]): Promise<Map<string, DocView>> {
  const out = new Map<string, DocView>();
  const ids = (t: DocType) => [...new Set(want.filter((w) => w.type === t).map((w) => w.id))];
  const put = (type: DocType, r: { id: number; number: string; reference: string | null; party: string; date: unknown; total: string; status: string }) =>
    out.set(`${type}:${r.id}`, { type, id: String(r.id), number: r.number, reference: r.reference, party: r.party, date: String(r.date).slice(0, 10), totalPaise: toPaiseFromSql(r.total), status: r.status, href: HREF[type](r.id) });
  if (ids('bill').length) {
    for (const r of await ex.selectFrom('bills as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
      .select(['d.id', 'd.internal_no as number', 'd.vendor_invoice_no as reference', 'c.display_name as party', 'd.bill_date as date', 'd.total', 'd.status'])
      .where('d.org_id', '=', orgId).where('d.id', 'in', ids('bill')).execute()) put('bill', r);
  }
  if (ids('expense').length) {
    for (const r of await ex.selectFrom('expenses as d').leftJoin('contacts as c', 'c.id', 'd.vendor_id')
      .select(['d.id', 'd.number', 'd.reference', 'c.display_name as party', 'd.expense_date as date', 'd.total', 'd.status'])
      .where('d.org_id', '=', orgId).where('d.id', 'in', ids('expense')).execute()) put('expense', { ...r, party: r.party ?? '' });
  }
  if (ids('goods_receipt').length) {
    for (const r of await ex.selectFrom('goods_receipts as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
      .select(['d.id', 'd.number', 'd.vendor_challan_no as reference', 'c.display_name as party', 'd.receipt_date as date', 'd.total', 'd.status'])
      .where('d.org_id', '=', orgId).where('d.id', 'in', ids('goods_receipt')).execute()) put('goods_receipt', r);
  }
  if (ids('invoice').length) {
    for (const r of await ex.selectFrom('invoices as d').innerJoin('contacts as c', 'c.id', 'd.customer_id')
      .select(['d.id', 'd.number', 'd.order_number as reference', 'c.display_name as party', 'd.invoice_date as date', 'd.total', 'd.status'])
      .where('d.org_id', '=', orgId).where('d.id', 'in', ids('invoice')).execute()) put('invoice', r);
  }
  return out;
}

export async function listDuplicateReviews(ex: Executor, orgId: number, opts: { status?: 'open' | 'cleared' | 'confirmed' | 'all' } = {}) {
  const rows = await ex.selectFrom('duplicate_reviews as r')
    .leftJoin('users as e', 'e.id', 'r.entered_by_user_id').leftJoin('users as v', 'v.id', 'r.reviewed_by_user_id')
    .select(['r.id', 'r.status', 'r.why', 'r.entered_reason', 'e.name as entered_by', 'r.created_at', 'v.name as reviewed_by', 'r.reviewed_at', 'r.review_note',
      'r.doc_type', 'r.doc_id', 'r.twin_type', 'r.twin_id'])
    .where('r.org_id', '=', orgId)
    .$if(!!opts.status && opts.status !== 'all', (q) => q.where('r.status', '=', opts.status as 'open'))
    .orderBy('r.status').orderBy('r.created_at', 'desc').limit(500).execute();
  const v = await views(ex, orgId, rows.flatMap((r) => [{ type: r.doc_type, id: Number(r.doc_id) }, { type: r.twin_type, id: Number(r.twin_id) }]));
  const blank = (type: DocType, id: number): DocView => ({ type, id: String(id), number: '(deleted)', reference: null, party: '', date: '', totalPaise: 0, status: 'deleted', href: HREF[type](id) });
  const counts = await ex.selectFrom('duplicate_reviews').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).where('org_id', '=', orgId).groupBy('status').execute();
  return {
    counts: { open: 0, cleared: 0, confirmed: 0, ...Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) } as Record<'open' | 'cleared' | 'confirmed', number>,
    rows: rows.map((r): DuplicateReviewRow => ({
      id: String(r.id), status: r.status, why: r.why, enteredReason: r.entered_reason, enteredBy: r.entered_by, createdAt: new Date(r.created_at).toISOString(),
      reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null, reviewNote: r.review_note,
      doc: v.get(`${r.doc_type}:${r.doc_id}`) ?? blank(r.doc_type, Number(r.doc_id)),
      twin: v.get(`${r.twin_type}:${r.twin_id}`) ?? blank(r.twin_type, Number(r.twin_id)),
    })),
  };
}

/** Clear (not a duplicate), confirm (a duplicate, to void), or reopen one entry. The note is required to clear or confirm. */
export async function reviewDuplicate(trx: Trx, orgId: number, userId: number, id: number, action: 'clear' | 'confirm' | 'reopen', note?: string | null) {
  const r = await trx.selectFrom('duplicate_reviews').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That entry is not on the register.');
  if (action !== 'reopen' && !(note?.trim())) throw badRequest(action === 'clear' ? 'Say why it is not a duplicate.' : 'Say what is to be done with the duplicate.');
  if (action === 'reopen' && r.status === 'open') throw conflict('It is already open.');
  if (action !== 'reopen' && r.status !== 'open') throw conflict(`It was ${r.status} already. Reopen it first to change that.`);
  const status = action === 'clear' ? 'cleared' : action === 'confirm' ? 'confirmed' : 'open';
  await trx.updateTable('duplicate_reviews').set({
    status, reviewed_by_user_id: action === 'reopen' ? null : userId, reviewed_at: action === 'reopen' ? null : new Date(), review_note: action === 'reopen' ? null : note!.trim().slice(0, 500),
  }).where('id', '=', id).execute();
  return { id, status, docType: r.doc_type, docId: r.doc_id };
}

/**
 * Look over the bills already in the books for pairs the check would flag
 * today, and put any not yet on the register there. Returns how many were added.
 */
export async function scanForDuplicates(trx: Trx, orgId: number, userId: number | null): Promise<number> {
  const bills = await trx.selectFrom('bills').select(['id', 'vendor_id', 'vendor_invoice_no', 'bill_date', 'total'])
    .where('org_id', '=', orgId).where('status', '!=', 'void').orderBy('bill_date').orderBy('id').execute();
  const seen = new Set((await trx.selectFrom('duplicate_reviews').select(['doc_type', 'doc_id', 'twin_type', 'twin_id']).where('org_id', '=', orgId).execute())
    .flatMap((r) => [`${r.doc_type}:${r.doc_id}|${r.twin_type}:${r.twin_id}`, `${r.twin_type}:${r.twin_id}|${r.doc_type}:${r.doc_id}`]));
  let added = 0;
  const day = (d: unknown) => Date.parse(String(d).slice(0, 10));
  for (let i = 0; i < bills.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = bills[i], b = bills[j];
      if (a.vendor_id !== b.vendor_id) continue;
      let why: string | null = null;
      if (billNumberKey(a.vendor_invoice_no) === billNumberKey(b.vendor_invoice_no)) why = 'the same bill number from this vendor (entered before the check refused it)';
      else if (billKey(a.vendor_invoice_no) === billKey(b.vendor_invoice_no)) why = `the same bill number but for leading zeros, written as ${b.vendor_invoice_no}`;
      else if (a.total === b.total && Math.abs(day(a.bill_date) - day(b.bill_date)) <= NEAR_DAYS * 86_400_000) why = 'the same amount from this vendor within a week, under another number';
      if (!why || seen.has(`bill:${a.id}|bill:${b.id}`)) continue;
      await trx.insertInto('duplicate_reviews').values({
        org_id: orgId, doc_type: 'bill', doc_id: a.id, twin_type: 'bill', twin_id: b.id, why, entered_reason: null, entered_by_user_id: userId, status: 'open',
      }).execute();
      seen.add(`bill:${a.id}|bill:${b.id}`);
      added++;
    }
  }
  return added;
}

/** How many entries are waiting, for the Bills list's banner. */
export async function openDuplicateCount(ex: Executor, orgId: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM duplicate_reviews WHERE org_id = ${orgId} AND status = 'open'`.execute(ex);
  return Number(rows[0]?.n ?? 0);
}
