import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-3B checked three ways before it is filed.
//
//  1. Against the values the portal itself puts in: since the 2023 changes to
//     Rule 59 and Form GSTR-3B, tables 3.1, 3.1.1 and 3.2 come over from the
//     GSTR-1 of the period (amendments and all) and table 4 from GSTR-2B. A
//     return that departs from those figures by more than the portal allows
//     is flagged (and, for the liability, may not be reduced without the
//     DRC-01B explanation, Rule 88C). So each table is shown against what
//     GSTR-1 and GSTR-2B carry, with the reason for any difference.
//  2. Against the general ledger: output tax, reverse-charge tax and input
//     tax as posted for the period, source by source, against the return's
//     own figures — every difference either explained (a GSTR-2B claim
//     decision, an amendment of an earlier period) or shown as unexplained.
//  3. Over the year, month by month (reconciliation()): GSTR-1 against
//     GSTR-3B against the books, the screen the auditors asked for.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { gstr1Build, type Gstr1DocEntry } from './gstr1-json';
import { amendmentDeltas } from './gstr1-amendments';
import { gstr1Report } from './gstr1-report';
import { gstr3bForm, gstr3bPeriod } from './gstr3b-form';
import { itcReconciliation } from './compliance';
import { claimShifts, shiftTotal } from './itc-claims';
import { ZERO_HEADS, type Gstr3bHeads } from '../../gst/gstr3b-layout';

const p = toPaiseFromSql;
const fromRupees = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const add = (a: Gstr3bHeads, b: Partial<Gstr3bHeads>): Gstr3bHeads => ({
  taxablePaise: a.taxablePaise + (b.taxablePaise ?? 0), igstPaise: a.igstPaise + (b.igstPaise ?? 0), cgstPaise: a.cgstPaise + (b.cgstPaise ?? 0),
  sgstPaise: a.sgstPaise + (b.sgstPaise ?? 0), cessPaise: a.cessPaise + (b.cessPaise ?? 0),
});
const sub = (a: Gstr3bHeads, b: Gstr3bHeads): Gstr3bHeads => ({
  taxablePaise: a.taxablePaise - b.taxablePaise, igstPaise: a.igstPaise - b.igstPaise, cgstPaise: a.cgstPaise - b.cgstPaise,
  sgstPaise: a.sgstPaise - b.sgstPaise, cessPaise: a.cessPaise - b.cessPaise,
});
const isZero = (h: Gstr3bHeads) => !h.taxablePaise && !h.igstPaise && !h.cgstPaise && !h.sgstPaise && !h.cessPaise;
const taxOf = (h: Gstr3bHeads) => h.igstPaise + h.cgstPaise + h.sgstPaise + h.cessPaise;
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface CompareRow {
  key: string;
  label: string;
  source: 'GSTR-1' | 'GSTR-2B';
  fromSource: Gstr3bHeads;
  inReturn: Gstr3bHeads;
  difference: Gstr3bHeads;
  reasons: string[];
}

/** What the period's GSTR-1 carries for each row of 3.1 and 3.1.1, as the portal fills them. */
async function fromGstr1(ex: Executor, orgId: number, months: string[]) {
  const t: Record<'3.1a' | '3.1b' | '3.1c' | '3.1e' | '3.1.1i' | '3.1.1ii', Gstr3bHeads> = {
    '3.1a': ZERO_HEADS, '3.1b': ZERO_HEADS, '3.1c': ZERO_HEADS, '3.1e': ZERO_HEADS, '3.1.1i': ZERO_HEADS, '3.1.1ii': ZERO_HEADS,
  };
  const zeroRated = (d: Gstr1DocEntry) => {
    const e = (d.entry ?? {}) as Record<string, unknown>;
    return d.section === 'exp' || ['SEWP', 'SEWOP'].includes(String(e.inv_typ)) || ['EXPWP', 'EXPWOP'].includes(String(e.typ));
  };
  for (const m of months) {
    const { file, docs } = await gstr1Build(ex, orgId, m);
    for (const d of docs) {
      const h: Gstr3bHeads = { taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, cessPaise: d.cessPaise };
      if (d.section === 'nil') continue; // from the nil table below
      if (d.section === 'eco95') { t['3.1.1ii'] = add(t['3.1.1ii'], { taxablePaise: h.taxablePaise }); continue; }
      // Reverse charge: the buyer pays the tax; this return carries the value alone.
      const rc = (d.entry as Record<string, unknown> | null)?.rchrg === 'Y';
      const v = rc ? { ...ZERO_HEADS, taxablePaise: h.taxablePaise } : h;
      if (zeroRated(d)) t['3.1b'] = add(t['3.1b'], v);
      else t['3.1a'] = add(t['3.1a'], v);
    }
    for (const r of ((file.nil as { inv?: Record<string, unknown>[] } | undefined)?.inv ?? [])) {
      t['3.1c'] = add(t['3.1c'], { taxablePaise: fromRupees(r.nil_amt) + fromRupees(r.expt_amt) });
      t['3.1e'] = add(t['3.1e'], { taxablePaise: fromRupees(r.ngsup_amt) });
    }
    const adv = (key: 'at' | 'txpd', sign: number) => {
      for (const g of ((file[key] as { itms: Record<string, unknown>[] }[] | undefined) ?? [])) {
        for (const i of g.itms) {
          t['3.1a'] = add(t['3.1a'], {
            taxablePaise: sign * fromRupees(i.ad_amt), igstPaise: sign * fromRupees(i.iamt), cgstPaise: sign * fromRupees(i.camt),
            sgstPaise: sign * fromRupees(i.samt), cessPaise: sign * fromRupees(i.csamt),
          });
        }
      }
    };
    adv('at', 1);
    adv('txpd', -1);
    for (const r of ((file.ecob2c as Record<string, unknown>[] | undefined) ?? [])) {
      t['3.1.1i'] = add(t['3.1.1i'], { taxablePaise: fromRupees(r.txval), igstPaise: fromRupees(r.iamt), cgstPaise: fromRupees(r.camt), sgstPaise: fromRupees(r.samt), cessPaise: fromRupees(r.csamt) });
    }
  }
  for (const d of await amendmentDeltas(ex, orgId, months)) t[d.row] = add(t[d.row], d.delta);
  return t;
}

/** What GSTR-2B carries for the period: credit available, and the reverse-charge supplies. */
async function fromGstr2b(ex: Executor, orgId: number, months: string[]) {
  const periods = months.map((m) => `${m.slice(5, 7)}${m.slice(0, 4)}`);
  const { rows } = await sql<{ rc: number; taxable: string; igst: string; cgst: string; sgst: string; cess: string; n: number }>`
    SELECT is_reverse_charge AS rc, COUNT(*) AS n,
           COALESCE(SUM(IF(doc_type = 'credit_note', -taxable, taxable)), 0) AS taxable,
           COALESCE(SUM(IF(doc_type = 'credit_note', -igst, igst)), 0) AS igst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -cgst, cgst)), 0) AS cgst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -sgst, sgst)), 0) AS sgst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -cess, cess)), 0) AS cess
      FROM gstr2b_entries
     WHERE org_id = ${orgId} AND return_period IN (${sql.join(periods)}) AND itc_available = 1
       AND COALESCE(ims_action, 'accepted') = 'accepted'
     GROUP BY is_reverse_charge
  `.execute(ex);
  const h = (rc: number): Gstr3bHeads => {
    const r = rows.find((x) => Number(x.rc) === rc);
    return r ? { taxablePaise: p(r.taxable), igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst), cessPaise: p(r.cess) } : ZERO_HEADS;
  };
  const { rows: [held] } = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM gstr2b_entries WHERE org_id = ${orgId} AND return_period IN (${sql.join(periods)})
  `.execute(ex);
  return { forward: h(0), rcm: h(1), lines: Number(held?.n ?? 0) };
}

export interface TieOutLine {
  key: 'output' | 'rcm' | 'input';
  label: string;
  accounts: string;
  ledgerPaise: Paise;
  returnPaise: Paise;
  differencePaise: Paise;
  explained: { reason: string; paise: Paise }[];
  unexplainedPaise: Paise;
  bySource: { source: string; paise: Paise }[];
}

/** Net movement on accounts for the period, by source, leaving out the tax payment itself. */
async function moves(ex: Executor, orgId: number, codes: string[], from: string, to: string, sign: 1 | -1) {
  const { rows } = await sql<{ source_type: string; net: string }>`
    SELECT e.source_type, SUM(jl.credit - jl.debit) AS net
      FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND a.code IN (${sql.join(codes)}) AND e.entry_date BETWEEN ${from} AND ${to}
       AND e.source_type <> 'gst_tax_payment'
     GROUP BY e.source_type
  `.execute(ex);
  return rows.map((r) => ({ source: r.source_type, paise: sign * p(r.net) })).filter((r) => r.paise !== 0);
}

/** Sources whose postings to the GST ledgers the return reports. */
const REPORTED = new Set([
  'invoice', 'credit_note', 'payment_received', 'advance_adjustment', 'gst_eco_supply', 'gst_eco_amendment',
  'bill', 'expense', 'vendor_credit', 'bill_of_entry', 'itc_reversal_42', 'itc_reversal_43', 'itc_reversal_37', 'itc_reclaim_37',
]);

export interface Gstr3bChecks {
  compare: CompareRow[];
  tieOut: TieOutLine[];
  tied: boolean;
  twoB: { lines: number; imported: boolean };
}

export async function gstr3bChecks(ex: Executor, orgId: number, periodKey: string, today: string): Promise<Gstr3bChecks> {
  const period = gstr3bPeriod(periodKey);
  const [form, g1, g2] = await Promise.all([
    gstr3bForm(ex, orgId, periodKey, { today }),
    fromGstr1(ex, orgId, period.months),
    fromGstr2b(ex, orgId, period.months),
  ]);
  const r = form.rows;
  const strip = (h: Gstr3bHeads & { count?: number }): Gstr3bHeads => ({ taxablePaise: h.taxablePaise, igstPaise: h.igstPaise, cgstPaise: h.cgstPaise, sgstPaise: h.sgstPaise, cessPaise: h.cessPaise });
  const taxOnly = (h: Gstr3bHeads): Gstr3bHeads => ({ ...h, taxablePaise: 0 });

  // Header charges with tax of their own (shipping) are reported line by line in GSTR-1.
  const headerReasons: string[] = [];
  for (const m of period.months) {
    const rep = await gstr1Report(ex, orgId, m);
    for (const x of rep.tieOut.registerReasons) headerReasons.push(`${x.number}: ${x.reason} (${rupees(x.paise)})`);
  }

  const row = (key: string, label: string, source: CompareRow['source'], fromSource: Gstr3bHeads, inReturn: Gstr3bHeads, explain: () => string[]): CompareRow => {
    const difference = sub(inReturn, fromSource);
    return { key, label, source, fromSource, inReturn, difference, reasons: isZero(difference) ? [] : explain() };
  };
  const salesReasons = () => [
    ...headerReasons,
    'A document saved after GSTR-1 was prepared, or a GSTR-1 amendment not yet reported, moves the figure until both are prepared again.',
  ];

  // 4(A)(5) against GSTR-2B: what the books hold that the supplier did not file, and the reverse.
  const recon = await Promise.all(period.months.map((m) => itcReconciliation(ex, orgId, m)));
  const sum = (status: string, k: 'booksTaxPaise' | 'portalTaxPaise' | 'differencePaise') =>
    recon.flatMap((x) => x.rows).filter((x) => x.matchStatus === status).reduce((t, x) => t + x[k], 0);
  const shift = shiftTotal(await claimShifts(ex, orgId, period.months));
  const expenseTax = form.documents.filter((d) => d.row === '4A5' && d.docType === 'expense').reduce((t, d) => t + taxOf(d), 0);
  const itcReasons = () => [
    ...(sum('missing_in_portal', 'booksTaxPaise') ? [`Bills in the books the suppliers have not filed (not in GSTR-2B): ${rupees(sum('missing_in_portal', 'booksTaxPaise'))}. Hold them back (defer) on ITC Reconciliation until they appear.`] : []),
    ...(sum('missing_in_books', 'portalTaxPaise') ? [`Supplier invoices in GSTR-2B not booked yet: ${rupees(sum('missing_in_books', 'portalTaxPaise'))}.`] : []),
    ...(sum('mismatch', 'differencePaise') ? [`Bills whose tax differs from the supplier's filing: ${rupees(sum('mismatch', 'differencePaise'))} more in GSTR-2B than in the books.`] : []),
    ...(taxOf({ ...ZERO_HEADS, ...shift }) ? [`GSTR-2B claim decisions move ${rupees(taxOf({ ...ZERO_HEADS, ...shift }))} of credit into this period (negative: held back).`] : []),
    ...(expenseTax ? [`Expenses with GST (${rupees(expenseTax)}) are claimed from the expense entries; match their suppliers' invoices in GSTR-2B too.`] : []),
    ...(g2.lines === 0 ? ['No GSTR-2B has been brought in for this period: import it on ITC Reconciliation (JSON from the portal).'] : []),
  ];

  const compare: CompareRow[] = [
    row('3.1a', '3.1(a) Outward taxable supplies', 'GSTR-1', g1['3.1a'], strip(r['3.1a']), salesReasons),
    row('3.1b', '3.1(b) Zero-rated supplies (exports, SEZ)', 'GSTR-1', g1['3.1b'], strip(r['3.1b']), salesReasons),
    row('3.1c', '3.1(c) Nil-rated and exempt supplies', 'GSTR-1', g1['3.1c'], strip(r['3.1c']), salesReasons),
    row('3.1e', '3.1(e) Non-GST supplies', 'GSTR-1', g1['3.1e'], strip(r['3.1e']), salesReasons),
    row('3.1.1i', '3.1.1(i) Supplies on which the operator pays tax u/s 9(5)', 'GSTR-1', g1['3.1.1i'], strip(r['3.1.1i']), salesReasons),
    row('3.1.1ii', '3.1.1(ii) Supplies through an operator who pays tax u/s 9(5)', 'GSTR-1', g1['3.1.1ii'], strip(r['3.1.1ii']), salesReasons),
    row('3.1d', '3.1(d) Inward supplies liable to reverse charge', 'GSTR-2B', g2.rcm, strip(r['3.1d']), () => [
      'GSTR-2B lists reverse-charge supplies only from registered suppliers who reported them; purchases from unregistered suppliers and imported services are self-assessed and appear only in the books.',
    ]),
    row('4A5', '4(A)(5) All other ITC', 'GSTR-2B', taxOnly(g2.forward), taxOnly(strip(r['4A5'])), itcReasons),
  ];

  // ── The ledger ──────────────────────────────────────────────────────────
  const outCodes = [CODE.GST_IGST, CODE.GST_CGST, CODE.GST_SGST, CODE.GST_CESS];
  const inCodes = [CODE.ITC_IGST, CODE.ITC_CGST, CODE.ITC_SGST, CODE.ITC_CESS];
  const [outMoves, rcmMoves, inMoves] = await Promise.all([
    moves(ex, orgId, outCodes, period.from, period.to, 1),
    moves(ex, orgId, [CODE.RCM_PAYABLE], period.from, period.to, 1),
    moves(ex, orgId, inCodes, period.from, period.to, -1),
  ]);
  const total = (m: { paise: number }[]) => m.reduce((t, x) => t + x.paise, 0);
  const amendTax = form.documents.filter((d) => d.note?.startsWith('Amendment')).reduce((t, d) => t + taxOf(d), 0);
  const unreported = (m: { source: string; paise: number }[]) => m.filter((x) => !REPORTED.has(x.source));
  const line = (key: TieOutLine['key'], label: string, accounts: string, m: { source: string; paise: number }[], returnPaise: number, explained: TieOutLine['explained']): TieOutLine => {
    const ledgerPaise = total(m);
    const differencePaise = returnPaise - ledgerPaise;
    const ex2 = explained.filter((e) => e.paise !== 0);
    for (const u of unreported(m)) ex2.push({ reason: `Posted by ${u.source.replace(/_/g, ' ')} entries, which no document of the return explains: check them`, paise: -u.paise });
    const accounted = ex2.filter((e) => !e.reason.startsWith('Posted by')).reduce((t, e) => t + e.paise, 0);
    return { key, label, accounts, ledgerPaise, returnPaise, differencePaise, explained: ex2, unexplainedPaise: differencePaise - accounted, bySource: m };
  };
  const liability = taxOf(r['3.1a']) + taxOf(r['3.1b']) + taxOf(r['3.1.1i']);
  const tieOut = [
    line('output', 'Output tax (3.1(a), 3.1(b), 3.1.1(i))', 'Output CGST, SGST, IGST and cess', outMoves, liability, [
      { reason: 'Amendments of GSTR-1 documents of earlier filed periods, declared this period; the books carry them in their own months', paise: amendTax },
    ]),
    line('rcm', 'Reverse charge (3.1(d))', 'GST Payable under Reverse Charge', rcmMoves, taxOf(r['3.1d']), []),
    line('input', 'Net input tax credit (4(C))', 'Input CGST, SGST, IGST and cess', inMoves, taxOf(form.itcNet), [
      { reason: 'GSTR-2B claim decisions: credit held back from this period, or claimed in it from an earlier one (ITC Reconciliation)', paise: taxOf({ ...ZERO_HEADS, ...shift }) },
    ]),
  ];

  return {
    compare,
    tieOut,
    tied: tieOut.every((l) => l.unexplainedPaise === 0),
    twoB: { lines: g2.lines, imported: g2.lines > 0 },
  };
}

// ── Over the year: GSTR-1 against GSTR-3B against the books ─────────────────

export interface ReconMonth {
  month: string;
  gstr1: { taxablePaise: Paise; taxPaise: Paise };
  gstr3b: { taxablePaise: Paise; taxPaise: Paise };
  books: { taxablePaise: Paise; taxPaise: Paise };
  /** Output tax in the ledger for the month. */
  ledgerTaxPaise: Paise;
  /** Explained: a reason the law itself makes (an amendment, an advance). Otherwise for a person to look into. */
  differences: { between: string; paise: Paise; reason: string; explained: boolean }[];
  filed: { gstr1: string | null; gstr3b: string | null };
}

/**
 * Month by month for a financial year: the taxable value and tax as GSTR-1
 * reports them, as GSTR-3B declares them, and as the sales register and the
 * ledger hold them, with each difference and its reason. The three agree
 * when nothing is amiss; where they do not, the reasons the law itself makes
 * (an amendment declared later, an advance taxed on receipt, reverse charge,
 * a s.9(5) supply) are named, and anything else is left for a person to look
 * at.
 */
export async function reconciliation(ex: Executor, orgId: number, fyStart: number, today: string): Promise<{ fy: number; months: ReconMonth[]; totals: Omit<ReconMonth, 'month' | 'differences' | 'filed'> }> {
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return `${m >= 4 ? fyStart : fyStart + 1}-${String(m).padStart(2, '0')}`;
  }).filter((m) => `${m}-01` <= today);
  const filings = await ex.selectFrom('compliance_filings').select(['item_key', 'period', 'reference', 'done_on'])
    .where('org_id', '=', orgId).where('item_key', 'in', ['gstr1', 'gstr3b']).where('period', 'in', months.length ? months : ['-']).execute();
  const out: ReconMonth[] = [];
  for (const m of months) {
    const [g1, form] = await Promise.all([fromGstr1(ex, orgId, [m]), gstr3bForm(ex, orgId, m, { today })]);
    const range = gstr3bPeriod(m);
    const { rows: [reg] } = await sql<{ taxable: string; tax: string }>`
      SELECT COALESCE(SUM(t), 0) AS taxable, COALESCE(SUM(x), 0) AS tax FROM (
        SELECT subtotal AS t, cgst + sgst + igst + cess AS x
          FROM invoices WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND invoice_date BETWEEN ${range.from} AND ${range.to}
        UNION ALL
        SELECT -subtotal, -(cgst + sgst + igst + cess)
          FROM credit_notes WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND note_date BETWEEN ${range.from} AND ${range.to}
      ) z
    `.execute(ex);
    const ledger = (await moves(ex, orgId, [CODE.GST_IGST, CODE.GST_CGST, CODE.GST_SGST, CODE.GST_CESS], range.from, range.to, 1));
    const ledgerTaxPaise = ledger.reduce((t, x) => t + x.paise, 0);
    const keys = ['3.1a', '3.1b', '3.1c', '3.1e', '3.1.1ii'] as const;
    const g1Taxable = keys.reduce((t, k) => t + g1[k].taxablePaise, 0);
    const g1Tax = taxOf(g1['3.1a']) + taxOf(g1['3.1b']);
    const f = form.rows;
    const b3Taxable = keys.reduce((t, k) => t + f[k].taxablePaise, 0);
    const b3Tax = taxOf(f['3.1a']) + taxOf(f['3.1b']);
    const books = { taxablePaise: p(reg?.taxable ?? '0'), taxPaise: p(reg?.tax ?? '0') };

    const differences: ReconMonth['differences'] = [];
    const amend = form.documents.filter((d) => d.note?.startsWith('Amendment'));
    const amendTaxable = amend.reduce((t, d) => t + d.taxablePaise, 0);
    const amendTax = amend.reduce((t, d) => t + taxOf(d), 0);
    const adv = form.documents.filter((d) => d.docType === 'advance');
    const advTaxable = adv.reduce((t, d) => t + d.taxablePaise, 0);
    const advTax = adv.reduce((t, d) => t + taxOf(d), 0);
    if (g1Taxable !== b3Taxable || g1Tax !== b3Tax) {
      differences.push({ between: 'GSTR-1 and GSTR-3B', paise: (b3Taxable - g1Taxable) || (b3Tax - g1Tax), explained: false, reason: 'Charges on a document header (shipping) with tax of their own are reported line by line in GSTR-1; or a document changed after one of the two was prepared.' });
    }
    if (b3Taxable - amendTaxable - advTaxable !== books.taxablePaise) {
      differences.push({ between: 'GSTR-3B and the sales register (taxable value)', paise: b3Taxable - amendTaxable - advTaxable - books.taxablePaise, explained: false, reason: 'Look at the documents of the month: the register counts every invoice and credit note dated in it.' });
    }
    if (amendTaxable || amendTax) differences.push({ between: 'GSTR-3B and the books', paise: amendTax, explained: true, reason: `Amendments of earlier filed GSTR-1 documents declared this month (taxable ${rupees(amendTaxable)}); the books hold them in their own months.` });
    if (advTaxable || advTax) differences.push({ between: 'GSTR-3B and the sales register', paise: advTax, explained: true, reason: `GST on advances for services (taxable ${rupees(advTaxable)}): taxed when received, not in the register until invoiced.` });
    const ledgerGap = (b3Tax + taxOf(f['3.1.1i'])) - amendTax - ledgerTaxPaise;
    if (ledgerGap !== 0) {
      const odd = ledger.filter((x) => !REPORTED.has(x.source));
      differences.push({
        between: 'GSTR-3B and the ledger (output tax)', paise: ledgerGap, explained: false,
        reason: odd.length ? `Posted by ${odd.map((o) => `${o.source.replace(/_/g, ' ')} (${rupees(o.paise)})`).join(', ')}, which no document of the return explains.` : 'Output tax posted in the month does not match the return: look at the general ledger for the output tax accounts.',
      });
    }
    out.push({
      month: m,
      gstr1: { taxablePaise: g1Taxable, taxPaise: g1Tax },
      gstr3b: { taxablePaise: b3Taxable, taxPaise: b3Tax },
      books,
      ledgerTaxPaise,
      differences,
      filed: {
        gstr1: filings.find((x) => x.item_key === 'gstr1' && x.period === m)?.reference ?? null,
        gstr3b: filings.find((x) => x.item_key === 'gstr3b' && x.period === m)?.reference ?? null,
      },
    });
  }
  const sumOf = (pick: (r: ReconMonth) => { taxablePaise: number; taxPaise: number }) => out.reduce((t, r) => ({ taxablePaise: t.taxablePaise + pick(r).taxablePaise, taxPaise: t.taxPaise + pick(r).taxPaise }), { taxablePaise: 0, taxPaise: 0 });
  return {
    fy: fyStart,
    months: out,
    totals: { gstr1: sumOf((r) => r.gstr1), gstr3b: sumOf((r) => r.gstr3b), books: sumOf((r) => r.books), ledgerTaxPaise: out.reduce((t, r) => t + r.ledgerTaxPaise, 0) },
  };
}
