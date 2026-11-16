import 'server-only';
import { sql } from 'kysely';
import type { Executor } from '@/lib/server/db';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import type { Paise } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// The figures Zoho Books' Home shows, for the dashboard's Zoho cards:
//
// - Total Receivables and Total Payables, each split into what is still
//   current and what is overdue (the blue and orange bar under each);
// - Cash Flow for the financial year: the cash held at its start, the money
//   in and out each month, the balance at each month's end, and at the year's
//   end — across every bank and cash account (credit cards are borrowings,
//   not cash, and are left out as Zoho leaves them out);
// - Income and Expense, month by month for the financial year.
//
// All of it straight from the ledger and the open documents, so the cards
// agree with the reports to the paisa.
// ─────────────────────────────────────────────────────────────────────────────

export interface HomeFigures {
  receivables: { totalPaise: Paise; currentPaise: Paise; overduePaise: Paise };
  payables: { totalPaise: Paise; currentPaise: Paise; overduePaise: Paise };
  cashFlow: {
    from: string;
    to: string;
    openingPaise: Paise;
    incomingPaise: Paise;
    outgoingPaise: Paise;
    closingPaise: Paise;
    months: { month: string; incomingPaise: Paise; outgoingPaise: Paise; closingPaise: Paise }[];
  };
  incomeExpense: {
    incomePaise: Paise;
    expensePaise: Paise;
    months: { month: string; incomePaise: Paise; expensePaise: Paise }[];
  };
}

/** The twelve months of the year that starts on `fyStart`, as YYYY-MM. */
function fyMonths(fyStart: string): string[] {
  const y = Number(fyStart.slice(0, 4));
  const m = Number(fyStart.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function fyEnd(fyStart: string): string {
  const y = Number(fyStart.slice(0, 4));
  const m = Number(fyStart.slice(5, 7)) - 1;
  const d = new Date(Date.UTC(y + 1, m, 0));
  return d.toISOString().slice(0, 10);
}

export async function homeFigures(ex: Executor, orgId: number, fyStart: string, asOf: string): Promise<HomeFigures> {
  const months = fyMonths(fyStart);
  const to = fyEnd(fyStart);

  const party = async (table: 'invoices' | 'bills') => {
    const { rows } = await sql<{ total: string; overdue: string }>`
      SELECT COALESCE(SUM(d.total - d.amount_paid), 0) AS total,
             COALESCE(SUM(CASE WHEN d.due_date < ${asOf} THEN d.total - d.amount_paid ELSE 0 END), 0) AS overdue
        FROM ${sql.table(table)} d
       WHERE d.org_id = ${orgId} AND d.status NOT IN ('draft', 'void') AND d.total > d.amount_paid
    `.execute(ex);
    const total = toPaiseFromSql(rows[0]?.total ?? '0');
    const overdue = toPaiseFromSql(rows[0]?.overdue ?? '0');
    return { totalPaise: total, currentPaise: total - overdue, overduePaise: overdue };
  };

  const cashIds = (
    await ex
      .selectFrom('bank_accounts')
      .select(['ledger_account_id', 'kind'])
      .where('org_id', '=', orgId)
      .execute()
  ).filter((a) => a.kind !== 'card').map((a) => a.ledger_account_id);

  const cashFlow = async (): Promise<HomeFigures['cashFlow']> => {
    if (!cashIds.length) {
      return { from: fyStart, to, openingPaise: 0, incomingPaise: 0, outgoingPaise: 0, closingPaise: 0, months: months.map((month) => ({ month, incomingPaise: 0, outgoingPaise: 0, closingPaise: 0 })) };
    }
    const { rows: open } = await sql<{ v: string }>`
      SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines
       WHERE org_id = ${orgId} AND account_id IN (${sql.join(cashIds)}) AND entry_date < ${fyStart}
    `.execute(ex);
    const { rows } = await sql<{ ym: string; inflow: string; outflow: string }>`
      SELECT DATE_FORMAT(entry_date, '%Y-%m') AS ym, COALESCE(SUM(debit), 0) AS inflow, COALESCE(SUM(credit), 0) AS outflow
        FROM journal_lines
       WHERE org_id = ${orgId} AND account_id IN (${sql.join(cashIds)}) AND entry_date BETWEEN ${fyStart} AND ${to}
       GROUP BY ym
    `.execute(ex);
    const by = new Map(rows.map((r) => [r.ym, r]));
    let running = toPaiseFromSql(open[0]?.v ?? '0');
    const openingPaise = running;
    let incomingPaise = 0;
    let outgoingPaise = 0;
    const out = months.map((month) => {
      const r = by.get(month);
      const inc = toPaiseFromSql(r?.inflow ?? '0');
      const outg = toPaiseFromSql(r?.outflow ?? '0');
      incomingPaise += inc;
      outgoingPaise += outg;
      running += inc - outg;
      return { month, incomingPaise: inc, outgoingPaise: outg, closingPaise: running };
    });
    return { from: fyStart, to, openingPaise, incomingPaise, outgoingPaise, closingPaise: running, months: out };
  };

  const incomeExpense = async (): Promise<HomeFigures['incomeExpense']> => {
    const { rows } = await sql<{ ym: string; income: string; expense: string }>`
      SELECT DATE_FORMAT(jl.entry_date, '%Y-%m') AS ym,
             COALESCE(SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
             COALESCE(SUM(CASE WHEN a.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
        FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE jl.org_id = ${orgId} AND a.type IN ('income', 'expense') AND jl.entry_date BETWEEN ${fyStart} AND ${to}
       GROUP BY ym
    `.execute(ex);
    const by = new Map(rows.map((r) => [r.ym, r]));
    let incomePaise = 0;
    let expensePaise = 0;
    const out = months.map((month) => {
      const r = by.get(month);
      const inc = toPaiseFromSql(r?.income ?? '0');
      const exp = toPaiseFromSql(r?.expense ?? '0');
      incomePaise += inc;
      expensePaise += exp;
      return { month, incomePaise: inc, expensePaise: exp };
    });
    return { incomePaise, expensePaise, months: out };
  };

  const [receivables, payables, cf, ie] = await Promise.all([party('invoices'), party('bills'), cashFlow(), incomeExpense()]);
  return { receivables, payables, cashFlow: cf, incomeExpense: ie };
}
