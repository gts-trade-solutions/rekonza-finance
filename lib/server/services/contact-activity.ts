import { sql } from 'kysely';
import type { Executor } from '@/lib/server/db';
import { asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';

// ─────────────────────────────────────────────────────────────────────────────
// A customer's or vendor's record, as Zoho shows it beyond the master: the
// documents under the Transactions tab (one section per kind, each with its
// status), the Income chart on the Overview, and the Mails tab.
// ─────────────────────────────────────────────────────────────────────────────

export type ContactTxKind =
  | 'invoice' | 'payment_received' | 'estimate' | 'sales_order' | 'challan' | 'credit_note' | 'recurring_invoice' | 'project'
  | 'bill' | 'payment_made' | 'purchase_order' | 'vendor_credit' | 'expense';

export interface ContactTxRow {
  kind: ContactTxKind;
  id: string;
  date: string | null;
  number: string;
  /** Order number, reference, payment mode or frequency: the section's third column. */
  ref: string | null;
  amountPaise: number;
  /** What is still owed or unused, where the kind has one. */
  balancePaise: number | null;
  status: string;
}

const ymd = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const LIMIT = 100;

/** Every document of the contact, newest first, a hundred of each kind at most. */
export async function contactTransactions(
  ex: Executor, orgId: number, id: number, sides: { sales: boolean; purchases: boolean },
): Promise<ContactTxRow[]> {
  const out: ContactTxRow[] = [];
  const p = toPaiseFromSql;
  if (sides.sales) {
    const [inv, pay, est, so, ch, cn, rec, prj] = await Promise.all([
      ex.selectFrom('invoices').select(['id', 'number', 'invoice_date', 'order_number', 'total', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('invoice_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'mode', 'amount', 'unapplied_amount', 'status'])
        .where('org_id', '=', orgId).where('contact_id', '=', id).where('kind', '=', 'received').orderBy('payment_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('estimates').select(['id', 'number', 'estimate_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('estimate_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('sales_orders').select(['id', 'number', 'order_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('order_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('delivery_challans').select(['id', 'number', 'challan_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('challan_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('credit_notes').select(['id', 'number', 'note_date', 'total', 'applied_amount', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('note_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('recurring_invoices').select(['id', 'profile_name', 'frequency', 'next_run', 'is_active', 'end_date', 'template'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).limit(LIMIT).execute(),
      ex.selectFrom('projects').select(['id', 'name', 'billing_method', 'status', 'created_at'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).limit(LIMIT).execute(),
    ]);
    out.push(
      ...inv.map((r) => ({ kind: 'invoice' as const, id: asId(r.id), date: ymd(r.invoice_date), number: r.number, ref: r.order_number, amountPaise: p(r.total), balancePaise: r.status === 'void' ? 0 : p(r.total) - p(r.amount_paid), status: r.status })),
      ...pay.map((r) => ({ kind: 'payment_received' as const, id: asId(r.id), date: ymd(r.payment_date), number: r.number, ref: r.mode, amountPaise: p(r.amount), balancePaise: p(r.unapplied_amount), status: r.status })),
      ...est.map((r) => ({ kind: 'estimate' as const, id: asId(r.id), date: ymd(r.estimate_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status })),
      ...so.map((r) => ({ kind: 'sales_order' as const, id: asId(r.id), date: ymd(r.order_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status })),
      ...ch.map((r) => ({ kind: 'challan' as const, id: asId(r.id), date: ymd(r.challan_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status })),
      ...cn.map((r) => ({ kind: 'credit_note' as const, id: asId(r.id), date: ymd(r.note_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: r.status === 'open' ? p(r.total) - p(r.applied_amount) : 0, status: r.status })),
      ...rec.map((r) => {
        const lines = (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as { qty?: number; ratePaise?: number }[] | null;
        const amount = (Array.isArray(lines) ? lines : []).reduce((t, l) => t + Math.round(Number(l.qty ?? 0) * Number(l.ratePaise ?? 0)), 0);
        const ended = r.end_date && String(r.end_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
        return { kind: 'recurring_invoice' as const, id: asId(r.id), date: ymd(r.next_run), number: r.profile_name, ref: r.frequency, amountPaise: amount, balancePaise: null, status: ended ? 'expired' : r.is_active ? 'active' : 'stopped' };
      }),
      ...prj.map((r) => ({ kind: 'project' as const, id: asId(r.id), date: ymd(r.created_at), number: r.name, ref: r.billing_method, amountPaise: 0, balancePaise: null, status: r.status })),
    );
  }
  if (sides.purchases) {
    const [bills, pay, po, vc, exp] = await Promise.all([
      ex.selectFrom('bills').select(['id', 'internal_no', 'vendor_invoice_no', 'bill_date', 'total', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('bill_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'mode', 'amount', 'unapplied_amount', 'status'])
        .where('org_id', '=', orgId).where('contact_id', '=', id).where('kind', '=', 'made').orderBy('payment_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('purchase_orders').select(['id', 'number', 'order_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('order_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('vendor_credits').select(['id', 'number', 'credit_date', 'total', 'applied_amount', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('credit_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('expenses').select(['id', 'number', 'expense_date', 'reference', 'total', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('expense_date', 'desc').limit(LIMIT).execute(),
    ]);
    out.push(
      ...bills.map((r) => ({ kind: 'bill' as const, id: asId(r.id), date: ymd(r.bill_date), number: r.vendor_invoice_no || r.internal_no, ref: r.internal_no, amountPaise: p(r.total), balancePaise: r.status === 'void' ? 0 : p(r.total) - p(r.amount_paid), status: r.status })),
      ...pay.map((r) => ({ kind: 'payment_made' as const, id: asId(r.id), date: ymd(r.payment_date), number: r.number, ref: r.mode, amountPaise: p(r.amount), balancePaise: p(r.unapplied_amount), status: r.status })),
      ...po.map((r) => ({ kind: 'purchase_order' as const, id: asId(r.id), date: ymd(r.order_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status })),
      ...vc.map((r) => ({ kind: 'vendor_credit' as const, id: asId(r.id), date: ymd(r.credit_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: r.status === 'open' ? p(r.total) - p(r.applied_amount) : 0, status: r.status })),
      ...exp.map((r) => ({ kind: 'expense' as const, id: asId(r.id), date: ymd(r.expense_date), number: r.number, ref: r.reference, amountPaise: p(r.total), balancePaise: null, status: r.status })),
    );
  }
  return out;
}

export interface IncomeMonth { month: string; amountPaise: number }

/**
 * Zoho's "Income" chart on a customer (or, for a vendor, what was bought):
 * month by month over the last `months`, on accrual (what was invoiced,
 * before tax) or cash (what was received).
 */
export async function contactIncome(
  ex: Executor, orgId: number, id: number, side: 'customer' | 'vendor', months: number, basis: 'accrual' | 'cash', today: string,
): Promise<IncomeMonth[]> {
  const end = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const from = start.toISOString().slice(0, 10);
  const keys: string[] = [];
  for (let d = new Date(start); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) keys.push(d.toISOString().slice(0, 7));
  let rows: { m: string; v: string }[];
  if (basis === 'cash') {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(payment_date, '%Y-%m') AS m, SUM(amount) AS v FROM payments
       WHERE org_id = ${orgId} AND contact_id = ${id} AND kind = ${side === 'customer' ? 'received' : 'made'} AND status <> 'void' AND payment_date >= ${from}
       GROUP BY m`.execute(ex));
  } else if (side === 'customer') {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS m, SUM(subtotal) AS v FROM invoices
       WHERE org_id = ${orgId} AND customer_id = ${id} AND status NOT IN ('draft', 'void') AND invoice_date >= ${from}
       GROUP BY m`.execute(ex));
  } else {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(bill_date, '%Y-%m') AS m, SUM(subtotal) AS v FROM bills
       WHERE org_id = ${orgId} AND vendor_id = ${id} AND status NOT IN ('draft', 'void') AND bill_date >= ${from}
       GROUP BY m`.execute(ex));
  }
  const by = new Map(rows.map((r) => [r.m, toPaiseFromSql(r.v)]));
  return keys.map((k) => ({ month: k, amountPaise: by.get(k) ?? 0 }));
}

export interface ContactMail { id: string; at: string; to: string; subject: string; status: string; docType: string | null; docId: string | null }

/** The emails sent to the contact (its address or a contact person's), or about one of its invoices. */
export async function contactMails(ex: Executor, orgId: number, id: number): Promise<ContactMail[]> {
  const [c, persons, inv] = await Promise.all([
    ex.selectFrom('contacts').select('email').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst(),
    ex.selectFrom('contact_persons').select('email').where('contact_id', '=', id).where('org_id', '=', orgId).execute(),
    ex.selectFrom('invoices').select('id').where('customer_id', '=', id).where('org_id', '=', orgId).execute(),
  ]);
  const emails = [c?.email, ...persons.map((x) => x.email)].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const invoiceIds = inv.map((x) => x.id);
  if (!emails.length && !invoiceIds.length) return [];
  const rows = await ex.selectFrom('email_log')
    .select(['id', 'created_at', 'to_address', 'subject', 'status', 'doc_type', 'doc_id'])
    .where('org_id', '=', orgId)
    .where((eb) => eb.or([
      ...(emails.length ? [eb(sql`LOWER(to_address)`, 'in', emails)] : []),
      ...(invoiceIds.length ? [eb.and([eb('doc_type', '=', 'invoice'), eb('doc_id', 'in', invoiceIds)])] : []),
    ]))
    .orderBy('created_at', 'desc').limit(200).execute();
  return rows.map((r) => ({
    id: asId(r.id), at: new Date(r.created_at).toISOString(), to: r.to_address, subject: r.subject, status: r.status,
    docType: r.doc_type, docId: r.doc_id ? asId(r.doc_id) : null,
  }));
}
