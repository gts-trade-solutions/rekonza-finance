// Email templates (migration 096): the business's own wording for the emails
// the books send, with placeholders filled in — and the built-in wording until
// someone changes it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/email-templates.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { queueReminders } from '../../lib/server/services/reminders';
import { setPolicies } from '../../lib/server/services/org-settings';
import { EMAIL_SPECS, fill, getTemplate, listTemplates, renderEmail, resetTemplate, saveTemplate } from '../../lib/server/mail/templates';

test('fill: placeholders filled, a capital kept, unknown ones left as typed', () => {
  assert.equal(fill('{Document} {number} for {customer} {nope}', { document: 'debit note', number: 'DN-1', customer: 'Kumar' }), 'Debit note DN-1 for Kumar {nope}');
  assert.equal(fill('{link}', { link: '{link}' }), '{link}', 'a reminder keeps {link} for when it is sent');
});

test('templates: built-in until changed; saved wording is checked, used, and can be put back', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Mail Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCM6161M1Z5' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);

      const builtIn = await getTemplate(trx, orgId, 'invoice');
      assert.equal(builtIn.custom, false);
      assert.equal(builtIn.subject, EMAIL_SPECS.invoice.subject);
      const vars = { customer: 'Kumar Stores', document: 'invoice', number: 'INV-9', date: '02 Nov 2026', total: '₹1,180.00', balance: '₹1,180.00', due_date: '02 Dec 2026', balance_line: '₹1,180.00 is due by 02 Dec 2026.', link: 'https://x/s/1', business: 'Mail Co' };
      const plain = await renderEmail(trx, orgId, 'invoice', vars);
      assert.equal(plain.subject, 'Invoice INV-9 from Mail Co', 'the same subject the invoice email always had');
      assert.match(plain.text, /^Dear Kumar Stores,\n\nPlease find invoice INV-9 dated 02 Nov 2026 for ₹1,180.00\.\n₹1,180.00 is due by 02 Dec 2026\.\n\nView, download or pay it here: https:\/\/x\/s\/1/);

      await assert.rejects(saveTemplate(trx, orgId, null, 'invoice', { subject: 'Hi', body: 'Please pay.' }), /Keep \{link\}/);
      await assert.rejects(saveTemplate(trx, orgId, null, 'invoice', { subject: 'Hi {gstin}', body: 'Pay {link}' }), /\{gstin\} is not a placeholder/);
      await assert.rejects(saveTemplate(trx, orgId, null, 'invoice', { subject: ' ', body: 'Pay {link}' }), /needs a subject/);
      await saveTemplate(trx, orgId, null, 'invoice', { subject: 'Bill {number} — {Business}', body: 'Vanakkam {customer},\r\n\r\n{balance} is due by {due_date}. Pay here: {link}' });
      const mine = await renderEmail(trx, orgId, 'invoice', vars);
      assert.equal(mine.subject, 'Bill INV-9 — Mail Co');
      assert.equal(mine.text, 'Vanakkam Kumar Stores,\n\n₹1,180.00 is due by 02 Dec 2026. Pay here: https://x/s/1');
      const listed = await listTemplates(trx, orgId);
      assert.deepEqual(listed.filter((t) => t.custom).map((t) => t.kind), ['invoice']);
      assert.deepEqual(listed.map((t) => t.kind), [
        'invoice', 'quote', 'sales_order', 'challan', 'credit_note', 'retainer', 'payment_receipt',
        'purchase_order', 'vendor_credit', 'payment_advice', 'statement', 'reminder', 'portal_invite',
      ]);

      // A reminder queued today is in the business's words, {link} kept for sending.
      await saveTemplate(trx, orgId, null, 'reminder', { subject: 'Gentle nudge: {number}', body: '{customer}: {balance} {due_words}. {link} — {business}' });
      await setPolicies(trx, orgId, null, { reminders: { enabled: true, channel: 'email', stages: [0] } });
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Kumar Stores', state_code: '33', gst_treatment: 'unregistered', email: 'k@x.test' } as never).executeTakeFirstOrThrow()).insertId);
      const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
      const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: today, dueDate: today, status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }] });
      assert.equal(await queueReminders(trx, orgId, today), 1);
      const r = await trx.selectFrom('payment_reminders').select(['subject', 'message']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
      const number = (await trx.selectFrom('invoices').select('number').where('id', '=', inv.id).executeTakeFirstOrThrow()).number;
      assert.equal(r.subject, `Gentle nudge: ${number}`);
      assert.equal(r.message, 'Kumar Stores: ₹1,000.00 falls due today. {link} — Mail Co');

      await resetTemplate(trx, orgId, 'invoice');
      assert.equal((await renderEmail(trx, orgId, 'invoice', vars)).subject, 'Invoice INV-9 from Mail Co', 'back to the built-in wording');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
