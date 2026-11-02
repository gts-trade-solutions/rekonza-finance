import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Export data: any part of the books as rows, for CSV, Excel or JSON — and the
// whole book as one JSON backup, as Zoho Books' "Export data" and "Backup"
// give.
//
// Where an import exists for a module (customers and vendors, items, accounts,
// journals, invoices, bills), the export uses that import's columns first, so
// a file taken out of one book goes straight into another; the extra columns
// after them (status, tax, totals) are read by people and skipped by the
// import. The rest export the columns a person would ask for.
//
// Every export is the user's own book, filtered by what their role may see;
// nothing sealed (bank account numbers, PAN of employees) is unsealed here.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';

export type Row = Record<string, string | number | null>;

export interface ExportModule {
  key: string;
  label: string;
  /** Who may export it: the module whose view right it needs. */
  permission: string;
  /** Transactions are filtered by date; masters are not. */
  dated: boolean;
  /** The import that reads this export back, if any. */
  importKind?: string;
  rows: (ex: Executor, orgId: number, range: { from: string; to: string }) => Promise<Row[]>;
}

const rs = (v: unknown) => toPaiseFromSql(String(v ?? '0')) / 100;
const day = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const daysOf = (terms: string | null) => (terms === 'due_on_receipt' ? 0 : terms && /^net_(\d+)$/.test(terms) ? Number(terms.slice(4)) : null);

export const EXPORT_MODULES: ExportModule[] = [
  {
    key: 'contacts', label: 'Customers and vendors', permission: 'sales', dated: false, importKind: 'contacts',
    rows: async (ex, orgId) => {
      const r = await ex.selectFrom('contacts').selectAll().where('org_id', '=', orgId).where('erased_at', 'is', null).orderBy('display_name').execute();
      return r.map((c) => ({
        type: c.kind, name: c.display_name, legal_name: c.legal_name, gstin: c.gstin, pan: c.pan, state: c.state_code,
        email: c.email, phone: c.phone, address: c.billing_address, city: c.billing_city, pincode: c.billing_pincode,
        credit_days: daysOf(c.payment_terms), msme_udyam_no: c.msme_udyam_no,
        gst_treatment: c.gst_treatment, credit_limit: c.credit_limit === null ? null : rs(c.credit_limit),
        shipping_address: c.shipping_address, archived: c.is_archived ? 'yes' : 'no',
      }));
    },
  },
  {
    key: 'items', label: 'Items', permission: 'sales', dated: false, importKind: 'items',
    rows: async (ex, orgId) => {
      const r = await ex.selectFrom('items').selectAll().where('org_id', '=', orgId).orderBy('name').execute();
      return r.map((i) => ({
        name: i.name, kind: i.kind, sku: i.sku, hsn_sac: i.hsn_sac, unit: i.uqc, sale_price: rs(i.sale_price),
        purchase_price: rs(i.purchase_price), gst_rate: Number(i.gst_rate_pct), track_stock: i.track_inventory ? 'yes' : 'no',
        description: i.description, tax_preference: i.tax_pref, reorder_level: i.reorder_level === null ? null : Number(i.reorder_level),
        archived: i.is_archived ? 'yes' : 'no',
      }));
    },
  },
  {
    key: 'accounts', label: 'Chart of accounts', permission: 'accountant', dated: false, importKind: 'accounts',
    rows: async (ex, orgId) => {
      const r = await ex.selectFrom('accounts').select(['code', 'name', 'type', 'subtype', 'description', 'is_active', 'is_system'])
        .where('org_id', '=', orgId).orderBy('code').execute();
      return r.map((a) => ({ code: a.code, name: a.name, type: a.type, subtype: a.subtype, description: a.description, active: a.is_active ? 'yes' : 'no', system: a.is_system ? 'yes' : 'no' }));
    },
  },
  {
    key: 'invoices', label: 'Invoices (line by line)', permission: 'sales', dated: true, importKind: 'invoices',
    rows: async (ex, orgId, { from, to }) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT i.number, i.invoice_date, i.due_date, c.display_name AS customer, it.name AS item, l.description, l.hsn_sac,
               l.qty, l.rate, l.discount_pct, l.gst_rate_pct, i.status, i.doc_kind, i.place_of_supply,
               l.taxable, l.cgst, l.sgst, l.igst, l.cess, i.total
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
          JOIN invoice_lines l ON l.invoice_id = i.id LEFT JOIN items it ON it.id = l.item_id
         WHERE i.org_id = ${orgId} AND i.invoice_date BETWEEN ${from} AND ${to}
         ORDER BY i.invoice_date, i.id, l.line_no
      `.execute(ex);
      return rows.map((r) => ({
        invoice_no: String(r.number), date: day(r.invoice_date), due_date: day(r.due_date), customer: String(r.customer),
        item: (r.item as string) ?? null, description: (r.description as string) ?? null, hsn_sac: (r.hsn_sac as string) ?? null,
        qty: Number(r.qty), rate: rs(r.rate), discount_pct: Number(r.discount_pct), gst_rate: Number(r.gst_rate_pct),
        status: String(r.status), document: r.doc_kind === 'debit_note' ? 'debit note' : 'invoice', place_of_supply: String(r.place_of_supply),
        taxable: rs(r.taxable), cgst: rs(r.cgst), sgst: rs(r.sgst), igst: rs(r.igst), cess: rs(r.cess), invoice_total: rs(r.total),
      }));
    },
  },
  {
    key: 'bills', label: 'Bills (line by line)', permission: 'purchases', dated: true, importKind: 'bills',
    rows: async (ex, orgId, { from, to }) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT b.vendor_invoice_no, b.internal_no, b.bill_date, b.due_date, c.display_name AS vendor, it.name AS item, l.description,
               l.hsn_sac, l.qty, l.rate, l.gst_rate_pct, l.itc_eligibility, b.status, b.is_rcm, l.taxable, l.cgst, l.sgst, l.igst, l.cess, b.total
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
          JOIN bill_lines l ON l.bill_id = b.id LEFT JOIN items it ON it.id = l.item_id
         WHERE b.org_id = ${orgId} AND b.bill_date BETWEEN ${from} AND ${to}
         ORDER BY b.bill_date, b.id, l.line_no
      `.execute(ex);
      return rows.map((r) => ({
        bill_no: String(r.vendor_invoice_no), date: day(r.bill_date), due_date: day(r.due_date), vendor: String(r.vendor),
        item: (r.item as string) ?? null, description: (r.description as string) ?? null, hsn_sac: (r.hsn_sac as string) ?? null,
        qty: Number(r.qty), rate: rs(r.rate), gst_rate: Number(r.gst_rate_pct),
        our_number: String(r.internal_no), status: String(r.status), reverse_charge: Number(r.is_rcm) ? 'yes' : 'no', itc: String(r.itc_eligibility),
        taxable: rs(r.taxable), cgst: rs(r.cgst), sgst: rs(r.sgst), igst: rs(r.igst), cess: rs(r.cess), bill_total: rs(r.total),
      }));
    },
  },
  {
    key: 'journals', label: 'Manual journals', permission: 'accountant', dated: true, importKind: 'journals',
    rows: async (ex, orgId, { from, to }) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT e.entry_no, e.entry_date, a.code, jl.debit, jl.credit, c.display_name AS party, COALESCE(jl.description, e.memo) AS narration
          FROM journal_entries e JOIN journal_lines jl ON jl.entry_id = e.id JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN contacts c ON c.id = jl.contact_id
         WHERE e.org_id = ${orgId} AND e.source_type = 'manual' AND e.entry_date BETWEEN ${from} AND ${to}
         ORDER BY e.entry_date, e.entry_no, jl.id
      `.execute(ex);
      return rows.map((r) => ({
        voucher_no: `JV-${r.entry_no}`, date: day(r.entry_date), account_code: String(r.code),
        debit: rs(r.debit) || null, credit: rs(r.credit) || null, party: (r.party as string) ?? null, narration: (r.narration as string) ?? null,
      }));
    },
  },
  {
    key: 'journal-lines', label: 'All ledger entries', permission: 'accountant', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT e.entry_no, e.entry_date, e.source_type, e.memo, a.code, a.name, jl.debit, jl.credit, c.display_name AS party, jl.description
          FROM journal_entries e JOIN journal_lines jl ON jl.entry_id = e.id JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN contacts c ON c.id = jl.contact_id
         WHERE e.org_id = ${orgId} AND e.entry_date BETWEEN ${from} AND ${to}
         ORDER BY e.entry_date, e.entry_no, jl.id
      `.execute(ex);
      return rows.map((r) => ({
        entry_no: Number(r.entry_no), date: day(r.entry_date), source: String(r.source_type), memo: (r.memo as string) ?? null,
        account_code: String(r.code), account: String(r.name), debit: rs(r.debit), credit: rs(r.credit),
        party: (r.party as string) ?? null, description: (r.description as string) ?? null,
      }));
    },
  },
  {
    key: 'credit-notes', label: 'Credit notes', permission: 'sales', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('credit_notes as n').innerJoin('contacts as c', 'c.id', 'n.customer_id')
        .leftJoin('invoices as i', 'i.id', 'n.against_invoice_id')
        .select(['n.number', 'n.note_date', 'c.display_name', 'i.number as against', 'n.reason', 'n.status', 'n.subtotal', 'n.cgst', 'n.sgst', 'n.igst', 'n.cess', 'n.total', 'n.applied_amount'])
        .where('n.org_id', '=', orgId).where('n.note_date', '>=', from).where('n.note_date', '<=', to).orderBy('n.note_date').execute();
      return r.map((n) => ({ number: n.number, date: day(n.note_date), customer: n.display_name, against_invoice: n.against, reason: n.reason, status: n.status, taxable: rs(n.subtotal), cgst: rs(n.cgst), sgst: rs(n.sgst), igst: rs(n.igst), cess: rs(n.cess), total: rs(n.total), applied: rs(n.applied_amount) }));
    },
  },
  {
    key: 'estimates', label: 'Estimates', permission: 'sales', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('estimates as e').innerJoin('contacts as c', 'c.id', 'e.customer_id')
        .select(['e.number', 'e.estimate_date', 'e.expiry_date', 'c.display_name', 'e.status', 'e.subtotal', 'e.cgst', 'e.sgst', 'e.igst', 'e.total'])
        .where('e.org_id', '=', orgId).where('e.estimate_date', '>=', from).where('e.estimate_date', '<=', to).orderBy('e.estimate_date').execute();
      return r.map((e) => ({ number: e.number, date: day(e.estimate_date), expiry_date: day(e.expiry_date), customer: e.display_name, status: e.status, taxable: rs(e.subtotal), cgst: rs(e.cgst), sgst: rs(e.sgst), igst: rs(e.igst), total: rs(e.total) }));
    },
  },
  {
    key: 'sales-orders', label: 'Sales orders', permission: 'sales', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('sales_orders as o').innerJoin('contacts as c', 'c.id', 'o.customer_id')
        .select(['o.number', 'o.order_date', 'o.expected_ship_date', 'c.display_name', 'o.status', 'o.subtotal', 'o.total', 'o.invoiced_amount'])
        .where('o.org_id', '=', orgId).where('o.order_date', '>=', from).where('o.order_date', '<=', to).orderBy('o.order_date').execute();
      return r.map((o) => ({ number: o.number, date: day(o.order_date), expected_ship_date: day(o.expected_ship_date), customer: o.display_name, status: o.status, taxable: rs(o.subtotal), total: rs(o.total), invoiced: rs(o.invoiced_amount) }));
    },
  },
  {
    key: 'purchase-orders', label: 'Purchase orders', permission: 'purchases', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('purchase_orders as o').innerJoin('contacts as c', 'c.id', 'o.vendor_id')
        .select(['o.number', 'o.order_date', 'o.expected_date', 'c.display_name', 'o.status', 'o.subtotal', 'o.total', 'o.billed_amount'])
        .where('o.org_id', '=', orgId).where('o.order_date', '>=', from).where('o.order_date', '<=', to).orderBy('o.order_date').execute();
      return r.map((o) => ({ number: o.number, date: day(o.order_date), expected_date: day(o.expected_date), vendor: o.display_name, status: o.status, taxable: rs(o.subtotal), total: rs(o.total), billed: rs(o.billed_amount) }));
    },
  },
  {
    key: 'expenses', label: 'Expenses', permission: 'purchases', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('expenses as e').innerJoin('accounts as a', 'a.id', 'e.account_id')
        .leftJoin('contacts as c', 'c.id', 'e.vendor_id').leftJoin('bank_accounts as b', 'b.id', 'e.paid_through_bank_account_id')
        .select(['e.number', 'e.expense_date', 'a.code', 'a.name as account', 'c.display_name as vendor', 'b.name as paid_through', 'e.amount', 'e.gst_rate_pct', 'e.cgst', 'e.sgst', 'e.igst', 'e.total', 'e.itc_eligibility', 'e.reference', 'e.notes', 'e.status'])
        .where('e.org_id', '=', orgId).where('e.expense_date', '>=', from).where('e.expense_date', '<=', to).orderBy('e.expense_date').execute();
      return r.map((e) => ({ number: e.number, date: day(e.expense_date), account_code: e.code, account: e.account, vendor: e.vendor, paid_through: e.paid_through, amount: rs(e.amount), gst_rate: Number(e.gst_rate_pct), cgst: rs(e.cgst), sgst: rs(e.sgst), igst: rs(e.igst), total: rs(e.total), itc: e.itc_eligibility, reference: e.reference, notes: e.notes, status: e.status }));
    },
  },
  {
    key: 'payments-received', label: 'Payments received', permission: 'sales', dated: true,
    rows: async (ex, orgId, range) => payments(ex, orgId, range, 'received'),
  },
  {
    key: 'payments-made', label: 'Payments made', permission: 'purchases', dated: true,
    rows: async (ex, orgId, range) => payments(ex, orgId, range, 'made'),
  },
  {
    key: 'vendor-credits', label: 'Vendor credits', permission: 'purchases', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('vendor_credits as v').innerJoin('contacts as c', 'c.id', 'v.vendor_id')
        .select(['v.number', 'v.credit_date', 'c.display_name', 'v.reason', 'v.status', 'v.total', 'v.applied_amount'])
        .where('v.org_id', '=', orgId).where('v.credit_date', '>=', from).where('v.credit_date', '<=', to).orderBy('v.credit_date').execute();
      return r.map((v) => ({ number: v.number, date: day(v.credit_date), vendor: v.display_name, reason: v.reason, status: v.status, total: rs(v.total), applied: rs(v.applied_amount) }));
    },
  },
  {
    key: 'bank-transactions', label: 'Bank statement lines', permission: 'banking', dated: true,
    rows: async (ex, orgId, { from, to }) => {
      const r = await ex.selectFrom('bank_transactions as t').innerJoin('bank_accounts as b', 'b.id', 't.bank_account_id')
        .select(['t.txn_date', 'b.name as account', 't.narration', 't.reference', 't.deposit', 't.withdrawal', 't.running_balance', 't.status', 't.matched_type'])
        .where('t.org_id', '=', orgId).where('t.txn_date', '>=', from).where('t.txn_date', '<=', to).orderBy('t.txn_date').orderBy('t.id').execute();
      return r.map((t) => ({ date: day(t.txn_date), account: t.account, narration: t.narration, reference: t.reference, deposit: rs(t.deposit) || null, withdrawal: rs(t.withdrawal) || null, balance: t.running_balance === null ? null : rs(t.running_balance), status: t.status, matched_to: t.matched_type }));
    },
  },
];

async function payments(ex: Executor, orgId: number, { from, to }: { from: string; to: string }, kind: 'received' | 'made'): Promise<Row[]> {
  const r = await ex.selectFrom('payments as p').leftJoin('contacts as c', 'c.id', 'p.contact_id').leftJoin('bank_accounts as b', 'b.id', 'p.bank_account_id')
    .select(['p.number', 'p.payment_date', 'c.display_name', 'p.mode', 'b.name as account', 'p.reference', 'p.amount', 'p.tds_amount', 'p.bank_charges', 'p.unapplied_amount', 'p.status', 'p.notes'])
    .where('p.org_id', '=', orgId).where('p.kind', '=', kind).where('p.payment_date', '>=', from).where('p.payment_date', '<=', to)
    .orderBy('p.payment_date').execute();
  return r.map((p) => ({
    number: p.number, date: day(p.payment_date), [kind === 'received' ? 'customer' : 'vendor']: p.display_name, mode: p.mode,
    account: p.account, reference: p.reference, amount: rs(p.amount), tds: rs(p.tds_amount), bank_charges: rs(p.bank_charges),
    unapplied: rs(p.unapplied_amount), status: p.status, notes: p.notes,
  }));
}

export const exportModule = (key: string) => EXPORT_MODULES.find((m) => m.key === key);
