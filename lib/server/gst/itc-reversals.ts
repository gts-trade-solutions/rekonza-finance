import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Input tax credit taken back (CGST Rules 37, 42 and 43).
//
// Rule 37: a supplier not paid within 180 days of their invoice. The credit on
// what is still unpaid is reversed in the return for the month the 180 days
// run out, and taken again, in proportion, as the bill is paid. Meanwhile it
// sits in "ITC reversed, reclaimable on payment", an asset, because it comes
// back. Interest under s.50 runs on credit used while it was not due; that is
// worked out on the portal.
//
// Rule 42: credit on inputs and services that serve both taxable and exempt
// supplies. Each month the exempt share, E/F of it (E exempt turnover, F all
// turnover of the registration), is reversed; after the year the same sum is
// done on the year's figures and the difference trued up. This is a cost: it
// does not come back.
//
// Rule 43: the same for capital goods, on a sixtieth of each one's credit a
// month for the five years from its invoice.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';

const p = toPaiseFromSql;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(y, m, 0).getDate())}`;
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface TaxHeads { cgst: Paise; sgst: Paise; igst: Paise; cess: Paise }
const zero = (): TaxHeads => ({ cgst: 0, sgst: 0, igst: 0, cess: 0 });
const sumHeads = (h: TaxHeads) => h.cgst + h.sgst + h.igst + h.cess;
/** A share of each head, rounded to the paisa. */
const share = (h: TaxHeads, f: number): TaxHeads => ({
  cgst: Math.round(h.cgst * f), sgst: Math.round(h.sgst * f), igst: Math.round(h.igst * f), cess: Math.round(h.cess * f),
});
const ITC_CODES: [keyof TaxHeads, string][] = [['cgst', CODE.ITC_CGST], ['sgst', CODE.ITC_SGST], ['igst', CODE.ITC_IGST], ['cess', CODE.ITC_CESS]];

async function primaryBranch(ex: Executor, orgId: number) {
  return (await ex.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
}

// ── Rule 37 ──────────────────────────────────────────────────────────────────

export interface Rule37Row {
  billId: string; number: string; vendorName: string; billDate: string; dueBy: string;
  totalPaise: Paise; paidPaise: Paise; itc: TaxHeads;
  /** Credit to reverse now on the unpaid part, or already reversed. */
  reverse: TaxHeads;
  /** Credit that can be taken again for what has been paid since it was reversed. */
  reclaim: TaxHeads;
  status: 'due' | 'reversed' | 'reclaimable' | 'reclaimed';
  reversedIn: string | null;
}

/** Bills past 180 days and unpaid, and reversed bills that have since been paid. */
export async function rule37(ex: Executor, orgId: number, asOf: string): Promise<Rule37Row[]> {
  const cutoff = addDays(asOf, -180);
  const { rows } = await sql<{
    id: number; internal_no: string; vendor: string; bill_date: string; total: string; amount_paid: string;
    cgst: string; sgst: string; igst: string; cess: string;
  }>`
    SELECT b.id, b.internal_no, c.display_name AS vendor, b.bill_date, b.total, b.amount_paid,
           SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.cess) AS cess
      FROM bills b JOIN contacts c ON c.id = b.vendor_id JOIN bill_lines l ON l.bill_id = b.id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 0
       AND l.itc_eligibility IN ('eligible', 'capital_goods')
       AND (b.bill_date <= ${cutoff} OR b.id IN (SELECT bill_id FROM itc_reversals WHERE org_id = ${orgId} AND rule = '37'))
     GROUP BY b.id, b.internal_no, c.display_name, b.bill_date, b.total, b.amount_paid
    HAVING SUM(l.cgst + l.sgst + l.igst + l.cess) > 0
  `.execute(ex);
  const reversals = await ex.selectFrom('itc_reversals').selectAll().where('org_id', '=', orgId).where('rule', '=', '37').execute();
  const byBill = new Map(reversals.map((r) => [r.bill_id, r]));

  const out: Rule37Row[] = [];
  for (const b of rows) {
    const total = p(b.total);
    const paid = Math.min(total, p(b.amount_paid));
    const itc: TaxHeads = { cgst: p(b.cgst), sgst: p(b.sgst), igst: p(b.igst), cess: p(b.cess) };
    const r = byBill.get(b.id);
    const base = {
      billId: String(b.id), number: b.internal_no, vendorName: b.vendor, billDate: String(b.bill_date).slice(0, 10),
      dueBy: addDays(String(b.bill_date).slice(0, 10), 180), totalPaise: total, paidPaise: paid, itc,
    };
    if (!r) {
      if (paid >= total) continue;
      out.push({ ...base, reverse: share(itc, (total - paid) / total), reclaim: zero(), status: 'due', reversedIn: null });
      continue;
    }
    const reversed: TaxHeads = { cgst: p(r.cgst), sgst: p(r.sgst), igst: p(r.igst), cess: p(r.cess) };
    const reclaimed: TaxHeads = { cgst: p(r.reclaimed_cgst), sgst: p(r.reclaimed_sgst), igst: p(r.reclaimed_igst), cess: p(r.reclaimed_cess) };
    const unpaidThen = p(r.unpaid_at_reversal ?? '0');
    const paidSince = Math.max(0, paid - p(r.paid_at_reversal ?? '0'));
    const fraction = unpaidThen > 0 ? Math.min(1, paidSince / unpaidThen) : 0;
    const owed = share(reversed, fraction);
    const reclaim: TaxHeads = {
      cgst: owed.cgst - reclaimed.cgst, sgst: owed.sgst - reclaimed.sgst, igst: owed.igst - reclaimed.igst, cess: owed.cess - reclaimed.cess,
    };
    const fullyBack = sumHeads(reclaimed) >= sumHeads(reversed);
    out.push({
      ...base, reverse: reversed, reclaim,
      status: fullyBack ? 'reclaimed' : sumHeads(reclaim) > 0 ? 'reclaimable' : 'reversed', reversedIn: r.period,
    });
  }
  return out.sort((a, b) => a.billDate.localeCompare(b.billDate));
}

/** Reverse the credit on every bill whose 180 days have run out by the month's end. */
export async function postRule37(trx: Trx, orgId: number, userId: number | null, month: string): Promise<{ bills: number; totalPaise: Paise }> {
  const end = lastDay(month);
  const due = (await rule37(trx, orgId, end)).filter((r) => r.status === 'due');
  if (!due.length) throw badRequest(`No bill passed 180 days unpaid by ${end}.`);
  const acc = await accountIds(trx, orgId);
  const totals = due.reduce((t, r) => ({ cgst: t.cgst + r.reverse.cgst, sgst: t.sgst + r.reverse.sgst, igst: t.igst + r.reverse.igst, cess: t.cess + r.reverse.cess }), zero());
  const entry = await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: end, userId, module: 'purchases',
    memo: `Rule 37: credit reversed on ${due.length} bill(s) unpaid after 180 days`, sourceType: 'itc_reversal_37', sourceId: null,
    lines: [
      { accountId: requireAccount(acc, CODE.ITC_RECLAIMABLE), debit: sumHeads(totals), description: 'Reclaimable as the suppliers are paid' },
      ...ITC_CODES.filter(([k]) => totals[k] > 0).map(([k, code]) => ({ accountId: requireAccount(acc, code), credit: totals[k] })),
    ],
  });
  for (const r of due) {
    await trx.insertInto('itc_reversals').values({
      org_id: orgId, rule: '37', period: month, bill_id: Number(r.billId),
      cgst: toSqlFromPaise(r.reverse.cgst), sgst: toSqlFromPaise(r.reverse.sgst), igst: toSqlFromPaise(r.reverse.igst), cess: toSqlFromPaise(r.reverse.cess),
      unpaid_at_reversal: toSqlFromPaise(r.totalPaise - r.paidPaise), paid_at_reversal: toSqlFromPaise(r.paidPaise),
      journal_entry_id: entry.id, created_by_user_id: userId,
    }).execute();
  }
  return { bills: due.length, totalPaise: sumHeads(totals) };
}

/** Take back, in this month's return, the credit for what has been paid since it was reversed. */
export async function reclaimRule37(trx: Trx, orgId: number, userId: number | null, month: string): Promise<{ bills: number; totalPaise: Paise }> {
  const end = lastDay(month);
  const rows = (await rule37(trx, orgId, end)).filter((r) => r.status === 'reclaimable');
  if (!rows.length) throw badRequest('Nothing reversed under Rule 37 has been paid since.');
  const acc = await accountIds(trx, orgId);
  const totals = rows.reduce((t, r) => ({ cgst: t.cgst + r.reclaim.cgst, sgst: t.sgst + r.reclaim.sgst, igst: t.igst + r.reclaim.igst, cess: t.cess + r.reclaim.cess }), zero());
  await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: end, userId, module: 'purchases',
    memo: `Rule 37: credit taken again on ${rows.length} bill(s) paid since it was reversed`, sourceType: 'itc_reclaim_37', sourceId: null,
    lines: [
      ...ITC_CODES.filter(([k]) => totals[k] > 0).map(([k, code]) => ({ accountId: requireAccount(acc, code), debit: totals[k] })),
      { accountId: requireAccount(acc, CODE.ITC_RECLAIMABLE), credit: sumHeads(totals) },
    ],
  });
  for (const r of rows) {
    await trx.updateTable('itc_reversals').set((eb) => ({
      reclaimed_cgst: eb('reclaimed_cgst', '+', toSqlFromPaise(r.reclaim.cgst)),
      reclaimed_sgst: eb('reclaimed_sgst', '+', toSqlFromPaise(r.reclaim.sgst)),
      reclaimed_igst: eb('reclaimed_igst', '+', toSqlFromPaise(r.reclaim.igst)),
      reclaimed_cess: eb('reclaimed_cess', '+', toSqlFromPaise(r.reclaim.cess)),
    })).where('org_id', '=', orgId).where('rule', '=', '37').where('bill_id', '=', Number(r.billId)).execute();
  }
  return { bills: rows.length, totalPaise: sumHeads(totals) };
}

// ── Rules 42 and 43 ──────────────────────────────────────────────────────────

export interface CommonCredit {
  period: string;
  /** Exempt and nil-rated supplies (E), and all supplies of the registration (F). */
  exemptPaise: Paise;
  turnoverPaise: Paise;
  ratio: number;
  /** Rule 42: credit on inputs and services of the period (C2), and the exempt share (D1). */
  common: TaxHeads;
  rule42: TaxHeads;
  /** Rule 43: a sixtieth of each capital good's credit within five years (Tm), and its exempt share (Te). */
  capitalMonthly: TaxHeads;
  rule43: TaxHeads;
  posted: boolean;
}

/** E and F for a range: supplies by value, net of credit notes, exports and SEZ counted in F only. */
async function turnover(ex: Executor, orgId: number, from: string, to: string): Promise<{ exempt: Paise; total: Paise }> {
  const { rows } = await sql<{ exempt: string; total: string }>`
    SELECT COALESCE(SUM(CASE WHEN x.supply_type = 'nil_or_exempt' OR (x.rate = 0 AND x.supply_type IN ('intra', 'inter')) THEN x.taxable * x.sign ELSE 0 END), 0) AS exempt,
           COALESCE(SUM(x.taxable * x.sign), 0) AS total
      FROM (
        SELECT i.supply_type, l.gst_rate_pct AS rate, l.taxable, 1 AS sign
          FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.invoice_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT COALESCE(i.supply_type, 'intra'), cl.gst_rate_pct, cl.taxable, -1
          FROM credit_note_lines cl JOIN credit_notes n ON n.id = cl.credit_note_id
          LEFT JOIN invoices i ON i.id = n.against_invoice_id
         WHERE n.org_id = ${orgId} AND n.status <> 'void' AND n.note_date BETWEEN ${from} AND ${to}
      ) x
  `.execute(ex);
  return { exempt: p(rows[0]?.exempt ?? '0'), total: p(rows[0]?.total ?? '0') };
}

async function creditOn(ex: Executor, orgId: number, from: string, to: string, kind: 'inputs' | 'capital'): Promise<TaxHeads> {
  const elig = kind === 'inputs' ? sql`= 'eligible'` : sql`= 'capital_goods'`;
  const { rows } = await sql<{ cgst: string; sgst: string; igst: string; cess: string }>`
    SELECT COALESCE(SUM(l.cgst), 0) AS cgst, COALESCE(SUM(l.sgst), 0) AS sgst, COALESCE(SUM(l.igst), 0) AS igst, COALESCE(SUM(l.cess), 0) AS cess
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND l.itc_eligibility ${elig}
       AND b.bill_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  const e = await sql<{ cgst: string; sgst: string; igst: string }>`
    SELECT COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(igst), 0) AS igst
      FROM expenses WHERE org_id = ${orgId} AND status <> 'void' AND itc_eligibility ${elig} AND expense_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  return {
    cgst: p(rows[0].cgst) + p(e.rows[0].cgst), sgst: p(rows[0].sgst) + p(e.rows[0].sgst),
    igst: p(rows[0].igst) + p(e.rows[0].igst), cess: p(rows[0].cess),
  };
}

export async function commonCredit(ex: Executor, orgId: number, month: string): Promise<CommonCredit> {
  const from = `${month}-01`;
  const to = lastDay(month);
  const t = await turnover(ex, orgId, from, to);
  const ratio = t.total > 0 ? Math.max(0, Math.min(1, t.exempt / t.total)) : 0;
  const common = await creditOn(ex, orgId, from, to, 'inputs');
  // Capital goods whose five years include this month: invoices from the 60 months to its end.
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - 59, 1)).toISOString().slice(0, 10);
  const capital = await creditOn(ex, orgId, start, to, 'capital');
  const capitalMonthly = share(capital, 1 / 60);
  const posted = await ex.selectFrom('itc_reversals').select('id').where('org_id', '=', orgId)
    .where('rule', 'in', ['42', '43']).where('period', '=', month).executeTakeFirst();
  return {
    period: month, exemptPaise: t.exempt, turnoverPaise: t.total, ratio,
    common, rule42: share(common, ratio), capitalMonthly, rule43: share(capitalMonthly, ratio), posted: !!posted,
  };
}

/** Post the month's Rule 42 and 43 reversals: a cost, against the input-tax ledgers. */
export async function postCommonCredit(trx: Trx, orgId: number, userId: number | null, month: string): Promise<CommonCredit> {
  const c = await commonCredit(trx, orgId, month);
  if (c.posted) throw conflict(`The Rule 42 and 43 reversal for ${month} is already posted.`);
  const total: TaxHeads = { cgst: c.rule42.cgst + c.rule43.cgst, sgst: c.rule42.sgst + c.rule43.sgst, igst: c.rule42.igst + c.rule43.igst, cess: c.rule42.cess + c.rule43.cess };
  if (sumHeads(total) <= 0) throw badRequest(`Nothing to reverse for ${month}: ${c.exemptPaise ? 'no common credit' : 'no exempt supplies'} in the month.`);
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: lastDay(month), userId, module: 'purchases',
    memo: `Rules 42/43: exempt share (${(c.ratio * 100).toFixed(2)}%) of common credit for ${month}`, sourceType: 'itc_reversal_42', sourceId: null,
    lines: [
      { accountId: requireAccount(acc, CODE.ITC_REVERSED_EXEMPT), debit: sumHeads(total) },
      ...ITC_CODES.filter(([k]) => total[k] > 0).map(([k, code]) => ({ accountId: requireAccount(acc, code), credit: total[k] })),
    ],
  });
  for (const [rule, h] of [['42', c.rule42], ['43', c.rule43]] as const) {
    if (sumHeads(h) <= 0) continue;
    await trx.insertInto('itc_reversals').values({
      org_id: orgId, rule, period: month, cgst: toSqlFromPaise(h.cgst), sgst: toSqlFromPaise(h.sgst), igst: toSqlFromPaise(h.igst), cess: toSqlFromPaise(h.cess),
      journal_entry_id: entry.id, created_by_user_id: userId,
    }).execute();
  }
  return { ...c, posted: true };
}

/**
 * Rule 42(2): after the year, the exempt share worked out on the year's own
 * figures, against what the months reversed. More is reversed by September;
 * less is taken back as credit.
 */
export async function commonCreditYear(ex: Executor, orgId: number, fy: number) {
  const from = `${fy}-04-01`;
  const to = `${fy + 1}-03-31`;
  const t = await turnover(ex, orgId, from, to);
  const ratio = t.total > 0 ? Math.max(0, Math.min(1, t.exempt / t.total)) : 0;
  const credit = await creditOn(ex, orgId, from, to, 'inputs');
  const due = share(credit, ratio);
  const posted = await ex.selectFrom('itc_reversals').select([
    sql<string>`COALESCE(SUM(cgst), 0)`.as('cgst'), sql<string>`COALESCE(SUM(sgst), 0)`.as('sgst'),
    sql<string>`COALESCE(SUM(igst), 0)`.as('igst'), sql<string>`COALESCE(SUM(cess), 0)`.as('cess'),
  ]).where('org_id', '=', orgId).where('rule', '=', '42').where('period', '>=', `${fy}-04`).where('period', '<=', `${fy + 1}-03`).executeTakeFirst();
  const done: TaxHeads = { cgst: p(posted?.cgst ?? '0'), sgst: p(posted?.sgst ?? '0'), igst: p(posted?.igst ?? '0'), cess: p(posted?.cess ?? '0') };
  const trueUp = await ex.selectFrom('itc_reversals').select('id').where('org_id', '=', orgId).where('rule', '=', '42-annual').where('period', '=', String(fy)).executeTakeFirst();
  return {
    fy, exemptPaise: t.exempt, turnoverPaise: t.total, ratio, credit, due, reversed: done,
    difference: { cgst: due.cgst - done.cgst, sgst: due.sgst - done.sgst, igst: due.igst - done.igst, cess: due.cess - done.cess },
    trueUpPosted: !!trueUp,
  };
}

export async function postCommonCreditYear(trx: Trx, orgId: number, userId: number | null, fy: number) {
  const now = localToday();
  if (now <= `${fy + 1}-03-31`) throw badRequest('The true-up is worked out once the year has ended, in a return no later than September.');
  const y = await commonCreditYear(trx, orgId, fy);
  if (y.trueUpPosted) throw conflict(`The true-up for FY ${fy}-${String(fy + 1).slice(2)} is already posted.`);
  const d = y.difference;
  if (sumHeads(d) === 0) throw badRequest('The months already reversed exactly the year’s share.');
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: now, userId, module: 'purchases',
    memo: `Rule 42(2): annual true-up of common credit for FY ${fy}-${String(fy + 1).slice(2)} (${(y.ratio * 100).toFixed(2)}%)`,
    sourceType: 'itc_reversal_42', sourceId: null,
    // A positive difference reverses more; a negative one takes credit back.
    lines: [
      sumHeads(d) > 0
        ? { accountId: requireAccount(acc, CODE.ITC_REVERSED_EXEMPT), debit: sumHeads(d) }
        : { accountId: requireAccount(acc, CODE.ITC_REVERSED_EXEMPT), credit: -sumHeads(d) },
      ...ITC_CODES.filter(([k]) => d[k] !== 0).map(([k, code]) => (d[k] > 0 ? { accountId: requireAccount(acc, code), credit: d[k] } : { accountId: requireAccount(acc, code), debit: -d[k] })),
    ],
  });
  await trx.insertInto('itc_reversals').values({
    org_id: orgId, rule: '42-annual', period: String(fy),
    cgst: toSqlFromPaise(d.cgst), sgst: toSqlFromPaise(d.sgst), igst: toSqlFromPaise(d.igst), cess: toSqlFromPaise(d.cess),
    journal_entry_id: entry.id, created_by_user_id: userId,
  }).execute();
  return commonCreditYear(trx, orgId, fy);
}
