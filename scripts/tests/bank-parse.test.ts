// How statement amounts, dates and Dr/Cr marks are read (lib/bank-statement.ts),
// in the shapes Indian banks actually download.

import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, isDebitMark, readWithMapping, statementDate, type StatementMapping } from '../../lib/bank-statement';

test('amounts: commas, rupee signs, brackets and a trailing minus', () => {
  assert.equal(amount('1,234.50'), 1234.5);
  assert.equal(amount('₹ 1,234.50'), 1234.5);
  assert.equal(amount('INR 1234.50'), 1234.5);
  assert.equal(amount('(1,234.50)'), -1234.5, 'brackets are a minus, not a dropped line');
  assert.equal(amount('1234.00-'), -1234, 'a trailing minus is a minus');
  assert.equal(amount('1,200.00 Dr'), 1200, 'the Dr is read by the caller');
  assert.equal(amount(''), 0);
});

test('dates: with a time, with the month written, two-digit years', () => {
  assert.equal(statementDate('01/11/2026 10:15:32'), '2026-11-01');
  assert.equal(statementDate('01-11-2026 10:15 AM'), '2026-11-01');
  assert.equal(statementDate('01/Nov/2026'), '2026-11-01');
  assert.equal(statementDate('01-Nov-26'), '2026-11-01');
  assert.equal(statementDate('01.Nov.2026'), '2026-11-01');
  assert.equal(statementDate('01/11/26'), '2026-11-01');
  assert.equal(statementDate('2026-11-01T00:00:00'), '2026-11-01');
});

test('Dr/Cr marks: one letter counts as much as the word', () => {
  for (const d of ['D', 'Dr', 'DR.', 'DB', 'Debit', 'withdrawal', '1,200.00 Dr']) assert.ok(isDebitMark(d), d);
  for (const c of ['C', 'Cr', 'CR.', 'Credit', 'deposit', '1,200.00 Cr']) assert.ok(!isDebitMark(c), c);
});

test('a statement with one amount column and a D/C column books each line on its side', () => {
  const grid = [
    ['Txn Date', 'Description', 'Amount', 'D/C'],
    ['01/11/2026 09:00', 'NEFT IN', '1,000.00', 'C'],
    ['02/11/2026', 'ATM', '500.00', 'D'],
    ['03/Nov/2026', 'REVERSAL', '(200.00)', 'C'],
  ];
  const m: StatementMapping = { headerAt: 0, date: 0, narration: 1, reference: -1, withdrawal: -1, deposit: -1, amount: 2, drcr: 3, balance: -1, dateOrder: 'dmy' };
  const { rows, problem } = readWithMapping(grid, m);
  assert.equal(problem, null);
  assert.equal(rows.length, 3, 'no line dropped');
  assert.deepEqual(rows.map((r) => [r.date, r.depositPaise, r.withdrawalPaise]), [
    ['2026-11-01', 100_000, 0],
    ['2026-11-02', 0, 50_000],
    ['2026-11-03', 0, 20_000],
  ]);
});
