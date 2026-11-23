// HSN codes as Zoho Books takes them, on the server: any properly formed code of
// at least the digits set in Settings → Items reaches an invoice line, saved or
// not; a malformed one, or one short of the setting, is refused. The saved list
// still lends a line its rate.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/hsn-setting.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { getPolicies, setPolicies } from '../../lib/server/services/org-settings';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'HSN Setting Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Shop', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 28, is_active: 1 }).execute();
  const customer = Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind: 'customer', display_name: 'Speedwell Garages', state_code: '33', gst_treatment: 'unregistered',
  } as never).executeTakeFirstOrThrow()).insertId);
  const sell = (hsnSac: string, gstRatePct = 18) => createInvoice(trx, orgId, null, {
    branchId, customerId: customer, date: '2026-11-20', dueDate: '2026-12-20', status: 'draft',
    lines: [{ description: 'Steel bar', hsnSac, qty: 2, ratePaise: 620_00, gstRatePct }],
  });
  return { orgId, sell };
}

test('a valid code that was never saved reaches the invoice, as in Zoho', async () => {
  await rolledBack(async (trx) => {
    const { sell } = await book(trx);
    const inv = await sell('72142090');
    const [line] = await trx.selectFrom('invoice_lines').select(['hsn_sac']).where('invoice_id', '=', Number(inv.id)).execute();
    assert.equal(line.hsn_sac, '72142090');
    await sell('998311'); // a SAC on a line
  });
});

test('a malformed code, or a chapter that does not exist, is refused with the reason', async () => {
  await rolledBack(async (trx) => {
    const { sell } = await book(trx);
    await assert.rejects(sell('12345'), /4, 6 or 8 digits/);
    await assert.rejects(sell('7714'), /no chapter 77/);
    await assert.rejects(sell('99831'), /six digits/);
  });
});

test('Settings → Items: six digits refuses a four-digit code; 4, 6 and 8 are the only choices', async () => {
  await rolledBack(async (trx) => {
    const { orgId, sell } = await book(trx);
    assert.equal((await getPolicies(trx, orgId)).hsn.digits, 4, 'four digits until the business says otherwise');
    await sell('8708');
    await setPolicies(trx, orgId, null, { hsn: { digits: 6 } });
    assert.equal((await getPolicies(trx, orgId)).hsn.digits, 6);
    await assert.rejects(sell('8708'), /at least 6/);
    await sell('870830');
    await assert.rejects(setPolicies(trx, orgId, null, { hsn: { digits: 5 as never } }), /4, 6 or 8/);
  });
});

test.after(() => db.destroy());
