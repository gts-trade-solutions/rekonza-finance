import { z } from 'zod';
import { NextResponse } from 'next/server';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, query, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { trialBalance } from '@/lib/server/reports/statements';
import { stockPosition } from '@/lib/server/reports/stock';

// Flat tables for Power BI, Excel Power Query, Tableau or Google Sheets.
//
// Each dataset is one table of rows, amounts in rupees, dates as yyyy-mm-dd —
// the shape a BI tool reads without transforming. Read with an API key
// (Settings → Developer): in Power BI, Get data → Web → Advanced, this URL,
// and a header "Authorization: Bearer rk_live_…". ?format=csv returns CSV.
// The key's role decides what it may read, as for every API call.

const DATASETS = {
  'journal-lines': 'reports.financial',
  'trial-balance': 'reports.financial',
  invoices: 'sales',
  bills: 'purchases',
  payments: 'reports.financial',
  contacts: 'sales',
  stock: 'inventory',
} as const;
type Dataset = keyof typeof DATASETS;

const r = (v: string | null | undefined) => (v == null ? 0 : toPaiseFromSql(v) / 100);
const d = (v: unknown) => (v == null ? null : String(v).slice(0, 10));

async function rows(orgId: number, ds: Dataset, from: string, to: string): Promise<Record<string, unknown>[]> {
  switch (ds) {
    case 'journal-lines': {
      const { rows: list } = await sql<{ entry_no: number; entry_date: string; source_type: string; memo: string | null; code: string; name: string; type: string; debit: string; credit: string; contact: string | null; cost_centre: string | null }>`
        SELECT e.entry_no, jl.entry_date, e.source_type, e.memo, a.code, a.name, a.type, jl.debit, jl.credit,
               c.display_name AS contact, cc.name AS cost_centre
          FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN contacts c ON c.id = jl.contact_id LEFT JOIN cost_centres cc ON cc.id = jl.cost_centre_id
         WHERE jl.org_id = ${orgId} AND jl.entry_date BETWEEN ${from} AND ${to}
         ORDER BY jl.entry_date, e.entry_no, jl.id LIMIT 200000`.execute(db);
      return list.map((x) => ({ entry_no: x.entry_no, date: d(x.entry_date), source: x.source_type, memo: x.memo, account_code: x.code, account: x.name, account_type: x.type, debit: r(x.debit), credit: r(x.credit), party: x.contact, cost_centre: x.cost_centre }));
    }
    case 'trial-balance': {
      const tb = await trialBalance(db, orgId, to);
      return tb.rows.map((x) => ({ as_of: to, account_code: x.code, account: x.name, account_type: x.type, debit: x.debitSide / 100, credit: x.creditSide / 100 }));
    }
    case 'invoices': {
      const list = await db.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
        .select(['i.number', 'i.doc_kind', 'i.invoice_date', 'i.due_date', 'i.status', 'i.place_of_supply', 'i.subtotal', 'i.cgst', 'i.sgst', 'i.igst', 'i.cess', 'i.total', 'i.amount_paid', 'c.display_name', 'c.gstin'])
        .where('i.org_id', '=', orgId).where('i.status', '<>', 'draft').where('i.invoice_date', '>=', from).where('i.invoice_date', '<=', to).orderBy('i.invoice_date').limit(100000).execute();
      return list.map((x) => ({ number: x.number, kind: x.doc_kind, date: d(x.invoice_date), due_date: d(x.due_date), status: x.status, customer: x.display_name, gstin: x.gstin, place_of_supply: x.place_of_supply, taxable: r(x.subtotal), cgst: r(x.cgst), sgst: r(x.sgst), igst: r(x.igst), cess: r(x.cess), total: r(x.total), paid: r(x.amount_paid), balance: x.status === 'void' ? 0 : r(x.total) - r(x.amount_paid) }));
    }
    case 'bills': {
      const list = await db.selectFrom('bills as b').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
        .select(['b.internal_no', 'b.vendor_invoice_no', 'b.bill_date', 'b.due_date', 'b.status', 'b.subtotal', 'b.cgst', 'b.sgst', 'b.igst', 'b.total', 'b.amount_paid', 'c.display_name', 'c.gstin', 'c.is_msme'])
        .where('b.org_id', '=', orgId).where('b.status', '<>', 'draft').where('b.bill_date', '>=', from).where('b.bill_date', '<=', to).orderBy('b.bill_date').limit(100000).execute();
      return list.map((x) => ({ number: x.internal_no, vendor_bill_no: x.vendor_invoice_no, date: d(x.bill_date), due_date: d(x.due_date), status: x.status, vendor: x.display_name, gstin: x.gstin, msme: !!x.is_msme, taxable: r(x.subtotal), cgst: r(x.cgst), sgst: r(x.sgst), igst: r(x.igst), total: r(x.total), paid: r(x.amount_paid), balance: x.status === 'void' ? 0 : r(x.total) - r(x.amount_paid) }));
    }
    case 'payments': {
      const list = await db.selectFrom('payments as p').innerJoin('contacts as c', 'c.id', 'p.contact_id').leftJoin('bank_accounts as k', 'k.id', 'p.bank_account_id')
        .select(['p.number', 'p.kind', 'p.payment_date', 'p.mode', 'p.amount', 'p.tds_amount', 'p.status', 'c.display_name', 'k.name as bank'])
        .where('p.org_id', '=', orgId).where('p.payment_date', '>=', from).where('p.payment_date', '<=', to).orderBy('p.payment_date').limit(100000).execute();
      return list.map((x) => ({ number: x.number, direction: x.kind, date: d(x.payment_date), mode: x.mode, party: x.display_name, account: x.bank, amount: r(x.amount), tds: r(x.tds_amount), status: x.status }));
    }
    case 'contacts': {
      const list = await db.selectFrom('contacts').select(['display_name', 'kind', 'gstin', 'pan', 'state_code', 'email', 'phone', 'is_msme', 'credit_limit', 'is_archived'])
        .where('org_id', '=', orgId).orderBy('display_name').limit(100000).execute();
      return list.map((x) => ({ name: x.display_name, kind: x.kind, gstin: x.gstin, pan: x.pan, state_code: x.state_code, email: x.email, phone: x.phone, msme: !!x.is_msme, credit_limit: r(x.credit_limit), archived: !!x.is_archived }));
    }
    case 'stock': {
      const pos = await stockPosition(db, orgId, to);
      return pos.lines.map((x) => ({ as_of: to, item: x.name, sku: x.sku, unit: x.uqc, qty: x.qty, unit_cost: x.unitCostPaise / 100, value: x.valuePaise / 100, valuation: x.valuation }));
    }
  }
}

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = route(async ({ orgId, role, params, req }) => {
  const ds = params.dataset as Dataset;
  if (!(ds in DATASETS)) throw notFound(`There is no dataset called ${params.dataset}. Try one of: ${Object.keys(DATASETS).join(', ')}.`);
  if (!hasPermission(role, DATASETS[ds], 'view')) throw forbidden('This key or user cannot read that dataset.');
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const q = query(req, z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('1900-01-01'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today),
    format: z.enum(['json', 'csv']).default('json'),
  }));
  const data = await rows(orgId, ds, q.from, q.to);
  if (q.format === 'csv') {
    const cols = data.length ? Object.keys(data[0]) : [];
    const body = [cols.join(','), ...data.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join('\n');
    return new NextResponse(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `inline; filename="${ds}.csv"` } });
  }
  return data;
});
