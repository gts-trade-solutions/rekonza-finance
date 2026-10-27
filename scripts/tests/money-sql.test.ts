// Round-trip and edge-case tests for the DECIMAL <-> paise boundary.
//   npx tsx --test scripts/tests/money-sql.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toPaiseFromSql, toSqlFromPaise, toDateString,
} from '../../lib/server/money-sql';

test('reads DECIMAL(19,4) strings as exact paise', () => {
  assert.equal(toPaiseFromSql('0.0000'), 0);
  assert.equal(toPaiseFromSql('1.0000'), 100);
  assert.equal(toPaiseFromSql('0.0100'), 1);
  assert.equal(toPaiseFromSql('1234.5600'), 123456);
  assert.equal(toPaiseFromSql('-1234.5600'), -123456);
  assert.equal(toPaiseFromSql('99999999.9900'), 9999999999);
});

test('the classic float traps stay exact', () => {
  // parseFloat('0.10') * 100 is 10.000000000000002, and 0.1 + 0.2 is
  // 0.30000000000000004. Neither may reach a ledger.
  assert.equal(toPaiseFromSql('0.1000'), 10);
  assert.equal(toPaiseFromSql('0.2000'), 20);
  assert.equal(toPaiseFromSql('0.3000'), 30);
  assert.equal(toPaiseFromSql('0.1000') + toPaiseFromSql('0.2000'), toPaiseFromSql('0.3000'));
  assert.equal(toPaiseFromSql('8.1700'), 817);
  assert.equal(toPaiseFromSql('1.0050'), 101); // half-up at the sub-paisa
});

test('sub-paisa digits round half-up rather than truncating', () => {
  assert.equal(toPaiseFromSql('1.0049'), 100);
  assert.equal(toPaiseFromSql('1.0050'), 101);
  assert.equal(toPaiseFromSql('1.0099'), 101);
});

test('writes paise back as a DECIMAL literal', () => {
  assert.equal(toSqlFromPaise(0), '0.0000');
  assert.equal(toSqlFromPaise(1), '0.0100');
  assert.equal(toSqlFromPaise(100), '1.0000');
  assert.equal(toSqlFromPaise(123456), '1234.5600');
  assert.equal(toSqlFromPaise(-123456), '-1234.5600');
  assert.equal(toSqlFromPaise(9999999999), '99999999.9900');
});

test('round-trips every paise value without drift', () => {
  const cases = [0, 1, 7, 99, 100, 101, 999, 1000, 123456, 6215569020, -1, -99, -123456];
  for (const p of cases) {
    assert.equal(toPaiseFromSql(toSqlFromPaise(p)), p, `round trip failed for ${p}`);
  }
});

test('a long addition chain stays exact', () => {
  // Ten thousand additions of 0.07 is where float arithmetic visibly drifts.
  let total = 0;
  for (let i = 0; i < 10_000; i++) total += toPaiseFromSql('0.0700');
  assert.equal(total, 70_000);
  assert.equal(toSqlFromPaise(total), '700.0000');
});

test('rejects non-integer paise rather than rounding silently', () => {
  assert.throws(() => toSqlFromPaise(10.5), TypeError);
});

test('handles null and empty as zero', () => {
  assert.equal(toPaiseFromSql(null), 0);
  assert.equal(toPaiseFromSql(undefined), 0);
  assert.equal(toPaiseFromSql(''), 0);
});

test('reads DATE columns without a timezone shift', () => {
  assert.equal(toDateString('2026-08-07'), '2026-08-07');
  // Late-evening IST is the case that toISOString() gets wrong.
  assert.equal(toDateString(new Date(2026, 7, 7, 23, 30)), '2026-08-07');
  assert.equal(toDateString(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});
