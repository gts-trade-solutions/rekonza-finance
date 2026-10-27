// The pay-by-UPI link printed on invoices.
//
//   npx tsx --test scripts/tests/upi.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVpa, upiPayUri } from '../../lib/billing/upi';

test('a UPI ID is name@handle', () => {
  assert.ok(isValidVpa('raceauto@okhdfcbank'));
  assert.ok(isValidVpa('9876543210@ybl'));
  assert.ok(!isValidVpa('raceauto'));
  assert.ok(!isValidVpa('race auto@okhdfcbank'));
  assert.ok(!isValidVpa('a@b'), 'the handle has at least two characters');
});

test('the link fixes the amount and carries the invoice number', () => {
  const uri = upiPayUri({
    vpa: 'raceauto@okhdfcbank', payeeName: 'Race Auto Spares Pvt Ltd',
    amountPaise: 1_18_000_50, note: 'Invoice INV/26-27/0041', reference: 'INV/26-27/0041',
  });
  assert.ok(uri.startsWith('upi://pay?'));
  const q = new URLSearchParams(uri.slice('upi://pay?'.length));
  assert.equal(q.get('pa'), 'raceauto@okhdfcbank');
  assert.equal(q.get('pn'), 'Race Auto Spares Pvt Ltd');
  assert.equal(q.get('am'), '118000.50');
  assert.equal(q.get('cu'), 'INR');
  assert.equal(q.get('tn'), 'Invoice INV/26-27/0041');
  assert.equal(q.get('tr'), 'INV/26-27/0041');
  assert.ok(!uri.includes(' '), 'spaces are encoded');
});
