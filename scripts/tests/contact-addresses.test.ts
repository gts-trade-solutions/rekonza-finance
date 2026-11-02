// A contact's other addresses (migration 098): checked as they are saved, one
// default at a time, and only the contact's own.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/contact-addresses.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { deleteAddress, listAddresses, saveAddress } from '../../lib/server/services/contact-addresses';

test('addresses: state required and GSTIN checked against it; one default; another contact’s untouched', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Address Co' }).executeTakeFirstOrThrow()).insertId);
      const mk = (name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const kumar = await mk('Kumar Stores');
      const other = await mk('Other');

      await assert.rejects(saveAddress(trx, orgId, kumar, { label: 'Hosur', address: '1 SIPCOT', stateCode: '' }), /Pick the state/);
      await assert.rejects(saveAddress(trx, orgId, kumar, { label: '', address: '1 SIPCOT', stateCode: '33' }), /Give the address a name/);
      await assert.rejects(saveAddress(trx, orgId, kumar, { label: 'Hosur', address: '1 SIPCOT', stateCode: '33', pincode: '63512' }), /six digits/);
      await assert.rejects(saveAddress(trx, orgId, kumar, { label: 'Hosur', address: '1 SIPCOT', stateCode: '33', gstin: '33AAAAA0000A1Z0' }), /checksum/);
      await assert.rejects(saveAddress(trx, orgId, kumar, { label: 'Bengaluru', address: 'Peenya', stateCode: '33', gstin: '29AAACA1111A1ZO' }), /registered in state 29/);

      const hosur = await saveAddress(trx, orgId, kumar, { label: 'Hosur godown', address: '1 SIPCOT', city: 'Hosur', pincode: '635126', stateCode: '33', isDefault: true });
      const blr = await saveAddress(trx, orgId, kumar, { label: 'Bengaluru branch', address: 'Peenya Industrial Area', city: 'Bengaluru', stateCode: '29', gstin: '29AAACA1111A1ZO' });
      let list = await listAddresses(trx, orgId, kumar);
      assert.deepEqual(list.map((a) => [a.label, a.isDefault, a.stateCode]), [['Hosur godown', true, '33'], ['Bengaluru branch', false, '29']]);

      // Making another the default takes it off the first.
      await saveAddress(trx, orgId, kumar, { id: blr, label: 'Bengaluru branch', address: 'Peenya Industrial Area', stateCode: '29', isDefault: true });
      list = await listAddresses(trx, orgId, kumar);
      assert.deepEqual(list.map((a) => [a.label, a.isDefault]), [['Bengaluru branch', true], ['Hosur godown', false]]);

      await assert.rejects(saveAddress(trx, orgId, other, { id: hosur, label: 'x', address: 'y', stateCode: '33' }), /not found/);
      await assert.rejects(deleteAddress(trx, orgId, other, hosur), /not found/);
      assert.equal(await deleteAddress(trx, orgId, kumar, hosur), 'Hosur godown');
      assert.deepEqual((await listAddresses(trx, orgId, kumar)).map((a) => a.label), ['Bengaluru branch']);
      assert.deepEqual(await listAddresses(trx, orgId, other), []);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
