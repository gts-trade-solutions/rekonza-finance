import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-9C, the reconciliation statement, worked out from the books.
//
// GSTR-9C sets the audited accounts beside the annual return and explains
// every difference: turnover (table 5), taxable turnover (7), tax by rate (9)
// and input tax credit (12, and 14 by expense head). It is self-certified
// since 2020-21 and due with GSTR-9 from registrations whose turnover is above
// ₹5 crore.
//
// Here both sides come from one ledger. The accounts side is the journal —
// every posting to revenue, output tax and credit ledgers, whatever made it.
// The return side is GSTR-9, which is built from documents: invoices, notes,
// bills, advances. So what does not reconcile is exactly what reached the
// ledgers without a GST document behind it — a manual journal to sales, an
// opening adjustment, a bank-feed rule posting to income — and each of those
// is listed with its amount, so the reasons in table 6 write themselves.
//
// What the books cannot know (unbilled revenue, deemed supplies, trade
// discounts not allowed under GST, foreign exchange) is left at nil for the
// preparer to fill in on the portal, and said so.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { gstr9, type Gstr9, type TaxHeads } from './gstr9';

/** Postings these sources make are backed by a GST document the return already counts. */
const DOCUMENT_SOURCES = new Set([
  'invoice', 'credit_note', 'bill', 'expense', 'vendor_credit', 'advance_adjustment',
  'payment_received', 'payment_made', 'goods_receipt',
]);

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual journals', opening: 'Opening balances', opening_balance: 'Opening balances',
  opening_document: 'Opening bills', bank_txn: 'Bank statement postings', retainer: 'Retainer invoices',
  retainer_application: 'Retainers applied', recurring_journal: 'Recurring journals', transfer: 'Transfers',
  cheque_return: 'Cheque returns', tds_challan: 'TDS challans', credit_note_refund: 'Credit note refunds',
  vendor_credit_refund: 'Vendor credit refunds',
};
const label = (s: string) => SOURCE_LABEL[s] ?? s.replace(/_/g, ' ');

const OUTPUT = { CGST: CODE.GST_CGST, SGST: CODE.GST_SGST, IGST: CODE.GST_IGST, CESS: CODE.GST_CESS } as const;
const INPUT = { CGST: CODE.ITC_CGST, SGST: CODE.ITC_SGST, IGST: CODE.ITC_IGST, CESS: CODE.ITC_CESS } as const;
type Head = keyof typeof OUTPUT;
const HEADS: Head[] = ['IGST', 'CGST', 'SGST', 'CESS'];

export interface Line {
  ref: string;
  label: string;
  paise: Paise;
  /** Worked out from the books, or left for the preparer. */
  source: 'books' | 'return' | 'preparer' | 'total';
}

export interface Unexplained {
  source: string;
  label: string;
  paise: Paise;
}

export interface RateRow {
  ratePct: number;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

export interface Gstr9c {
  fy: string;
  from: string;
  to: string;
  gstin: string | null;
  table5: Line[];
  /** Turnover reached the books this way but has no GST document behind it. */
  table6: Unexplained[];
  table7: Line[];
  table9: {
    byRate: RateRow[];
    /** Per head: what the output-tax ledgers say, what the return paid, the gap. */
    heads: { head: Head; booksPaise: Paise; returnPaise: Paise; unreconciledPaise: Paise }[];
    outsideDocuments: Unexplained[];
  };
  table12: Line[];
  table14: { accountId: string; code: string; name: string; itcPaise: Paise }[];
  unreconciled: { turnoverPaise: Paise; taxableTurnoverPaise: Paise; taxPaise: Paise; itcPaise: Paise };
  notes: string[];
  gstr9: Gstr9;
}

const taxOf = (h: TaxHeads) => h.cgstPaise + h.sgstPaise + h.igstPaise + h.cessPaise;

export async function gstr9c(ex: Executor, orgId: number, startYear: number, branchId?: number): Promise<Gstr9c> {
  const from = `${startYear}-04-01`;
  const to = `${startYear + 1}-03-31`;
  const dayBefore = `${startYear}-03-31`;
  const br = branchId ? sql`AND e.branch_id = ${branchId}` : sql``;
  const pbr = branchId ? sql`AND p.branch_id = ${branchId}` : sql``;

  const [ret, moves, advancesAt, byRate, itcByAccount, docTaxable] = await Promise.all([
    gstr9(ex, orgId, startYear, branchId),
    // Every movement on revenue, output tax and credit ledgers in the year, by
    // what posted it. Reversals carry their original's source, so a voided
    // invoice nets to nothing here as it does in the return.
    sql<{ code: string; type: string; line: string | null; source_type: string; net: string }>`
      SELECT a.code, a.type, a.schedule_iii_line AS line, e.source_type, SUM(l.credit - l.debit) AS net
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
       WHERE l.org_id = ${orgId} AND l.entry_date BETWEEN ${from} AND ${to} ${br}
         AND (a.type = 'income' OR a.code IN (${sql.join([...Object.values(OUTPUT), CODE.RCM_PAYABLE, ...Object.values(INPUT)])}))
       GROUP BY a.code, a.type, a.schedule_iii_line, e.source_type
    `.execute(ex),
    // Advances for services, taxed on receipt and not yet set against an
    // invoice, as at the day before the year and its last day.
    Promise.all([dayBefore, to].map((at) => sql<{ taxable: string }>`
      SELECT COALESCE(SUM(p.advance_amount - p.advance_cgst - p.advance_sgst - p.advance_igst), 0)
           - COALESCE((SELECT SUM(a.amount - a.cgst - a.sgst - a.igst) FROM advance_tax_adjustments a
                        JOIN payments q ON q.id = a.payment_id
                       WHERE a.org_id = ${orgId} AND a.reversed_at IS NULL AND a.adjusted_on <= ${at}
                         AND q.status <> 'void' AND q.payment_date <= ${at}
                         ${branchId ? sql`AND q.branch_id = ${branchId}` : sql``}), 0) AS taxable
        FROM payments p
       WHERE p.org_id = ${orgId} AND p.kind = 'received' AND p.status <> 'void' AND p.advance_gst = 1
         AND p.payment_date <= ${at} ${pbr}
    `.execute(ex))),
    // Tax by rate from the documents: invoices less credit notes.
    sql<{ rate: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string }>`
      SELECT rate, SUM(taxable) AS taxable, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst, SUM(cess) AS cess FROM (
        SELECT l.gst_rate_pct AS rate, l.taxable, l.cgst, l.sgst, l.igst, l.cess
          FROM invoice_lines l JOIN invoices x ON x.id = l.invoice_id
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.invoice_date BETWEEN ${from} AND ${to}
               ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}
        UNION ALL
        SELECT l.gst_rate_pct, -l.taxable, -l.cgst, -l.sgst, -l.igst, -l.cess
          FROM credit_note_lines l JOIN credit_notes x ON x.id = l.credit_note_id
         WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.note_date BETWEEN ${from} AND ${to}
               ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}
      ) t GROUP BY rate ORDER BY rate
    `.execute(ex),
    // Credit by expense head (table 14): bill lines and expenses with credit taken.
    sql<{ account_id: number; code: string; name: string; itc: string }>`
      SELECT a.id AS account_id, a.code, a.name, SUM(t.itc) AS itc FROM (
        SELECT l.account_id, l.cgst + l.sgst + l.igst + l.cess AS itc
          FROM bill_lines l JOIN bills x ON x.id = l.bill_id
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.is_rcm = 0
           AND l.itc_eligibility IN ('eligible', 'capital_goods') AND x.bill_date BETWEEN ${from} AND ${to}
               ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}
        UNION ALL
        SELECT x.account_id, x.cgst + x.sgst + x.igst
          FROM expenses x
         WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.itc_eligibility IN ('eligible', 'capital_goods')
           AND x.expense_date BETWEEN ${from} AND ${to} ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}
      ) t JOIN accounts a ON a.id = t.account_id
      GROUP BY a.id, a.code, a.name HAVING SUM(t.itc) <> 0 ORDER BY itc DESC
    `.execute(ex),
    // The taxable value the invoices and notes carried, to set against what
    // they put into revenue.
    sql<{ taxable: string }>`
      SELECT COALESCE((SELECT SUM(x.subtotal) FROM invoices x
                        WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.invoice_date BETWEEN ${from} AND ${to}
                              ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}), 0)
           - COALESCE((SELECT SUM(x.subtotal) FROM credit_notes x
                        WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.note_date BETWEEN ${from} AND ${to}
                              ${branchId ? sql`AND x.branch_id = ${branchId}` : sql``}), 0) AS taxable
    `.execute(ex),
  ]);

  const p = toPaiseFromSql;
  const rows = moves.rows.map((r) => ({ ...r, net: p(r.net) }));

  // ── Table 5: turnover ──────────────────────────────────────────────────────
  // Revenue from operations, as the Schedule III statement of profit and loss
  // shows it: every income account but Other Income, unless a CA has moved one.
  const isRevenue = (r: { type: string; code: string; line: string | null }) =>
    r.type === 'income' && (r.line ? r.line === 'revenue_from_operations' : r.code !== CODE.OTHER_INCOME);
  const revenue = rows.filter(isRevenue);
  const booksTurnover = revenue.reduce((t, r) => t + r.net, 0);
  const advancesStart = p(advancesAt[0].rows[0]?.taxable ?? '0');
  const advancesEnd = p(advancesAt[1].rows[0]?.taxable ?? '0');

  const t5p = booksTurnover + advancesEnd - advancesStart;
  // Turnover in GSTR-9 is table 5N: 4N less 4G (inward supplies under reverse
  // charge are not our turnover) plus the zero-rated and exempt supplies.
  const t5q = ret.table4.total.taxablePaise - ret.table4.rcmInward.taxablePaise + ret.table5.total;
  const table5: Line[] = [
    { ref: '5A', label: 'Turnover (including exports) as per the audited financial statements', paise: booksTurnover, source: 'books' },
    { ref: '5B', label: 'Unbilled revenue at the beginning of the year (+)', paise: 0, source: 'preparer' },
    { ref: '5C', label: 'Unadjusted advances at the end of the year (+)', paise: advancesEnd, source: 'books' },
    { ref: '5D', label: 'Deemed supply under Schedule I (+)', paise: 0, source: 'preparer' },
    { ref: '5E', label: 'Credit notes issued after the year but in the annual return (+)', paise: 0, source: 'preparer' },
    { ref: '5F', label: 'Trade discounts in the accounts but not permissible under GST (+)', paise: 0, source: 'preparer' },
    { ref: '5H', label: 'Unbilled revenue at the end of the year (−)', paise: 0, source: 'preparer' },
    { ref: '5I', label: 'Unadjusted advances at the beginning of the year (−)', paise: 0 - advancesStart, source: 'books' },
    { ref: '5J', label: 'Credit notes in the accounts but not permissible under GST (−)', paise: 0, source: 'preparer' },
    { ref: '5M', label: 'Adjustments under section 15 (valuation) (+/−)', paise: 0, source: 'preparer' },
    { ref: '5N', label: 'Adjustments for foreign exchange fluctuations (+/−)', paise: 0, source: 'preparer' },
    { ref: '5O', label: 'Adjustments for reasons not listed above (+/−)', paise: 0, source: 'preparer' },
    { ref: '5P', label: 'Annual turnover after adjustments', paise: t5p, source: 'total' },
    { ref: '5Q', label: 'Turnover as declared in the annual return (GSTR-9)', paise: t5q, source: 'return' },
    { ref: '5R', label: 'Un-reconciled turnover (Q − P)', paise: t5q - t5p, source: 'total' },
  ];

  // ── Table 6: why ───────────────────────────────────────────────────────────
  const outside = (list: typeof rows, sign: 1 | -1): Unexplained[] => {
    const by = new Map<string, number>();
    for (const r of list) if (!DOCUMENT_SOURCES.has(r.source_type)) by.set(r.source_type, (by.get(r.source_type) ?? 0) + r.net * sign);
    return [...by].filter(([, v]) => v !== 0).map(([s, v]) => ({ source: s, label: label(s), paise: v }));
  };
  const table6 = outside(revenue, 1);
  // Shipping, packing and other charges an invoice adds outside its taxable
  // value reach revenue but not the return. Under section 15 they usually
  // belong in the taxable value; either way they are a reason here.
  const fromInvoices = revenue.filter((r) => r.source_type === 'invoice' || r.source_type === 'credit_note')
    .reduce((t, r) => t + r.net, 0);
  const charges = fromInvoices - p(docTaxable.rows[0]?.taxable ?? '0');
  if (charges !== 0) {
    table6.unshift({ source: 'invoice_charges', label: 'Charges on invoices outside the taxable value (shipping, adjustments)', paise: charges });
  }

  // ── Table 7: taxable turnover ──────────────────────────────────────────────
  const exempt = ret.table5.exemptOrNil;
  const zeroRated = ret.table5.exportsLut + ret.table5.sezLut;
  const t7e = t5p - exempt - zeroRated;
  const t7f = ret.table4.total.taxablePaise - ret.table4.rcmInward.taxablePaise;
  const table7: Line[] = [
    { ref: '7A', label: 'Annual turnover after adjustments (5P)', paise: t5p, source: 'total' },
    { ref: '7B', label: 'Exempted, nil-rated, non-GST and no-supply turnover', paise: exempt, source: 'books' },
    { ref: '7C', label: 'Zero-rated supplies without payment of tax', paise: zeroRated, source: 'books' },
    { ref: '7D', label: 'Supplies on which the recipient pays tax under reverse charge', paise: 0, source: 'preparer' },
    { ref: '7E', label: 'Taxable turnover as per the adjustments above', paise: t7e, source: 'total' },
    { ref: '7F', label: 'Taxable turnover as per the liability declared in GSTR-9', paise: t7f, source: 'return' },
    { ref: '7G', label: 'Un-reconciled taxable turnover (F − E)', paise: t7f - t7e, source: 'total' },
  ];

  // ── Table 9: tax ───────────────────────────────────────────────────────────
  const ledger = (code: string, sign: 1 | -1) => rows.filter((r) => r.code === code).reduce((t, r) => t + r.net * sign, 0);
  const table9Heads = HEADS.map((head) => {
    const books = ledger(OUTPUT[head], 1);
    const returned = ret.table9.find((t) => t.head === head)?.payablePaise ?? 0;
    return { head, booksPaise: books, returnPaise: returned, unreconciledPaise: returned - books };
  });
  const outputRows = rows.filter((r) => (Object.values(OUTPUT) as string[]).includes(r.code) || r.code === CODE.RCM_PAYABLE);
  const table9Outside = outside(outputRows, 1);

  // ── Table 12: credit ───────────────────────────────────────────────────────
  const itcBooks = HEADS.reduce((t, h) => t + ledger(INPUT[h], -1), 0);
  const itcReturn = taxOf(ret.table6.total) - ret.table7.vendorCreditsPaise;
  const table12: Line[] = [
    { ref: '12A', label: 'ITC availed as per the audited financial statements', paise: itcBooks, source: 'books' },
    { ref: '12B', label: 'ITC booked in an earlier year, claimed in this one (+)', paise: 0, source: 'preparer' },
    { ref: '12C', label: 'ITC booked this year, to be claimed in a later one (−)', paise: 0, source: 'preparer' },
    { ref: '12D', label: 'ITC availed as per the accounts, adjusted', paise: itcBooks, source: 'total' },
    { ref: '12E', label: 'ITC claimed in the annual return (GSTR-9, net of reversals)', paise: itcReturn, source: 'return' },
    { ref: '12F', label: 'Un-reconciled ITC (D − E)', paise: itcBooks - itcReturn, source: 'total' },
  ];
  const inputRows = rows.filter((r) => (Object.values(INPUT) as string[]).includes(r.code));

  const unreconciled = {
    turnoverPaise: t5q - t5p,
    taxableTurnoverPaise: t7f - t7e,
    taxPaise: table9Heads.reduce((t, h) => t + h.unreconciledPaise, 0),
    itcPaise: itcBooks - itcReturn,
  };

  const notes: string[] = [
    'Lines marked “preparer” are not kept in the books — unbilled revenue, deemed supplies, trade discounts and the like — and are entered on the portal.',
    'GSTR-9C has been self-certified since 2020-21. It is due with GSTR-9 by 31 December from registrations whose aggregate turnover exceeded ₹5 crore.',
  ];
  if (table6.length) notes.push('Revenue was posted without GST documents (see table 6). Each one either needs a document, or is a reason in table 6.');
  const itcOutside = outside(inputRows, -1);
  if (itcOutside.length) {
    notes.push(`Credit was posted to the ITC ledgers without a bill: ${itcOutside.map((o) => `${o.label} ₹${(o.paise / 100).toLocaleString('en-IN')}`).join(', ')}.`);
  }
  if (ledger(CODE.RCM_PAYABLE, 1) !== 0) {
    notes.push('Tax payable under reverse charge is held in its own ledger; table 9 compares the output ledgers by head, so reverse-charge tax appears as a difference there.');
  }

  return {
    fy: ret.fy, from, to, gstin: ret.gstin,
    table5, table6, table7,
    table9: {
      byRate: byRate.rows.map((r) => ({
        ratePct: Number(r.rate), taxablePaise: p(r.taxable), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst),
        igstPaise: p(r.igst), cessPaise: p(r.cess),
      })),
      heads: table9Heads,
      outsideDocuments: table9Outside,
    },
    table12,
    table14: itcByAccount.rows.map((r) => ({ accountId: String(r.account_id), code: r.code, name: r.name, itcPaise: p(r.itc) })),
    unreconciled,
    notes,
    gstr9: ret,
  };
}
