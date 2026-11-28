import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Catching a supplier's bill entered twice, before it is paid twice.
//
//   exact    the same vendor and the same bill number, on a bill or expense
//            that stands (not void), however the number is written: case,
//            spaces and the separators GST allows in an invoice number (- and
//            /, CGST Rules r.46(b)), and dots or underscores, are ignored, so
//            "INV-001", "inv-001", "INV001" and " INV/001 " are one number.
//            Refused: open that bill instead.
//   likely   worth a second look, saved only with a reason, which is kept in
//            the audit trail and on the "Possible duplicate bills" register
//            (duplicate_reviews, migration 131) until an accountant clears or
//            confirms it:
//              · the same number but for leading zeros ("INV-01" and "INV-1"),
//              · the same amount from the same vendor within a week, under
//                another number,
//              · either of those, or the same number, from another contact
//                with the same GSTIN (one supplier entered twice as a vendor).
//
// A supplier's tax invoice number is unique to it for the financial year
// (CGST Rules r.46(b)), and the input credit on it can be taken only once
// (CGST Act s.16), so the same number twice from one supplier is never right.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import type { Paise } from '../../types';
import { ApiError, badRequest } from '../http';

export interface BillTwin {
  id: string;
  /** What the twin is: a bill (the usual), or an expense carrying the supplier's invoice number. */
  kind: 'bill' | 'expense' | 'goods_receipt';
  href: string;
  internalNo: string;
  vendorInvoiceNo: string;
  vendorName: string;
  date: string;
  totalPaise: number;
  why: string;
}

/** A bill number with only its letters and digits, leading zeros dropped from each run of digits: "INV-001" is "inv1". */
export const billKey = (no: string) => no.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(^|[a-z])0+(\d)/g, '$1$2');

/** A bill number as it is compared for a refusal: case, spaces and separators ignored. "inv-001" and " INV/001 " are "INV001". */
export const billNumberKey = (no: string) => no.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** How far apart two bills of the same amount may be dated and still look like one bill entered twice. */
export const NEAR_DAYS = 7;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const SQL_KEY = (col: string) => sql<string>`UPPER(REGEXP_REPLACE(${sql.ref(col)}, '[^0-9A-Za-z]', ''))`;

export async function findBillDuplicates(ex: Executor, orgId: number, input: {
  vendorId: number; vendorInvoiceNo: string; totalPaise?: number | null; date?: string | null; excludeId?: number | null;
  /** Checking an expense: leave that expense itself out. */
  excludeExpenseId?: number | null;
}): Promise<{ exact: BillTwin | null; likely: BillTwin[] }> {
  const vendor = await ex.selectFrom('contacts').select(['id', 'gstin']).where('id', '=', input.vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor) return { exact: null, likely: [] };
  const no = input.vendorInvoiceNo.trim();
  const norm = billNumberKey(no);
  if (!norm) return { exact: null, likely: [] };
  // The vendor, and any other contact carrying the same GSTIN.
  const same = vendor.gstin
    ? (await ex.selectFrom('contacts').select('id').where('org_id', '=', orgId).where('gstin', '=', vendor.gstin).execute()).map((c) => Number(c.id))
    : [Number(vendor.id)];
  const key = billKey(no);
  const digits = no.replace(/[^0-9]/g, '').replace(/^0+/, '');
  const near = input.totalPaise && input.date ? { from: addDays(input.date, -NEAR_DAYS), to: addDays(input.date, NEAR_DAYS) } : null;

  const bills = await ex.selectFrom('bills').innerJoin('contacts', 'contacts.id', 'bills.vendor_id')
    .select(['bills.id', 'bills.internal_no', 'bills.vendor_invoice_no', 'bills.vendor_id', 'bills.bill_date', 'bills.total', 'contacts.display_name'])
    .where('bills.org_id', '=', orgId).where('bills.status', '!=', 'void').where('bills.vendor_id', 'in', same)
    .$if(!!input.excludeId, (q) => q.where('bills.id', '!=', input.excludeId!))
    .where((eb) => eb.or([
      eb(SQL_KEY('bills.vendor_invoice_no'), '=', norm),
      // Narrowed in SQL by its digits, then compared exactly below.
      ...(digits ? [eb(sql<string>`TRIM(LEADING '0' FROM REGEXP_REPLACE(bills.vendor_invoice_no, '[^0-9]', ''))`, '=', digits)] : []),
      ...(near ? [eb.and([eb('bills.total', '=', toSqlFromPaise(input.totalPaise as Paise)), eb('bills.bill_date', '>=', near.from), eb('bills.bill_date', '<=', near.to)])] : []),
    ]))
    .orderBy('bills.bill_date', 'desc').limit(20).execute();
  // An expense booked with the supplier's invoice number as its reference is the same invoice.
  const expenses = await ex.selectFrom('expenses').innerJoin('contacts', 'contacts.id', 'expenses.vendor_id')
    .select(['expenses.id', 'expenses.number', 'expenses.reference', 'expenses.vendor_id', 'expenses.expense_date', 'expenses.total', 'contacts.display_name'])
    .where('expenses.org_id', '=', orgId).where('expenses.status', '!=', 'void').where('expenses.vendor_id', 'in', same)
    .$if(!!input.excludeExpenseId, (q) => q.where('expenses.id', '!=', input.excludeExpenseId!))
    .where((eb) => eb.or([
      eb(SQL_KEY('expenses.reference'), '=', norm),
      ...(near ? [eb.and([eb('expenses.total', '=', toSqlFromPaise(input.totalPaise as Paise)), eb('expenses.expense_date', '>=', near.from), eb('expenses.expense_date', '<=', near.to)])] : []),
    ]))
    .limit(10).execute();

  const rows = [
    ...bills.map((r) => ({ kind: 'bill' as const, id: Number(r.id), internalNo: r.internal_no, number: r.vendor_invoice_no, vendorId: Number(r.vendor_id), date: String(r.bill_date).slice(0, 10), total: toPaiseFromSql(r.total), vendorName: r.display_name })),
    ...expenses.map((r) => ({ kind: 'expense' as const, id: Number(r.id), internalNo: r.number, number: r.reference ?? '', vendorId: Number(r.vendor_id), date: String(r.expense_date).slice(0, 10), total: toPaiseFromSql(r.total), vendorName: r.display_name })),
  ];
  const view = (r: (typeof rows)[number], why: string): BillTwin => ({
    id: String(r.id), kind: r.kind, href: r.kind === 'bill' ? `/purchases/bills/${r.id}` : `/purchases/expenses?open=${r.id}`,
    internalNo: r.internalNo, vendorInvoiceNo: r.number, vendorName: r.vendorName, date: r.date, totalPaise: r.total, why,
  });
  let exact: BillTwin | null = null;
  const likely: BillTwin[] = [];
  for (const r of rows) {
    const sameVendor = r.vendorId === Number(vendor.id);
    const sameNo = r.number && billNumberKey(r.number) === norm;
    const what = r.kind === 'expense' ? 'an expense' : 'a bill';
    if (sameVendor && sameNo) {
      exact ??= view(r, r.number.trim() === no
        ? `the same bill number from this vendor, already entered as ${what}`
        : `the same bill number from this vendor, written as "${r.number}" on ${what}`);
      continue;
    }
    const other = sameVendor ? '' : ` from ${r.vendorName}, which has the same GSTIN`;
    if (sameNo) likely.push(view(r, `the same bill number${other}`));
    else if (r.number && billKey(r.number) === key && key) likely.push(view(r, `the same bill number but for leading zeros, written as ${r.number}${other}`));
    else if (near && r.total === input.totalPaise && r.date >= near.from && r.date <= near.to) {
      likely.push(view(r, r.date === input.date ? `the same amount on the same day${other}` : `the same amount ${Math.abs((Date.parse(r.date) - Date.parse(input.date!)) / 86_400_000)} day(s) apart${other}`));
    }
  }
  return { exact, likely };
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

/**
 * The check a supplier's invoice passes before it is saved (a bill, or an
 * expense with the supplier's invoice number): the same number again is
 * refused, naming the first; one that only looks like another needs the
 * reason it is not a duplicate. Returns the likely twins to register once
 * the document has its id (registerDuplicates).
 */
export async function guardSupplierInvoice(ex: Executor, orgId: number, input: {
  vendorId: number; vendorInvoiceNo: string; totalPaise?: number | null; date?: string | null;
  excludeId?: number | null; excludeExpenseId?: number | null; duplicateReason?: string | null; what?: string;
}): Promise<BillTwin[]> {
  if (!input.vendorInvoiceNo?.trim()) return [];
  const { exact, likely } = await findBillDuplicates(ex, orgId, input);
  if (exact) {
    throw new ApiError(409,
      `Bill ${input.vendorInvoiceNo.trim()} from ${exact.vendorName} is already in your books as ${exact.internalNo}, dated ${exact.date} ` +
        `(${exact.why}). A supplier's bill is entered once: open that one, or void it first if it was wrong.`,
      'duplicate_bill', { href: exact.href, twinId: exact.id, twinNo: exact.internalNo });
  }
  if (likely.length && !(input.duplicateReason?.trim())) {
    const first = likely[0];
    throw new ApiError(409,
      `This looks like ${first.internalNo} (${first.vendorInvoiceNo}, ${first.date}, ${rupees(first.totalPaise)}): ${first.why}. ` +
        'If it is a different bill, say why and save again; the reason is kept in the audit trail and on the Possible duplicate bills list.',
      'possible_duplicate', { href: first.href, twinId: first.id, twinNo: first.internalNo, count: String(likely.length) });
  }
  if (likely.length && input.duplicateReason!.trim().length < 5) throw badRequest('Give a reason of a few words: why is this not a duplicate?');
  return likely;
}

/** Put what a saved document resembled on the Possible duplicate bills register, with the reason given. */
export async function registerDuplicates(trx: Trx, orgId: number, userId: number | null, doc: { type: 'bill' | 'expense' | 'goods_receipt' | 'invoice'; id: number },
  twins: { kind: 'bill' | 'expense' | 'goods_receipt' | 'invoice'; id: string; why: string }[], reason: string | null) {
  for (const t of twins) {
    await trx.insertInto('duplicate_reviews').values({
      org_id: orgId, doc_type: doc.type, doc_id: doc.id, twin_type: t.kind, twin_id: Number(t.id), why: t.why.slice(0, 300),
      entered_reason: reason?.trim().slice(0, 500) || null, entered_by_user_id: userId, status: 'open',
    }).onDuplicateKeyUpdate({ why: t.why.slice(0, 300), entered_reason: reason?.trim().slice(0, 500) || null, status: 'open' }).execute();
  }
}
