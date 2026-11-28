import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Integration check (status review 7, item 14): do the payroll and inventory
// sub-ledgers agree with the general ledger?
//
// Payroll vs GL
//   * Each pay run in the period: the register's totals (gross, employer
//     contributions, reimbursements, each statutory liability, advances
//     recovered, net pay) against what its own entries — the posting, net of
//     any reversal on reopening — put in each ledger account.
//   * Each imported salary register (payroll-import.ts) the same way.
//   * Each payroll liability at the period's end: what the documents say is
//     still owed (posted by runs and imports, less dues paid, challans
//     deposited and salaries paid) against the account's balance. Entries in
//     the account from anywhere else (a manual journal, a supplier's TDS) are
//     listed, so a difference is explained, not just shown.
//
// Inventory vs GL
//   * The stock valuation at the period's end, from the documents
//     (reports/stock.ts stockPosition), against the Inventory account
//     (reports/statements.ts inventoryInLedger). On a perpetual book these
//     agree once the month-end true-up has posted; mid-month the difference is
//     the items that moved since, listed. On a periodic book the ledger carries
//     no stock by design (AS 2: the statements value closing stock), which is a
//     stated pass, not a failure.
//   The inventory side is read only through those two functions, so this
//   screen follows however stock is posted.
//
// External integration: payroll imported from another system, and the Tally
// sync, import and export, with when each last ran.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE, accountIds } from '../ledger/chart-of-accounts';
import { stockPosition } from '../reports/stock';
import { inventoryInLedger } from '../reports/statements';
import { getPolicies } from './org-settings';

const p = toPaiseFromSql;
const ymd = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };
const prevMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };

/** Entries that belong to payroll: runs, imports, settlements, and the payments of them. */
const PAYROLL_SOURCES = ['payroll', 'payroll_payment', 'statutory_payment', 'salary_tds_challan', 'payroll_import', 'payroll_import_payment', 'fnf', 'fnf_payment'];

export interface CheckLine { label: string; code: string | null; accountId: string | null; registerPaise: Paise; ledgerPaise: Paise; differencePaise: Paise }
export interface RunCheck {
  kind: 'run' | 'import'; id: string; month: string; status: string; label: string; employees: number;
  components: { label: string; amountPaise: Paise }[];
  lines: CheckLine[]; entryIds: string[]; ok: boolean;
}
/**
 * A document dated after the check's To date: on neither side of the
 * liability comparison (the ledger as at To does not hold it, so the payroll
 * side leaves it out too), listed so the timing is explained, not shown as a
 * difference.
 */
export interface TimingItem { kind: 'run' | 'import' | 'statutory_payment' | 'tds_challan' | 'salary_payment'; label: string; date: string; amountPaise: Paise; href: string | null }

export interface LiabilityCheck {
  code: string; label: string; accountId: string | null;
  postedPaise: Paise; settledPaise: Paise; subledgerPaise: Paise;
  ledgerPaise: Paise; settlementsPaise: Paise; otherPaise: Paise; differencePaise: Paise; ok: boolean;
  other: { entryId: string; entryNo: number; date: string; source: string; memo: string | null; amountPaise: Paise }[];
}

async function movementBySource(ex: Executor, orgId: number, sourceType: string, sourceIds: number[]) {
  if (!sourceIds.length) return [];
  return ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id').innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['e.source_id', 'a.code', 'l.account_id', sql<string>`SUM(l.debit - l.credit)`.as('net')])
    .where('e.org_id', '=', orgId).where('e.source_type', '=', sourceType).where('e.source_id', 'in', sourceIds)
    .groupBy(['e.source_id', 'a.code', 'l.account_id']).execute();
}

export async function payrollVsLedger(ex: Executor, orgId: number, from: string, to: string) {
  const acc = await accountIds(ex, orgId);
  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);
  const id = (code: string) => (acc[code] ? String(acc[code]) : null);
  const [runs, imports] = await Promise.all([
    ex.selectFrom('payroll_runs').select(['id', 'month', 'status', 'journal_entry_id']).where('org_id', '=', orgId)
      .where('status', 'in', ['posted', 'paid']).where('month', '>=', fromMonth).where('month', '<=', toMonth).orderBy('month').execute(),
    ex.selectFrom('payroll_imports').selectAll().where('org_id', '=', orgId).where('status', '=', 'posted')
      .where('month', '>=', fromMonth).where('month', '<=', toMonth).orderBy('month').execute(),
  ]);
  const runLines = runs.length
    ? await ex.selectFrom('payroll_lines').select(['run_id', sql<number>`COUNT(*)`.as('n'),
      ...(['basic', 'da', 'hra', 'special', 'other', 'bonus', 'arrears', 'gross', 'reimbursement', 'pf_employee', 'pf_employer_epf', 'pf_employer_eps', 'pf_admin', 'pf_edli',
        'esi_employee', 'esi_employer', 'pt', 'lwf_employee', 'lwf_employer', 'tds', 'advance_recovery', 'net_pay'] as const).map((k) => sql<string>`SUM(${sql.ref(k)})`.as(k))])
      .where('run_id', 'in', runs.map((r) => r.id)).groupBy('run_id').execute()
    : [];
  const [runGl, importGl] = await Promise.all([
    movementBySource(ex, orgId, 'payroll', runs.map((r) => r.id)),
    movementBySource(ex, orgId, 'payroll_import', imports.map((i) => i.id)),
  ]);
  const entriesOf = async (sourceType: string, sourceId: number) => (await ex.selectFrom('journal_entries').select('id')
    .where('org_id', '=', orgId).where('source_type', '=', sourceType).where('source_id', '=', sourceId).execute()).map((e) => String(e.id));
  const gl = (rows: typeof runGl, sourceId: number, code: string, credit = false) => {
    const v = rows.filter((r) => Number(r.source_id) === sourceId && r.code === code).reduce((t, r) => t + p(r.net), 0);
    return credit ? -v : v;
  };
  const line = (label: string, code: string, register: Paise, ledger: Paise): CheckLine => ({ label, code, accountId: id(code), registerPaise: register, ledgerPaise: ledger, differencePaise: ledger - register });

  const runChecks: RunCheck[] = [];
  for (const r of runs) {
    const t = runLines.find((x) => x.run_id === r.id);
    const v = (k: string) => p(((t as Record<string, unknown> | undefined)?.[k] as string) ?? '0');
    const lines = [
      line('Salaries & Wages (gross pay)', CODE.SALARIES, v('gross'), gl(runGl, r.id, CODE.SALARIES)),
      line('Employer PF, ESI and LWF', CODE.EMPLOYER_CONTRIBUTIONS, v('pf_employer_epf') + v('pf_employer_eps') + v('pf_admin') + v('pf_edli') + v('esi_employer') + v('lwf_employer'), gl(runGl, r.id, CODE.EMPLOYER_CONTRIBUTIONS)),
      line('Staff reimbursements', CODE.STAFF_REIMBURSEMENTS, v('reimbursement'), gl(runGl, r.id, CODE.STAFF_REIMBURSEMENTS)),
      line('PF Payable', CODE.PF_PAYABLE, v('pf_employee') + v('pf_employer_epf') + v('pf_employer_eps') + v('pf_admin') + v('pf_edli'), gl(runGl, r.id, CODE.PF_PAYABLE, true)),
      line('ESI Payable', CODE.ESI_PAYABLE, v('esi_employee') + v('esi_employer'), gl(runGl, r.id, CODE.ESI_PAYABLE, true)),
      line('Professional Tax Payable', CODE.PT_PAYABLE, v('pt'), gl(runGl, r.id, CODE.PT_PAYABLE, true)),
      line('LWF Payable', CODE.LWF_PAYABLE, v('lwf_employee') + v('lwf_employer'), gl(runGl, r.id, CODE.LWF_PAYABLE, true)),
      line('TDS Payable (salary)', CODE.TDS_PAYABLE, v('tds'), gl(runGl, r.id, CODE.TDS_PAYABLE, true)),
      line('Advances recovered', CODE.LOANS_ADVANCES, v('advance_recovery'), gl(runGl, r.id, CODE.LOANS_ADVANCES, true)),
      line('Salaries Payable (net pay)', CODE.SALARIES_PAYABLE, v('net_pay'), gl(runGl, r.id, CODE.SALARIES_PAYABLE, true)),
    ];
    runChecks.push({
      kind: 'run', id: String(r.id), month: r.month, status: r.status, label: `Pay run ${r.month}`, employees: Number(t?.n ?? 0),
      components: [['Basic', 'basic'], ['Dearness allowance', 'da'], ['House rent allowance', 'hra'], ['Special allowance', 'special'], ['Other allowances', 'other'], ['Bonus', 'bonus'], ['Arrears', 'arrears']]
        .map(([label, k]) => ({ label, amountPaise: v(k) })).filter((c) => c.amountPaise),
      lines, entryIds: await entriesOf('payroll', r.id), ok: lines.every((l) => l.differencePaise === 0),
    });
  }
  for (const i of imports) {
    const lines = [
      line('Salaries & Wages (gross pay)', CODE.SALARIES, p(i.gross), gl(importGl, i.id, CODE.SALARIES)),
      line('Employer PF, ESI and LWF', CODE.EMPLOYER_CONTRIBUTIONS, p(i.employer_cost), gl(importGl, i.id, CODE.EMPLOYER_CONTRIBUTIONS)),
      line('PF Payable', CODE.PF_PAYABLE, p(i.pf), gl(importGl, i.id, CODE.PF_PAYABLE, true)),
      line('ESI Payable', CODE.ESI_PAYABLE, p(i.esi), gl(importGl, i.id, CODE.ESI_PAYABLE, true)),
      line('Professional Tax Payable', CODE.PT_PAYABLE, p(i.pt), gl(importGl, i.id, CODE.PT_PAYABLE, true)),
      line('LWF Payable', CODE.LWF_PAYABLE, p(i.lwf), gl(importGl, i.id, CODE.LWF_PAYABLE, true)),
      line('TDS Payable (salary)', CODE.TDS_PAYABLE, p(i.tds), gl(importGl, i.id, CODE.TDS_PAYABLE, true)),
      line('Advances recovered', CODE.LOANS_ADVANCES, p(i.advances), gl(importGl, i.id, CODE.LOANS_ADVANCES, true)),
      line('Salaries Payable (net pay)', CODE.SALARIES_PAYABLE, p(i.net_pay), gl(importGl, i.id, CODE.SALARIES_PAYABLE, true)),
    ];
    runChecks.push({
      kind: 'import', id: String(i.id), month: i.month, status: 'imported', label: `Imported ${i.month}${i.source_system ? ` (${i.source_system})` : ''}`, employees: i.employees,
      components: [], lines, entryIds: await entriesOf('payroll_import', i.id), ok: lines.every((l) => l.differencePaise === 0),
    });
  }

  // The liabilities at the period's end, from the documents against the ledger.
  //
  // Both sides on one date basis: what is posted up to the To date. A run posts
  // on its month's last day (payroll.ts postRun), so a November run dated
  // 30 November is not in the ledger as at 28 November, and must not be on the
  // payroll side either; otherwise every liability shows a false difference
  // mid-month. Payments, challans and salary payments already count by their
  // own dates. What falls after To is listed under timing, with its date.
  const postedThrough = lastDay(toMonth) <= to ? toMonth : prevMonth(toMonth);
  const toM = postedThrough;
  const allRuns = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select([sql<string>`SUM(l.pf_employee + l.pf_employer_epf + l.pf_employer_eps + l.pf_admin + l.pf_edli)`.as('pf'),
      sql<string>`SUM(l.esi_employee + l.esi_employer)`.as('esi'), sql<string>`SUM(l.pt)`.as('pt'), sql<string>`SUM(l.lwf_employee + l.lwf_employer)`.as('lwf'),
      sql<string>`SUM(l.tds)`.as('tds'), sql<string>`SUM(l.net_pay)`.as('net')])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid']).where('r.month', '<=', toM).executeTakeFirst();
  const allImports = await ex.selectFrom('payroll_imports').select([sql<string>`COALESCE(SUM(pf),0)`.as('pf'), sql<string>`COALESCE(SUM(esi),0)`.as('esi'),
    sql<string>`COALESCE(SUM(pt),0)`.as('pt'), sql<string>`COALESCE(SUM(lwf),0)`.as('lwf'), sql<string>`COALESCE(SUM(tds),0)`.as('tds'), sql<string>`COALESCE(SUM(net_pay),0)`.as('net')])
    .where('org_id', '=', orgId).where('status', '=', 'posted').where('month', '<=', toM).executeTakeFirst();
  const statPaid = await ex.selectFrom('statutory_payments').select(['component', sql<string>`SUM(amount)`.as('v')])
    .where('org_id', '=', orgId).where('paid_on', '<=', to).groupBy('component').execute();
  const challans = await ex.selectFrom('salary_tds_challans').select(sql<string>`COALESCE(SUM(tax + surcharge + cess), 0)`.as('v'))
    .where('org_id', '=', orgId).where('challan_date', '<=', to).executeTakeFirst();
  const salPaid = await ex.selectFrom('payroll_payments').select(sql<string>`COALESCE(SUM(amount), 0)`.as('v'))
    .where('org_id', '=', orgId).where('reversed', '=', 0).where('paid_on', '<=', to).executeTakeFirst();
  // Runs paid before payments were kept per employee: their one payment entry.
  const legacyPaid = await ex.selectFrom('payroll_runs as r').select(sql<string>`COALESCE(SUM((SELECT SUM(l.net_pay) FROM payroll_lines l WHERE l.run_id = r.id)), 0)`.as('v'))
    .where('r.org_id', '=', orgId).where('r.status', '=', 'paid').where('r.paid_on', '<=', to)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('payroll_payments as x').select('x.id').whereRef('x.run_id', '=', 'r.id')))).executeTakeFirst();
  const importPaid = await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .select(sql<string>`COALESCE(SUM(l.debit - l.credit), 0)`.as('v'))
    .where('e.org_id', '=', orgId).where('e.source_type', '=', 'payroll_import_payment').where('l.account_id', '=', acc[CODE.SALARIES_PAYABLE] ?? 0).where('l.entry_date', '<=', to).executeTakeFirst();
  const r0 = (v: unknown) => p((v as string) ?? '0');
  const paidOf = (c: string) => r0(statPaid.find((x) => x.component === c)?.v);
  const subledger: Record<string, { label: string; posted: Paise; settled: Paise }> = {
    [CODE.PF_PAYABLE]: { label: 'PF Payable', posted: r0(allRuns?.pf) + r0(allImports?.pf), settled: paidOf('pf') },
    [CODE.ESI_PAYABLE]: { label: 'ESI Payable', posted: r0(allRuns?.esi) + r0(allImports?.esi), settled: paidOf('esi') },
    [CODE.PT_PAYABLE]: { label: 'Professional Tax Payable', posted: r0(allRuns?.pt) + r0(allImports?.pt), settled: paidOf('pt') },
    [CODE.LWF_PAYABLE]: { label: 'LWF Payable', posted: r0(allRuns?.lwf) + r0(allImports?.lwf), settled: paidOf('lwf') },
    [CODE.TDS_PAYABLE]: { label: 'TDS Payable (salary part)', posted: r0(allRuns?.tds) + r0(allImports?.tds), settled: r0(challans?.v) },
    [CODE.SALARIES_PAYABLE]: { label: 'Salaries Payable', posted: r0(allRuns?.net) + r0(allImports?.net), settled: r0(salPaid?.v) + r0(legacyPaid?.v) + r0(importPaid?.v) },
  };
  const liabilities: LiabilityCheck[] = [];
  for (const [code, s] of Object.entries(subledger)) {
    const accountId = acc[code];
    const lines = accountId
      ? await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
        .select(['e.id', 'e.entry_no', 'e.entry_date', 'e.source_type', 'e.memo', sql<string>`SUM(l.credit - l.debit)`.as('v')])
        .where('l.org_id', '=', orgId).where('l.account_id', '=', accountId).where('l.entry_date', '<=', to)
        .groupBy(['e.id', 'e.entry_no', 'e.entry_date', 'e.source_type', 'e.memo']).execute()
      : [];
    const ledger = lines.reduce((t, l) => t + p(l.v), 0);
    const settlements = lines.filter((l) => l.source_type === 'fnf' || l.source_type === 'fnf_payment').reduce((t, l) => t + p(l.v), 0);
    const others = lines.filter((l) => !PAYROLL_SOURCES.includes(l.source_type));
    const other = others.reduce((t, l) => t + p(l.v), 0);
    const sub = s.posted - s.settled;
    const diff = ledger - settlements - other - sub;
    liabilities.push({
      code, label: s.label, accountId: accountId ? String(accountId) : null, postedPaise: s.posted, settledPaise: s.settled, subledgerPaise: sub,
      ledgerPaise: ledger, settlementsPaise: settlements, otherPaise: other, differencePaise: diff, ok: diff === 0,
      other: others.filter((l) => p(l.v) !== 0).slice(0, 50).map((l) => ({
        entryId: String(l.id), entryNo: l.entry_no, date: ymd(l.entry_date)!, source: l.source_type, memo: l.memo, amountPaise: p(l.v),
      })),
    });
  }
  // What the To date leaves out on both sides, with its date: runs and imports
  // of the period that post after To, and payments dated after To for months up to To's.
  const timing: TimingItem[] = [];
  for (const r of runs) if (lastDay(r.month) > to) {
    const t = runLines.find((x) => x.run_id === r.id);
    timing.push({ kind: 'run', label: `Pay run ${r.month} posts on its month's last day`, date: lastDay(r.month), amountPaise: p(((t as Record<string, unknown> | undefined)?.gross as string) ?? '0'), href: `/payroll/runs/${r.id}` });
  }
  for (const i of imports) if (lastDay(i.month) > to) timing.push({ kind: 'import', label: `Imported payroll ${i.month} posts on its month's last day`, date: lastDay(i.month), amountPaise: p(i.gross), href: '/payroll/import' });
  const [laterStat, laterChallans, laterSal] = await Promise.all([
    ex.selectFrom('statutory_payments').select(['component', 'period', 'paid_on', 'amount']).where('org_id', '=', orgId).where('paid_on', '>', to).where('period', '<=', toMonth).execute(),
    ex.selectFrom('salary_tds_challans').select(['for_month', 'challan_date', 'tax', 'surcharge', 'cess']).where('org_id', '=', orgId).where('challan_date', '>', to).where('for_month', '<=', toMonth).execute(),
    ex.selectFrom('payroll_payments as pp').innerJoin('payroll_runs as r', 'r.id', 'pp.run_id').select(['r.month', 'pp.paid_on', sql<string>`SUM(pp.amount)`.as('v')])
      .where('pp.org_id', '=', orgId).where('pp.reversed', '=', 0).where('pp.paid_on', '>', to).where('r.month', '<=', toMonth).groupBy(['r.month', 'pp.paid_on']).execute(),
  ]);
  for (const x of laterStat) timing.push({ kind: 'statutory_payment', label: `${x.component.toUpperCase()} for ${x.period} paid`, date: ymd(x.paid_on)!, amountPaise: p(x.amount), href: '/payroll/statutory' });
  for (const x of laterChallans) timing.push({ kind: 'tds_challan', label: `TDS challan for ${x.for_month}`, date: ymd(x.challan_date)!, amountPaise: p(x.tax) + p(x.surcharge) + p(x.cess), href: '/payroll/statutory' });
  for (const x of laterSal) timing.push({ kind: 'salary_payment', label: `Salaries for ${x.month} paid`, date: ymd(x.paid_on)!, amountPaise: p(x.v), href: '/payroll/runs' });
  timing.sort((a, b) => a.date.localeCompare(b.date));
  const ok = runChecks.every((r) => r.ok) && liabilities.every((l) => l.ok);
  return { runs: runChecks, liabilities, ok, postedThrough: lastDay(postedThrough), timing };
}

export async function inventoryVsLedger(ex: Executor, orgId: number, asOf: string) {
  const policy = (await getPolicies(ex, orgId)).stockAccounting;
  const perpetual = policy.method === 'perpetual' && !!policy.from && asOf >= policy.from;
  const [pos, ledger] = await Promise.all([stockPosition(ex, orgId, asOf, { includeArchived: true }), inventoryInLedger(ex, orgId, asOf)]);
  const acc = await accountIds(ex, orgId);
  const inventory = acc[CODE.INVENTORY];
  // The last time the account was brought into line with the valuation.
  const trueUp = inventory
    ? await ex.selectFrom('journal_entries').select(sql<string>`MAX(entry_date)`.as('d'))
      .where('org_id', '=', orgId).where('source_type', 'in', ['stock_valuation', 'stock_opening']).where('entry_date', '<=', asOf).executeTakeFirst()
    : null;
  const lastTrueUp = ymd(trueUp?.d);
  // What moved the Inventory account in the period since then, by kind of document, for drill-down.
  const movements = inventory
    ? await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .select(['e.source_type', sql<number>`COUNT(DISTINCT e.id)`.as('n'), sql<string>`SUM(l.debit - l.credit)`.as('v')])
      .where('l.org_id', '=', orgId).where('l.account_id', '=', inventory).where('l.entry_date', '<=', asOf)
      .$if(!!lastTrueUp, (q) => q.where('l.entry_date', '>', lastTrueUp!)).groupBy('e.source_type').execute()
    : [];
  const difference = pos.totalValuePaise - ledger;
  // Where they differ: the items whose value moved since the ledger was last brought into line.
  let items: { itemId: string; name: string; sku: string | null; qty: number; valuePaise: Paise; atTrueUpPaise: Paise; movedPaise: Paise }[] = [];
  if (perpetual && difference !== 0) {
    const before = lastTrueUp ? await stockPosition(ex, orgId, lastTrueUp, { includeArchived: true }) : null;
    items = pos.lines.map((l) => {
      const was = before?.lines.find((b) => b.itemId === l.itemId)?.valuePaise ?? 0;
      return { itemId: l.itemId, name: l.name, sku: l.sku, qty: l.qty, valuePaise: l.valuePaise, atTrueUpPaise: was, movedPaise: l.valuePaise - was };
    }).filter((i) => i.movedPaise !== 0).sort((a, b) => Math.abs(b.movedPaise) - Math.abs(a.movedPaise)).slice(0, 100);
  }
  return {
    asOf, method: perpetual ? 'perpetual' as const : 'periodic' as const, perpetualFrom: policy.method === 'perpetual' ? policy.from : null,
    stockValuePaise: pos.totalValuePaise, ledgerPaise: ledger, differencePaise: difference,
    // Periodic: the ledger rightly carries nothing; any balance there is someone's manual entry.
    status: perpetual ? (difference === 0 ? 'pass' as const : 'difference' as const) : (ledger === 0 ? 'pass_periodic' as const : 'difference' as const),
    itemCount: pos.lines.filter((l) => l.qty !== 0).length, lastTrueUp,
    inventoryAccountId: inventory ? String(inventory) : null,
    movements: movements.map((m) => ({ sourceType: m.source_type, entries: Number(m.n), amountPaise: p(m.v) })),
    items,
  };
}

export async function externalIntegrations(ex: Executor, orgId: number) {
  const [imports, companies, vouchers, exports, fileImports] = await Promise.all([
    ex.selectFrom('payroll_imports').select(['month', 'source_system', 'created_at', 'status']).where('org_id', '=', orgId).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
    ex.selectFrom('tally_companies').select(['name', 'last_synced_at', 'last_error', 'maintains_inventory']).where('org_id', '=', orgId).orderBy('last_synced_at', 'desc').execute(),
    ex.selectFrom('tally_voucher_imports').select([sql<string>`MAX(imported_at)`.as('at'), sql<number>`COUNT(*)`.as('n')]).where('org_id', '=', orgId).executeTakeFirst(),
    ex.selectFrom('tally_exports').select(['kind', 'created_at', 'voucher_count', 'ledger_count', 'from_date', 'to_date']).where('org_id', '=', orgId).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
    ex.selectFrom('audit_log').select(['created_at', 'detail', 'target_type']).where('org_id', '=', orgId).where('action', '=', 'import')
      .where((eb) => eb.or([eb('target_type', 'like', 'tally%'), eb('detail', 'like', '%Tally%')])).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
  ]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    payrollImport: imports ? { month: imports.month, source: imports.source_system, at: iso(imports.created_at), status: imports.status } : null,
    tallySync: companies.length ? companies.map((c) => ({ company: c.name, lastSyncedAt: iso(c.last_synced_at), lastError: c.last_error, inventory: !!c.maintains_inventory })) : [],
    tallyVoucherImport: vouchers?.at ? { at: iso(vouchers.at), vouchers: Number(vouchers.n) } : null,
    tallyExport: exports ? { kind: exports.kind, at: iso(exports.created_at), vouchers: exports.voucher_count, ledgers: exports.ledger_count, from: ymd(exports.from_date), to: ymd(exports.to_date) } : null,
    tallyFileImport: fileImports ? { at: iso(fileImports.created_at), detail: fileImports.detail } : null,
  };
}

/** The whole check for a period. */
export async function integrationCheck(ex: Executor, orgId: number, from: string, to: string) {
  const [payroll, inventory, external] = await Promise.all([
    payrollVsLedger(ex, orgId, from, to), inventoryVsLedger(ex, orgId, to), externalIntegrations(ex, orgId),
  ]);
  return { from, to, monthEnd: lastDay(to.slice(0, 7)), payroll, inventory, external };
}
