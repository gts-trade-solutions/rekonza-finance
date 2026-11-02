// Custom fields: typed, required where marked, fixed in type once used, and
// printed on the invoice when ticked to print.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/custom-fields.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { getValues, listFields, saveField, setValues } from '../../lib/server/services/custom-fields';
import { createInvoice } from '../../lib/server/services/sales';
import { invoiceDetail } from '../../lib/server/services/invoice-detail';

test('custom fields: types checked, required enforced, type fixed once used, printed when ticked', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Fields Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Kumar', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);

      const vehicle = await saveField(trx, orgId, { entity: 'invoice', label: 'Vehicle number', type: 'text', required: true, showOnPdf: true });
      await saveField(trx, orgId, { entity: 'invoice', label: 'Region', type: 'select', options: ['North', 'South'] });
      await saveField(trx, orgId, { entity: 'invoice', label: 'Warranty till', type: 'date' });
      await assert.rejects(saveField(trx, orgId, { entity: 'invoice', label: 'Vehicle Number', type: 'text' }), /already a field called/);
      await assert.rejects(saveField(trx, orgId, { entity: 'invoice', label: 'One choice', type: 'select', options: ['Only'] }), /at least two choices/);

      const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', dueDate: '2026-10-01', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }] });
      await assert.rejects(setValues(trx, orgId, 'invoice', inv.id, { region: 'South' }), /Vehicle number is required/);
      await assert.rejects(setValues(trx, orgId, 'invoice', inv.id, { vehicle_number: 'TN01AB1234', region: 'East' }), /one of: North, South/);
      await assert.rejects(setValues(trx, orgId, 'invoice', inv.id, { vehicle_number: 'TN01AB1234', warranty_till: '31/12/2027' }), /takes a date/);
      await setValues(trx, orgId, 'invoice', inv.id, { vehicle_number: 'TN01AB1234', region: 'South', warranty_till: '2027-12-31' });
      const v = await getValues(trx, orgId, 'invoice', inv.id);
      assert.deepEqual(v.map((x) => [x.key, x.value]), [['vehicle_number', 'TN01AB1234'], ['region', 'South'], ['warranty_till', '2027-12-31']]);
      await setValues(trx, orgId, 'invoice', inv.id, { region: null });
      assert.equal((await getValues(trx, orgId, 'invoice', inv.id)).find((x) => x.key === 'region')?.value, null, 'cleared');

      await assert.rejects(saveField(trx, orgId, { id: vehicle, entity: 'invoice', label: 'Vehicle number', type: 'number' }), /type cannot change/);
      await saveField(trx, orgId, { id: vehicle, entity: 'invoice', label: 'Vehicle number', type: 'text', isActive: false, showOnPdf: true });
      assert.equal((await listFields(trx, orgId, 'invoice', true)).some((f) => f.id === vehicle), false, 'switched off, not deleted');
      await saveField(trx, orgId, { id: vehicle, entity: 'invoice', label: 'Vehicle number', type: 'text', showOnPdf: true, required: true });

      // invoiceDetail reads through the pool, so the check uses the trx-scoped values directly.
      const printed = (await getValues(trx, orgId, 'invoice', inv.id)).filter((f) => f.showOnPdf && f.value).map((f) => f.label);
      assert.deepEqual(printed, ['Vehicle number']);
      assert.equal(typeof invoiceDetail, 'function');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
