// Payment links: a link for what is owed, a webhook believed only with the
// company's signature, the receipt recorded once, however often it arrives.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payment-links.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createPaymentLink, handleLinkWebhook, saveGateway, setPaymentLinkApi, type LinkRequest } from '../../lib/server/services/payment-links';

test('payment link: asks for what is owed; a signed webhook records the receipt once; a forged one records nothing', async () => {
  const rollback = Symbol('rollback');
  const savedKey = process.env.INTEGRATION_KEY;
  process.env.INTEGRATION_KEY = randomBytes(32).toString('hex');
  const asked: LinkRequest[] = [];
  setPaymentLinkApi(async (_id, _secret, body) => { asked.push(body); return { id: `plink_${asked.length}`, short_url: `https://rzp.io/i/x${asked.length}` }; });
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Pay Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Kumar', state_code: '33', gst_treatment: 'unregistered', email: 'a@kumar.test' } as never).executeTakeFirstOrThrow()).insertId);
      const clearing = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'clearing', name: 'Razorpay clearing', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await assert.rejects(createPaymentLink(trx, orgId, null, 0), /does not exist/);

      await saveGateway(trx, orgId, { keyId: 'rzp_test_abc123', keySecret: 'secret_0123456789', webhookSecret: 'whsec_123', depositBankAccountId: clearing });
      const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', dueDate: '2026-10-15', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 2_500_00, gstRatePct: 0 }] });
      const link = await createPaymentLink(trx, orgId, null, inv.id);
      assert.equal(link.amountPaise, 2_500_00);
      assert.equal(asked[0].amount, 2_500_00, 'Razorpay is asked for paise');
      assert.equal(asked[0].customer.email, 'a@kumar.test');
      assert.equal((await createPaymentLink(trx, orgId, null, inv.id)).reused, true, 'the live link is reused');

      const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1' } }, payment: { entity: { id: 'pay_9', amount: 2_500_00, method: 'upi' } } } });
      const sig = createHmac('sha256', 'whsec_123').update(body).digest('hex');
      await assert.rejects(handleLinkWebhook(orgId, body, 'f'.repeat(64), { trx }), /signature does not match/);
      const first = await handleLinkWebhook(orgId, body, sig, { trx });
      assert.equal(first.recorded, true);
      const again = await handleLinkWebhook(orgId, body, sig, { trx });
      assert.deepEqual(again, { recorded: false, reason: 'already recorded' });
      const paid = await trx.selectFrom('invoices').select(['amount_paid', 'status']).where('id', '=', inv.id).executeTakeFirstOrThrow();
      assert.deepEqual([Number(paid.amount_paid), paid.status], [2_500, 'paid']);
      const pay = await trx.selectFrom('payments').select(['mode', 'reference', 'bank_account_id']).where('org_id', '=', orgId).execute();
      assert.deepEqual(pay.map((p) => [p.mode, p.reference, p.bank_account_id]), [['upi', 'pay_9', clearing]], 'one receipt, into the clearing account');
      await assert.rejects(createPaymentLink(trx, orgId, null, inv.id), /Nothing is owed/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    setPaymentLinkApi(null);
    if (savedKey === undefined) delete process.env.INTEGRATION_KEY; else process.env.INTEGRATION_KEY = savedKey;
  }
});

test.after(() => db.destroy());
