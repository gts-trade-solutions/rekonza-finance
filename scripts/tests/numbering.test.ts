// Document numbering: prefixes per branch, the 16-character GST limit, and a
// new year starting at one under last year's style.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/numbering.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { allocateNumber, assertGstDocNumber, peekNumber } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { listSeries, setSeriesStyle } from '../../lib/server/services/numbering';

interface Fixture { trx: Trx; orgId: number; branchId: number; customer: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Numbers Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'unregistered',
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a branch prefix applies from the next number on, and the count carries on', async () => {
  await withFixture(async (f) => {
    assert.equal(await allocateNumber(f.trx, f.orgId, f.branchId, 'INV', '26-27', { prefix: 'INV' }), 'INV/26-27/0001');
    await setSeriesStyle(f.trx, f.orgId, { branchId: f.branchId, docType: 'INV', prefix: 'tn', padding: 3, today: '2026-10-26' });
    assert.equal(await allocateNumber(f.trx, f.orgId, f.branchId, 'INV', '26-27', { prefix: 'INV' }), 'TN/26-27/002');

    // Next year starts at one, still TN, still three digits.
    assert.equal(await peekNumber(f.trx, f.orgId, f.branchId, 'INV', '27-28', 'INV'), 'TN/27-28/001');
    assert.equal(await allocateNumber(f.trx, f.orgId, f.branchId, 'INV', '27-28', { prefix: 'INV' }), 'TN/27-28/001');
  });
});

test('a prefix that would push an invoice past 16 characters is refused; an estimate may be longer', async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      setSeriesStyle(f.trx, f.orgId, { branchId: f.branchId, docType: 'INV', prefix: 'CHENNAI', padding: 4, today: '2026-10-26' }),
      /GST allows 16.*Keep the prefix to 5/,
    );
    await setSeriesStyle(f.trx, f.orgId, { branchId: f.branchId, docType: 'INV', prefix: 'CHN-1', padding: 4, today: '2026-10-26' });
    await setSeriesStyle(f.trx, f.orgId, { branchId: f.branchId, docType: 'EST', prefix: 'CHENNAI-Q', padding: 4, today: '2026-10-26' });
    await assert.rejects(
      setSeriesStyle(f.trx, f.orgId, { branchId: f.branchId, docType: 'INV', prefix: 'A/B', padding: 4, today: '2026-10-26' }),
      /letters, digits or hyphens/,
    );

    const s = await listSeries(f.trx, f.orgId, '2026-10-26');
    const inv = s.find((r) => r.docType === 'INV')!;
    assert.equal(inv.sample, 'CHN-1/26-27/0001');
    assert.equal(inv.maxLength, 16);
    assert.equal(s.filter((r) => r.scope === 'branch').length, 8, 'every series a branch runs, issued or not');
  });
});

test('a hand-typed invoice number meets the same rules', async () => {
  await withFixture(async (f) => {
    const sell = (number: string) => createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-05-01', dueDate: '2026-05-31', status: 'approved', number,
      lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }],
    });
    await assert.rejects(sell('CHENNAI/2026-27/00001'), /at most 16 characters/);
    await assert.rejects(sell('INV 42'), /only letters, digits/);
    const ok = await sell('MAN/26-27/1');
    assert.ok(ok.id);
  });
});

test('the checks themselves', () => {
  assert.doesNotThrow(() => assertGstDocNumber('INV/26-27/0042'));
  assert.doesNotThrow(() => assertGstDocNumber('ABCDEFGHIJKLMNOP'));
  assert.throws(() => assertGstDocNumber('ABCDEFGHIJKLMNOPQ'), /16 characters/);
  assert.throws(() => assertGstDocNumber('INV#1'), /only letters/);
});

test.after(async () => {
  await db.destroy();
});
