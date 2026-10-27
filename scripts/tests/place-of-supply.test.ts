// Place of supply from the ship-to, export shipping bills, and the LUT.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/place-of-supply.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, setExportDetails } from '../../lib/server/services/sales';
import { gstr1 } from '../../lib/server/gst/returns';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { placeOfSupplyFor, stateTaxLabel } from '../../lib/tax/gst';

interface Fixture { trx: Trx; orgId: number; branchId: number; customer: number; overseas: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'POS Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1, gstin: '33AAAAA0000A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: '18' },
        { org_id: orgId, code: '998313', kind: 'sac', description: 'IT consulting', gst_rate_pct: '18' },
      ]).execute();
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        customer: await mk({ kind: 'customer', display_name: 'TN Buyer', state_code: '33', gst_treatment: 'registered', gstin: '33BBBBB0000B1Z5' }),
        overseas: await mk({ kind: 'customer', display_name: 'Dubai Importer', state_code: '96', gst_treatment: 'overseas' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sale = (f: Fixture, extra: Record<string, unknown>, hsnSac = '8708') => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.customer, date: '2026-08-01', dueDate: '2026-08-31', status: 'approved',
  lines: [{ description: 'Line', hsnSac, qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }], ...extra,
} as never);
const head = (f: Fixture, id: number) => f.trx.selectFrom('invoices').select(['place_of_supply', 'supply_type', 'igst', 'cgst', 'ship_to_state_code'])
  .where('id', '=', id).executeTakeFirstOrThrow();

test('the rule', () => {
  assert.equal(placeOfSupplyFor({ billToState: '33', shipToState: '29', servicesOnly: false }), '29', 'goods: where they are delivered');
  assert.equal(placeOfSupplyFor({ billToState: '33', shipToState: '29', shipToThirdParty: true, servicesOnly: false }), '33', 'bill-to-ship-to');
  assert.equal(placeOfSupplyFor({ billToState: '33', shipToState: '29', servicesOnly: true }), '33', 'services: the recipient');
  assert.equal(placeOfSupplyFor({ billToState: '33', shipToState: '29', servicesOnly: false, override: '27' }), '27');
});

test('the state half is UTGST in a union territory without a legislature', () => {
  for (const ut of ['04', '26', '31', '35', '38', '97']) assert.equal(stateTaxLabel(ut), 'UTGST', ut);
  for (const st of ['33', '07', '34', '01']) assert.equal(stateTaxLabel(st), 'SGST', `${st} has a legislature`);
  assert.equal(stateTaxLabel('04-Chandigarh'), 'UTGST');
  assert.equal(stateTaxLabel(null), 'SGST');
});

test('goods shipped to another state are inter-state; to a third party, or services, they are not', async () => {
  await withFixture(async (f) => {
    const toKa = await sale(f, { shipTo: { name: 'Bengaluru depot', city: 'Bengaluru', pincode: '560001', stateCode: '29' } });
    let h = await head(f, toKa.id);
    assert.deepEqual([h.place_of_supply, h.supply_type, h.ship_to_state_code], ['29', 'inter', '29']);
    assert.ok(Number(h.igst) > 0);

    const thirdParty = await sale(f, { shipTo: { stateCode: '29', thirdParty: true } });
    h = await head(f, thirdParty.id);
    assert.deepEqual([h.place_of_supply, h.supply_type], ['33', 'intra']);

    const service = await sale(f, { shipTo: { stateCode: '29' } }, '998313');
    h = await head(f, service.id);
    assert.equal(h.place_of_supply, '33');

    await assert.rejects(sale(f, { shipTo: { stateCode: '29', pincode: '0123' } }), /PIN code/);
  });
});

test('an export’s shipping bill reaches GSTR-1, and a LUT must be in force', async () => {
  await withFixture(async (f) => {
    const exp = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-08-05', dueDate: '2026-09-05', status: 'approved',
      lines: [{ description: 'Brake pads', hsnSac: '8708', qty: 100, ratePaise: 500_00, gstRatePct: 18 }],
    });
    let g = await gstr1(f.trx, f.orgId, '2026-08');
    assert.ok(g.issues.some((i) => /no Letter of Undertaking is on file/.test(i.message)));

    await f.trx.updateTable('organizations').set({ lut_arn: 'AD330426012345X', lut_valid_from: '2026-04-01', lut_valid_to: '2027-03-31' })
      .where('id', '=', f.orgId).execute();
    g = await gstr1(f.trx, f.orgId, '2026-08');
    assert.ok(!g.issues.some((i) => /Undertaking|LUT/.test(i.message)));

    await assert.rejects(setExportDetails(f.trx, f.orgId, exp.id, { portCode: 'chennai' }), /port code/);
    await setExportDetails(f.trx, f.orgId, exp.id, { shippingBillNo: '4417823', shippingBillDate: '2026-08-07', portCode: 'INMAA1' });
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08') as { exp?: { exp_typ: string; inv: Record<string, unknown>[] }[] };
    const inv = file.exp![0].inv[0];
    assert.deepEqual([inv.sbnum, inv.sbpcode, inv.sbdt], ['4417823', 'INMAA1', '07-08-2026']);

    const sale2 = await sale(f, {});
    await assert.rejects(setExportDetails(f.trx, f.orgId, sale2.id, { shippingBillNo: '1' }), /not an export/);
  });
});

test.after(async () => {
  await db.destroy();
});
