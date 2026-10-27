import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The compliance registers: e-invoices, e-way bills, GSTR-2B reconciliation and
// TDS.
//
// One thing runs through all four. Every figure the government holds about you
// comes from somebody else's filing — your customer's IRN, your supplier's
// GSTR-1 — and the only thing you control is whether your books agree with it.
// These screens exist to surface the disagreements while they can still be
// fixed, rather than at an assessment two years later.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { irnCancelOpenUntil } from '../../tax/einvoice';
import { queuedRetries, type QueuedRetry } from '../jobs/queue';

// ── e-invoices ───────────────────────────────────────────────────────────────

export interface EinvoiceRow {
  id: string;
  invoiceId: string;
  number: string;
  date: string;
  customerName: string;
  gstin: string | null;
  totalPaise: Paise;
  status: string;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  /** While the IRN can still be cancelled, when that ends (ISO); otherwise null. */
  cancelUntil: string | null;
  /** A retry queued after the portal did not answer. */
  retry: QueuedRetry | null;
  errorMessage: string | null;
  attempts: number;
  /** Days left of the 30-day registration window. Negative means it has passed. */
  daysLeft: number;
}

export async function einvoiceQueue(
  ex: Executor,
  orgId: number,
  status?: string,
): Promise<{ rows: EinvoiceRow[]; counts: Record<string, number> }> {
  const today = new Date().toISOString().slice(0, 10);

  // DATETIME columns arrive as Date objects: the pool keeps only DATE as text.
  const { rows } = await sql<{
    id: number; invoice_id: number; number: string; invoice_date: string;
    customer_name: string; gstin: string | null; total: string; status: string;
    irn: string | null; ack_no: string | null; ack_date: Date | null; updated_at: Date;
    error_message: string | null; attempts: number; age: number;
  }>`
    SELECT e.id, e.invoice_id, i.number, i.invoice_date,
           c.display_name AS customer_name, c.gstin, i.total,
           e.status, e.irn, e.ack_no, e.ack_date, e.updated_at, e.error_message, e.attempts,
           DATEDIFF(${today}, i.invoice_date) AS age
      FROM einvoices e
      JOIN invoices i ON i.id = e.invoice_id
      JOIN contacts c ON c.id = i.customer_id
     WHERE e.org_id = ${orgId}
       ${status && status !== 'all' ? sql`AND e.status = ${status}` : sql``}
     ORDER BY
       CASE e.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       i.invoice_date DESC
     LIMIT 500
  `.execute(ex);

  const retries = await queuedRetries(ex, orgId, 'einvoice.register');

  const { rows: counts } = await sql<{ status: string; n: string }>`
    SELECT status, COUNT(*) AS n FROM einvoices WHERE org_id = ${orgId} GROUP BY status
  `.execute(ex);

  const byStatus: Record<string, number> = { all: 0 };
  for (const c of counts) {
    byStatus[c.status] = Number(c.n);
    byStatus.all += Number(c.n);
  }

  return {
    rows: rows.map((r) => ({
      id: String(r.id),
      invoiceId: String(r.invoice_id),
      number: r.number,
      date: String(r.invoice_date).slice(0, 10),
      customerName: r.customer_name,
      gstin: r.gstin,
      totalPaise: toPaiseFromSql(r.total),
      status: r.status,
      irn: r.irn,
      ackNo: r.ack_no,
      ackDate: r.ack_date ? new Date(r.ack_date).toISOString() : null,
      cancelUntil: r.status === 'submitted' ? irnCancelOpenUntil(r.ack_date ?? r.updated_at) : null,
      retry: retries.get(`invoice:${r.invoice_id}`) ?? null,
      errorMessage: r.error_message,
      attempts: r.attempts,
      // An invoice must be registered within 30 days of its date. After that
      // the portal simply refuses it and the invoice is not legally valid.
      daysLeft: 30 - Number(r.age),
    })),
    counts: byStatus,
  };
}

// ── GSTR-2B reconciliation ───────────────────────────────────────────────────

export interface ItcMatchRow {
  id: string | null;
  vendorGstin: string;
  vendorName: string | null;
  /** Which of our registrations the supplier billed. */
  recipientGstin: string | null;
  docType: 'invoice' | 'credit_note' | 'debit_note';
  invoiceNo: string;
  invoiceDate: string;
  portalTaxPaise: Paise;
  booksTaxPaise: Paise;
  differencePaise: Paise;
  matchStatus: 'matched' | 'mismatch' | 'missing_in_books' | 'missing_in_portal';
  billId: string | null;
  billNo: string | null;
  itcAvailable: boolean;
  isReverseCharge: boolean;
  /** What was done in IMS. Null means no action, which the portal deems accepted. */
  imsAction: 'accepted' | 'rejected' | 'pending' | null;
  imsNote: string | null;
}

/**
 * Books against GSTR-2B.
 *
 * Since 2022 input credit is only claimable if the supplier actually filed the
 * invoice — what is in your books is irrelevant if it is not in your 2B. So
 * this runs the comparison in both directions: entries the portal has that you
 * do not, and bills you have that the portal does not. The second kind is the
 * expensive one, because you have probably already claimed the credit.
 *
 * A supplier who files late puts an old invoice into a later month's 2B, so a
 * portal line is matched against any bill dated up to the period's end, not
 * only this month's. Bills are listed as missing from the portal only for the
 * month itself.
 */
export async function itcReconciliation(
  ex: Executor,
  orgId: number,
  period: string,
): Promise<{ rows: ItcMatchRow[]; summary: Record<string, number> & { atRiskPaise: Paise } }> {
  // 'YYYY-MM' on the wire; the table stores the portal's own 'MMYYYY'.
  const [y, m] = period.split('-');
  const returnPeriod = `${m}${y}`;
  const from = `${period}-01`;
  const to = `${period}-${String(new Date(Number(y), Number(m), 0).getDate()).padStart(2, '0')}`;

  const portal = await ex
    .selectFrom('gstr2b_entries')
    .select([
      'id', 'vendor_gstin', 'vendor_name', 'recipient_gstin', 'doc_type', 'invoice_no', 'invoice_date',
      'taxable', 'cgst', 'sgst', 'igst', 'cess', 'itc_available', 'is_reverse_charge',
      'matched_bill_id', 'match_status', 'ims_action', 'ims_note',
    ])
    .where('org_id', '=', orgId)
    .where('return_period', '=', returnPeriod)
    .execute();

  const bills = await ex
    .selectFrom('bills as b')
    .innerJoin('contacts as c', 'c.id', 'b.vendor_id')
    .select([
      'b.id', 'b.internal_no', 'b.vendor_invoice_no', 'b.bill_date',
      'b.cgst', 'b.sgst', 'b.igst', 'b.cess', 'c.gstin', 'c.display_name',
    ])
    .where('b.org_id', '=', orgId)
    .where('b.status', 'not in', ['draft', 'void'])
    .where('b.bill_date', '<=', to)
    .execute();

  const tax = (r: { cgst: string; sgst: string; igst: string; cess: string }) =>
    toPaiseFromSql(r.cgst) + toPaiseFromSql(r.sgst) + toPaiseFromSql(r.igst) + toPaiseFromSql(r.cess);

  // Matched on the supplier's own invoice number, which is what the portal
  // keys on — our internal number means nothing to them.
  const billByKey = new Map(
    bills.map((b) => [`${b.gstin ?? ''}|${b.vendor_invoice_no.trim().toUpperCase()}`, b]),
  );
  const seen = new Set<string>();
  const rows: ItcMatchRow[] = [];

  for (const p of portal) {
    const key = `${p.vendor_gstin}|${p.invoice_no.trim().toUpperCase()}`;
    // A supplier's credit note is not a bill. It reverses credit, and is
    // recorded in the books as a vendor credit, which carries our number.
    const bill = p.doc_type === 'credit_note' ? undefined : billByKey.get(key);
    if (bill) seen.add(key);

    const portalTax = tax(p);
    const booksTax = bill ? tax(bill) : 0;

    rows.push({
      id: String(p.id),
      vendorGstin: p.vendor_gstin,
      vendorName: p.vendor_name,
      recipientGstin: p.recipient_gstin,
      docType: p.doc_type,
      invoiceNo: p.invoice_no,
      invoiceDate: String(p.invoice_date).slice(0, 10),
      portalTaxPaise: portalTax,
      booksTaxPaise: booksTax,
      differencePaise: portalTax - booksTax,
      matchStatus: !bill ? 'missing_in_books' : portalTax === booksTax ? 'matched' : 'mismatch',
      billId: bill ? String(bill.id) : null,
      billNo: bill ? bill.internal_no : null,
      itcAvailable: !!p.itc_available,
      isReverseCharge: !!p.is_reverse_charge,
      imsAction: p.ims_action,
      imsNote: p.ims_note,
    });
  }

  // The other direction: this month's bills that the supplier has not filed.
  for (const b of bills) {
    const date = String(b.bill_date).slice(0, 10);
    if (date < from) continue;
    const key = `${b.gstin ?? ''}|${b.vendor_invoice_no.trim().toUpperCase()}`;
    if (seen.has(key) || !b.gstin) continue;
    const booksTax = tax(b);
    if (booksTax === 0) continue;

    rows.push({
      id: null,
      vendorGstin: b.gstin,
      vendorName: b.display_name,
      recipientGstin: null,
      docType: 'invoice',
      invoiceNo: b.vendor_invoice_no,
      invoiceDate: date,
      portalTaxPaise: 0,
      booksTaxPaise: booksTax,
      differencePaise: -booksTax,
      matchStatus: 'missing_in_portal',
      billId: String(b.id),
      billNo: b.internal_no,
      itcAvailable: false,
      isReverseCharge: false,
      imsAction: null,
      imsNote: null,
    });
  }

  const count = (s: string) => rows.filter((r) => r.matchStatus === s).length;
  const fromPortal = rows.filter((r) => r.id !== null);

  return {
    rows: rows.sort((a, b) => Math.abs(b.differencePaise) - Math.abs(a.differencePaise)),
    summary: {
      total: rows.length,
      matched: count('matched'),
      mismatch: count('mismatch'),
      missing_in_books: count('missing_in_books'),
      missing_in_portal: count('missing_in_portal'),
      ims_accepted: fromPortal.filter((r) => r.imsAction === 'accepted').length,
      ims_rejected: fromPortal.filter((r) => r.imsAction === 'rejected').length,
      ims_pending: fromPortal.filter((r) => r.imsAction === 'pending').length,
      // No action is deemed acceptance when 2B is generated.
      ims_no_action: fromPortal.filter((r) => r.imsAction === null).length,
      // Credit claimed in the books that the portal does not support. This is
      // the number that turns into a demand with interest. A line rejected or
      // held pending in IMS is not in 2B either, so its credit is at risk too.
      atRiskPaise: rows
        .filter((r) => r.matchStatus === 'missing_in_portal' || r.matchStatus === 'mismatch'
          || (r.billId !== null && (r.imsAction === 'rejected' || r.imsAction === 'pending')))
        .reduce((t, r) => t + (r.imsAction === 'rejected' || r.imsAction === 'pending'
          ? r.booksTaxPaise
          : Math.max(0, -r.differencePaise)), 0),
    },
  };
}

// ── TDS ──────────────────────────────────────────────────────────────────────

export interface TdsRow {
  section: string;
  vendorName: string;
  vendorId: string;
  pan: string | null;
  billCount: number;
  taxablePaise: Paise;
  tdsPaise: Paise;
  ratePct: number;
}

/**
 * TDS deducted from suppliers, and TDS customers deducted from us.
 *
 * The two sides are opposite in every sense. What we deduct is a liability —
 * we are holding the government's money and must deposit it by the 7th. What
 * customers deduct from us is an asset: they have already paid it on our
 * behalf, and it comes back as credit against our own income tax.
 */
export async function tdsSummary(
  ex: Executor,
  orgId: number,
  from: string,
  to: string,
): Promise<{
  deducted: TdsRow[];
  deductedTotalPaise: Paise;
  withheldByCustomersPaise: Paise;
  withheldRows: { paymentId: string; number: string; date: string; customerName: string; tdsPaise: Paise; amountPaise: Paise }[];
}> {
  const { rows: deductedRows } = await sql<{
    section: string | null; vendor_id: number; name: string; pan: string | null;
    n: string; taxable: string; tds: string;
  }>`
    SELECT b.tds_section AS section, b.vendor_id, c.display_name AS name, c.pan,
           COUNT(*) AS n,
           COALESCE(SUM(b.subtotal), 0) AS taxable,
           COALESCE(SUM(b.tds_amount), 0) AS tds
      FROM bills b
      JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void')
       AND b.tds_amount > 0
       AND b.bill_date BETWEEN ${from} AND ${to}
     GROUP BY b.tds_section, b.vendor_id, c.display_name, c.pan
     ORDER BY tds DESC
  `.execute(ex);

  const deducted: TdsRow[] = deductedRows.map((r) => {
    const taxable = toPaiseFromSql(r.taxable);
    const tds = toPaiseFromSql(r.tds);
    return {
      section: r.section ?? '—',
      vendorName: r.name,
      vendorId: String(r.vendor_id),
      pan: r.pan,
      billCount: Number(r.n),
      taxablePaise: taxable,
      tdsPaise: tds,
      ratePct: taxable > 0 ? (tds / taxable) * 100 : 0,
    };
  });

  const withheld = await ex
    .selectFrom('payments as p')
    .innerJoin('contacts as c', 'c.id', 'p.contact_id')
    .select(['p.id', 'p.number', 'p.payment_date', 'p.tds_amount', 'p.amount', 'c.display_name'])
    .where('p.org_id', '=', orgId)
    .where('p.kind', '=', 'received')
    .where('p.status', '<>', 'void')
    .where('p.tds_amount', '>', '0')
    .where('p.payment_date', '>=', from)
    .where('p.payment_date', '<=', to)
    .orderBy('p.payment_date', 'desc')
    .execute();

  return {
    deducted,
    deductedTotalPaise: deducted.reduce((t, r) => t + r.tdsPaise, 0),
    withheldByCustomersPaise: withheld.reduce((t, r) => t + toPaiseFromSql(r.tds_amount), 0),
    withheldRows: withheld.map((r) => ({
      paymentId: String(r.id),
      number: r.number,
      date: String(r.payment_date).slice(0, 10),
      customerName: r.display_name,
      tdsPaise: toPaiseFromSql(r.tds_amount),
      amountPaise: toPaiseFromSql(r.amount),
    })),
  };
}
