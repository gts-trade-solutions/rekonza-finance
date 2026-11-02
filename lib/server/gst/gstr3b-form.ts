import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-3B, table by table, the way the portal and Zoho Books lay it out.
//
// Every figure is built from a list of contributions: one per document (or per
// journal, for reversals) and table row, carrying the document's own number,
// date, party and amounts. The tables are the sums of that list, and the drill
// down from any figure is the same list filtered to that row — so a figure and
// the documents behind it can never disagree.
//
// The form is read as it stands since Circular 170/02/2022-GST:
//
//   * Table 4(A) carries all the credit the supplier side shows, including
//     credit blocked under section 17(5); the blocked part is then reversed in
//     4(B)(1) with the Rule 42/43 reversals, and 4(C) is what can be used.
//   * Rule 37 reversals (suppliers unpaid after 180 days) go in 4(B)(2); what
//     comes back once they are paid is in 4(A)(5) and repeated, for
//     information, in 4(D)(1).
//   * A supplier's credit note (our vendor credit) reduces 4(A)(5), as 2B
//     nets it.
//
// The net credit (4C) and the cash payable agree exactly with gstr3b() in
// returns.ts, which the AI, GSTR-9 and the checks use; a test holds them to it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { advancesForMonth } from './advances';
import { monthRange } from './returns';
import { creditUsedFor, setOffCredit, TAX_HEADS, type TaxHead } from './set-off';
import { calendarProfile, obligations } from '../tax/compliance-calendar';
import { GSTR3B_ROWS, ZERO_HEADS, type Gstr3bHeads, type Gstr3bRowKey } from '../../gst/gstr3b-layout';

// ── The period ───────────────────────────────────────────────────────────────

export interface Gstr3bPeriod {
  /** 'YYYY-MM' for a month, 'YYYY-Qn' for a quarter of the financial year starting in YYYY. */
  key: string;
  label: string;
  from: string;
  to: string;
  months: string[];
  quarterly: boolean;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function gstr3bPeriod(key: string): Gstr3bPeriod {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (q) {
    const fy = Number(q[1]);
    const n = Number(q[2]);
    // Q1 is April to June; Q4 is January to March of the next calendar year.
    const months = [0, 1, 2].map((i) => {
      const m = 4 + (n - 1) * 3 + i;
      const y = m > 12 ? fy + 1 : fy;
      return `${y}-${String(m > 12 ? m - 12 : m).padStart(2, '0')}`;
    });
    const first = monthRange(months[0]);
    const last = monthRange(months[2]);
    const name = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3);
    return {
      key, quarterly: true, months, from: first.from, to: last.to,
      label: `${name(months[0])}–${name(months[2])} ${months[2].slice(0, 4)} (Q${n} FY ${fy}-${String(fy + 1).slice(2)})`,
    };
  }
  if (!/^\d{4}-\d{2}$/.test(key)) throw new Error(`Not a GSTR-3B period: ${key}`);
  const r = monthRange(key);
  return { key, quarterly: false, months: [key], from: r.from, to: r.to, label: `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` };
}

// ── Contributions ────────────────────────────────────────────────────────────

export type Gstr3bDocType =
  | 'invoice' | 'debit_note' | 'credit_note' | 'advance' | 'bill' | 'expense' | 'bill_of_entry'
  | 'vendor_credit' | 'itc_reversal';

export interface Gstr3bDoc extends Gstr3bHeads {
  row: Gstr3bRowKey;
  docType: Gstr3bDocType;
  docId: string | null;
  number: string;
  date: string;
  party: string | null;
  gstin: string | null;
  /** Place of supply, as the state code. */
  pos: string | null;
  inter: boolean;
  /** Table 3.2 only: who the inter-state supply was to. */
  recipient?: 'unregistered' | 'composition' | 'uin' | null;
  /** Where the document opens. */
  href: string | null;
  note?: string;
}

const HREF: Record<Gstr3bDocType, (id: string | null) => string | null> = {
  invoice: (id) => (id ? `/sales/invoices/${id}` : '/sales/invoices'),
  debit_note: (id) => (id ? `/sales/invoices/${id}` : '/sales/debit-notes'),
  credit_note: () => '/sales/credit-notes',
  advance: () => '/sales/payments',
  bill: (id) => (id ? `/purchases/bills/${id}` : '/purchases/bills'),
  expense: () => '/purchases/expenses',
  bill_of_entry: () => '/purchases/bills-of-entry',
  vendor_credit: () => '/purchases/vendor-credits',
  itc_reversal: () => '/gst/itc-reversals',
};

type HeadsRow = { taxable: string; igst: string; cgst: string; sgst: string; cess: string };
const p = toPaiseFromSql;
const heads = (r: Partial<HeadsRow>, sign = 1): Gstr3bHeads => ({
  taxablePaise: sign * p(r.taxable ?? '0'),
  igstPaise: sign * p(r.igst ?? '0'),
  cgstPaise: sign * p(r.cgst ?? '0'),
  sgstPaise: sign * p(r.sgst ?? '0'),
  cessPaise: sign * p(r.cess ?? '0'),
});
const add = (a: Gstr3bHeads, b: Gstr3bHeads): Gstr3bHeads => ({
  taxablePaise: a.taxablePaise + b.taxablePaise,
  igstPaise: a.igstPaise + b.igstPaise,
  cgstPaise: a.cgstPaise + b.cgstPaise,
  sgstPaise: a.sgstPaise + b.sgstPaise,
  cessPaise: a.cessPaise + b.cessPaise,
});
const sub = (a: Gstr3bHeads, b: Gstr3bHeads): Gstr3bHeads => add(a, { taxablePaise: -b.taxablePaise, igstPaise: -b.igstPaise, cgstPaise: -b.cgstPaise, sgstPaise: -b.sgstPaise, cessPaise: -b.cessPaise });
const isZero = (h: Gstr3bHeads) => !h.taxablePaise && !h.igstPaise && !h.cgstPaise && !h.sgstPaise && !h.cessPaise;
const taxOnly = (h: Gstr3bHeads): Gstr3bHeads => ({ ...h, taxablePaise: 0 });
const day = (v: unknown) => String(v).slice(0, 10);

type SalesBucket = '3.1a' | '3.1b' | '3.1c' | '3.1e';

/** Which outward row a line of a sale belongs on. */
function salesBucket(supplyType: string, rate: number, taxPref: string): SalesBucket {
  if (['export_lut', 'export_with_tax', 'sez'].includes(supplyType)) return '3.1b';
  if (taxPref === 'non_gst') return '3.1e';
  if (supplyType === 'nil_or_exempt' || taxPref === 'exempt' || taxPref === 'nil' || rate === 0) return '3.1c';
  return '3.1a';
}

function recipientOf(treatment: string, gstin: string | null): Gstr3bDoc['recipient'] {
  if (treatment === 'registered_composition') return 'composition';
  if (treatment === 'uin') return 'uin';
  if (!gstin && (treatment === 'unregistered' || treatment === 'consumer')) return 'unregistered';
  return null;
}

/** Every contribution to the return, in document order. */
export async function gstr3bDocuments(ex: Executor, orgId: number, period: Gstr3bPeriod, branchId?: number): Promise<Gstr3bDoc[]> {
  const { from, to } = period;
  const br = (alias: string) => (branchId ? sql`AND ${sql.ref(`${alias}.branch_id`)} = ${branchId}` : sql``);
  const out: Gstr3bDoc[] = [];

  // ── Sales: invoices, debit notes and credit notes, line by line ────────────
  type SaleHead = {
    id: number; number: string; doc_date: string; doc_kind: string; supply_type: string; pos: string; branch_state: string;
    party: string; gstin: string | null; treatment: string;
  } & HeadsRow;
  type SaleLine = { doc_id: number; rate: string; tax_pref: string } & HeadsRow;

  const [invHeads, invLines, cnHeads, cnLines] = await Promise.all([
    sql<SaleHead>`
      SELECT i.id, i.number, i.invoice_date AS doc_date, i.doc_kind, i.supply_type, i.place_of_supply AS pos,
             b.state_code AS branch_state, c.display_name AS party, NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             i.subtotal AS taxable, i.igst, i.cgst, i.sgst, i.cess
        FROM invoices i JOIN contacts c ON c.id = i.customer_id JOIN branches b ON b.id = i.branch_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${from} AND ${to} ${br('i')}
       ORDER BY i.invoice_date, i.id
    `.execute(ex),
    sql<SaleLine>`
      SELECT l.invoice_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
             SUM(l.taxable) AS taxable, SUM(l.igst) AS igst, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.cess) AS cess
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN items it ON it.id = l.item_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${from} AND ${to} ${br('i')}
       GROUP BY l.invoice_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
    `.execute(ex),
    sql<SaleHead>`
      SELECT n.id, n.number, n.note_date AS doc_date, 'credit_note' AS doc_kind, n.supply_type, n.place_of_supply AS pos,
             b.state_code AS branch_state, c.display_name AS party, NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             n.subtotal AS taxable, n.igst, n.cgst, n.sgst, n.cess
        FROM credit_notes n JOIN contacts c ON c.id = n.customer_id JOIN branches b ON b.id = n.branch_id
       WHERE n.org_id = ${orgId} AND n.status <> 'void'
         AND n.note_date BETWEEN ${from} AND ${to} ${br('n')}
       ORDER BY n.note_date, n.id
    `.execute(ex),
    sql<SaleLine>`
      SELECT l.credit_note_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
             SUM(l.taxable) AS taxable, SUM(l.igst) AS igst, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.cess) AS cess
        FROM credit_note_lines l JOIN credit_notes n ON n.id = l.credit_note_id LEFT JOIN items it ON it.id = l.item_id
       WHERE n.org_id = ${orgId} AND n.status <> 'void'
         AND n.note_date BETWEEN ${from} AND ${to} ${br('n')}
       GROUP BY l.credit_note_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
    `.execute(ex),
  ]);

  const sales = (headRows: SaleHead[], lineRows: SaleLine[], sign: 1 | -1) => {
    const linesOf = new Map<number, SaleLine[]>();
    for (const l of lineRows) linesOf.set(Number(l.doc_id), [...(linesOf.get(Number(l.doc_id)) ?? []), l]);
    for (const h of headRows) {
      const docType: Gstr3bDocType = h.doc_kind === 'credit_note' ? 'credit_note' : h.doc_kind === 'debit_note' ? 'debit_note' : 'invoice';
      const inter = h.pos !== h.branch_state || ['export_lut', 'export_with_tax', 'sez'].includes(h.supply_type);
      const byRow = new Map<SalesBucket, Gstr3bHeads>();
      let lineSum = ZERO_HEADS;
      for (const l of linesOf.get(Number(h.id)) ?? []) {
        const row = salesBucket(h.supply_type, Number(l.rate), l.tax_pref);
        const v = heads(l, sign);
        byRow.set(row, add(byRow.get(row) ?? ZERO_HEADS, v));
        lineSum = add(lineSum, v);
      }
      // Header charges with tax of their own (shipping, say) belong with the
      // document's main supply, so the form totals what the documents total.
      const rest = sub(heads(h, sign), lineSum);
      if (!isZero(rest)) {
        const main = salesBucket(h.supply_type, rest.igstPaise + rest.cgstPaise ? 1 : 0, 'taxable');
        byRow.set(main, add(byRow.get(main) ?? ZERO_HEADS, rest));
      }
      for (const [row, v] of byRow) {
        if (isZero(v)) continue;
        out.push({
          row, docType, docId: String(h.id), number: h.number, date: day(h.doc_date), party: h.party, gstin: h.gstin,
          pos: h.pos, inter, href: HREF[docType](String(h.id)),
          recipient: row === '3.1a' && inter ? recipientOf(h.treatment, h.gstin) : null,
          // Only taxable value is reported for nil, exempt and non-GST supplies.
          ...(row === '3.1c' || row === '3.1e' ? { ...v, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 } : v),
        });
      }
    }
  };
  sales(invHeads.rows, invLines.rows, 1);
  sales(cnHeads.rows, cnLines.rows, -1);

  // ── Advances for services: taxed when received, untaxed when invoiced ──────
  for (const m of period.months) {
    const adv = await advancesForMonth(ex, orgId, monthRange(m), branchId);
    const sum = (rows: typeof adv.received) => rows.reduce<Gstr3bHeads>((t, r) => add(t, {
      taxablePaise: r.taxablePaise, igstPaise: r.igstPaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, cessPaise: 0,
    }), ZERO_HEADS);
    const received = sum(adv.received);
    const adjusted = sum(adv.adjusted);
    const base = { row: '3.1a' as const, docType: 'advance' as const, docId: null, date: monthRange(m).to, party: null, gstin: null, pos: null, inter: false, href: HREF.advance(null) };
    if (!isZero(received)) out.push({ ...base, number: `Advances received in ${m}`, ...received, note: 'Table 11A of GSTR-1' });
    if (!isZero(adjusted)) {
      out.push({
        ...base, number: `Earlier advances invoiced in ${m}`, note: 'Table 11B of GSTR-1',
        taxablePaise: -adjusted.taxablePaise, igstPaise: -adjusted.igstPaise, cgstPaise: -adjusted.cgstPaise, sgstPaise: -adjusted.sgstPaise, cessPaise: 0,
      });
    }
  }

  // ── Purchases: bills by line, for credit, reverse charge and table 5 ───────
  type BillLine = {
    id: number; number: string; vendor_invoice_no: string | null; bill_date: string; is_rcm: number; supply_type: string;
    pos: string; branch_state: string; party: string; gstin: string | null; treatment: string;
    eligibility: string; rate: string; tax_pref: string;
  } & HeadsRow;
  type BillHead = { id: number; number: string; vendor_invoice_no: string | null; bill_date: string; pos: string; branch_state: string; party: string; gstin: string | null; treatment: string } & HeadsRow;

  const [billLines, rcmHeads] = await Promise.all([
    sql<BillLine>`
      SELECT b.id, b.internal_no AS number, b.vendor_invoice_no, b.bill_date, b.is_rcm, b.supply_type, b.place_of_supply AS pos,
             br.state_code AS branch_state, c.display_name AS party, NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             bl.itc_eligibility AS eligibility, bl.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
             SUM(bl.taxable) AS taxable, SUM(bl.igst) AS igst, SUM(bl.cgst) AS cgst, SUM(bl.sgst) AS sgst, SUM(bl.cess) AS cess
        FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id JOIN contacts c ON c.id = b.vendor_id
        JOIN branches br ON br.id = b.branch_id LEFT JOIN items it ON it.id = bl.item_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void')
         AND b.bill_date BETWEEN ${from} AND ${to} ${br('b')}
       GROUP BY b.id, b.internal_no, b.vendor_invoice_no, b.bill_date, b.is_rcm, b.supply_type, b.place_of_supply, br.state_code,
                c.display_name, c.gstin, c.gst_treatment, bl.itc_eligibility, bl.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
       ORDER BY b.bill_date, b.id
    `.execute(ex),
    sql<BillHead>`
      SELECT b.id, b.internal_no AS number, b.vendor_invoice_no, b.bill_date, b.place_of_supply AS pos, br.state_code AS branch_state,
             c.display_name AS party, NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             b.subtotal AS taxable, b.igst, b.cgst, b.sgst, b.cess
        FROM bills b JOIN contacts c ON c.id = b.vendor_id JOIN branches br ON br.id = b.branch_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 1
         AND b.bill_date BETWEEN ${from} AND ${to} ${br('b')}
       ORDER BY b.bill_date, b.id
    `.execute(ex),
  ]);

  const billDoc = (b: { id: number; number: string; vendor_invoice_no: string | null; bill_date: string; pos: string; branch_state: string; party: string; gstin: string | null }) => ({
    docType: 'bill' as const, docId: String(b.id),
    number: b.vendor_invoice_no ? `${b.vendor_invoice_no} (${b.number})` : b.number,
    date: day(b.bill_date), party: b.party, gstin: b.gstin, pos: b.pos, inter: b.pos !== b.branch_state, href: HREF.bill(String(b.id)),
  });

  // 3.1(d): the tax we owe on a reverse-charge purchase, as billed.
  for (const b of rcmHeads.rows) {
    const v = heads(b);
    if (!isZero(v)) out.push({ row: '3.1d', ...billDoc(b), ...v });
  }

  // Credit, and the inward supplies table, bill by bill.
  const credit = new Map<string, Gstr3bDoc>();
  const put = (row: Gstr3bRowKey, b: BillLine, v: Gstr3bHeads) => {
    const key = `${row}:${b.id}`;
    const have = credit.get(key);
    if (have) Object.assign(have, add(have, v));
    else credit.set(key, { row, ...billDoc(b), ...v });
  };
  for (const l of billLines.rows) {
    const v = heads(l);
    const tax = taxOnly(v);
    const hasTax = !!(tax.igstPaise || tax.cgstPaise || tax.sgstPaise || tax.cessPaise);
    if (Number(l.is_rcm) === 1) {
      // Imported services are always reverse charge; other RCM purchases are 4(A)(3).
      if (hasTax) put(l.treatment === 'overseas' ? '4A2' : '4A3', l, tax);
    } else if (hasTax) {
      put('4A5', l, tax);
    } else if (l.treatment !== 'overseas') {
      // Goods brought in from abroad are on a bill of entry (4A1), not here.
      put(l.tax_pref === 'non_gst' ? '5nongst' : '5gst', l, { ...ZERO_HEADS, taxablePaise: v.taxablePaise });
    }
    // Blocked credit is shown in 4(A) and taken back out in 4(B)(1).
    if (hasTax && l.eligibility === 'ineligible') put('4B1', l, tax);
  }
  out.push(...credit.values());

  // ── Expenses keep only claimable tax in their GST columns ──────────────────
  const expenses = await sql<{ id: number; number: string; expense_date: string; party: string | null; gstin: string | null; taxable: string; igst: string; cgst: string; sgst: string }>`
    SELECT e.id, e.number, e.expense_date, c.display_name AS party, NULLIF(c.gstin, '') AS gstin,
           e.amount AS taxable, e.igst, e.cgst, e.sgst
      FROM expenses e LEFT JOIN contacts c ON c.id = e.vendor_id
     WHERE e.org_id = ${orgId} AND e.status <> 'void' AND e.itc_eligibility IN ('eligible', 'capital_goods')
       AND (e.igst + e.cgst + e.sgst) <> 0
       AND e.expense_date BETWEEN ${from} AND ${to} ${br('e')}
     ORDER BY e.expense_date, e.id
  `.execute(ex);
  for (const e of expenses.rows) {
    out.push({
      row: '4A5', docType: 'expense', docId: String(e.id), number: e.number, date: day(e.expense_date), party: e.party, gstin: e.gstin,
      pos: null, inter: p(e.igst) !== 0, href: HREF.expense(null), ...taxOnly(heads(e)),
    });
  }

  // ── Bills of entry: IGST and cess paid at customs ──────────────────────────
  const boe = await sql<{ id: number; boe_no: string; boe_date: string; eligibility: string; igst: string; cess: string }>`
    SELECT id, boe_no, boe_date, itc_eligibility AS eligibility, igst, cess
      FROM bills_of_entry
     WHERE org_id = ${orgId} AND status = 'recorded' AND boe_date BETWEEN ${from} AND ${to} ${br('bills_of_entry')}
     ORDER BY boe_date, id
  `.execute(ex);
  for (const r of boe.rows) {
    const tax: Gstr3bHeads = { ...ZERO_HEADS, igstPaise: p(r.igst), cessPaise: p(r.cess) };
    if (isZero(tax)) continue;
    const doc = {
      docType: 'bill_of_entry' as const, docId: String(r.id), number: r.boe_no, date: day(r.boe_date),
      party: 'Customs', gstin: null, pos: '96', inter: true, href: HREF.bill_of_entry(null),
    };
    out.push({ row: '4A1', ...doc, ...tax });
    if (r.eligibility === 'ineligible') out.push({ row: '4B1', ...doc, ...tax });
  }

  // ── What the input-tax ledgers say: vendor credits, reversals, reclaims ────
  const ledger = await sql<{ entry_id: number; source_type: string; source_id: number | null; entry_date: string; memo: string | null; vc_number: string | null; party: string | null } & Omit<HeadsRow, 'taxable'>>`
    SELECT e.id AS entry_id, e.source_type, e.source_id, e.entry_date, e.memo, vc.number AS vc_number, c.display_name AS party,
           COALESCE(SUM(CASE WHEN a.code = '1330' THEN jl.credit - jl.debit ELSE 0 END), 0) AS igst,
           COALESCE(SUM(CASE WHEN a.code = '1310' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cgst,
           COALESCE(SUM(CASE WHEN a.code = '1320' THEN jl.credit - jl.debit ELSE 0 END), 0) AS sgst,
           COALESCE(SUM(CASE WHEN a.code = '1340' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cess
      FROM journal_entries e
      JOIN journal_lines jl ON jl.entry_id = e.id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN vendor_credits vc ON e.source_type = 'vendor_credit' AND vc.id = e.source_id
      LEFT JOIN contacts c ON c.id = vc.vendor_id
     WHERE e.org_id = ${orgId}
       AND e.source_type IN ('vendor_credit', 'itc_reversal_42', 'itc_reversal_43', 'itc_reversal_37', 'itc_reclaim_37')
       AND e.entry_date BETWEEN ${from} AND ${to} ${br('e')}
     GROUP BY e.id, e.source_type, e.source_id, e.entry_date, e.memo, vc.number, c.display_name
     ORDER BY e.entry_date, e.id
  `.execute(ex);
  for (const r of ledger.rows) {
    // Credit less debit on the input ledgers: positive is credit taken away.
    const v: Gstr3bHeads = { taxablePaise: 0, igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst), cessPaise: p(r.cess) };
    if (isZero(v)) continue;
    const neg: Gstr3bHeads = { taxablePaise: 0, igstPaise: -v.igstPaise, cgstPaise: -v.cgstPaise, sgstPaise: -v.sgstPaise, cessPaise: -v.cessPaise };
    const base = { docId: r.source_id ? String(r.source_id) : null, date: day(r.entry_date), gstin: null, pos: null, inter: false };
    if (r.source_type === 'vendor_credit') {
      out.push({ row: '4A5', ...base, docType: 'vendor_credit', number: r.vc_number ?? `Vendor credit ${r.source_id}`, party: r.party, href: HREF.vendor_credit(null), ...neg, note: 'Supplier credit note: reduces credit' });
    } else if (r.source_type === 'itc_reclaim_37') {
      const doc = { ...base, docType: 'itc_reversal' as const, number: r.memo ?? 'Credit reclaimed on payment', party: null, href: HREF.itc_reversal(null) };
      out.push({ row: '4A5', ...doc, ...neg, note: 'Rule 37: reclaimed once the supplier was paid' });
      out.push({ row: '4D1', ...doc, ...neg });
    } else {
      const rule = r.source_type === 'itc_reversal_37' ? '37' : r.source_type.slice(-2);
      out.push({
        row: r.source_type === 'itc_reversal_37' ? '4B2' : '4B1', ...base, docType: 'itc_reversal',
        number: r.memo ?? `Rule ${rule} reversal`, party: null, href: HREF.itc_reversal(null), ...v, note: `Rule ${rule}`,
      });
    }
  }

  return out;
}

// ── The form ─────────────────────────────────────────────────────────────────

export interface Gstr3bPosRow { pos: string; taxablePaise: number; igstPaise: number }

export interface Gstr3bPaymentRow {
  kind: 'forward' | 'rcm';
  head: TaxHead;
  payablePaise: number;
  /** Paid through credit, by the head of the credit used. */
  itc: Record<TaxHead, number>;
  cashPaise: number;
  interestPaise: number;
  lateFeePaise: number;
}

export interface Gstr3bForm {
  period: Gstr3bPeriod;
  gstin: string | null;
  legalName: string;
  tradeName: string | null;
  rows: Record<Gstr3bRowKey, Gstr3bHeads & { count: number }>;
  /** 3.2, by place of supply. */
  interState: { unregistered: Gstr3bPosRow[]; composition: Gstr3bPosRow[]; uin: Gstr3bPosRow[] };
  /** 4(A) and 4(B) in total, and 4(C), the credit that can be used. */
  itcAvailable: Gstr3bHeads;
  itcReversed: Gstr3bHeads;
  itcNet: Gstr3bHeads;
  /** Table 5, split by inter- and intra-state. */
  inward: { gst: { inter: number; intra: number }; nonGst: { inter: number; intra: number } };
  /** 5.1: worked out from the due date and the cash payable. */
  interestLateFee: {
    interest: Gstr3bHeads;
    lateFee: Gstr3bHeads;
    daysLate: number;
    basis: string;
  };
  payment: Gstr3bPaymentRow[];
  totals: { liabilityPaise: number; itcUsedPaise: number; cashPaise: number; interestPaise: number; lateFeePaise: number; payablePaise: number };
  /** Credit not needed this period, carried forward on the electronic credit ledger. */
  creditCarriedForward: Record<TaxHead, number>;
  status: {
    filed: boolean;
    filedOn: string | null;
    arn: string | null;
    filedBy: string | null;
    dueDate: string;
    overdue: boolean;
  };
  notes: string[];
}

const fyOf = (iso: string) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const nextMonthOn = (month: string, d: number) => {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

async function dueDateFor(ex: Executor, orgId: number, period: Gstr3bPeriod): Promise<string> {
  const profile = await calendarProfile(ex, orgId);
  const last = period.months[period.months.length - 1];
  const found = obligations(profile, fyOf(`${last}-01`)).find((o) => o.key === 'gstr3b' && o.period === period.key);
  // A month asked of a quarterly filer, or a quarter of a monthly one: the usual dates.
  return found?.dueDate ?? nextMonthOn(last, period.quarterly ? 24 : 20);
}

/**
 * Late fee under section 47, as reduced by Notification 19/2021-Central Tax:
 * ₹50 a day (₹20 for a nil return), half CGST and half SGST, capped by the
 * previous year's turnover. Interest under section 50 is 18% a year on the
 * tax paid in cash, for the days after the due date.
 */
function interestAndLateFee(o: {
  daysLate: number; nilReturn: boolean; cashByHead: Record<TaxHead, number>; turnoverPaise: number; aboveFiveCrore: boolean;
}): Gstr3bForm['interestLateFee'] {
  const none = { interest: ZERO_HEADS, lateFee: ZERO_HEADS, daysLate: 0, basis: 'Filed by the due date: no interest or late fee.' };
  if (o.daysLate <= 0) return none;
  const perDayRupees = o.nilReturn ? 20 : 50;
  const capRupees = o.nilReturn ? 500
    : o.aboveFiveCrore || o.turnoverPaise > 5_00_00_000_00 ? 10_000
      : o.turnoverPaise > 1_50_00_000_00 ? 5_000 : 2_000;
  const feeRupees = Math.min(perDayRupees * o.daysLate, capRupees);
  const half = Math.round((feeRupees * 100) / 2);
  const interest = (head: TaxHead) => Math.round((o.cashByHead[head] * 18 * o.daysLate) / (100 * 365) / 100) * 100;
  return {
    interest: { taxablePaise: 0, igstPaise: interest('IGST'), cgstPaise: interest('CGST'), sgstPaise: interest('SGST'), cessPaise: interest('CESS') },
    lateFee: { taxablePaise: 0, igstPaise: 0, cgstPaise: half, sgstPaise: half, cessPaise: 0 },
    daysLate: o.daysLate,
    basis: `${o.daysLate} day${o.daysLate === 1 ? '' : 's'} after the due date: interest at 18% a year on the tax paid in cash, and a late fee of ₹${perDayRupees} a day capped at ₹${capRupees.toLocaleString('en-IN')}. The portal works out the final figures when the return is filed.`,
  };
}

export async function gstr3bForm(
  ex: Executor, orgId: number, periodKey: string,
  opts: { branchId?: number; today: string },
): Promise<Gstr3bForm & { documents: Gstr3bDoc[] }> {
  const period = gstr3bPeriod(periodKey);
  const { branchId } = opts;

  const [documents, org, branch, filing, dueDate] = await Promise.all([
    gstr3bDocuments(ex, orgId, period, branchId),
    ex.selectFrom('organizations').select(['name', 'legal_name', 'aato_above_5cr']).where('id', '=', orgId).executeTakeFirstOrThrow(),
    ex.selectFrom('branches').select(['gstin', 'name']).where('org_id', '=', orgId)
      .$if(!!branchId, (q) => q.where('id', '=', branchId!))
      .$if(!branchId, (q) => q.where('is_primary', '=', 1))
      .executeTakeFirst(),
    ex.selectFrom('compliance_filings as f').leftJoin('users as u', 'u.id', 'f.created_by_user_id')
      .select(['f.done_on', 'f.reference', 'u.name as by'])
      .where('f.org_id', '=', orgId).where('f.item_key', '=', 'gstr3b').where('f.period', '=', period.key)
      .executeTakeFirst(),
    dueDateFor(ex, orgId, period),
  ]);

  const rows = Object.fromEntries(
    (Object.keys(GSTR3B_ROWS) as Gstr3bRowKey[]).map((k) => [k, { ...ZERO_HEADS, count: 0 }]),
  ) as Gstr3bForm['rows'];
  const counted = new Map<Gstr3bRowKey, Set<string>>();
  for (const d of documents) {
    const r = rows[d.row];
    Object.assign(r, add(r, d));
    const seen = counted.get(d.row) ?? new Set<string>();
    seen.add(`${d.docType}:${d.docId ?? d.number}`);
    counted.set(d.row, seen);
  }
  for (const [k, s] of counted) rows[k].count = s.size;

  // 3.2: inter-state supplies in 3.1(a) to the unregistered, composition dealers and UIN holders.
  const byPos = (who: 'unregistered' | 'composition' | 'uin'): Gstr3bPosRow[] => {
    const m = new Map<string, Gstr3bPosRow>();
    for (const d of documents) {
      if (d.row !== '3.1a' || d.recipient !== who || !d.pos) continue;
      const r = m.get(d.pos) ?? { pos: d.pos, taxablePaise: 0, igstPaise: 0 };
      r.taxablePaise += d.taxablePaise;
      r.igstPaise += d.igstPaise;
      m.set(d.pos, r);
    }
    return [...m.values()].filter((r) => r.taxablePaise || r.igstPaise).sort((a, b) => a.pos.localeCompare(b.pos));
  };

  const sumRows = (keys: Gstr3bRowKey[]) => keys.reduce<Gstr3bHeads>((t, k) => add(t, rows[k]), ZERO_HEADS);
  const itcAvailable = taxOnly(sumRows(['4A1', '4A2', '4A3', '4A4', '4A5']));
  const itcReversed = taxOnly(sumRows(['4B1', '4B2']));
  const itcNet = sub(itcAvailable, itcReversed);

  const inward = { gst: { inter: 0, intra: 0 }, nonGst: { inter: 0, intra: 0 } };
  for (const d of documents) {
    if (d.row !== '5gst' && d.row !== '5nongst') continue;
    const bucket = d.row === '5gst' ? inward.gst : inward.nonGst;
    bucket[d.inter ? 'inter' : 'intra'] += d.taxablePaise;
  }

  // 6.1: forward charge met by credit in the law's order; reverse charge in cash.
  const fwd = add(rows['3.1a'], rows['3.1b']);
  const owed: Record<TaxHead, number> = { IGST: Math.max(0, fwd.igstPaise), CGST: Math.max(0, fwd.cgstPaise), SGST: Math.max(0, fwd.sgstPaise), CESS: Math.max(0, fwd.cessPaise) };
  const so = setOffCredit(owed, { IGST: itcNet.igstPaise, CGST: itcNet.cgstPaise, SGST: itcNet.sgstPaise, CESS: itcNet.cessPaise });
  const rcm = rows['3.1d'];
  const rcmByHead: Record<TaxHead, number> = { IGST: rcm.igstPaise, CGST: rcm.cgstPaise, SGST: rcm.sgstPaise, CESS: rcm.cessPaise };
  const cashByHead: Record<TaxHead, number> = { IGST: 0, CGST: 0, SGST: 0, CESS: 0 };
  for (const h of TAX_HEADS) cashByHead[h] = so.cash[h] + Math.max(0, rcmByHead[h]);

  const filedOn = filing ? day(filing.done_on) : null;
  const asOf = filedOn ?? opts.today;
  const daysLate = Math.max(0, daysBetween(dueDate, asOf));
  const nilReturn = isZero(sumRows(['3.1a', '3.1b', '3.1c', '3.1d', '3.1e'])) && isZero(itcAvailable);
  let turnoverPaise = 0;
  if (daysLate > 0 && !org.aato_above_5cr) {
    // The previous financial year's turnover sets the late-fee cap.
    const fy = fyOf(period.from);
    const t = await sql<{ v: string }>`
      SELECT COALESCE(SUM(subtotal), 0) AS v FROM invoices
       WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND invoice_date BETWEEN ${`${fy - 1}-04-01`} AND ${`${fy}-03-31`}
    `.execute(ex);
    turnoverPaise = p(t.rows[0]?.v ?? '0');
  }
  const interestLateFee = interestAndLateFee({ daysLate, nilReturn, cashByHead, turnoverPaise, aboveFiveCrore: !!org.aato_above_5cr });
  const interestBy: Record<TaxHead, number> = { IGST: interestLateFee.interest.igstPaise, CGST: interestLateFee.interest.cgstPaise, SGST: interestLateFee.interest.sgstPaise, CESS: interestLateFee.interest.cessPaise };
  const feeBy: Record<TaxHead, number> = { IGST: 0, CGST: interestLateFee.lateFee.cgstPaise, SGST: interestLateFee.lateFee.sgstPaise, CESS: 0 };

  const payment: Gstr3bPaymentRow[] = [
    ...TAX_HEADS.map((head): Gstr3bPaymentRow => ({
      kind: 'forward', head, payablePaise: owed[head], itc: so.used[head], cashPaise: so.cash[head],
      interestPaise: interestBy[head], lateFeePaise: feeBy[head],
    })),
    ...TAX_HEADS.map((head): Gstr3bPaymentRow => ({
      kind: 'rcm', head, payablePaise: Math.max(0, rcmByHead[head]), itc: { IGST: 0, CGST: 0, SGST: 0, CESS: 0 },
      cashPaise: Math.max(0, rcmByHead[head]), interestPaise: 0, lateFeePaise: 0,
    })),
  ];
  const itcUsedPaise = TAX_HEADS.reduce((t, h) => t + creditUsedFor(so, h), 0);
  const cashPaise = payment.reduce((t, r) => t + r.cashPaise, 0);
  const interestPaise = payment.reduce((t, r) => t + r.interestPaise, 0);
  const lateFeePaise = payment.reduce((t, r) => t + r.lateFeePaise, 0);

  const notes: string[] = [];
  if (rows['4B1'].count) notes.push('Credit blocked under section 17(5) is shown in 4(A) and reversed in 4(B)(1), as Circular 170/02/2022-GST asks.');
  if (documents.some((d) => d.docType === 'advance')) notes.push('3.1(a) includes tax on advances received for services and takes off the tax on earlier advances invoiced this period.');
  if (!branch?.gstin) notes.push('The branch has no GSTIN yet. Add it in Settings before downloading the return file.');
  if (!filing && daysLate > 0) notes.push(`This return was due on ${dueDate}. Interest and late fee below are what they would be if it were filed today.`);

  return {
    period,
    gstin: branch?.gstin ?? null,
    legalName: org.legal_name ?? org.name,
    tradeName: org.legal_name && org.legal_name !== org.name ? org.name : null,
    rows,
    interState: { unregistered: byPos('unregistered'), composition: byPos('composition'), uin: byPos('uin') },
    itcAvailable,
    itcReversed,
    itcNet,
    inward,
    interestLateFee,
    payment,
    totals: {
      liabilityPaise: TAX_HEADS.reduce((t, h) => t + owed[h] + Math.max(0, rcmByHead[h]), 0),
      itcUsedPaise,
      cashPaise,
      interestPaise,
      lateFeePaise,
      payablePaise: cashPaise + interestPaise + lateFeePaise,
    },
    creditCarriedForward: so.creditLeft,
    status: {
      filed: !!filing,
      filedOn,
      arn: filing?.reference ?? null,
      filedBy: filing?.by ?? null,
      dueDate,
      overdue: !filing && opts.today > dueDate,
    },
    notes,
    documents,
  };
}

// ── The portal's JSON ────────────────────────────────────────────────────────

const r2 = (paise: number) => Math.round(paise) / 100;
const tx = (h: Gstr3bHeads) => ({ txval: r2(h.taxablePaise), iamt: r2(h.igstPaise), camt: r2(h.cgstPaise), samt: r2(h.sgstPaise), csamt: r2(h.cessPaise) });
const taxes = (h: Gstr3bHeads) => ({ iamt: r2(h.igstPaise), camt: r2(h.cgstPaise), samt: r2(h.sgstPaise), csamt: r2(h.cessPaise) });

/**
 * The return in the GSTN's GSTR-3B schema (the one the portal's API and the
 * offline tools take): ret_period is MMYYYY, amounts are rupees to two places.
 */
export function gstr3bPortalJson(f: Gstr3bForm) {
  const last = f.period.months[f.period.months.length - 1];
  const pos = (rows: Gstr3bPosRow[]) => rows.map((r) => ({ pos: r.pos, txval: r2(r.taxablePaise), iamt: r2(r.igstPaise) }));
  return {
    gstin: f.gstin ?? '',
    ret_period: `${last.slice(5, 7)}${last.slice(0, 4)}`,
    sup_details: {
      osup_det: tx(f.rows['3.1a']),
      osup_zero: { txval: r2(f.rows['3.1b'].taxablePaise), iamt: r2(f.rows['3.1b'].igstPaise), csamt: r2(f.rows['3.1b'].cessPaise) },
      osup_nil_exmp: { txval: r2(f.rows['3.1c'].taxablePaise) },
      isup_rev: tx(f.rows['3.1d']),
      osup_nongst: { txval: r2(f.rows['3.1e'].taxablePaise) },
    },
    eco_dtls: {
      eco_sup: tx(f.rows['3.1.1i']),
      eco_reg_sup: { txval: r2(f.rows['3.1.1ii'].taxablePaise) },
    },
    inter_sup: {
      unreg_details: pos(f.interState.unregistered),
      comp_details: pos(f.interState.composition),
      uin_details: pos(f.interState.uin),
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...taxes(f.rows['4A1']) },
        { ty: 'IMPS', ...taxes(f.rows['4A2']) },
        { ty: 'ISRC', ...taxes(f.rows['4A3']) },
        { ty: 'ISD', ...taxes(f.rows['4A4']) },
        { ty: 'OTH', ...taxes(f.rows['4A5']) },
      ],
      itc_rev: [
        { ty: 'RUL', ...taxes(f.rows['4B1']) },
        { ty: 'OTH', ...taxes(f.rows['4B2']) },
      ],
      itc_net: taxes(f.itcNet),
      itc_inelg: [
        { ty: 'RUL', ...taxes(f.rows['4D1']) },
        { ty: 'OTH', ...taxes(f.rows['4D2']) },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: 'GST', inter: r2(f.inward.gst.inter), intra: r2(f.inward.gst.intra) },
        { ty: 'NONGST', inter: r2(f.inward.nonGst.inter), intra: r2(f.inward.nonGst.intra) },
      ],
    },
    intr_ltfee: {
      intr_details: taxes(f.interestLateFee.interest),
      ltfee_details: { camt: r2(f.interestLateFee.lateFee.cgstPaise), samt: r2(f.interestLateFee.lateFee.sgstPaise) },
    },
  };
}
