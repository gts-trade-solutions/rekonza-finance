import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The books as flat tables, for BI and planning tools: Power BI and Excel
// (/api/bi, JSON or CSV), Tableau (/api/odata, OData v4), and OneStream (the
// "onestream" table, its trial-balance import layout).
//
// Each table is one row per thing, amounts in rupees, dates as yyyy-mm-dd —
// the shape a BI tool reads without transforming. Every column is declared
// with its type, so the OData feed can describe it and Tableau gets numbers
// as numbers and dates as dates.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, type Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { trialBalance } from '../reports/statements';
import { stockPosition } from '../reports/stock';
import { CODE } from '../ledger/chart-of-accounts';

export type ColType = 'string' | 'decimal' | 'date' | 'int' | 'boolean';

interface DatasetDef {
  /** The module a key's role must be able to view. */
  permission: string;
  /** The name Tableau shows, as an OData entity set. */
  entitySet: string;
  title: string;
  columns: [name: string, type: ColType][];
}

export const DATASETS = {
  'journal-lines': {
    permission: 'reports.financial', entitySet: 'JournalLines', title: 'Every journal line',
    columns: [['entry_no', 'int'], ['date', 'date'], ['source', 'string'], ['memo', 'string'], ['account_code', 'string'], ['account', 'string'], ['account_type', 'string'], ['debit', 'decimal'], ['credit', 'decimal'], ['party', 'string'], ['cost_centre', 'string']],
  },
  'trial-balance': {
    permission: 'reports.financial', entitySet: 'TrialBalance', title: 'Trial balance as at a date',
    columns: [['as_of', 'date'], ['account_code', 'string'], ['account', 'string'], ['account_type', 'string'], ['debit', 'decimal'], ['credit', 'decimal']],
  },
  invoices: {
    permission: 'sales', entitySet: 'Invoices', title: 'Sales invoices',
    columns: [['number', 'string'], ['kind', 'string'], ['date', 'date'], ['due_date', 'date'], ['status', 'string'], ['customer', 'string'], ['gstin', 'string'], ['place_of_supply', 'string'], ['taxable', 'decimal'], ['cgst', 'decimal'], ['sgst', 'decimal'], ['igst', 'decimal'], ['cess', 'decimal'], ['total', 'decimal'], ['paid', 'decimal'], ['balance', 'decimal']],
  },
  bills: {
    permission: 'purchases', entitySet: 'Bills', title: 'Purchase bills',
    columns: [['number', 'string'], ['vendor_bill_no', 'string'], ['date', 'date'], ['due_date', 'date'], ['status', 'string'], ['vendor', 'string'], ['gstin', 'string'], ['msme', 'boolean'], ['taxable', 'decimal'], ['cgst', 'decimal'], ['sgst', 'decimal'], ['igst', 'decimal'], ['total', 'decimal'], ['paid', 'decimal'], ['balance', 'decimal']],
  },
  payments: {
    permission: 'reports.financial', entitySet: 'Payments', title: 'Payments received and made',
    columns: [['number', 'string'], ['direction', 'string'], ['date', 'date'], ['mode', 'string'], ['party', 'string'], ['account', 'string'], ['amount', 'decimal'], ['tds', 'decimal'], ['status', 'string']],
  },
  contacts: {
    permission: 'sales', entitySet: 'Contacts', title: 'Customers and vendors',
    columns: [['name', 'string'], ['kind', 'string'], ['gstin', 'string'], ['pan', 'string'], ['state_code', 'string'], ['email', 'string'], ['phone', 'string'], ['msme', 'boolean'], ['credit_limit', 'decimal'], ['archived', 'boolean']],
  },
  stock: {
    permission: 'inventory', entitySet: 'Stock', title: 'Stock on hand as at a date',
    columns: [['as_of', 'date'], ['item', 'string'], ['sku', 'string'], ['unit', 'string'], ['qty', 'decimal'], ['unit_cost', 'decimal'], ['value', 'decimal'], ['valuation', 'string']],
  },
  onestream: {
    permission: 'reports.financial', entitySet: 'OneStream', title: 'Trial balance by month, in OneStream’s import layout',
    columns: [['Entity', 'string'], ['Account', 'string'], ['AccountDescription', 'string'], ['AccountType', 'string'], ['Time', 'string'], ['Scenario', 'string'], ['View', 'string'], ['Flow', 'string'], ['IC', 'string'], ['UD1', 'string'], ['UD2', 'string'], ['Amount', 'decimal'], ['Currency', 'string']],
  },
} satisfies Record<string, DatasetDef>;

export type Dataset = keyof typeof DATASETS;
export const isDataset = (s: string): s is Dataset => s in DATASETS;

export interface DatasetOptions {
  from: string;
  to: string;
  /** OneStream only: amounts for the month alone, or year to date (balance-sheet accounts at their closing balance). */
  view?: 'periodic' | 'ytd';
}

const r = (v: string | null | undefined) => (v == null ? 0 : toPaiseFromSql(v) / 100);
const d = (v: unknown) => (v == null ? null : String(v).slice(0, 10));

/** A name as a OneStream member: letters, digits and underscores. */
export const member = (s: string) => s.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'None';

/** Months from one date to another, as yyyy-mm. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
    if (out.length > 600) break;
  }
  return out;
}

/** The Indian financial year a month falls in, by the year it starts. */
const fyOf = (ym: string) => (Number(ym.slice(5, 7)) >= 4 ? Number(ym.slice(0, 4)) : Number(ym.slice(0, 4)) - 1);

/**
 * OneStream's trial-balance layout: one row per month, account, branch (UD1)
 * and cost centre (UD2), signed debit positive. YTD gives balance-sheet
 * accounts at their closing balance and income and expense from the start of
 * the financial year, with earlier years' profit carried in retained earnings,
 * so every month's rows add up to nil; Periodic gives the month's movement.
 */
export async function oneStreamRows(orgId: number, opt: DatasetOptions, ex: Executor = db): Promise<Record<string, unknown>[]> {
  const view = opt.view ?? 'ytd';
  // No period asked for: the financial year so far, not every month since 1900.
  if (opt.from < '2000-01-01') opt = { ...opt, from: `${fyOf(opt.to.slice(0, 7))}-04-01` };
  const org = await ex.selectFrom('organizations').select('name').where('id', '=', orgId).executeTakeFirst();
  const entity = member(org?.name ?? `Org_${orgId}`).slice(0, 50);
  const startFrom = view === 'ytd' ? '1900-01-01' : `${opt.from.slice(0, 7)}-01`;
  const { rows } = await sql<{ ym: string; account_id: number; code: string; name: string; type: string; branch: string | null; cc: string | null; net: string }>`
    SELECT DATE_FORMAT(jl.entry_date, '%Y-%m') AS ym, a.id AS account_id, a.code, a.name, a.type,
           b.name AS branch, cc.code AS cc, SUM(jl.debit - jl.credit) AS net
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN branches b ON b.id = e.branch_id
      LEFT JOIN cost_centres cc ON cc.id = jl.cost_centre_id
     WHERE jl.org_id = ${orgId} AND jl.entry_date BETWEEN ${startFrom} AND ${opt.to}
     GROUP BY ym, a.id, a.code, a.name, a.type, b.name, cc.code
     ORDER BY ym`.execute(ex);
  const retained = await ex.selectFrom('accounts').select(['code', 'name']).where('org_id', '=', orgId).where('code', '=', CODE.RETAINED).executeTakeFirst();

  const wanted = monthsBetween(opt.from, opt.to);
  const out: Record<string, unknown>[] = [];
  const row = (ym: string, code: string, name: string, type: string, branch: string | null, cc: string | null, paise: number) => ({
    Entity: entity, Account: code, AccountDescription: name, AccountType: type,
    Time: `${ym.slice(0, 4)}M${Number(ym.slice(5, 7))}`, Scenario: 'Actual', View: view === 'ytd' ? 'YTD' : 'Periodic',
    Flow: 'None', IC: 'None', UD1: branch ? member(branch) : 'None', UD2: cc ? member(cc) : 'None',
    Amount: paise / 100, Currency: 'INR',
  });
  const isPl = (type: string) => type === 'income' || type === 'expense';

  if (view === 'periodic') {
    for (const x of rows) {
      const p = toPaiseFromSql(x.net);
      if (p && wanted.includes(x.ym)) out.push(row(x.ym, x.code, x.name, x.type, x.branch, x.cc, p));
    }
    return out;
  }

  // Year to date: run each line's balance forward month by month.
  const byMonth = new Map<string, typeof rows>();
  for (const x of rows) byMonth.set(x.ym, [...(byMonth.get(x.ym) ?? []), x]);
  const first = rows[0]?.ym ?? wanted[0];
  const running = new Map<string, { code: string; name: string; type: string; branch: string | null; cc: string | null; paise: number }>();
  const carried = new Map<string, number>(); // earlier years' profit, by branch and cost centre
  let fy = first ? fyOf(first) : 0;
  for (const ym of first ? monthsBetween(first < wanted[0] ? first : wanted[0], opt.to) : []) {
    if (fyOf(ym) !== fy) {
      // A new year: income and expense close into retained earnings.
      for (const [k, v] of running) {
        if (!isPl(v.type) || !v.paise) continue;
        const ck = `${v.branch ?? ''}|${v.cc ?? ''}`;
        carried.set(ck, (carried.get(ck) ?? 0) + v.paise);
        running.delete(k);
      }
      fy = fyOf(ym);
    }
    for (const x of byMonth.get(ym) ?? []) {
      const k = `${x.account_id}|${x.branch ?? ''}|${x.cc ?? ''}`;
      const at = running.get(k) ?? { code: x.code, name: x.name, type: x.type, branch: x.branch, cc: x.cc, paise: 0 };
      at.paise += toPaiseFromSql(x.net);
      running.set(k, at);
    }
    if (!wanted.includes(ym)) continue;
    // Retained earnings carries the closed years' profit on top of what is posted to it.
    const re = new Map(carried);
    for (const v of running.values()) {
      if (v.code === CODE.RETAINED) { const ck = `${v.branch ?? ''}|${v.cc ?? ''}`; re.set(ck, (re.get(ck) ?? 0) + v.paise); continue; }
      if (v.paise) out.push(row(ym, v.code, v.name, v.type, v.branch, v.cc, v.paise));
    }
    for (const [ck, p] of re) {
      if (!p) continue;
      const [branch, cc] = ck.split('|');
      out.push(row(ym, retained?.code ?? CODE.RETAINED, retained?.name ?? 'Retained Earnings', 'equity', branch || null, cc || null, p));
    }
  }
  return out;
}

export async function datasetRows(orgId: number, ds: Dataset, opt: DatasetOptions): Promise<Record<string, unknown>[]> {
  const { from, to } = opt;
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
    case 'onestream':
      return oneStreamRows(orgId, opt);
  }
}
