import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Banking: accounts, statement import, rules, reconciliation, transfers.
//
// A bank statement line is not a transaction. It is evidence that money moved,
// and it stays outside the ledger until somebody says what it was for. That
// separation is the whole point of reconciliation: the statement is the bank's
// version of events, the ledger is ours, and the job is finding where the two
// disagree. Posting statement lines automatically would collapse the two into
// one and there would be nothing left to reconcile against.
//
// Automatic feeds are deliberately absent. Pulling transactions from a bank in
// India means an Account Aggregator, and registering as a Financial Information
// User requires being regulated by the RBI, SEBI, IRDAI or PFRDA — which
// accounting software is not. Statement import is the honest route, and the
// dedupe hash below is what makes re-importing an overlapping statement safe.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, notFound } from '../http';
import { receivePayment } from './payments';

export interface StatementRow {
  date: string;
  narration: string;
  reference?: string | null;
  depositPaise?: Paise;
  withdrawalPaise?: Paise;
  runningBalancePaise?: Paise | null;
}

/**
 * Fingerprint of a statement line.
 *
 * Statements overlap: you download January, then December-to-January, and the
 * same rows arrive twice. Without this the second import silently doubles the
 * month. Date, narration, reference and both amounts are enough to identify a
 * line; the running balance is excluded because banks recompute it when a
 * later correction lands, which would make the same line hash differently.
 */
function fingerprint(accountId: number, row: StatementRow): string {
  return createHash('sha256')
    .update(
      [
        accountId,
        row.date,
        row.narration.trim().replace(/\s+/g, ' ').toLowerCase(),
        row.reference?.trim().toLowerCase() ?? '',
        row.depositPaise ?? 0,
        row.withdrawalPaise ?? 0,
      ].join('|'),
    )
    .digest('hex');
}

export interface ImportResult {
  importId: number;
  total: number;
  imported: number;
  duplicates: number;
  autoMatched: number;
  periodFrom: string | null;
  periodTo: string | null;
}

/**
 * Import statement lines, skipping anything already present.
 *
 * Duplicates are counted and reported rather than treated as an error — a
 * partial overlap is the normal case, not a mistake by the person importing.
 */
export async function importStatement(
  trx: Trx,
  orgId: number,
  userId: number | null,
  bankAccountId: number,
  filename: string,
  rows: StatementRow[],
): Promise<ImportResult> {
  const account = await trx
    .selectFrom('bank_accounts').select(['id', 'name'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!account) throw notFound('That bank account does not exist.');
  if (!rows.length) throw badRequest('The statement had no rows to import.');

  for (const [i, r] of rows.entries()) {
    const dep = r.depositPaise ?? 0;
    const wdr = r.withdrawalPaise ?? 0;
    if (dep === 0 && wdr === 0) {
      throw badRequest(`Row ${i + 1} has neither a deposit nor a withdrawal.`);
    }
    if (dep !== 0 && wdr !== 0) {
      throw badRequest(`Row ${i + 1} has both a deposit and a withdrawal. A line is one or the other.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      throw badRequest(`Row ${i + 1} has an unreadable date (${r.date}).`);
    }
  }

  const dates = rows.map((r) => r.date).sort();
  const periodFrom = dates[0] ?? null;
  const periodTo = dates[dates.length - 1] ?? null;

  const imp = await trx
    .insertInto('bank_statement_imports')
    .values({
      org_id: orgId,
      bank_account_id: bankAccountId,
      filename,
      rows_total: rows.length,
      rows_imported: 0,
      rows_duplicate: 0,
      period_from: periodFrom,
      period_to: periodTo,
      imported_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const importId = Number(imp.insertId);

  const existing = await trx
    .selectFrom('bank_transactions').select('dedupe_hash')
    .where('bank_account_id', '=', bankAccountId).execute();
  const seen = new Set(existing.map((r) => r.dedupe_hash));

  const fresh: { row: StatementRow; hash: string }[] = [];
  for (const row of rows) {
    const hash = fingerprint(bankAccountId, row);
    // Also guard within the file itself: a statement can repeat a line.
    if (seen.has(hash)) continue;
    seen.add(hash);
    fresh.push({ row, hash });
  }

  if (fresh.length) {
    await trx
      .insertInto('bank_transactions')
      .values(
        fresh.map(({ row, hash }) => ({
          org_id: orgId,
          bank_account_id: bankAccountId,
          txn_date: row.date,
          narration: row.narration.slice(0, 500),
          reference: row.reference ?? null,
          deposit: toSqlFromPaise(row.depositPaise ?? 0),
          withdrawal: toSqlFromPaise(row.withdrawalPaise ?? 0),
          running_balance: row.runningBalancePaise != null ? toSqlFromPaise(row.runningBalancePaise) : null,
          status: 'unmatched' as const,
          import_batch_id: importId,
          dedupe_hash: hash,
        })),
      )
      .execute();
  }

  const autoMatched = await applyRules(trx, orgId, userId, bankAccountId) + await matchInvoicePayments(trx, orgId, userId, bankAccountId)
    + await matchEnteredPayments(trx, orgId, userId, bankAccountId);

  await trx
    .updateTable('bank_statement_imports')
    .set({ rows_imported: fresh.length, rows_duplicate: rows.length - fresh.length })
    .where('id', '=', importId)
    .execute();

  return {
    importId,
    total: rows.length,
    imported: fresh.length,
    duplicates: rows.length - fresh.length,
    autoMatched,
    periodFrom,
    periodTo,
  };
}

/**
 * A statement line equal to a payment already entered — the same account, the
 * same amount, the same direction, within three days — is that payment, and is
 * matched to it. Only when exactly one payment fits and it is not matched to
 * another line already: two cheques of ₹10,000 the same week are left for a
 * person to tell apart.
 */
export async function matchEnteredPayments(trx: Trx, orgId: number, userId: number | null, bankAccountId: number): Promise<number> {
  const lines = await trx.selectFrom('bank_transactions').select(['id', 'txn_date', 'deposit', 'withdrawal'])
    .where('org_id', '=', orgId).where('bank_account_id', '=', bankAccountId).where('status', '=', 'unmatched').execute();
  if (!lines.length) return 0;
  const taken = new Set((await trx.selectFrom('bank_transactions').select('matched_id')
    .where('org_id', '=', orgId).where('matched_type', '=', 'payment').where('status', '=', 'matched').execute()).map((r) => Number(r.matched_id)));
  const payments = (await trx.selectFrom('payments').select(['id', 'kind', 'amount', 'payment_date'])
    .where('org_id', '=', orgId).where('bank_account_id', '=', bankAccountId).where('status', '<>', 'void').execute())
    .filter((p) => !taken.has(Number(p.id)));
  const day = (d: unknown) => Date.parse(String(d instanceof Date ? d.toISOString() : d).slice(0, 10));
  let matched = 0;
  for (const l of lines) {
    const deposit = toPaiseFromSql(l.deposit);
    const amount = deposit || toPaiseFromSql(l.withdrawal);
    const fits = payments.filter((p) => !taken.has(Number(p.id)) && (p.kind === 'received') === deposit > 0
      && toPaiseFromSql(p.amount) === amount && Math.abs(day(p.payment_date) - day(l.txn_date)) <= 3 * 86_400_000);
    if (fits.length !== 1) continue;
    await matchToPayment(trx, orgId, userId, l.id, Number(fits[0].id));
    taken.add(Number(fits[0].id));
    matched++;
  }
  return matched;
}

/** Letters and digits only, in capitals: how an invoice number survives a bank's narration. */
const bare = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Money in that names one open invoice — as a UPI payment from the invoice's
 * own code does, the invoice number riding in its reference — is that
 * invoice's receipt. Where the receipt was already entered by hand, the line
 * is matched to it; where it was not, it is recorded and matched, so long as
 * the money is no more than the invoice still owes. Only when exactly one
 * invoice is named: anything less clear is left for a person.
 */
export async function matchInvoicePayments(trx: Trx, orgId: number, userId: number | null, bankAccountId: number): Promise<number> {
  const lines = await trx.selectFrom('bank_transactions').select(['id', 'txn_date', 'narration', 'reference', 'deposit'])
    .where('org_id', '=', orgId).where('bank_account_id', '=', bankAccountId).where('status', '=', 'unmatched').where('deposit', '>', '0').execute();
  if (!lines.length) return 0;
  const open = await trx.selectFrom('invoices').select(['id', 'number', 'customer_id', 'branch_id', 'total', 'amount_paid'])
    .where('org_id', '=', orgId).where('currency', '=', 'INR').where('status', 'in', ['approved', 'sent', 'overdue', 'partially_paid', 'paid']).execute();
  const keyed = open.map((i) => ({ ...i, key: bare(i.number), left: toPaiseFromSql(i.total) - toPaiseFromSql(i.amount_paid) }))
    .filter((i) => i.key.length >= 4);
  let matched = 0;
  for (const line of lines) {
    const text = bare(`${line.narration} ${line.reference ?? ''}`);
    // A number followed by another digit is a different, longer number.
    const named = keyed.filter((i) => new RegExp(`${i.key}(?![0-9])`).test(text));
    if (named.length !== 1) continue;
    const inv = named[0];
    const amount = toPaiseFromSql(line.deposit);
    const date = String(line.txn_date).slice(0, 10);
    // Entered by hand already: the customer, the amount, this account, near the day, and not yet matched.
    const typed = await trx.selectFrom('payments as p')
      .leftJoin('bank_transactions as t', (j) => j.onRef('t.matched_id', '=', 'p.id').on('t.matched_type', '=', 'payment'))
      .select('p.id').where('p.org_id', '=', orgId).where('p.kind', '=', 'received').where('p.status', '<>', 'void')
      .where('p.contact_id', '=', inv.customer_id).where('p.bank_account_id', '=', bankAccountId).where('p.amount', '=', toSqlFromPaise(amount))
      .where('p.payment_date', '>=', sql<string>`DATE_SUB(${date}, INTERVAL 7 DAY)`).where('p.payment_date', '<=', sql<string>`DATE_ADD(${date}, INTERVAL 7 DAY)`)
      .where('t.id', 'is', null).executeTakeFirst();
    let paymentId = typed?.id;
    if (!paymentId) {
      if (amount > inv.left) continue;
      const receipt = await receivePayment(trx, orgId, userId, {
        branchId: inv.branch_id, contactId: inv.customer_id, date, mode: /UPI/.test(text) ? 'upi' : 'neft',
        amountPaise: amount, bankAccountId, reference: (line.reference || line.narration).slice(0, 100),
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: amount }],
        notes: 'Recorded from the bank statement: the payment named this invoice.',
      });
      paymentId = receipt.id;
      inv.left -= amount;
    }
    await trx.updateTable('bank_transactions').set({ status: 'matched', matched_type: 'payment', matched_id: paymentId, matched_at: new Date(), matched_by_user_id: userId })
      .where('id', '=', line.id).execute();
    matched++;
  }
  return matched;
}

interface RuleCondition {
  field: 'narration' | 'reference' | 'amount';
  op: 'contains' | 'equals' | 'starts_with' | 'greater_than' | 'less_than';
  value: string;
}

/**
 * Run the organisation's rules over unmatched lines.
 *
 * Only rules marked auto-confirm actually post. The rest record a suggestion
 * for a human to accept, because a rule that silently miscategorises is worse
 * than one that asks — the misposting is invisible until somebody reads the
 * profit and loss and wonders why fuel is so high.
 */
export async function applyRules(
  trx: Trx,
  orgId: number,
  userId: number | null,
  bankAccountId?: number,
): Promise<number> {
  const rules = await trx
    .selectFrom('bank_rules').selectAll()
    .where('org_id', '=', orgId).where('is_active', '=', 1)
    .orderBy('priority').execute();
  if (!rules.length) return 0;

  let q = trx
    .selectFrom('bank_transactions').selectAll()
    .where('org_id', '=', orgId).where('status', '=', 'unmatched');
  if (bankAccountId) q = q.where('bank_account_id', '=', bankAccountId);
  const txns = await q.execute();

  let matched = 0;
  for (const txn of txns) {
    for (const rule of rules) {
      if (rule.bank_account_id && rule.bank_account_id !== txn.bank_account_id) continue;

      const conditions = (rule.conditions ?? []) as unknown as RuleCondition[];
      if (!Array.isArray(conditions) || !conditions.length) continue;

      const amount = toPaiseFromSql(txn.deposit) || toPaiseFromSql(txn.withdrawal);
      const hit = conditions.every((c) => {
        const haystack =
          c.field === 'narration' ? txn.narration.toLowerCase()
          : c.field === 'reference' ? (txn.reference ?? '').toLowerCase()
          : String(amount);
        const needle = String(c.value).toLowerCase();
        switch (c.op) {
          case 'contains': return haystack.includes(needle);
          case 'equals': return haystack === needle;
          case 'starts_with': return haystack.startsWith(needle);
          case 'greater_than': return amount > Number(c.value);
          case 'less_than': return amount < Number(c.value);
          default: return false;
        }
      });
      if (!hit) continue;

      if (rule.auto_confirm && rule.action_account_id) {
        await categoriseTransaction(trx, orgId, userId, txn.id, {
          accountId: rule.action_account_id,
          contactId: rule.contact_id,
          ruleId: rule.id,
        });
        matched++;
      } else {
        // Suggestion only: recorded so the reconciliation screen can offer it.
        await trx
          .updateTable('bank_transactions').set({ applied_rule_id: rule.id })
          .where('id', '=', txn.id).execute();
      }
      break; // First matching rule wins; priority decides which that is.
    }
  }
  return matched;
}

/**
 * Post an unmatched statement line straight to an account.
 *
 * This is the "create from bank" path — the money moved and there was no
 * document, so the statement line becomes the source of the entry.
 */
export async function categoriseTransaction(
  trx: Trx,
  orgId: number,
  userId: number | null,
  txnId: number,
  input: { accountId: number; contactId?: number | null; description?: string | null; ruleId?: number | null },
): Promise<number> {
  const txn = await trx
    .selectFrom('bank_transactions')
    .innerJoin('bank_accounts', 'bank_accounts.id', 'bank_transactions.bank_account_id')
    .select([
      'bank_transactions.id', 'bank_transactions.status', 'bank_transactions.txn_date',
      'bank_transactions.narration', 'bank_transactions.deposit', 'bank_transactions.withdrawal',
      'bank_accounts.ledger_account_id', 'bank_accounts.name as bank_name',
    ])
    .where('bank_transactions.id', '=', txnId)
    .where('bank_transactions.org_id', '=', orgId)
    .executeTakeFirst();
  if (!txn) throw notFound('That bank line does not exist.');
  if (txn.status === 'matched') throw new ApiError(409, 'That line is already matched.', 'conflict');

  const deposit = toPaiseFromSql(txn.deposit);
  const withdrawal = toPaiseFromSql(txn.withdrawal);

  const branch = await trx
    .selectFrom('branches').select('id')
    .where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirst();
  if (!branch) throw notFound('No primary branch is configured.');

  const lines: DraftLine[] = deposit > 0
    ? [
        { accountId: txn.ledger_account_id, debit: deposit, description: txn.narration },
        { accountId: input.accountId, credit: deposit, contactId: input.contactId ?? null },
      ]
    : [
        { accountId: input.accountId, debit: withdrawal, contactId: input.contactId ?? null, description: txn.narration },
        { accountId: txn.ledger_account_id, credit: withdrawal, description: `Paid from ${txn.bank_name}` },
      ];

  const entry = await postEntry(trx, {
    orgId,
    branchId: branch.id,
    date: txn.txn_date,
    memo: input.description ?? txn.narration,
    sourceType: 'bank_txn',
    sourceId: txnId,
    userId,
    module: 'banking',
    lines,
  });

  await trx
    .updateTable('bank_transactions')
    .set({
      status: 'matched',
      matched_type: 'journal_entry',
      matched_id: entry.id,
      matched_at: new Date(),
      matched_by_user_id: userId,
      applied_rule_id: input.ruleId ?? null,
    })
    .where('id', '=', txnId)
    .execute();

  return entry.id;
}

/**
 * Match a statement line to a payment already in the books.
 *
 * Nothing is posted here — the payment posted when it was recorded. All this
 * does is record that the bank has confirmed it, which is what makes the line
 * stop appearing as unreconciled. Posting again would double the money.
 */
export async function matchToPayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  txnId: number,
  paymentId: number,
): Promise<void> {
  const txn = await trx
    .selectFrom('bank_transactions')
    .select(['id', 'status', 'deposit', 'withdrawal', 'bank_account_id'])
    .where('id', '=', txnId).where('org_id', '=', orgId).executeTakeFirst();
  if (!txn) throw notFound('That bank line does not exist.');
  if (txn.status === 'matched') throw new ApiError(409, 'That line is already matched.', 'conflict');

  const payment = await trx
    .selectFrom('payments').select(['id', 'number', 'kind', 'amount', 'bank_account_id', 'status'])
    .where('id', '=', paymentId).where('org_id', '=', orgId).executeTakeFirst();
  if (!payment) throw notFound('That payment does not exist.');
  if (payment.status === 'void') throw badRequest('That payment has been voided.');

  const lineAmount = toPaiseFromSql(txn.deposit) || toPaiseFromSql(txn.withdrawal);
  const paymentAmount = toPaiseFromSql(payment.amount);
  if (lineAmount !== paymentAmount) {
    throw new ApiError(
      409,
      `The statement shows ${(lineAmount / 100).toFixed(2)} but ${payment.number} is ` +
        `${(paymentAmount / 100).toFixed(2)}. Matching them would hide a real difference — ` +
        'correct one of the two first.',
      'amount_mismatch',
    );
  }

  const isDeposit = toPaiseFromSql(txn.deposit) > 0;
  if (isDeposit !== (payment.kind === 'received')) {
    throw badRequest(
      `That line is a ${isDeposit ? 'deposit' : 'withdrawal'} but ${payment.number} is a ` +
        `payment ${payment.kind}. They cannot be the same transaction.`,
    );
  }

  await trx
    .updateTable('bank_transactions')
    .set({
      status: 'matched',
      matched_type: 'payment',
      matched_id: paymentId,
      matched_at: new Date(),
      matched_by_user_id: userId,
    })
    .where('id', '=', txnId)
    .execute();
}

/** Undo a match. Reverses the entry if the match created one. */
export async function unmatchTransaction(
  trx: Trx,
  orgId: number,
  userId: number | null,
  txnId: number,
): Promise<void> {
  const txn = await trx
    .selectFrom('bank_transactions').select(['id', 'status', 'matched_type', 'matched_id'])
    .where('id', '=', txnId).where('org_id', '=', orgId).executeTakeFirst();
  if (!txn) throw notFound('That bank line does not exist.');
  if (txn.status !== 'matched') throw badRequest('That line is not matched.');

  // Only a match that posted an entry has one to reverse. Matching to an
  // existing payment posted nothing, so there is nothing to undo in the ledger.
  if (txn.matched_type === 'journal_entry' && txn.matched_id) {
    await reverseEntry(trx, orgId, txn.matched_id, {
      memo: 'Bank line unmatched',
      userId,
      module: 'banking',
    });
  }

  await trx
    .updateTable('bank_transactions')
    .set({ status: 'unmatched', matched_type: null, matched_id: null, matched_at: null })
    .where('id', '=', txnId)
    .execute();
}

/**
 * Move money between our own accounts.
 *
 * Not income and not an expense — the same money in a different place. Posting
 * it as either would inflate both sides of the profit and loss.
 */
export async function createTransfer(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: { fromBankAccountId: number; toBankAccountId: number; date: string; amountPaise: Paise; reference?: string | null },
): Promise<{ id: number; journalEntryId: number }> {
  if (input.fromBankAccountId === input.toBankAccountId) {
    throw badRequest('Choose two different accounts.');
  }
  if (input.amountPaise <= 0) throw badRequest('Enter an amount above zero.');

  const accounts = await trx
    .selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id'])
    .where('org_id', '=', orgId)
    .where('id', 'in', [input.fromBankAccountId, input.toBankAccountId])
    .execute();
  const from = accounts.find((a) => a.id === input.fromBankAccountId);
  const to = accounts.find((a) => a.id === input.toBankAccountId);
  if (!from || !to) throw notFound('One of those accounts does not exist.');

  const branch = await trx
    .selectFrom('branches').select('id')
    .where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow();

  const entry = await postEntry(trx, {
    orgId,
    branchId: branch.id,
    date: input.date,
    memo: `Transfer ${from.name} to ${to.name}`,
    sourceType: 'transfer',
    userId,
    module: 'banking',
    lines: [
      { accountId: to.ledger_account_id, debit: input.amountPaise, description: `From ${from.name}` },
      { accountId: from.ledger_account_id, credit: input.amountPaise, description: `To ${to.name}` },
    ],
  });

  const row = await trx
    .insertInto('bank_transfers')
    .values({
      org_id: orgId,
      from_bank_account_id: input.fromBankAccountId,
      to_bank_account_id: input.toBankAccountId,
      transfer_date: input.date,
      amount: toSqlFromPaise(input.amountPaise),
      reference: input.reference ?? null,
      journal_entry_id: entry.id,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();

  return { id: Number(row.insertId), journalEntryId: entry.id };
}

/**
 * Create a bank account and its ledger account together.
 *
 * They are always a pair: a bank account with no ledger account behind it can
 * hold money the books never see.
 */
export async function createBankAccount(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: {
    kind: 'bank' | 'card' | 'cash' | 'wallet';
    name: string;
    bankName?: string | null;
    accountLast4?: string | null;
    ifsc?: string | null;
    openingBalancePaise?: Paise;
    openingDate?: string | null;
  },
): Promise<{ id: number; ledgerAccountId: number; journalEntryId: number | null }> {
  const isCard = input.kind === 'card';

  // Next free code in the right block, so the chart stays ordered.
  const prefix = isCard ? '25' : '12';
  const { rows } = await sql<{ code: string }>`
    SELECT code FROM accounts
    WHERE org_id = ${orgId} AND code LIKE ${`${prefix}%`}
    ORDER BY code DESC LIMIT 1
  `.execute(trx);
  const nextCode = rows[0] ? String(Number(rows[0].code) + 1) : `${prefix}10`;

  const ledger = await trx
    .insertInto('accounts')
    .values({
      org_id: orgId,
      code: nextCode,
      name: input.name,
      type: isCard ? 'liability' : 'asset',
      subtype: isCard ? 'credit_card' : input.kind === 'cash' ? 'cash' : 'bank',
      is_system: 1,
      is_active: 1,
    })
    .executeTakeFirstOrThrow();
  const ledgerAccountId = Number(ledger.insertId);

  const opening = input.openingBalancePaise ?? 0;
  const row = await trx
    .insertInto('bank_accounts')
    .values({
      org_id: orgId,
      kind: input.kind,
      name: input.name,
      bank_name: input.bankName ?? null,
      account_last4: input.accountLast4 ?? null,
      ifsc: input.ifsc ?? null,
      ledger_account_id: ledgerAccountId,
      opening_balance: toSqlFromPaise(opening),
      opening_date: input.openingDate ?? null,
      feed_connected: 0,
      is_active: 1,
    })
    .executeTakeFirstOrThrow();

  let journalEntryId: number | null = null;
  if (opening !== 0 && input.openingDate) {
    // The other side of an opening balance goes to Opening Balance Equity —
    // it is not income, because the money was earned before the books began.
    const acc = await accountIds(trx, orgId);
    const branch = await trx
      .selectFrom('branches').select('id')
      .where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow();

    const equity = requireAccount(acc, CODE.OPENING_BALANCE_EQUITY);
    const entry = await postEntry(trx, {
      orgId,
      branchId: branch.id,
      date: input.openingDate,
      memo: `Opening balance — ${input.name}`,
      sourceType: 'opening_balance',
      userId,
      lines: isCard
        ? [
            { accountId: equity, debit: Math.abs(opening) },
            { accountId: ledgerAccountId, credit: Math.abs(opening) },
          ]
        : [
            { accountId: ledgerAccountId, debit: opening },
            { accountId: equity, credit: opening },
          ],
    });
    journalEntryId = entry.id;
  }

  return { id: Number(row.insertId), ledgerAccountId, journalEntryId };
}

/** Live balance per account: opening plus everything posted to its ledger account. */
export async function bankBalances(
  trx: Trx,
  orgId: number,
): Promise<{ id: number; name: string; kind: string; balancePaise: Paise; unmatched: number }[]> {
  const { rows } = await sql<{
    id: number; name: string; kind: string; opening: string; movement: string; unmatched: number;
  }>`
    SELECT ba.id, ba.name, ba.kind,
           ba.opening_balance AS opening,
           COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
                      WHERE jl.account_id = ba.ledger_account_id), 0) AS movement,
           (SELECT COUNT(*) FROM bank_transactions bt
             WHERE bt.bank_account_id = ba.id AND bt.status = 'unmatched') AS unmatched
      FROM bank_accounts ba
     WHERE ba.org_id = ${orgId} AND ba.is_active = 1
     ORDER BY ba.is_primary DESC, ba.name
  `.execute(trx);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    // The opening balance is already posted as a journal entry, so counting it
    // again here would double it. Movement alone is the balance.
    balancePaise: toPaiseFromSql(r.movement),
    unmatched: Number(r.unmatched),
  }));
}
