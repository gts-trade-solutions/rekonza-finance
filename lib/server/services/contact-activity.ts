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
  | 'invoice' | 'payment_received' | 'estimate' | 'retainer_invoice' | 'sales_order' | 'challan' | 'recurring_invoice'
  | 'expense' | 'recurring_expense' | 'project' | 'journal' | 'bill' | 'credit_note'
  | 'payment_made' | 'purchase_order' | 'vendor_credit';

export interface ContactTxRow {
  kind: ContactTxKind;
  id: string;
  date: string | null;
  number: string;
  /** The reference, order number or memo: whatever the section shows beside the number. */
  ref: string | null;
  amountPaise: number;
  /** What is still owed, unused or open, where the kind has one. */
  balancePaise: number | null;
  status: string;
  /**
   * The options of the section's "Status:" filter this row falls under, in
   * Zoho's words lower-cased (an unpaid overdue invoice is both 'unpaid' and
   * 'overdue'). The filter lists are Zoho's own, the same for every customer.
   */
  filters: string[];
  /** A section's own columns: shipment date, frequency, category, debit… */
  extra?: Record<string, string | number | null>;
}

const ymd = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const LIMIT = 100;
const today = () => new Date().toISOString().slice(0, 10);

/** Every document of the contact, newest first, a hundred of each kind at most. */
export async function contactTransactions(
  ex: Executor, orgId: number, id: number, sides: { sales: boolean; purchases: boolean },
): Promise<ContactTxRow[]> {
  const out: ContactTxRow[] = [];
  const p = toPaiseFromSql;
  const now = today();
  if (sides.sales) {
    const [inv, pay, est, ret, so, ch, rec, exp, prj, jv, cn] = await Promise.all([
      ex.selectFrom('invoices').select(['id', 'number', 'invoice_date', 'due_date', 'order_number', 'total', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('invoice_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'mode', 'reference', 'amount', 'unapplied_amount', 'status'])
        .where('org_id', '=', orgId).where('contact_id', '=', id).where('kind', '=', 'received').orderBy('payment_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('estimates').select(['id', 'number', 'estimate_date', 'expiry_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('estimate_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('retainer_invoices').select(['id', 'number', 'retainer_date', 'amount', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('retainer_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('sales_orders').select(['id', 'number', 'order_date', 'expected_ship_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('order_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('delivery_challans').select(['id', 'number', 'challan_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('challan_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('recurring_invoices').select(['id', 'profile_name', 'frequency', 'next_run', 'last_generated_at', 'is_active', 'end_date', 'template'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).limit(LIMIT).execute(),
      // Expenses billed on to the customer (Zoho's billable expenses).
      ex.selectFrom('expenses as e').innerJoin('accounts as a', 'a.id', 'e.account_id').leftJoin('invoices as i', 'i.id', 'e.billed_invoice_id')
        .select(['e.id', 'e.number', 'e.expense_date', 'e.total', 'e.status', 'e.is_billable', 'e.billed_invoice_id', 'e.receipt_file_id', 'a.name as category', 'i.number as invoice_number'])
        .where('e.org_id', '=', orgId).where('e.billable_customer_id', '=', id).orderBy('e.expense_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('projects').select(['id', 'name', 'billing_method', 'rate', 'fixed_amount', 'status', 'created_at'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).limit(LIMIT).execute(),
      // Journals that name the customer on a line: the manual ones, as Zoho lists them.
      ex.selectFrom('journal_entries as je').innerJoin('journal_lines as jl', 'jl.entry_id', 'je.id')
        .select(['je.id', 'je.entry_no', 'je.entry_date', 'je.memo', sql<string>`SUM(jl.debit)`.as('debit'), sql<string>`SUM(jl.credit)`.as('credit')])
        .where('je.org_id', '=', orgId).where('jl.contact_id', '=', id).where('je.source_type', 'in', ['manual', 'recurring', 'write_off'])
        .groupBy(['je.id', 'je.entry_no', 'je.entry_date', 'je.memo']).orderBy('je.entry_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('credit_notes').select(['id', 'number', 'note_date', 'total', 'applied_amount', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', id).orderBy('note_date', 'desc').limit(LIMIT).execute(),
    ]);
    const SO: Record<string, string[]> = { open: ['confirmed'], partially_invoiced: ['partially invoiced'], invoiced: ['invoiced'], closed: ['closed'], cancelled: ['void'] };
    const DC: Record<string, string[]> = { open: ['open'], partially_invoiced: ['open'], invoiced: ['delivered'], returned: ['returned'], cancelled: [] };
    const RET: Record<string, string[]> = { draft: ['draft'], sent: ['sent'], paid: ['paid'], partially_applied: ['partially drawn'], applied: ['drawn'], void: ['void'] };
    out.push(
      ...inv.map((r) => {
        const balance = r.status === 'void' ? 0 : p(r.total) - p(r.amount_paid);
        const overdue = !['draft', 'void', 'paid'].includes(r.status) && balance > 0 && (r.status === 'overdue' || (ymd(r.due_date) ?? now) < now);
        const filters = r.status === 'draft' ? ['draft'] : r.status === 'void' ? ['void'] : r.status === 'paid' || balance <= 0 ? ['paid']
          : [...(r.status === 'partially_paid' ? ['partially paid'] : []), 'unpaid', ...(overdue ? ['overdue'] : [])];
        return { kind: 'invoice' as const, id: asId(r.id), date: ymd(r.invoice_date), number: r.number, ref: r.order_number, amountPaise: p(r.total), balancePaise: balance, status: overdue ? 'overdue' : r.status, filters };
      }),
      ...pay.map((r) => ({ kind: 'payment_received' as const, id: asId(r.id), date: ymd(r.payment_date), number: r.number, ref: r.reference, amountPaise: p(r.amount), balancePaise: p(r.unapplied_amount), status: r.status, filters: [], extra: { mode: r.mode } })),
      ...est.map((r) => {
        const expired = r.status === 'expired' || (r.status === 'sent' && (ymd(r.expiry_date) ?? '9999') < now);
        return { kind: 'estimate' as const, id: asId(r.id), date: ymd(r.estimate_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: expired ? 'expired' : r.status, filters: [expired ? 'expired' : r.status === 'converted' ? 'invoiced' : r.status] };
      }),
      ...ret.map((r) => ({ kind: 'retainer_invoice' as const, id: asId(r.id), date: ymd(r.retainer_date), number: r.number, ref: null, amountPaise: p(r.amount), balancePaise: r.status === 'void' ? 0 : p(r.amount) - p(r.amount_paid), status: r.status, filters: RET[r.status] ?? [] })),
      ...so.map((r) => {
        const overdue = ['open', 'partially_invoiced'].includes(r.status) && (ymd(r.expected_ship_date) ?? '9999') < now;
        return { kind: 'sales_order' as const, id: asId(r.id), date: ymd(r.order_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status, filters: [...(SO[r.status] ?? []), ...(overdue ? ['overdue'] : [])], extra: { shipmentDate: ymd(r.expected_ship_date) } };
      }),
      ...ch.map((r) => ({ kind: 'challan' as const, id: asId(r.id), date: ymd(r.challan_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status, filters: DC[r.status] ?? [] })),
      ...rec.map((r) => {
        const lines = (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as { qty?: number; ratePaise?: number }[] | null;
        const amount = (Array.isArray(lines) ? lines : []).reduce((t, l) => t + Math.round(Number(l.qty ?? 0) * Number(l.ratePaise ?? 0)), 0);
        const ended = r.end_date && String(r.end_date).slice(0, 10) < now;
        const status = ended ? 'expired' : r.is_active ? 'active' : 'stopped';
        return { kind: 'recurring_invoice' as const, id: asId(r.id), date: ymd(r.next_run), number: r.profile_name, ref: r.frequency, amountPaise: amount, balancePaise: null, status, filters: [status], extra: { frequency: r.frequency, lastDate: ymd(r.last_generated_at), nextDate: ymd(r.next_run) } };
      }),
      ...exp.map((r) => ({
        kind: 'expense' as const, id: asId(r.id), date: ymd(r.expense_date), number: r.number, ref: r.invoice_number, amountPaise: p(r.total), balancePaise: null,
        status: r.status === 'void' ? 'void' : r.billed_invoice_id ? 'invoiced' : r.is_billable ? 'unbilled' : 'non-billable',
        filters: [r.billed_invoice_id ? 'invoiced' : r.is_billable ? 'unbilled' : 'non-billable', ...(r.is_billable ? ['billable'] : []), r.receipt_file_id ? 'with receipts' : 'without receipts'],
        extra: { category: r.category, invoiceNumber: r.invoice_number, invoiceId: r.billed_invoice_id ? asId(r.billed_invoice_id) : null },
      })),
      ...prj.map((r) => ({
        kind: 'project' as const, id: asId(r.id), date: ymd(r.created_at), number: r.name, ref: r.billing_method, amountPaise: 0, balancePaise: null, status: r.status,
        filters: [r.status === 'active' ? 'active' : 'inactive'],
        extra: { billingMethod: r.billing_method, ratePaise: r.billing_method === 'fixed' ? p(r.fixed_amount) : p(r.rate) },
      })),
      ...jv.map((r) => ({ kind: 'journal' as const, id: asId(r.id), date: ymd(r.entry_date), number: String(r.entry_no), ref: r.memo, amountPaise: Math.max(p(r.debit), p(r.credit)), balancePaise: null, status: 'published', filters: [], extra: { debitPaise: p(r.debit), creditPaise: p(r.credit) } })),
      ...cn.map((r) => ({
        kind: 'credit_note' as const, id: asId(r.id), date: ymd(r.note_date), number: r.number, ref: null, amountPaise: p(r.total),
        balancePaise: r.status === 'open' ? p(r.total) - p(r.applied_amount) : 0, status: r.status, filters: [r.status === 'void' ? 'void' : r.status === 'open' ? 'open' : 'closed'],
      })),
    );
  }
  if (sides.purchases) {
    const [bills, pay, po, vc, exp] = await Promise.all([
      ex.selectFrom('bills').select(['id', 'internal_no', 'vendor_invoice_no', 'bill_date', 'due_date', 'total', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('bill_date', 'desc').orderBy('id', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'mode', 'reference', 'amount', 'unapplied_amount', 'status'])
        .where('org_id', '=', orgId).where('contact_id', '=', id).where('kind', '=', 'made').orderBy('payment_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('purchase_orders').select(['id', 'number', 'order_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('order_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('vendor_credits').select(['id', 'number', 'credit_date', 'total', 'applied_amount', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('credit_date', 'desc').limit(LIMIT).execute(),
      ex.selectFrom('expenses').select(['id', 'number', 'expense_date', 'reference', 'total', 'status'])
        .where('org_id', '=', orgId).where('vendor_id', '=', id).orderBy('expense_date', 'desc').limit(LIMIT).execute(),
    ]);
    out.push(
      ...bills.map((r) => {
        const balance = r.status === 'void' ? 0 : p(r.total) - p(r.amount_paid);
        const overdue = !['draft', 'void', 'paid'].includes(r.status) && balance > 0 && (ymd(r.due_date) ?? now) < now;
        return {
          kind: 'bill' as const, id: asId(r.id), date: ymd(r.bill_date), number: r.vendor_invoice_no || r.internal_no, ref: r.internal_no, amountPaise: p(r.total), balancePaise: balance, status: overdue ? 'overdue' : r.status,
          filters: r.status === 'void' ? ['void'] : balance <= 0 ? ['paid'] : ['open', 'unpaid', ...(r.status === 'partially_paid' ? ['partially paid'] : []), ...(overdue ? ['overdue'] : [])],
        };
      }),
      ...pay.map((r) => ({ kind: 'payment_made' as const, id: asId(r.id), date: ymd(r.payment_date), number: r.number, ref: r.reference, amountPaise: p(r.amount), balancePaise: p(r.unapplied_amount), status: r.status, filters: [], extra: { mode: r.mode } })),
      ...po.map((r) => ({ kind: 'purchase_order' as const, id: asId(r.id), date: ymd(r.order_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: null, status: r.status, filters: [r.status] })),
      ...vc.map((r) => ({ kind: 'vendor_credit' as const, id: asId(r.id), date: ymd(r.credit_date), number: r.number, ref: null, amountPaise: p(r.total), balancePaise: r.status === 'open' ? p(r.total) - p(r.applied_amount) : 0, status: r.status, filters: [r.status === 'void' ? 'void' : r.status === 'open' ? 'open' : 'closed'] })),
      ...exp.map((r) => ({ kind: 'expense' as const, id: asId(r.id), date: ymd(r.expense_date), number: r.number, ref: r.reference, amountPaise: p(r.total), balancePaise: null, status: r.status, filters: [] })),
    );
  }
  return out;
}

export interface IncomeMonth { month: string; amountPaise: number }

/** Zoho's periods for the chart: This Fiscal Year, Previous Fiscal Year, Last 12 Months, Last 6 Months. */
export type IncomePeriod = 'this_fy' | 'prev_fy' | 'last_12' | 'last_6';

/** The months a period covers: the last six or twelve to this one, or a financial year from April. */
export function incomeMonths(period: IncomePeriod, today: string): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  let startY: number, startM: number, count: number;
  if (period === 'last_6' || period === 'last_12') {
    count = period === 'last_6' ? 6 : 12;
    const s = new Date(Date.UTC(y, m - 1 - (count - 1), 1));
    startY = s.getUTCFullYear(); startM = s.getUTCMonth() + 1;
  } else {
    // The financial year runs April to March: the one today falls in, or the one before.
    const fyStart = m >= 4 ? y : y - 1;
    startY = period === 'this_fy' ? fyStart : fyStart - 1; startM = 4; count = 12;
  }
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(startY, startM - 1 + i, 1)).toISOString().slice(0, 7));
}

/**
 * Zoho's "Income" chart on a customer (or, for a vendor, what was bought):
 * month by month over the period, on accrual (what was invoiced, before tax)
 * or cash (what was received).
 */
export async function contactIncome(
  ex: Executor, orgId: number, id: number, side: 'customer' | 'vendor', period: IncomePeriod | 6 | 12, basis: 'accrual' | 'cash', today: string,
): Promise<IncomeMonth[]> {
  const keys = incomeMonths(period === 6 ? 'last_6' : period === 12 ? 'last_12' : period, today);
  const from = `${keys[0]}-01`;
  const last = keys[keys.length - 1];
  const [ly, lm] = last.split('-').map(Number);
  const to = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);
  let rows: { m: string; v: string }[];
  if (basis === 'cash') {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(payment_date, '%Y-%m') AS m, SUM(amount) AS v FROM payments
       WHERE org_id = ${orgId} AND contact_id = ${id} AND kind = ${side === 'customer' ? 'received' : 'made'} AND status <> 'void' AND payment_date >= ${from} AND payment_date <= ${to}
       GROUP BY m`.execute(ex));
  } else if (side === 'customer') {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS m, SUM(subtotal) AS v FROM invoices
       WHERE org_id = ${orgId} AND customer_id = ${id} AND status NOT IN ('draft', 'void') AND invoice_date >= ${from} AND invoice_date <= ${to}
       GROUP BY m`.execute(ex));
  } else {
    ({ rows } = await sql<{ m: string; v: string }>`
      SELECT DATE_FORMAT(bill_date, '%Y-%m') AS m, SUM(subtotal) AS v FROM bills
       WHERE org_id = ${orgId} AND vendor_id = ${id} AND status NOT IN ('draft', 'void') AND bill_date >= ${from} AND bill_date <= ${to}
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
