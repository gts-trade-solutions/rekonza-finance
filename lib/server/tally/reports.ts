import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A Tally company's books, as the portal shows them.
//
// Two kinds of figure, kept apart on purpose:
//
//   Tally's own    closing balances Tally computed on the day of the last sync.
//                  The trial balance, profit and loss and balance sheet are
//                  built from these, so they read as Tally reads — the portal
//                  arranges them and never re-adds them.
//
//   From vouchers  the day book and a ledger's vouchers, for any dates. These
//                  can only be as complete as the vouchers that have arrived,
//                  so a ledger's page also works its balance out from them
//                  and says whether that agrees with Tally's.
//
// Groups are followed up to their primary group by name, the way Tally links
// them. Tally's standard groups are laid out in Tally's own order.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { notFound } from '../http';
import type { TallyNature } from '../../tally/protocol';
import type {
  BalanceSheetView, DayBookRow, DayBookView, FinalLine, LedgerListView, LedgerVouchersView,
  ProfitAndLossView, StockSummaryView, TallyOverview, TrialBalanceNode, TrialBalanceView,
} from '../../tally/views';

const DAY_BOOK_LIMIT = 3000;
const LEDGER_LIMIT = 5000;

/** Tally's primary groups, in the order Tally lists them. */
export const PRIMARY_ORDER = [
  'Capital Account', 'Loans (Liability)', 'Current Liabilities', 'Fixed Assets', 'Investments',
  'Current Assets', 'Branch / Divisions', 'Misc. Expenses (ASSET)', 'Suspense A/c',
  'Sales Accounts', 'Purchase Accounts', 'Direct Incomes', 'Direct Expenses', 'Indirect Incomes',
  'Indirect Expenses',
];

/** The one ledger Tally keeps at the top level rather than under a group. */
export const PROFIT_AND_LOSS_LEDGER = 'Profit & Loss A/c';

const iso = (d: unknown): string | null => {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
};
const day = (d: unknown): string => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);

// ── The company ──────────────────────────────────────────────────────────────

export interface CompanyRow {
  id: number;
  name: string;
  asOf: string | null;
  fyFrom: string;
  maintainsInventory: boolean;
}

/** The start of the financial year a date falls in, given the month and day a year starts. */
export function fyStartFor(date: string, fyFrom: string): string {
  const md = fyFrom.slice(5);
  const year = Number(date.slice(0, 4));
  return date.slice(5) >= md ? `${year}-${md}` : `${year - 1}-${md}`;
}

export async function companyFor(ex: Executor, orgId: number, companyId: number): Promise<CompanyRow> {
  const row = await ex
    .selectFrom('tally_companies')
    .select(['id', 'name', 'as_of', 'fy_from', 'maintains_inventory'])
    .where('id', '=', companyId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound('That Tally company is not connected to this organisation.');
  const asOf = row.as_of ? day(row.as_of) : null;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return {
    id: row.id,
    name: row.name,
    asOf,
    // Without a year start from Tally, India's: 1 April of the year the balances are for.
    fyFrom: row.fy_from ? day(row.fy_from) : fyStartFor(asOf ?? today, '2000-04-01'),
    maintainsInventory: !!row.maintains_inventory,
  };
}

// ── Overview ─────────────────────────────────────────────────────────────────

export async function tallyOverview(ex: Executor, orgId: number): Promise<TallyOverview> {
  const [connectors, companies, counts] = await Promise.all([
    ex
      .selectFrom('tally_connectors')
      .select([
        'id', 'status', 'machine_name', 'connector_version', 'tally_version', 'token_prefix', 'paired_at',
        'last_seen_at', 'last_error', 'pairing_expires_at',
      ])
      .where('org_id', '=', orgId)
      .orderBy('status')
      .orderBy('id', 'desc')
      .execute(),
    ex
      .selectFrom('tally_companies as c')
      .innerJoin('tally_connectors as k', 'k.id', 'c.connector_id')
      .select([
        'c.id', 'c.name', 'c.gstin', 'c.state_name', 'c.books_from', 'c.fy_from', 'c.as_of', 'c.last_synced_at',
        'c.last_error', 'c.maintains_inventory', 'c.connector_id', 'k.machine_name', 'k.status as connector_status',
      ])
      .where('c.org_id', '=', orgId)
      .orderBy('c.name')
      .execute(),
    sql<{ company_id: number; ledgers: string; vouchers: string; items: string; first_date: unknown; last_date: unknown }>`
      SELECT c.id AS company_id,
             (SELECT COUNT(*) FROM tally_ledgers l WHERE l.company_id = c.id) AS ledgers,
             (SELECT COUNT(*) FROM tally_vouchers v WHERE v.company_id = c.id) AS vouchers,
             (SELECT COUNT(*) FROM tally_stock_items s WHERE s.company_id = c.id) AS items,
             (SELECT MIN(date) FROM tally_vouchers v WHERE v.company_id = c.id) AS first_date,
             (SELECT MAX(date) FROM tally_vouchers v WHERE v.company_id = c.id) AS last_date
        FROM tally_companies c
       WHERE c.org_id = ${orgId}
    `.execute(ex),
  ]);

  const countOf = new Map(counts.rows.map((r) => [Number(r.company_id), r]));
  const now = Date.now();
  const pending = connectors.find(
    (k) => k.status === 'pending' && k.pairing_expires_at && new Date(k.pairing_expires_at).getTime() > now,
  );

  return {
    pendingCodeExpiresAt: pending ? iso(pending.pairing_expires_at) : null,
    connectors: connectors
      .filter((k) => k.status !== 'pending')
      .map((k) => ({
        id: String(k.id),
        status: k.status,
        machineName: k.machine_name,
        connectorVersion: k.connector_version,
        tallyVersion: k.tally_version,
        tokenPrefix: k.token_prefix,
        pairedAt: iso(k.paired_at),
        lastSeenAt: iso(k.last_seen_at),
        lastError: k.last_error,
        companies: companies.filter((c) => c.connector_id === k.id).length,
      })),
    companies: companies.map((c) => {
      const n = countOf.get(c.id);
      return {
        id: String(c.id),
        name: c.name,
        gstin: c.gstin,
        stateName: c.state_name,
        booksFrom: c.books_from ? day(c.books_from) : null,
        fyFrom: c.fy_from ? day(c.fy_from) : null,
        asOf: c.as_of ? day(c.as_of) : null,
        lastSyncedAt: iso(c.last_synced_at),
        lastError: c.last_error,
        maintainsInventory: !!c.maintains_inventory,
        connectorName: c.machine_name,
        connectorStatus: c.connector_status,
        ledgers: Number(n?.ledgers ?? 0),
        vouchers: Number(n?.vouchers ?? 0),
        stockItems: Number(n?.items ?? 0),
        firstVoucherDate: n?.first_date ? day(n.first_date) : null,
        lastVoucherDate: n?.last_date ? day(n.last_date) : null,
      };
    }),
  };
}

// ── Groups ───────────────────────────────────────────────────────────────────

interface GroupInfo {
  name: string;
  parent: string | null;
  nature: TallyNature;
  affectsGrossProfit: boolean;
}

export interface GroupTree {
  groups: Map<string, GroupInfo>;
  /** The primary group a group or a ledger's parent belongs to; null when it is not a known group. */
  primaryOf(name: string): string | null;
  /** The chain from a group up to its primary group, the group itself first. */
  chainOf(name: string): string[];
}

export function groupTree(rows: { name: string; parent: string | null; nature: string; affects_gross_profit: number }[]): GroupTree {
  const groups = new Map<string, GroupInfo>(
    rows.map((g) => [
      g.name,
      { name: g.name, parent: g.parent, nature: g.nature as TallyNature, affectsGrossProfit: !!g.affects_gross_profit },
    ]),
  );
  const chainOf = (name: string): string[] => {
    const chain: string[] = [];
    let at: string | null = name;
    // Bounded: a loop in the tree, however it got there, must not hang a page.
    while (at && groups.has(at) && chain.length < 50 && !chain.includes(at)) {
      chain.push(at);
      const parent: string | null = groups.get(at)!.parent;
      at = parent && parent !== 'Primary' ? parent : null;
    }
    return chain;
  };
  return {
    groups,
    chainOf,
    primaryOf: (name) => chainOf(name).at(-1) ?? null,
  };
}

const primaryRank = (name: string) => {
  const i = PRIMARY_ORDER.indexOf(name);
  return i === -1 ? PRIMARY_ORDER.length : i;
};

interface LedgerRow {
  id: number;
  name: string;
  parent: string;
  opening: number;
  closing: number;
  gstin: string | null;
}

async function loadBooks(ex: Executor, companyId: number) {
  const [groups, ledgers] = await Promise.all([
    ex
      .selectFrom('tally_groups')
      .select(['name', 'parent', 'nature', 'affects_gross_profit'])
      .where('company_id', '=', companyId)
      .execute(),
    ex
      .selectFrom('tally_ledgers')
      .select(['id', 'name', 'parent', 'opening_paise', 'closing_paise', 'gstin'])
      .where('company_id', '=', companyId)
      .orderBy('name')
      .execute(),
  ]);
  return {
    tree: groupTree(groups),
    ledgers: ledgers.map(
      (l): LedgerRow => ({
        id: l.id,
        name: l.name,
        parent: l.parent,
        opening: Number(l.opening_paise),
        closing: Number(l.closing_paise),
        gstin: l.gstin,
      }),
    ),
  };
}

// ── Ledgers ──────────────────────────────────────────────────────────────────

export async function ledgerList(ex: Executor, company: CompanyRow): Promise<LedgerListView> {
  const { tree, ledgers } = await loadBooks(ex, company.id);
  return {
    asOf: company.asOf,
    fyFrom: company.fyFrom,
    rows: ledgers.map((l) => ({
      id: String(l.id),
      name: l.name,
      group: l.parent,
      primaryGroup: tree.primaryOf(l.parent) ?? l.parent,
      openingPaise: l.opening,
      closingPaise: l.closing,
      gstin: l.gstin,
    })),
  };
}

/** Sum of a ledger's entries between two dates, inclusive, from vouchers that count. */
async function movement(ex: Executor, companyId: number, ledger: string, from: string | null, to: string | null): Promise<number> {
  let q = ex
    .selectFrom('tally_voucher_entries as e')
    .innerJoin('tally_vouchers as v', 'v.id', 'e.voucher_id')
    .select(sql<string>`COALESCE(SUM(e.debit_paise - e.credit_paise), 0)`.as('net'))
    .where('e.company_id', '=', companyId)
    .where('e.ledger', '=', ledger)
    .where('v.is_optional', '=', 0)
    .where('v.is_cancelled', '=', 0);
  if (from) q = q.where('v.date', '>=', from);
  if (to) q = q.where('v.date', '<=', to);
  const row = await q.executeTakeFirst();
  return Number(row?.net ?? 0);
}

const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export async function ledgerVouchers(
  ex: Executor,
  company: CompanyRow,
  ledgerId: number,
  from: string,
  to: string,
): Promise<LedgerVouchersView> {
  const row = await ex
    .selectFrom('tally_ledgers')
    .select(['id', 'name', 'parent', 'opening_paise', 'closing_paise'])
    .where('id', '=', ledgerId)
    .where('company_id', '=', company.id)
    .executeTakeFirst();
  if (!row) throw notFound('That ledger is not in this company.');

  const groups = await ex
    .selectFrom('tally_groups')
    .select(['name', 'parent', 'nature', 'affects_gross_profit'])
    .where('company_id', '=', company.id)
    .execute();
  const tree = groupTree(groups);
  const nature = tree.groups.get(row.parent)?.nature;
  // Income and expense ledgers start every financial year at nothing; the rest carry their balance.
  const revenue = nature === 'income' || nature === 'expenses';
  const openingFy = revenue ? 0 : Number(row.opening_paise);

  let opening: number;
  if (revenue) {
    const start = fyStartFor(from, company.fyFrom);
    opening = start < from ? await movement(ex, company.id, row.name, start, dayBefore(from)) : 0;
  } else if (from >= company.fyFrom) {
    opening = openingFy + (from > company.fyFrom ? await movement(ex, company.id, row.name, company.fyFrom, dayBefore(from)) : 0);
  } else {
    opening = openingFy - (await movement(ex, company.id, row.name, from, dayBefore(company.fyFrom)));
  }

  const lines = await sql<{
    voucher_id: number; date: unknown; voucher_type: string; number: string | null; narration: string | null;
    debit: string; credit: string;
  }>`
    SELECT v.id AS voucher_id, v.date, v.voucher_type, v.number, v.narration,
           SUM(e.debit_paise) AS debit, SUM(e.credit_paise) AS credit
      FROM tally_voucher_entries e
      JOIN tally_vouchers v ON v.id = e.voucher_id
     WHERE e.company_id = ${company.id} AND e.ledger = ${row.name}
       AND v.date >= ${from} AND v.date <= ${to}
       AND v.is_optional = 0 AND v.is_cancelled = 0
     GROUP BY v.id, v.date, v.voucher_type, v.number, v.narration
     ORDER BY v.date, v.id
     LIMIT ${LEDGER_LIMIT + 1}
  `.execute(ex);
  const truncated = lines.rows.length > LEDGER_LIMIT;
  const shown = lines.rows.slice(0, LEDGER_LIMIT);

  // The other side of each voucher: what Tally shows as its particulars.
  const others = shown.length
    ? await ex
        .selectFrom('tally_voucher_entries')
        .select(['voucher_id', 'ledger', 'debit_paise', 'credit_paise', 'line_no'])
        .where('voucher_id', 'in', shown.map((l) => l.voucher_id))
        .where('ledger', '<>', row.name)
        .orderBy('voucher_id')
        .orderBy('line_no')
        .execute()
    : [];
  const byVoucher = new Map<number, typeof others>();
  for (const o of others) byVoucher.set(o.voucher_id, [...(byVoucher.get(o.voucher_id) ?? []), o]);

  let balance = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const rows = shown.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    const net = debit - credit;
    balance += net;
    totalDebit += debit;
    totalCredit += credit;
    const list = byVoucher.get(l.voucher_id) ?? [];
    const opposite = list.filter((o) => (net >= 0 ? Number(o.credit_paise) > 0 : Number(o.debit_paise) > 0));
    const pick = (opposite.length ? opposite : list)[0];
    return {
      voucherId: String(l.voucher_id),
      date: day(l.date),
      particulars: pick?.ledger ?? row.name,
      others: Math.max(0, (opposite.length ? opposite.length : list.length) - 1),
      voucherType: l.voucher_type,
      number: l.number,
      debitPaise: debit,
      creditPaise: credit,
      balancePaise: balance,
      narration: l.narration,
    };
  });

  let check: LedgerVouchersView['check'] = null;
  if (company.asOf) {
    const counted = await movement(ex, company.id, row.name, company.fyFrom, company.asOf);
    const fromVouchers = openingFy + counted;
    check = {
      asOf: company.asOf,
      tallyPaise: Number(row.closing_paise),
      fromVouchersPaise: fromVouchers,
      matches: fromVouchers === Number(row.closing_paise),
    };
  }

  return {
    ledger: {
      id: String(row.id),
      name: row.name,
      group: row.parent,
      primaryGroup: tree.primaryOf(row.parent) ?? row.parent,
      revenue,
    },
    from,
    to,
    openingPaise: opening,
    rows,
    totalDebitPaise: totalDebit,
    totalCreditPaise: totalCredit,
    closingPaise: opening + totalDebit - totalCredit,
    truncated,
    check,
  };
}

// ── Day book ─────────────────────────────────────────────────────────────────

export async function dayBook(ex: Executor, company: CompanyRow, from: string, to: string): Promise<DayBookView> {
  const vouchers = await ex
    .selectFrom('tally_vouchers')
    .select(['id', 'date', 'voucher_type', 'base_type', 'number', 'party', 'narration', 'is_cancelled', 'is_optional'])
    .where('company_id', '=', company.id)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .orderBy('date')
    .orderBy('id')
    .limit(DAY_BOOK_LIMIT + 1)
    .execute();
  const truncated = vouchers.length > DAY_BOOK_LIMIT;
  const shown = vouchers.slice(0, DAY_BOOK_LIMIT);

  const entries = shown.length
    ? await ex
        .selectFrom('tally_voucher_entries')
        .select(['voucher_id', 'ledger', 'debit_paise', 'credit_paise'])
        .where('voucher_id', 'in', shown.map((v) => v.id))
        .orderBy('voucher_id')
        .orderBy('line_no')
        .execute()
    : [];
  const byVoucher = new Map<number, { ledger: string; debitPaise: number; creditPaise: number }[]>();
  for (const e of entries) {
    byVoucher.set(e.voucher_id, [
      ...(byVoucher.get(e.voucher_id) ?? []),
      { ledger: e.ledger, debitPaise: Number(e.debit_paise), creditPaise: Number(e.credit_paise) },
    ]);
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const rows: DayBookRow[] = shown.map((v) => {
    const lines = byVoucher.get(v.id) ?? [];
    const particulars = v.party ?? lines[0]?.ledger ?? '';
    const own = lines.filter((l) => l.ledger === particulars);
    const net = own.reduce((t, l) => t + l.debitPaise - l.creditPaise, 0);
    const moves = lines.length > 0 && !v.is_cancelled;
    const debit = moves && net > 0 ? net : null;
    const credit = moves && net < 0 ? -net : null;
    if (!v.is_optional) {
      totalDebit += debit ?? 0;
      totalCredit += credit ?? 0;
    }
    return {
      id: String(v.id),
      date: day(v.date),
      voucherType: v.voucher_type,
      baseType: v.base_type,
      number: v.number,
      particulars,
      debitPaise: debit,
      creditPaise: credit,
      narration: v.narration,
      isCancelled: !!v.is_cancelled,
      isOptional: !!v.is_optional,
      entries: lines,
    };
  });

  return { from, to, rows, totalDebitPaise: totalDebit, totalCreditPaise: totalCredit, truncated };
}

// ── Trial balance ────────────────────────────────────────────────────────────

const sides = (net: number) => ({ debitPaise: Math.max(net, 0), creditPaise: Math.max(-net, 0) });

export async function trialBalance(ex: Executor, company: CompanyRow): Promise<TrialBalanceView> {
  const { tree, ledgers } = await loadBooks(ex, company.id);

  const childGroups = new Map<string, string[]>();
  for (const g of tree.groups.values()) {
    if (g.parent && g.parent !== 'Primary' && tree.groups.has(g.parent)) {
      childGroups.set(g.parent, [...(childGroups.get(g.parent) ?? []), g.name]);
    }
  }
  const ledgersUnder = new Map<string, LedgerRow[]>();
  const topLedgers: LedgerRow[] = [];
  for (const l of ledgers) {
    if (tree.groups.has(l.parent)) ledgersUnder.set(l.parent, [...(ledgersUnder.get(l.parent) ?? []), l]);
    else topLedgers.push(l);
  }

  const build = (name: string): TrialBalanceNode | null => {
    const children: TrialBalanceNode[] = [];
    for (const g of (childGroups.get(name) ?? []).sort()) {
      const node = build(g);
      if (node) children.push(node);
    }
    for (const l of ledgersUnder.get(name) ?? []) {
      if (l.closing !== 0) children.push({ name: l.name, kind: 'ledger', ledgerId: String(l.id), ...sides(l.closing), children: [] });
    }
    if (!children.length) return null;
    const net = children.reduce((t, c) => t + c.debitPaise - c.creditPaise, 0);
    return { name, kind: 'group', ...sides(net), children };
  };

  const primaries = [...tree.groups.values()]
    .filter((g) => !g.parent || g.parent === 'Primary' || !tree.groups.has(g.parent))
    .map((g) => g.name)
    .sort((a, b) => primaryRank(a) - primaryRank(b) || a.localeCompare(b));

  const rows: TrialBalanceNode[] = [];
  for (const p of primaries) {
    const node = build(p);
    if (node) rows.push(node);
  }
  for (const l of topLedgers) {
    // Tally's Profit & Loss A/c closes at what was brought forward plus this
    // year's result — and that result is already here, spread over the income
    // and expense ledgers. Counting the closing balance too would report it
    // twice and the trial balance would not agree, so it shows what was
    // brought forward, exactly as Tally's own Trial Balance does.
    const balance = l.name === PROFIT_AND_LOSS_LEDGER ? l.opening : l.closing;
    if (balance !== 0) rows.push({ name: l.name, kind: 'ledger', ledgerId: String(l.id), ...sides(balance), children: [] });
  }

  // Stock kept as items is in no ledger, so the ledger openings only balance
  // once it is counted — which is why Tally lists it in the trial balance.
  if (company.maintainsInventory) {
    const stock = await stockFigures(ex, company, tree, ledgers);
    if (stock.openingPaise) {
      rows.unshift({ name: 'Opening Stock', kind: 'group', ...sides(stock.openingPaise), children: [] });
    }
  }

  const totalDebit = rows.reduce((t, r) => t + r.debitPaise, 0);
  const totalCredit = rows.reduce((t, r) => t + r.creditPaise, 0);
  return {
    asOf: company.asOf,
    rows,
    totalDebitPaise: totalDebit,
    totalCreditPaise: totalCredit,
    differencePaise: totalDebit - totalCredit,
  };
}

// ── Profit and loss, balance sheet ───────────────────────────────────────────

async function stockFigures(ex: Executor, company: CompanyRow, tree: GroupTree, ledgers: LedgerRow[]) {
  if (company.maintainsInventory) {
    const row = await ex
      .selectFrom('tally_stock_items')
      .select([
        sql<string>`COALESCE(SUM(opening_value_paise), 0)`.as('opening'),
        sql<string>`COALESCE(SUM(closing_value_paise), 0)`.as('closing'),
      ])
      .where('company_id', '=', company.id)
      .executeTakeFirst();
    return { openingPaise: Number(row?.opening ?? 0), closingPaise: Number(row?.closing ?? 0), from: 'stock items' as const };
  }
  // Without inventory, Tally takes stock from the ledgers under Stock-in-Hand.
  const stockLedgers = ledgers.filter((l) => tree.chainOf(l.parent).includes('Stock-in-Hand'));
  return {
    openingPaise: stockLedgers.reduce((t, l) => t + l.opening, 0),
    closingPaise: stockLedgers.reduce((t, l) => t + l.closing, 0),
    from: 'stock ledgers' as const,
  };
}

/** Lines for the primary groups of one kind, each with its ledgers beneath, on the side's own sign. */
function linesFor(
  tree: GroupTree,
  ledgers: LedgerRow[],
  keep: (primary: GroupInfo) => boolean,
  sign: 1 | -1,
): FinalLine[] {
  const byPrimary = new Map<string, LedgerRow[]>();
  for (const l of ledgers) {
    const p = tree.primaryOf(l.parent);
    if (!p) continue;
    byPrimary.set(p, [...(byPrimary.get(p) ?? []), l]);
  }
  return [...tree.groups.values()]
    .filter((g) => (!g.parent || g.parent === 'Primary' || !tree.groups.has(g.parent)) && keep(g))
    .sort((a, b) => primaryRank(a.name) - primaryRank(b.name) || a.name.localeCompare(b.name))
    .map((g) => {
      const children = (byPrimary.get(g.name) ?? [])
        .filter((l) => l.closing !== 0)
        .map((l) => ({ name: l.name, amountPaise: sign * l.closing, ledgerId: String(l.id), children: [] }))
        .sort((a, b) => b.amountPaise - a.amountPaise);
      return { name: g.name, amountPaise: children.reduce((t, c) => t + c.amountPaise, 0), children };
    })
    .filter((line) => line.amountPaise !== 0 || line.children.length > 0);
}

const sum = (lines: FinalLine[]) => lines.reduce((t, l) => t + l.amountPaise, 0);

async function profitParts(ex: Executor, company: CompanyRow) {
  const { tree, ledgers } = await loadBooks(ex, company.id);
  const stock = await stockFigures(ex, company, tree, ledgers);
  const isNature = (n: TallyNature, gross: boolean) => (g: GroupInfo) => g.nature === n && g.affectsGrossProfit === gross;

  const tradingDebit = linesFor(tree, ledgers, isNature('expenses', true), 1);
  const tradingCredit = linesFor(tree, ledgers, isNature('income', true), -1);
  const plDebit = linesFor(tree, ledgers, isNature('expenses', false), 1);
  const plCredit = linesFor(tree, ledgers, isNature('income', false), -1);

  const grossProfit = sum(tradingCredit) + stock.closingPaise - stock.openingPaise - sum(tradingDebit);
  const netProfit = grossProfit + sum(plCredit) - sum(plDebit);
  return { tree, ledgers, stock, tradingDebit, tradingCredit, plDebit, plCredit, grossProfit, netProfit };
}

const line = (name: string, amountPaise: number, children: FinalLine[] = []): FinalLine => ({ name, amountPaise, children });

export async function profitAndLoss(ex: Executor, company: CompanyRow): Promise<ProfitAndLossView> {
  const p = await profitParts(ex, company);
  const gp = p.grossProfit;

  const tradingDebit = [
    ...(p.stock.openingPaise ? [line('Opening Stock', p.stock.openingPaise)] : []),
    ...p.tradingDebit,
    ...(gp > 0 ? [line('Gross Profit c/o', gp)] : []),
  ];
  const tradingCredit = [
    ...p.tradingCredit,
    ...(p.stock.closingPaise ? [line('Closing Stock', p.stock.closingPaise)] : []),
    ...(gp < 0 ? [line('Gross Loss c/o', -gp)] : []),
  ];
  const np = p.netProfit;
  const plDebit = [
    ...(gp < 0 ? [line('Gross Loss b/f', -gp)] : []),
    ...p.plDebit,
    ...(np > 0 ? [line('Nett Profit', np)] : []),
  ];
  const plCredit = [
    ...(gp > 0 ? [line('Gross Profit b/f', gp)] : []),
    ...p.plCredit,
    ...(np < 0 ? [line('Nett Loss', -np)] : []),
  ];

  return {
    fyFrom: company.fyFrom,
    asOf: company.asOf,
    trading: { debit: tradingDebit, credit: tradingCredit, totalPaise: Math.max(sum(tradingDebit), sum(tradingCredit)) },
    grossProfitPaise: gp,
    profitAndLoss: { debit: plDebit, credit: plCredit, totalPaise: Math.max(sum(plDebit), sum(plCredit)) },
    netProfitPaise: np,
    stock: p.stock,
  };
}

export async function balanceSheet(ex: Executor, company: CompanyRow): Promise<BalanceSheetView> {
  const p = await profitParts(ex, company);
  const { tree, ledgers } = p;

  const liabilities = linesFor(tree, ledgers, (g) => g.nature === 'liabilities', -1);
  const assets = linesFor(tree, ledgers, (g) => g.nature === 'assets', 1);

  // Stock kept as stock items sits under Current Assets. Kept in ledgers, it
  // is already there.
  if (p.stock.from === 'stock items' && p.stock.closingPaise) {
    let current = assets.find((a) => a.name === 'Current Assets');
    if (!current) {
      current = line('Current Assets', 0);
      assets.push(current);
    }
    current.children.unshift(line('Closing Stock', p.stock.closingPaise));
    current.amountPaise += p.stock.closingPaise;
  }

  // The profit and loss account: what was brought forward, and this year's result.
  const plLedger = ledgers.find((l) => l.name === PROFIT_AND_LOSS_LEDGER && !tree.groups.has(l.parent));
  // What was brought forward, not the closing balance: Tally has already added
  // this year's result into that ledger, and it is added again on the next line.
  const openingProfit = plLedger ? -plLedger.opening : 0;
  liabilities.push(
    line(PROFIT_AND_LOSS_LEDGER, openingProfit + p.netProfit, [
      ...(openingProfit ? [line('Opening Balance', openingProfit)] : []),
      line('Current Period', p.netProfit),
    ]),
  );

  // Any other top-level ledger lands on the side its balance is on.
  for (const l of ledgers) {
    if (tree.groups.has(l.parent) || l === plLedger || l.closing === 0) continue;
    if (l.closing < 0) liabilities.push({ ...line(l.name, -l.closing), ledgerId: String(l.id) });
    else assets.push({ ...line(l.name, l.closing), ledgerId: String(l.id) });
  }

  const totalLiabilities = sum(liabilities);
  const totalAssets = sum(assets);
  return {
    asOf: company.asOf,
    liabilities,
    assets,
    totalLiabilitiesPaise: totalLiabilities,
    totalAssetsPaise: totalAssets,
    differencePaise: totalAssets - totalLiabilities,
  };
}

// ── Stock summary ────────────────────────────────────────────────────────────

export async function stockSummary(ex: Executor, company: CompanyRow): Promise<StockSummaryView> {
  const items = await ex
    .selectFrom('tally_stock_items')
    .select(['id', 'name', 'parent', 'unit', 'closing_qty', 'closing_value_paise'])
    .where('company_id', '=', company.id)
    .orderBy('parent')
    .orderBy('name')
    .execute();
  const groups = new Map<string, StockSummaryView['groups'][number]>();
  for (const i of items) {
    const key = i.parent ?? 'Primary';
    const g = groups.get(key) ?? { name: key, items: [], totalValuePaise: 0 };
    const qty = Number(i.closing_qty);
    const value = Number(i.closing_value_paise);
    g.items.push({
      id: String(i.id),
      name: i.name,
      unit: i.unit,
      closingQty: qty,
      ratePaise: qty ? Math.round(value / qty) : null,
      closingValuePaise: value,
    });
    g.totalValuePaise += value;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  return { asOf: company.asOf, groups: list, totalValuePaise: list.reduce((t, g) => t + g.totalValuePaise, 0) };
}
