import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Cash-flow forecast: the next thirteen weeks of bank and cash, from what the
// books already know is coming.
//
//   starts at   today's balance in every bank, cash and wallet account
//   money in    cheques in hand, post-dated ones on their dates; open
//               invoices on their due dates; recurring invoices on the date
//               each will fall due; post-dated entries into the bank
//   money out   cheques issued and not yet presented; open bills on their
//               due dates; recurring journals paid from the bank; salaries at
//               the last run's net pay, monthly; post-dated entries out
//
// A cheque already given for an invoice is that invoice being paid, on the
// cheque's date: the party's open invoices or bills, oldest first, are taken
// down by it so the same money is not counted twice.
//
// It leans cautious. A bill already past due is counted in the first week, as
// it should be paid now; an invoice already past due is shown but not counted
// unless asked for, because a customer who is late already may be later still.
// Customers can also be assumed to pay a number of days after their due date.
// Tax payments are left out: what falls due depends on returns not yet made.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { advancePeriod, TERM_DAYS, type Frequency, type TemplateLine } from '../services/recurring';

export type ForecastKind = 'receivable' | 'payable' | 'cheque' | 'recurring_invoice' | 'recurring_journal' | 'payroll' | 'post_dated';

export interface ForecastItem {
  date: string;
  kind: ForecastKind;
  label: string;
  /** In is positive, out negative. */
  amountPaise: Paise;
  href: string | null;
  overdue?: boolean;
}

export interface ForecastWeek {
  start: string;
  end: string;
  inPaise: Paise;
  outPaise: Paise;
  closingPaise: Paise;
  items: ForecastItem[];
}

export interface CashForecast {
  today: string;
  horizon: string;
  openingPaise: Paise;
  accounts: { name: string; kind: string; balancePaise: Paise }[];
  /** Past-due invoices: counted only when asked for. */
  overdueReceivablesPaise: Paise;
  overdueReceivablesCounted: boolean;
  /** Past-due bills: always counted, in the first week. */
  overduePayablesPaise: Paise;
  lowestPaise: Paise;
  lowestWeek: string;
  weeks: ForecastWeek[];
}

const ymd = (v: unknown) => String(v).slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const LIQUID = ['bank', 'cash', 'wallet'] as const;

export async function cashForecast(
  ex: Executor, orgId: number,
  opts: { today: string; weeks?: number; lateDays?: number; countOverdueReceivables?: boolean },
): Promise<CashForecast> {
  const weeks = Math.min(Math.max(opts.weeks ?? 13, 1), 26);
  const today = opts.today;
  const horizon = addDays(today, weeks * 7 - 1);
  const late = Math.max(0, Math.round(opts.lateDays ?? 0));
  const items: ForecastItem[] = [];

  // ── Where the money is now ────────────────────────────────────────────────
  const banks = await ex.selectFrom('bank_accounts as b')
    .leftJoin('journal_lines as l', (j) => j.onRef('l.account_id', '=', 'b.ledger_account_id').on('l.entry_date', '<=', today))
    .select((eb) => ['b.name', 'b.kind', 'b.ledger_account_id', eb.fn.coalesce(eb.fn.sum<string>(eb('l.debit', '-', eb.ref('l.credit'))), eb.val('0')).as('balance')])
    .where('b.org_id', '=', orgId).where('b.is_active', '=', 1).where('b.kind', 'in', [...LIQUID])
    .groupBy(['b.id', 'b.name', 'b.kind', 'b.ledger_account_id']).execute();
  const liquid = new Set(banks.map((b) => b.ledger_account_id));
  const accounts = banks.map((b) => ({ name: b.name, kind: b.kind, balancePaise: toPaiseFromSql(b.balance) }));
  const openingPaise = accounts.reduce((t, a) => t + a.balancePaise, 0);

  // ── Cheques not yet in the bank ───────────────────────────────────────────
  // In hand or deposited, and not tied to a payment already recorded (that
  // money is in the opening balance). Each covers the party's oldest owed.
  const cheques = await ex.selectFrom('cheques as q').innerJoin('contacts as c', 'c.id', 'q.contact_id')
    .select(['q.cheque_no', 'q.kind', 'q.amount', 'q.maturity_date', 'q.is_pdc', 'q.contact_id', 'c.display_name'])
    .where('q.org_id', '=', orgId).where('q.status', 'in', ['in_hand', 'deposited']).where('q.payment_id', 'is', null).execute();
  const cover = new Map<string, Paise>();
  for (const q of cheques) {
    const amount = toPaiseFromSql(q.amount);
    const key = `${q.kind}:${q.contact_id}`;
    cover.set(key, (cover.get(key) ?? 0) + amount);
    const when = ymd(q.maturity_date) < today ? today : ymd(q.maturity_date);
    if (when > horizon) continue;
    items.push({
      date: when, kind: 'cheque', href: '/banking/cheques',
      label: `Cheque ${q.cheque_no} ${q.kind === 'received' ? 'from' : 'to'} ${q.display_name}${q.is_pdc ? ', post-dated' : ''}`,
      amountPaise: q.kind === 'received' ? amount : -amount,
    });
  }
  /** What is still owed on a document once the party's cheques are set against it. */
  const uncovered = (key: string, left: Paise) => {
    const c = Math.min(cover.get(key) ?? 0, left);
    if (c > 0) cover.set(key, (cover.get(key) ?? 0) - c);
    return left - c;
  };

  // ── Invoices and bills still owed ─────────────────────────────────────────
  const invoices = await ex.selectFrom('invoices as d').innerJoin('contacts as c', 'c.id', 'd.customer_id')
    .select(['d.id', 'd.number', 'd.due_date', 'd.total', 'd.amount_paid', 'd.customer_id', 'c.display_name'])
    .where('d.org_id', '=', orgId).where('d.status', 'in', ['approved', 'sent', 'overdue', 'partially_paid'])
    .orderBy('d.due_date').orderBy('d.id').execute();
  let overdueReceivablesPaise = 0;
  for (const d of invoices) {
    const left = uncovered(`received:${d.customer_id}`, toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid));
    if (left <= 0) continue;
    const due = ymd(d.due_date);
    const overdue = due < today;
    if (overdue) overdueReceivablesPaise += left;
    if (overdue && !opts.countOverdueReceivables) continue;
    const when = overdue ? today : addDays(due, late);
    if (when > horizon) continue;
    items.push({ date: when, kind: 'receivable', label: `${d.number} · ${d.display_name}`, amountPaise: left, href: `/sales/invoices/${d.id}`, overdue });
  }

  const bills = await ex.selectFrom('bills as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
    .select(['d.id', 'd.internal_no', 'd.due_date', 'd.total', 'd.amount_paid', 'd.vendor_id', 'c.display_name'])
    .where('d.org_id', '=', orgId).where('d.status', 'in', ['open', 'overdue', 'partially_paid'])
    .orderBy('d.due_date').orderBy('d.id').execute();
  let overduePayablesPaise = 0;
  for (const d of bills) {
    const left = uncovered(`issued:${d.vendor_id}`, toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid));
    if (left <= 0) continue;
    const due = ymd(d.due_date);
    const overdue = due < today;
    if (overdue) overduePayablesPaise += left;
    const when = overdue ? today : due;
    if (when > horizon) continue;
    items.push({ date: when, kind: 'payable', label: `${d.internal_no} · ${d.display_name}`, amountPaise: -left, href: `/purchases/bills/${d.id}`, overdue });
  }

  // ── Recurring profiles, each run in the window ────────────────────────────
  const runs = function* (next: string, frequency: Frequency, end: string | null) {
    for (let d = next, n = 0; d <= horizon && (!end || d <= end) && n < 60; d = advancePeriod(d, frequency), n++) yield d;
  };
  const recurringInvoices = await ex.selectFrom('recurring_invoices as r').innerJoin('contacts as c', 'c.id', 'r.customer_id')
    .select(['r.profile_name', 'r.next_run', 'r.end_date', 'r.frequency', 'r.payment_terms', 'r.template', 'c.display_name'])
    .where('r.org_id', '=', orgId).where('r.is_active', '=', 1).execute();
  for (const r of recurringInvoices) {
    const template = (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as TemplateLine[];
    const total = template.reduce((t, l) => {
      const taxable = Math.round(l.ratePaise * l.qty);
      return t + taxable + Math.round((taxable * l.gstRatePct) / 100);
    }, 0);
    const terms = TERM_DAYS[r.payment_terms ?? 'net_30'] ?? 30;
    for (const run of runs(ymd(r.next_run), r.frequency as Frequency, r.end_date ? ymd(r.end_date) : null)) {
      const when = addDays(run, terms + late);
      if (when < today || when > horizon) continue;
      items.push({ date: when, kind: 'recurring_invoice', label: `${r.profile_name} · ${r.display_name} (raised ${run})`, amountPaise: total, href: '/sales/recurring' });
    }
  }

  if (liquid.size) {
    const recurringJournals = await ex.selectFrom('recurring_journals')
      .select(['name', 'next_run', 'end_date', 'frequency', 'amount', 'debit_account_id', 'credit_account_id'])
      .where('org_id', '=', orgId).where('is_active', '=', 1).execute();
    for (const r of recurringJournals) {
      const sign = (liquid.has(r.debit_account_id) ? 1 : 0) - (liquid.has(r.credit_account_id) ? 1 : 0);
      if (!sign) continue;
      for (const run of runs(ymd(r.next_run), r.frequency as Frequency, r.end_date ? ymd(r.end_date) : null)) {
        if (run < today) continue;
        items.push({ date: run, kind: 'recurring_journal', label: r.name, amountPaise: sign * toPaiseFromSql(r.amount), href: '/accountant/recurring-journals' });
      }
    }

    // Post-dated entries that move money in or out of the bank.
    const held = await ex.selectFrom('held_journals').select(['id', 'entry_date', 'memo', 'entry_lines'])
      .where('org_id', '=', orgId).where('status', '=', 'held').where('kind', '=', 'post_dated')
      .where('entry_date', '<=', horizon).execute();
    for (const h of held) {
      const lines = (typeof h.entry_lines === 'string' ? JSON.parse(h.entry_lines) : h.entry_lines) as { accountId: number; debitPaise?: number; creditPaise?: number }[];
      const net = lines.filter((l) => liquid.has(l.accountId)).reduce((t, l) => t + (l.debitPaise ?? 0) - (l.creditPaise ?? 0), 0);
      if (net) items.push({ date: ymd(h.entry_date) < today ? today : ymd(h.entry_date), kind: 'post_dated', label: h.memo, amountPaise: net, href: '/accountant/journals' });
    }
  }

  // ── Salaries: the last run's net pay, each month on the same day ──────────
  const lastRun = await ex.selectFrom('payroll_runs as r').innerJoin('payroll_lines as l', 'l.run_id', 'r.id')
    .select((eb) => ['r.month', 'r.paid_on', eb.fn.sum<string>('l.net_pay').as('net')])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid'])
    .groupBy(['r.id', 'r.month', 'r.paid_on']).orderBy('r.month', 'desc').limit(1).executeTakeFirst();
  if (lastRun && toPaiseFromSql(lastRun.net) > 0) {
    const net = toPaiseFromSql(lastRun.net);
    const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    let month = String(lastRun.month).slice(0, 7);
    // Each later month is paid a month after the last payment. A run posted
    // but not yet paid is owed now, from the 1st of the month after it.
    let paid: string;
    if (lastRun.paid_on) paid = ymd(lastRun.paid_on);
    else {
      const owed = advancePeriod(`${month}-01`, 'monthly');
      paid = owed < today ? today : owed;
      if (paid <= horizon) items.push({ date: paid, kind: 'payroll', label: `Salaries for ${monthName(month)}, posted and not yet paid`, amountPaise: -net, href: '/payroll/runs' });
    }
    for (let k = 0; k < 8; k++) {
      paid = advancePeriod(paid, 'monthly');
      month = advancePeriod(`${month}-01`, 'monthly').slice(0, 7);
      if (paid > horizon) break;
      if (paid < today) continue;
      items.push({ date: paid, kind: 'payroll', label: `Salaries for ${monthName(month)}, at the last run's net pay`, amountPaise: -net, href: '/payroll/runs' });
    }
  }

  // ── Into weeks ────────────────────────────────────────────────────────────
  items.sort((a, b) => a.date.localeCompare(b.date) || b.amountPaise - a.amountPaise);
  let running = openingPaise;
  let lowestPaise = openingPaise;
  let lowestWeek = today;
  const out: ForecastWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(today, w * 7);
    const end = addDays(start, 6);
    const these = items.filter((i) => i.date >= start && i.date <= end);
    const inPaise = these.filter((i) => i.amountPaise > 0).reduce((t, i) => t + i.amountPaise, 0);
    const outPaise = these.filter((i) => i.amountPaise < 0).reduce((t, i) => t - i.amountPaise, 0);
    running += inPaise - outPaise;
    if (running < lowestPaise) { lowestPaise = running; lowestWeek = start; }
    out.push({ start, end, inPaise, outPaise, closingPaise: running, items: these });
  }
  return {
    today, horizon, openingPaise, accounts,
    overdueReceivablesPaise, overdueReceivablesCounted: !!opts.countOverdueReceivables, overduePayablesPaise,
    lowestPaise, lowestWeek, weeks: out,
  };
}
