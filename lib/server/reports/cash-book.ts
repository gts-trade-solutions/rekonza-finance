import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The cash book and bank book: one cash or bank account's receipts and
// payments, day by day, with the account on the other side of each and the
// balance carried forward — the book a cashier closes each evening.
//
// And counting the cash: notes and coins on a date against the book balance,
// any difference posted to Cash Short & Excess so the books agree with the
// drawer.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';

export interface CashBookLine {
  entryId: string; entryNo: number; memo: string | null; sourceType: string; party: string | null;
  /** The other side: the accounts the money came from or went to. */
  against: string; receiptPaise: Paise; paymentPaise: Paise;
}
export interface CashBookDay { date: string; openingPaise: Paise; lines: CashBookLine[]; receiptsPaise: Paise; paymentsPaise: Paise; closingPaise: Paise }

async function accountOf(ex: Executor, orgId: number, bankAccountId: number) {
  const b = await ex.selectFrom('bank_accounts').select(['id', 'name', 'kind', 'ledger_account_id'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!b) throw notFound('That cash or bank account does not exist.');
  return b;
}

async function balanceOn(ex: Executor, orgId: number, ledgerId: number, before: string): Promise<Paise> {
  const { rows } = await sql<{ b: string }>`
    SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines
     WHERE org_id = ${orgId} AND account_id = ${ledgerId} AND entry_date < ${before}
  `.execute(ex);
  return toPaiseFromSql(rows[0]?.b ?? '0');
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export async function cashBook(ex: Executor, orgId: number, bankAccountId: number, from: string, to: string) {
  const acct = await accountOf(ex, orgId, bankAccountId);
  const opening = await balanceOn(ex, orgId, acct.ledger_account_id, from);
  const { rows } = await sql<{
    entry_id: number; entry_no: number; entry_date: string; memo: string | null; source_type: string;
    party: string | null; debit: string; credit: string; against: string | null;
  }>`
    SELECT e.id AS entry_id, e.entry_no, jl.entry_date, e.memo, e.source_type,
           (SELECT c.display_name FROM journal_lines x JOIN contacts c ON c.id = x.contact_id
             WHERE x.entry_id = e.id AND x.contact_id IS NOT NULL LIMIT 1) AS party,
           jl.debit, jl.credit,
           (SELECT GROUP_CONCAT(DISTINCT a.name ORDER BY a.name SEPARATOR ', ') FROM journal_lines y JOIN accounts a ON a.id = y.account_id
             WHERE y.entry_id = e.id AND y.account_id <> ${acct.ledger_account_id}) AS against
      FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
     WHERE jl.org_id = ${orgId} AND jl.account_id = ${acct.ledger_account_id}
       AND jl.entry_date BETWEEN ${from} AND ${to}
     ORDER BY jl.entry_date, e.entry_no, jl.id
  `.execute(ex);

  const days: CashBookDay[] = [];
  let running = opening;
  for (const r of rows) {
    const date = String(r.entry_date).slice(0, 10);
    let day = days[days.length - 1];
    if (!day || day.date !== date) {
      day = { date, openingPaise: running, lines: [], receiptsPaise: 0, paymentsPaise: 0, closingPaise: running };
      days.push(day);
    }
    const receipt = toPaiseFromSql(r.debit);
    const payment = toPaiseFromSql(r.credit);
    day.lines.push({
      entryId: String(r.entry_id), entryNo: r.entry_no, memo: r.memo, sourceType: r.source_type, party: r.party,
      against: r.against ?? '', receiptPaise: receipt, paymentPaise: payment,
    });
    day.receiptsPaise += receipt;
    day.paymentsPaise += payment;
    running += receipt - payment;
    day.closingPaise = running;
  }
  return {
    account: { id: String(acct.id), name: acct.name, kind: acct.kind },
    from, to, openingPaise: opening, closingPaise: running,
    receiptsPaise: days.reduce((t, d) => t + d.receiptsPaise, 0),
    paymentsPaise: days.reduce((t, d) => t + d.paymentsPaise, 0),
    // A cash balance below zero means a payment was entered before the receipt that funded it, or never funded.
    negativeDays: days.filter((d) => d.closingPaise < 0).map((d) => d.date),
    days,
  };
}

// ── Counting the cash ────────────────────────────────────────────────────────

/** Notes and coins in circulation, in rupees. */
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export async function countCash(
  trx: Trx, orgId: number, userId: number | null,
  o: { bankAccountId: number; date: string; pieces: Record<string, number>; note?: string | null },
) {
  const acct = await accountOf(trx, orgId, o.bankAccountId);
  if (acct.kind !== 'cash') throw badRequest('Only a cash account can be counted.');
  const counted = Object.entries(o.pieces).reduce((t, [d, n]) => {
    if (!DENOMINATIONS.includes(Number(d) as never) || !Number.isInteger(n) || n < 0) throw badRequest(`₹${d} × ${n} is not a count.`);
    return t + Number(d) * 100 * n;
  }, 0);
  const book = await balanceOn(trx, orgId, acct.ledger_account_id, nextDay(o.date));
  const difference = counted - book;
  let journalEntryId: number | null = null;
  if (difference !== 0) {
    const acc = await accountIds(trx, orgId);
    const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
    const shortExcess = requireAccount(acc, CODE.CASH_SHORT_EXCESS);
    const entry = await postEntry(trx, {
      orgId, branchId: branch, date: o.date, userId, module: 'banking', sourceType: 'cash_count', sourceId: null,
      memo: `${acct.name} counted: ${difference > 0 ? 'excess' : 'short'} of ₹${(Math.abs(difference) / 100).toLocaleString('en-IN')}${o.note ? ` — ${o.note}` : ''}`,
      lines: difference > 0
        ? [{ accountId: acct.ledger_account_id, debit: difference }, { accountId: shortExcess, credit: difference }]
        : [{ accountId: shortExcess, debit: -difference }, { accountId: acct.ledger_account_id, credit: -difference }],
    });
    journalEntryId = entry.id;
  }
  const id = Number((await trx.insertInto('cash_counts').values({
    org_id: orgId, bank_account_id: o.bankAccountId, counted_on: o.date, denominations: JSON.stringify(o.pieces),
    counted: toSqlFromPaise(counted), book: toSqlFromPaise(book), difference: toSqlFromPaise(difference),
    note: o.note ?? null, journal_entry_id: journalEntryId, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  return { id: String(id), countedPaise: counted, bookPaise: book, differencePaise: difference, journalEntryId: journalEntryId ? String(journalEntryId) : null };
}

export async function cashCounts(ex: Executor, orgId: number, bankAccountId: number) {
  const rows = await ex.selectFrom('cash_counts as c').leftJoin('users as u', 'u.id', 'c.created_by_user_id')
    .select(['c.id', 'c.counted_on', 'c.counted', 'c.book', 'c.difference', 'c.note', 'u.name'])
    .where('c.org_id', '=', orgId).where('c.bank_account_id', '=', bankAccountId)
    .orderBy('c.counted_on', 'desc').orderBy('c.id', 'desc').limit(50).execute();
  return rows.map((r) => ({
    id: String(r.id), date: String(r.counted_on).slice(0, 10), countedPaise: toPaiseFromSql(r.counted), bookPaise: toPaiseFromSql(r.book),
    differencePaise: toPaiseFromSql(r.difference), note: r.note, by: r.name,
  }));
}
