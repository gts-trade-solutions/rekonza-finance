// DPDP: requests and their due dates, what is held about a party, erasure that keeps what the tax laws require.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/privacy.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { closeRequest, contactData, eraseContact, logRequest, retainedUntil } from '../../lib/server/services/privacy';

test('a request is due in the book\'s days; erasure keeps the name while the invoices must be kept, then takes it', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Privacy Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const person = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Meena Iyer', state_code: '33', gst_treatment: 'consumer',
        email: 'meena@example.test', phone: '9876543210', billing_address: '4 Lake Road', bank_account_no: '1234567890', pan: 'ABCPI1234K',
      } as never).executeTakeFirstOrThrow()).insertId);
      await createInvoice(trx, orgId, null, {
        branchId, customerId: person, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
        lines: [{ description: 'Service', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
      });

      const r = await logRequest(trx, orgId, null, { subjectType: 'contact', subjectId: person, subjectName: 'Meena Iyer', kind: 'erasure', receivedOn: '2026-10-01' });
      assert.equal(r.dueOn, '2026-10-31', 'thirty days by default');
      await assert.rejects(closeRequest(trx, orgId, null, r.id, { status: 'done', response: ' ' }), /answer the person is owed/);

      const held = await contactData(trx, orgId, person);
      assert.equal(held.held.bank?.accountNo, '1234567890');
      assert.equal(held.documents.invoices.length, 1);

      assert.equal(await retainedUntil(trx, orgId, person), '2035-03-31', 'eight years after the year of the last invoice');
      const partial = await eraseContact(trx, orgId, person, '2026-10-26');
      assert.deepEqual(partial, { full: false, keptUntil: '2035-03-31' });
      let c = await trx.selectFrom('contacts').select(['display_name', 'email', 'phone', 'bank_account_no', 'billing_address']).where('id', '=', person).executeTakeFirstOrThrow();
      assert.deepEqual(c, { display_name: 'Meena Iyer', email: null, phone: null, bank_account_no: null, billing_address: '4 Lake Road' });

      const full = await eraseContact(trx, orgId, person, '2035-04-01');
      assert.equal(full.full, true);
      c = await trx.selectFrom('contacts').select(['display_name', 'email', 'phone', 'bank_account_no', 'billing_address']).where('id', '=', person).executeTakeFirstOrThrow();
      assert.equal(c.display_name, `Erased contact ${person}`);
      assert.equal(c.billing_address, null);
      const inv = await trx.selectFrom('invoices').select('customer_id').where('customer_id', '=', person).execute();
      assert.equal(inv.length, 1, 'the invoice stays, under the anonymous name');

      await closeRequest(trx, orgId, null, r.id, { status: 'done', response: 'Erased; invoice kept as the GST law requires.' });
      await assert.rejects(closeRequest(trx, orgId, null, r.id, { status: 'done', response: 'again' }), /not open/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
