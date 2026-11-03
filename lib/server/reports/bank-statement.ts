import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A bank account's statement as on a date: the Bank Reconciliation Statement
// an Indian accountant prepares at every month end and on 31 March.
//
//   Balance as per the books, as on the date
//   add  payments in the books the bank has not cleared yet (cheques issued, not presented)
//   less deposits in the books the bank has not credited yet
//   add  money the bank credited that the books do not have yet (interest, direct credits)
//   less money the bank debited that the books do not have yet (charges, direct debits)
//   = Balance as per the bank statement
//
// against the balance the imported statement itself shows on that day. An
// entry is cleared when a statement line dated on or before the date was
// matched to it, or to the payment it records.
//
// A statement line and the entry it was matched to need not share a date: a
// NEFT on the 31st entered in the books on the 2nd is in the bank and not in
// the books as on the 31st, so it is listed with the bank's own credits.
//
// Statements are usually imported from some date on, not from the first day of
// the account: an entry before the first imported line is taken to be in the
// statement's own opening balance already, and is not listed, unless a later
// statement line was matched to it (a cheque issued before, presented after).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { asId, notFound } from '../http';

const p = (v: unknown) => toPaiseFromSql(String(v ?? '0'));
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

export interface StatementItem {
  date: string; entryId: string | null; entryNo: number | null; particulars: string; reference: string | null; amountPaise: number;
}

export async function bankStatementAsOn(ex: Executor, orgId: number, bankAccountId: number, asOf: string) {
  const account = await ex.selectFrom('bank_accounts').select(['id', 'name', 'kind', 'ledger_account_id'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!account) throw notFound('That bank account does not exist.');

  const { rows: bal } = await sql<{ dr: string | null; cr: string | null }>`
    SELECT SUM(l.debit) AS dr, SUM(l.credit) AS cr FROM journal_lines l
     WHERE l.org_id = ${orgId} AND l.account_id = ${account.ledger_account_id} AND l.entry_date <= ${asOf}`.execute(ex);
  const bookPaise = p(bal[0]?.dr) - p(bal[0]?.cr);

  const { rows: span } = await sql<{ first_line: string | null; statement_balance: string | null; statement_date: string | null }>`
    SELECT (SELECT MIN(t.txn_date) FROM bank_transactions t WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id}) AS first_line,
           (SELECT t.running_balance FROM bank_transactions t WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id}
             AND t.txn_date <= ${asOf} AND t.running_balance IS NOT NULL ORDER BY t.txn_date DESC, t.id DESC LIMIT 1) AS statement_balance,
           (SELECT MAX(t.txn_date) FROM bank_transactions t WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id} AND t.txn_date <= ${asOf}) AS statement_date`.execute(ex);
  const firstLine = span[0]?.first_line ? day(span[0].first_line) : null;

  // The entries statement lines were matched to (directly, or through the
  // payment they record): every one, or those the bank had cleared by a date.
  const matchedEntries = (upTo: string | null) => sql`
    SELECT t.matched_id FROM bank_transactions t
     WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id} AND t.status IN ('matched', 'manually_added')
       AND t.matched_type = 'journal_entry' AND t.matched_id IS NOT NULL ${upTo ? sql`AND t.txn_date <= ${upTo}` : sql``}
    UNION
    SELECT pm.journal_entry_id FROM bank_transactions t JOIN payments pm ON pm.id = t.matched_id AND pm.org_id = ${orgId}
     WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id} AND t.status IN ('matched', 'manually_added')
       AND t.matched_type = 'payment' AND pm.journal_entry_id IS NOT NULL ${upTo ? sql`AND t.txn_date <= ${upTo}` : sql``}`;

  // Book entries on the account the bank has not cleared by the date.
  const { rows: open } = firstLine ? await sql<{
    entry_id: number; entry_no: number; entry_date: string; memo: string | null; description: string | null; party: string | null; source_type: string | null; debit: string; credit: string;
  }>`
    SELECT e.id AS entry_id, e.entry_no, e.entry_date, e.memo, l.description, c.display_name AS party, e.source_type, l.debit, l.credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      LEFT JOIN contacts c ON c.id = l.contact_id
     WHERE l.org_id = ${orgId} AND l.account_id = ${account.ledger_account_id}
       AND e.entry_date <= ${asOf}
       AND (e.entry_date >= ${firstLine} OR e.id IN (${matchedEntries(null)}))
       AND COALESCE(e.source_type, '') NOT IN ('opening', 'opening_balance', 'opening_document')
       AND e.id NOT IN (${matchedEntries(asOf)})
     ORDER BY e.entry_date, e.id`.execute(ex) : { rows: [] };

  const item = (r: (typeof open)[number], amount: number): StatementItem => ({
    date: day(r.entry_date), entryId: asId(r.entry_id), entryNo: r.entry_no,
    particulars: [r.party, r.description || r.memo].filter(Boolean).join(' · ') || (r.source_type ?? 'Entry').replace(/_/g, ' '),
    reference: null, amountPaise: amount,
  });
  const notPresented = open.filter((r) => p(r.credit) > 0).map((r) => item(r, p(r.credit)));
  const notCredited = open.filter((r) => p(r.debit) > 0).map((r) => item(r, p(r.debit)));

  // Statement lines up to the date the books do not have yet: unmatched, or
  // matched to an entry the books date after it.
  const { rows: bankOnly } = await sql<{
    id: number; txn_date: string; narration: string; reference: string | null; deposit: string; withdrawal: string; booked_on: string | null;
  }>`
    SELECT t.id, t.txn_date, t.narration, t.reference, t.deposit, t.withdrawal, e.entry_date AS booked_on
      FROM bank_transactions t
      LEFT JOIN payments pm ON t.matched_type = 'payment' AND pm.id = t.matched_id AND pm.org_id = ${orgId}
      LEFT JOIN journal_entries e ON e.org_id = ${orgId}
       AND e.id = CASE WHEN t.matched_type = 'journal_entry' THEN t.matched_id ELSE pm.journal_entry_id END
     WHERE t.org_id = ${orgId} AND t.bank_account_id = ${account.id} AND t.txn_date <= ${asOf}
       AND (t.status = 'unmatched' OR (t.status IN ('matched', 'manually_added') AND e.entry_date > ${asOf}))
     ORDER BY t.txn_date, t.id`.execute(ex);
  const line = (t: (typeof bankOnly)[number], amount: number): StatementItem => ({
    date: day(t.txn_date), entryId: null, entryNo: null,
    particulars: t.booked_on ? `${t.narration} · in the books on ${day(t.booked_on)}` : t.narration,
    reference: t.reference, amountPaise: amount,
  });
  const bankCredits = bankOnly.filter((t) => p(t.deposit) > 0).map((t) => line(t, p(t.deposit)));
  const bankDebits = bankOnly.filter((t) => p(t.withdrawal) > 0).map((t) => line(t, p(t.withdrawal)));

  const sum = (xs: StatementItem[]) => xs.reduce((s, x) => s + x.amountPaise, 0);
  const computedPaise = bookPaise + sum(notPresented) - sum(notCredited) + sum(bankCredits) - sum(bankDebits);
  const statementPaise = span[0]?.statement_balance == null ? null : p(span[0].statement_balance);

  return {
    account: { id: asId(account.id), name: account.name, kind: account.kind },
    asOf,
    reconciledFrom: firstLine,
    statementDate: span[0]?.statement_date ? day(span[0].statement_date) : null,
    bookPaise,
    notPresented, notCredited, bankCredits, bankDebits,
    totals: { notPresented: sum(notPresented), notCredited: sum(notCredited), bankCredits: sum(bankCredits), bankDebits: sum(bankDebits) },
    computedPaise,
    statementPaise,
    differencePaise: statementPaise === null ? null : statementPaise - computedPaise,
  };
}
