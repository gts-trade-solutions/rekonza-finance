import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The GST returns: GSTR-1 (what you sold) and GSTR-3B (what you owe).
//
// Both are computed from the invoices and bills themselves, never from a stored
// summary. A return is a statement about a period that is already closed, and
// the only way it can be wrong is if it disagrees with the documents behind it
// — so there is deliberately nothing in between.
//
// The section split in GSTR-1 is not cosmetic. Which table a supply lands in
// decides whether the buyer can see it in their GSTR-2B and claim credit on it.
// Putting a B2B sale in the B2C summary means your customer silently loses
// their input credit, and they will notice at their year end, not yours.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { advancesForMonth } from './advances';

/**
 * The B2CL threshold: an inter-state sale to a consumer above this is listed
 * invoice by invoice. ₹2.5 lakh until 31 July 2024, ₹1 lakh for invoices from
 * 1 August 2024 (notification 12/2024-Central Tax). It goes by the invoice
 * date, so a late return for an older month still splits the old way.
 */
export function b2clThreshold(invoiceDate: string): Paise {
  return invoiceDate < '2024-08-01' ? 2_50_000_00 : 1_00_000_00;
}

export interface Period {
  /** 'YYYY-MM'. */
  month: string;
  from: string;
  to: string;
}

export function monthRange(month: string): Period {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

// ── GSTR-1 ───────────────────────────────────────────────────────────────────

export interface Gstr1Row {
  id: string;
  number: string;
  date: string;
  customerName: string;
  gstin: string | null;
  placeOfSupply: string;
  supplyType: string;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  totalPaise: Paise;
  /** Only meaningful on a credit note. */
  reason?: string;
  againstNumber?: string | null;
  irnStatus?: string;
}

export interface Gstr1 {
  period: Period;
  gstin: string | null;
  b2b: Gstr1Row[];
  b2cl: Gstr1Row[];
  b2cs: Gstr1Row[];
  exports: Gstr1Row[];
  creditNotes: Gstr1Row[];
  hsn: {
    code: string;
    description: string | null;
    uqc: string;
    qty: number;
    taxablePaise: Paise;
    taxPaise: Paise;
  }[];
  totals: { taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; cessPaise: Paise };
  documentSummary: { from: string; to: string; total: number; cancelled: number };
  issues: { level: 'error' | 'warning'; message: string }[];
  invoiceCount: number;
}

export async function gstr1(ex: Executor, orgId: number, month: string, branchId?: number): Promise<Gstr1> {
  const period = monthRange(month);

  const invoiceRows = await sql<{
    id: number; number: string; invoice_date: string; status: string;
    customer_name: string; gstin: string | null; place_of_supply: string;
    supply_type: string; subtotal: string; cgst: string; sgst: string;
    igst: string; cess: string; total: string; irn_status: string | null;
  }>`
    SELECT i.id, i.number, i.invoice_date, i.status,
           c.display_name AS customer_name, c.gstin, i.place_of_supply, i.supply_type,
           i.subtotal, i.cgst, i.sgst, i.igst, i.cess, i.total,
           e.status AS irn_status
      FROM invoices i
      JOIN contacts c ON c.id = i.customer_id
      LEFT JOIN einvoices e ON e.invoice_id = i.id
     WHERE i.org_id = ${orgId}
       AND i.invoice_date BETWEEN ${period.from} AND ${period.to}
       ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
     ORDER BY i.invoice_date, i.id
  `.execute(ex);

  const toRow = (r: (typeof invoiceRows.rows)[number]): Gstr1Row => ({
    id: String(r.id),
    number: r.number,
    date: String(r.invoice_date).slice(0, 10),
    customerName: r.customer_name,
    gstin: r.gstin,
    placeOfSupply: r.place_of_supply,
    supplyType: r.supply_type,
    taxablePaise: toPaiseFromSql(r.subtotal),
    cgstPaise: toPaiseFromSql(r.cgst),
    sgstPaise: toPaiseFromSql(r.sgst),
    igstPaise: toPaiseFromSql(r.igst),
    cessPaise: toPaiseFromSql(r.cess),
    totalPaise: toPaiseFromSql(r.total),
    irnStatus: r.irn_status ?? 'not_applicable',
  });

  // A void invoice is reported in the document summary as cancelled, not in a
  // supply table: the number was issued and must be accounted for, but no
  // supply took place. A draft was never issued at all.
  const issued = invoiceRows.rows.filter((r) => r.status !== 'draft');
  const live = issued.filter((r) => r.status !== 'void');
  const cancelled = issued.filter((r) => r.status === 'void');

  const b2b: Gstr1Row[] = [];
  const b2cl: Gstr1Row[] = [];
  const b2cs: Gstr1Row[] = [];
  const exports: Gstr1Row[] = [];

  for (const r of live) {
    const row = toRow(r);
    if (['export_lut', 'export_with_tax', 'sez'].includes(r.supply_type)) exports.push(row);
    else if (r.gstin) b2b.push(row);
    else if (r.supply_type === 'inter' && row.totalPaise > b2clThreshold(row.date)) b2cl.push(row);
    else b2cs.push(row);
  }

  const creditNoteRows = await sql<{
    id: number; number: string; note_date: string; reason: string;
    customer_name: string; gstin: string | null; place_of_supply: string; supply_type: string;
    subtotal: string; cgst: string; sgst: string; igst: string; cess: string; total: string;
    against_number: string | null;
  }>`
    SELECT n.id, n.number, n.note_date, n.reason,
           c.display_name AS customer_name, c.gstin, n.place_of_supply, n.supply_type,
           n.subtotal, n.cgst, n.sgst, n.igst, n.cess, n.total,
           i.number AS against_number
      FROM credit_notes n
      JOIN contacts c ON c.id = n.customer_id
      LEFT JOIN invoices i ON i.id = n.against_invoice_id
     WHERE n.org_id = ${orgId} AND n.status <> 'void'
       AND n.note_date BETWEEN ${period.from} AND ${period.to}
       ${branchId ? sql`AND n.branch_id = ${branchId}` : sql``}
     ORDER BY n.note_date, n.id
  `.execute(ex);

  const creditNotes: Gstr1Row[] = creditNoteRows.rows.map((r) => ({
    id: String(r.id),
    number: r.number,
    date: String(r.note_date).slice(0, 10),
    customerName: r.customer_name,
    gstin: r.gstin,
    placeOfSupply: r.place_of_supply,
    supplyType: r.supply_type,
    taxablePaise: toPaiseFromSql(r.subtotal),
    cgstPaise: toPaiseFromSql(r.cgst),
    sgstPaise: toPaiseFromSql(r.sgst),
    igstPaise: toPaiseFromSql(r.igst),
    cessPaise: toPaiseFromSql(r.cess),
    totalPaise: toPaiseFromSql(r.total),
    reason: r.reason,
    againstNumber: r.against_number,
  }));

  // Table 12: goods and services rolled up by HSN/SAC.
  const hsnRows = await sql<{
    code: string | null; description: string | null; uqc: string | null;
    qty: string; taxable: string; tax: string;
  }>`
    SELECT l.hsn_sac AS code, h.description, MAX(l.uqc) AS uqc,
           COALESCE(SUM(l.qty), 0) AS qty,
           COALESCE(SUM(l.taxable), 0) AS taxable,
           COALESCE(SUM(l.cgst + l.sgst + l.igst + l.cess), 0) AS tax
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      LEFT JOIN hsn_codes h ON h.code = l.hsn_sac AND h.org_id = i.org_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
       AND i.invoice_date BETWEEN ${period.from} AND ${period.to}
       ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
     GROUP BY l.hsn_sac, h.description
     ORDER BY taxable DESC
  `.execute(ex);

  const hsn = hsnRows.rows.map((r) => ({
    code: r.code ?? 'UNCLASSIFIED',
    description: r.description,
    uqc: r.uqc ?? 'NOS',
    qty: Number(r.qty),
    taxablePaise: toPaiseFromSql(r.taxable),
    taxPaise: toPaiseFromSql(r.tax),
  }));

  // The checks the portal would otherwise bounce the whole return on.
  const issues: { level: 'error' | 'warning'; message: string }[] = [];

  const missingHsn = hsn.find((h) => h.code === 'UNCLASSIFIED');
  if (missingHsn) {
    issues.push({
      level: 'error',
      message: `Lines worth ₹${(missingHsn.taxablePaise / 100).toLocaleString('en-IN')} have no HSN/SAC code — the portal will reject the return.`,
    });
  }

  const noIrn = b2b.filter((r) => r.irnStatus === 'pending' || r.irnStatus === 'failed').length;
  if (noIrn) {
    issues.push({
      level: 'warning',
      message: `${noIrn} B2B invoice(s) have no IRN. Register them before filing — an invoice without one is not legally valid.`,
    });
  }

  const badGstin = b2b.filter((r) => !r.gstin || r.gstin.length !== 15).length;
  if (badGstin) {
    issues.push({
      level: 'error',
      message: `${badGstin} B2B invoice(s) have a missing or malformed customer GSTIN.`,
    });
  }

  // Rule 46(b): at most 16 characters, letters, digits, '-' and '/' only.
  const badNumbers = [...issued.map((r) => r.number), ...creditNotes.map((n) => n.number)]
    .filter((n) => n.length > 16 || !/^[A-Za-z0-9/-]+$/.test(n));
  if (badNumbers.length) {
    issues.push({
      level: 'error',
      message: `${badNumbers.length} document number(s) are longer than 16 characters or use characters other than letters, digits, '-' and '/' (for example ${badNumbers[0]}). The portal rejects them.`,
    });
  }

  if (cancelled.length) {
    issues.push({
      level: 'warning',
      message: `${cancelled.length} invoice number(s) were cancelled in this period. They are reported in the document summary, not as supplies.`,
    });
  }

  // An export or SEZ supply without tax needs a Letter of Undertaking in force
  // on the invoice date; without one the IGST was due.
  const zeroRated = live.filter((r) => r.supply_type === 'export_lut' || (r.supply_type === 'sez' && toPaiseFromSql(r.igst) === 0));
  if (zeroRated.length) {
    const org = await ex.selectFrom('organizations').select(['lut_arn', 'lut_valid_from', 'lut_valid_to'])
      .where('id', '=', orgId).executeTakeFirst();
    const from = org?.lut_valid_from ? String(org.lut_valid_from).slice(0, 10) : null;
    const to = org?.lut_valid_to ? String(org.lut_valid_to).slice(0, 10) : null;
    const outside = zeroRated.filter((r) => {
      const d = String(r.invoice_date).slice(0, 10);
      return !org?.lut_arn || !from || !to || d < from || d > to;
    });
    if (outside.length) {
      issues.push({
        level: 'error',
        message: org?.lut_arn
          ? `${outside.length} export or SEZ invoice(s) without tax are dated outside the LUT ${org.lut_arn} (${from} to ${to}). Without a LUT in force, IGST was due on them.`
          : `${outside.length} export or SEZ invoice(s) are without tax, but no Letter of Undertaking is on file. Add its ARN in Settings, or the IGST was due.`,
      });
    }
  }

  const totals = live.reduce(
    (acc, r) => ({
      taxablePaise: acc.taxablePaise + toPaiseFromSql(r.subtotal),
      cgstPaise: acc.cgstPaise + toPaiseFromSql(r.cgst),
      sgstPaise: acc.sgstPaise + toPaiseFromSql(r.sgst),
      igstPaise: acc.igstPaise + toPaiseFromSql(r.igst),
      cessPaise: acc.cessPaise + toPaiseFromSql(r.cess),
    }),
    { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 },
  );

  const branch = await ex
    .selectFrom('branches')
    .select(['gstin'])
    .where('org_id', '=', orgId)
    .$if(!!branchId, (q) => q.where('id', '=', branchId!))
    .$if(!branchId, (q) => q.where('is_primary', '=', 1))
    .executeTakeFirst();

  return {
    period,
    gstin: branch?.gstin ?? null,
    b2b,
    b2cl,
    b2cs,
    exports,
    creditNotes,
    hsn,
    totals,
    documentSummary: {
      from: issued[0]?.number ?? '—',
      to: issued[issued.length - 1]?.number ?? '—',
      total: issued.length,
      cancelled: cancelled.length,
    },
    issues,
    invoiceCount: live.length,
  };
}

// ── GSTR-3B ──────────────────────────────────────────────────────────────────

export interface Gstr3b {
  period: Period;
  /** Which registration the return is for; every GSTIN files its own. */
  gstin: string | null;
  /** Tax on sales, net of credit notes issued in the period. */
  outward: {
    taxablePaise: Paise;
    cgstPaise: Paise;
    sgstPaise: Paise;
    igstPaise: Paise;
    cessPaise: Paise;
  };
  /** GST on advances for services in the month, already included in outward. */
  advances: { receivedTaxPaise: Paise; adjustedTaxPaise: Paise };
  /** Reverse-charge supplies: we owe the tax on these, not the supplier. */
  inwardRcm: { taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; cessPaise: Paise };
  itc: {
    cgstPaise: Paise;
    sgstPaise: Paise;
    igstPaise: Paise;
    cessPaise: Paise;
    /** Credit blocked under section 17(5) — never claimable. */
    blockedPaise: Paise;
    /** Taken back by vendor credits (debit notes we raised) in the period. */
    reversedPaise: Paise;
    /** Table 4(B)(1): the exempt share of common credit, Rules 42 and 43. */
    reversedRule42Paise: Paise;
    /** Table 4(B)(2): suppliers unpaid after 180 days, Rule 37. */
    reversedRule37Paise: Paise;
    /** Table 4(D)(1): credit reversed earlier and taken again on payment. */
    reclaimedPaise: Paise;
  };
  /**
   * Head by head: what is owed, how much credit settles, and the cash left.
   * Reverse-charge tax is always cash (section 49(4)), so it is in the cash
   * column and never met by credit.
   */
  setOff: {
    head: 'IGST' | 'CGST' | 'SGST' | 'CESS';
    liabilityPaise: Paise;
    /** Of the liability, the part owed under reverse charge. */
    rcmPaise: Paise;
    creditUsedPaise: Paise;
    cashPaise: Paise;
  }[];
  totalCashPaise: Paise;
}

/**
 * GSTR-3B: the summary return, and the one you actually pay against.
 *
 * The set-off order is the part worth getting right. IGST credit is used
 * first, against IGST and then CGST and SGST. CGST credit then meets CGST and
 * any IGST left; SGST credit the same, but CGST and SGST credit never cross
 * each other. Cess credit only meets cess. Using credit in the wrong order
 * leaves it stranded and cash paid that did not need to be.
 *
 * Tax owed under reverse charge is not set off at all: it must be paid in
 * cash, and is then claimed back as credit in the same return.
 */
export async function gstr3b(ex: Executor, orgId: number, month: string, branchId?: number): Promise<Gstr3b> {
  const period = monthRange(month);
  const inv = branchId ? sql`AND branch_id = ${branchId}` : sql``;
  const b = branchId ? sql`AND b.branch_id = ${branchId}` : sql``;
  const je = branchId ? sql`AND e.branch_id = ${branchId}` : sql``;

  type Heads = { cgst: string; sgst: string; igst: string; cess: string };
  const [outwardRes, notesRes, rcmRes, itcRes, expenseRes, blockedRes, reversedRes, branch] = await Promise.all([
    sql<Heads & { taxable: string }>`
      SELECT COALESCE(SUM(subtotal), 0) AS taxable,
             COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
             COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(cess), 0) AS cess
        FROM invoices
       WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void')
         AND invoice_date BETWEEN ${period.from} AND ${period.to} ${inv}
    `.execute(ex),
    // A credit note issued this month reduces this month's output tax.
    sql<Heads & { taxable: string }>`
      SELECT COALESCE(SUM(subtotal), 0) AS taxable,
             COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
             COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(cess), 0) AS cess
        FROM credit_notes
       WHERE org_id = ${orgId} AND status <> 'void'
         AND note_date BETWEEN ${period.from} AND ${period.to} ${inv}
    `.execute(ex),
    sql<Heads & { taxable: string }>`
      SELECT COALESCE(SUM(b.subtotal), 0) AS taxable,
             COALESCE(SUM(b.cgst), 0) AS cgst, COALESCE(SUM(b.sgst), 0) AS sgst,
             COALESCE(SUM(b.igst), 0) AS igst, COALESCE(SUM(b.cess), 0) AS cess
        FROM bills b
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 1
         AND b.bill_date BETWEEN ${period.from} AND ${period.to} ${b}
    `.execute(ex),
    // Credit on ordinary purchases. Reverse-charge credit is added below,
    // from the tax paid on it.
    sql<Heads>`
      SELECT COALESCE(SUM(bl.cgst), 0) AS cgst, COALESCE(SUM(bl.sgst), 0) AS sgst,
             COALESCE(SUM(bl.igst), 0) AS igst, COALESCE(SUM(bl.cess), 0) AS cess
        FROM bill_lines bl
        JOIN bills b ON b.id = bl.bill_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 0
         AND bl.itc_eligibility IN ('eligible', 'capital_goods')
         AND b.bill_date BETWEEN ${period.from} AND ${period.to} ${b}
    `.execute(ex),
    // Expenses keep only claimable tax in their GST columns.
    sql<Heads>`
      SELECT COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
             COALESCE(SUM(igst), 0) AS igst, 0 AS cess
        FROM expenses
       WHERE org_id = ${orgId} AND status <> 'void' AND itc_eligibility IN ('eligible', 'capital_goods')
         AND expense_date BETWEEN ${period.from} AND ${period.to} ${inv}
    `.execute(ex),
    sql<{ blocked: string }>`
      SELECT COALESCE(SUM(bl.cgst + bl.sgst + bl.igst + bl.cess), 0) AS blocked
        FROM bill_lines bl
        JOIN bills b ON b.id = bl.bill_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 0
         AND bl.itc_eligibility NOT IN ('eligible', 'capital_goods')
         AND b.bill_date BETWEEN ${period.from} AND ${period.to} ${b}
    `.execute(ex),
    // A vendor credit holds no tax columns of its own; what it reversed is the
    // credit side of its entry on the input-tax ledgers.
    sql<Heads>`
      SELECT COALESCE(SUM(CASE WHEN a.code = '1310' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cgst,
             COALESCE(SUM(CASE WHEN a.code = '1320' THEN jl.credit - jl.debit ELSE 0 END), 0) AS sgst,
             COALESCE(SUM(CASE WHEN a.code = '1330' THEN jl.credit - jl.debit ELSE 0 END), 0) AS igst,
             COALESCE(SUM(CASE WHEN a.code = '1340' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cess
        FROM journal_lines jl
        JOIN journal_entries e ON e.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
       WHERE e.org_id = ${orgId} AND e.source_type = 'vendor_credit'
         AND e.entry_date BETWEEN ${period.from} AND ${period.to} ${je}
    `.execute(ex),
    ex.selectFrom('branches').select(['gstin']).where('org_id', '=', orgId)
      .$if(!!branchId, (q) => q.where('id', '=', branchId!))
      .$if(!branchId, (q) => q.where('is_primary', '=', 1))
      .executeTakeFirst(),
  ]);

  const p = toPaiseFromSql;
  const o = outwardRes.rows[0];
  const n = notesRes.rows[0];
  const r = rcmRes.rows[0];
  const i = itcRes.rows[0];
  const x = expenseRes.rows[0];
  const v = reversedRes.rows[0];

  // Tax on advances for services is due in the month the money arrives and
  // comes off in the month it is applied; table 3.1(a) carries the net.
  const adv = await advancesForMonth(ex, orgId, period, branchId);
  const advTax = (rows: typeof adv.received) => rows.reduce((t, r) => t + r.cgstPaise + r.sgstPaise + r.igstPaise, 0);

  const outward = {
    taxablePaise: p(o.taxable) - p(n.taxable) + adv.net.taxablePaise,
    cgstPaise: p(o.cgst) - p(n.cgst) + adv.net.cgstPaise,
    sgstPaise: p(o.sgst) - p(n.sgst) + adv.net.sgstPaise,
    igstPaise: p(o.igst) - p(n.igst) + adv.net.igstPaise,
    cessPaise: p(o.cess) - p(n.cess),
  };

  const inwardRcm = {
    taxablePaise: p(r.taxable),
    cgstPaise: p(r.cgst),
    sgstPaise: p(r.sgst),
    igstPaise: p(r.igst),
    cessPaise: p(r.cess),
  };

  const reversed = { cgst: p(v.cgst), sgst: p(v.sgst), igst: p(v.igst), cess: p(v.cess) };

  // Reverse-charge credit, only on lines whose credit can be taken; and the
  // month's reversals and reclaims, read off the input-tax ledgers by source.
  const heads = (where: ReturnType<typeof sql>) => sql<Heads>`
    SELECT COALESCE(SUM(CASE WHEN a.code = '1310' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cgst,
           COALESCE(SUM(CASE WHEN a.code = '1320' THEN jl.credit - jl.debit ELSE 0 END), 0) AS sgst,
           COALESCE(SUM(CASE WHEN a.code = '1330' THEN jl.credit - jl.debit ELSE 0 END), 0) AS igst,
           COALESCE(SUM(CASE WHEN a.code = '1340' THEN jl.credit - jl.debit ELSE 0 END), 0) AS cess
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND ${where}
       AND e.entry_date BETWEEN ${period.from} AND ${period.to} ${je}
  `.execute(ex).then((r) => r.rows[0]);
  const [rcmCredit, rule42, rule37, reclaim] = await Promise.all([
    sql<Heads>`
      SELECT COALESCE(SUM(bl.cgst), 0) AS cgst, COALESCE(SUM(bl.sgst), 0) AS sgst,
             COALESCE(SUM(bl.igst), 0) AS igst, COALESCE(SUM(bl.cess), 0) AS cess
        FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 1
         AND bl.itc_eligibility IN ('eligible', 'capital_goods')
         AND b.bill_date BETWEEN ${period.from} AND ${period.to} ${b}
    `.execute(ex).then((r) => r.rows[0]),
    heads(sql`e.source_type IN ('itc_reversal_42', 'itc_reversal_43')`),
    heads(sql`e.source_type = 'itc_reversal_37'`),
    heads(sql`e.source_type = 'itc_reclaim_37'`),
  ]);
  const total = (h: Heads) => p(h.cgst) + p(h.sgst) + p(h.igst) + p(h.cess);
  // A reclaim debits the ledgers, so its 'credit less debit' is negative.
  const out = (k: keyof Heads) => p(rule42[k]) + p(rule37[k]) + p(reclaim[k]);

  // RCM tax is paid in cash and then claimed back as credit in the same return.
  const itc = {
    cgstPaise: p(i.cgst) + p(x.cgst) + p(rcmCredit.cgst) - reversed.cgst - out('cgst'),
    sgstPaise: p(i.sgst) + p(x.sgst) + p(rcmCredit.sgst) - reversed.sgst - out('sgst'),
    igstPaise: p(i.igst) + p(x.igst) + p(rcmCredit.igst) - reversed.igst - out('igst'),
    cessPaise: p(i.cess) + p(rcmCredit.cess) - reversed.cess - out('cess'),
    blockedPaise: p(blockedRes.rows[0].blocked),
    reversedPaise: reversed.cgst + reversed.sgst + reversed.igst + reversed.cess,
    reversedRule42Paise: total(rule42),
    reversedRule37Paise: total(rule37),
    reclaimedPaise: -total(reclaim),
  };

  // Only the forward-charge liability can be met with credit.
  const owed = {
    IGST: Math.max(0, outward.igstPaise),
    CGST: Math.max(0, outward.cgstPaise),
    SGST: Math.max(0, outward.sgstPaise),
    CESS: Math.max(0, outward.cessPaise),
  };
  const used = { IGST: 0, CGST: 0, SGST: 0, CESS: 0 };
  const apply = (credit: number, head: keyof typeof owed): number => {
    const take = Math.min(Math.max(0, credit), owed[head] - used[head]);
    used[head] += take;
    return credit - take;
  };

  let igst = itc.igstPaise;
  igst = apply(igst, 'IGST');
  igst = apply(igst, 'CGST');
  apply(igst, 'SGST');
  let cgst = itc.cgstPaise;
  cgst = apply(cgst, 'CGST');
  apply(cgst, 'IGST');
  let sgst = itc.sgstPaise;
  sgst = apply(sgst, 'SGST');
  apply(sgst, 'IGST');
  apply(itc.cessPaise, 'CESS');

  const rcm = {
    IGST: inwardRcm.igstPaise, CGST: inwardRcm.cgstPaise, SGST: inwardRcm.sgstPaise, CESS: inwardRcm.cessPaise,
  };
  const setOff: Gstr3b['setOff'] = (['IGST', 'CGST', 'SGST', 'CESS'] as const).map((head) => ({
    head,
    liabilityPaise: owed[head] + rcm[head],
    rcmPaise: rcm[head],
    creditUsedPaise: used[head],
    cashPaise: owed[head] - used[head] + rcm[head],
  }));

  return {
    period,
    gstin: branch?.gstin ?? null,
    outward,
    advances: { receivedTaxPaise: advTax(adv.received), adjustedTaxPaise: advTax(adv.adjusted) },
    inwardRcm,
    itc,
    setOff,
    totalCashPaise: setOff.reduce((t, s) => t + s.cashPaise, 0),
  };
}

// ── IFF ──────────────────────────────────────────────────────────────────────

/**
 * The Invoice Furnishing Facility: a quarterly (QRMP) filer may upload B2B
 * invoices and notes in the first two months of a quarter, so their buyers can
 * claim credit without waiting for the quarter's GSTR-1. It is exactly the B2B
 * part of GSTR-1 — taken from it, so the two cannot disagree.
 */
export async function iff(ex: Executor, orgId: number, month: string, branchId?: number) {
  const g = await gstr1(ex, orgId, month, branchId);
  const cdnr = g.creditNotes.filter((n) => !!n.gstin);
  const sum = (rows: Gstr1Row[]) => rows.reduce(
    (t, r) => ({
      taxablePaise: t.taxablePaise + r.taxablePaise,
      cgstPaise: t.cgstPaise + r.cgstPaise,
      sgstPaise: t.sgstPaise + r.sgstPaise,
      igstPaise: t.igstPaise + r.igstPaise,
      cessPaise: t.cessPaise + r.cessPaise,
    }),
    { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 },
  );
  // The third month of a quarter goes in GSTR-1 itself, not IFF.
  const thirdMonth = Number(month.slice(5, 7)) % 3 === 0;
  return {
    period: g.period,
    gstin: g.gstin,
    b2b: g.b2b,
    cdnr,
    totals: { b2b: sum(g.b2b), cdnr: sum(cdnr) },
    issues: [
      ...g.issues.filter((i) => !/cancelled/.test(i.message)),
      ...(thirdMonth
        ? [{ level: 'warning' as const, message: 'This is the last month of a quarter. Its B2B invoices go in the quarter’s GSTR-1, not in IFF.' }]
        : []),
    ],
  };
}
