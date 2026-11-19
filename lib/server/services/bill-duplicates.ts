import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Catching a supplier's bill entered twice, before it is paid twice.
//
//   exact    the same vendor and the same bill number, on a bill that stands
//            (not void). Refused: open that bill instead.
//   likely   worth a second look, not refused:
//              · the same number written differently ("INV-01", "inv01"),
//              · the same amount on the same day under another number,
//              · either of those from another contact with the same GSTIN
//                (one supplier entered twice as a vendor).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import type { Paise } from '../../types';

export interface BillTwin {
  id: string;
  internalNo: string;
  vendorInvoiceNo: string;
  vendorName: string;
  date: string;
  totalPaise: number;
  why: string;
}

/** A bill number with only its letters and digits, leading zeros dropped from each run of digits: "INV-001" is "inv1". */
export const billKey = (no: string) => no.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(^|[a-z])0+(\d)/g, '$1$2');

export async function findBillDuplicates(ex: Executor, orgId: number, input: {
  vendorId: number; vendorInvoiceNo: string; totalPaise?: number | null; date?: string | null; excludeId?: number | null;
}): Promise<{ exact: BillTwin | null; likely: BillTwin[] }> {
  const vendor = await ex.selectFrom('contacts').select(['id', 'gstin']).where('id', '=', input.vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor) return { exact: null, likely: [] };
  // The vendor, and any other contact carrying the same GSTIN.
  const same = vendor.gstin
    ? (await ex.selectFrom('contacts').select('id').where('org_id', '=', orgId).where('gstin', '=', vendor.gstin).execute()).map((c) => Number(c.id))
    : [Number(vendor.id)];
  const key = billKey(input.vendorInvoiceNo);
  const rows = await ex.selectFrom('bills').innerJoin('contacts', 'contacts.id', 'bills.vendor_id')
    .select(['bills.id', 'bills.internal_no', 'bills.vendor_invoice_no', 'bills.vendor_id', 'bills.bill_date', 'bills.total', 'contacts.display_name'])
    .where('bills.org_id', '=', orgId).where('bills.status', '!=', 'void').where('bills.vendor_id', 'in', same)
    .$if(!!input.excludeId, (q) => q.where('bills.id', '!=', input.excludeId!))
    .where((eb) => eb.or([
      eb('bills.vendor_invoice_no', '=', input.vendorInvoiceNo.trim()),
      // Narrowed in SQL by its digits, then compared exactly below.
      eb(sql<string>`TRIM(LEADING '0' FROM REGEXP_REPLACE(bills.vendor_invoice_no, '[^0-9]', ''))`, '=', input.vendorInvoiceNo.replace(/[^0-9]/g, '').replace(/^0+/, '')),
      ...(input.totalPaise && input.date
        ? [eb.and([eb('bills.total', '=', toSqlFromPaise(input.totalPaise as Paise)), eb('bills.bill_date', '=', input.date)])]
        : []),
    ]))
    .orderBy('bills.bill_date', 'desc').limit(20).execute();

  const view = (r: (typeof rows)[number], why: string): BillTwin => ({
    id: String(r.id), internalNo: r.internal_no, vendorInvoiceNo: r.vendor_invoice_no, vendorName: r.display_name,
    date: String(r.bill_date).slice(0, 10), totalPaise: toPaiseFromSql(r.total), why,
  });
  let exact: BillTwin | null = null;
  const likely: BillTwin[] = [];
  for (const r of rows) {
    const sameVendor = Number(r.vendor_id) === Number(vendor.id);
    const sameNo = r.vendor_invoice_no.trim().toLowerCase() === input.vendorInvoiceNo.trim().toLowerCase();
    if (sameVendor && sameNo) { exact ??= view(r, 'the same bill number from this vendor'); continue; }
    const other = sameVendor ? '' : ` from ${r.display_name}, which has the same GSTIN`;
    if (billKey(r.vendor_invoice_no) === key) likely.push(view(r, `the same bill number written as ${r.vendor_invoice_no}${other}`));
    else if (input.totalPaise && input.date && toPaiseFromSql(r.total) === input.totalPaise && String(r.bill_date).slice(0, 10) === input.date) {
      likely.push(view(r, `the same amount on the same day${other}`));
    }
  }
  return { exact, likely };
}
