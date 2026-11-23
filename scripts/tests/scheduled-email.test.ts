// Zoho's Send ▾ → Schedule Email on an invoice (services/scheduled-email.ts):
// a mail.invoice job on the queue, run at the time chosen, callable off until
// then. Against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/scheduled-email.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { cancelScheduledEmail, scheduleInvoiceEmail, scheduledInvoiceEmails } from '../../lib/server/services/scheduled-email';
import { claimDueJob, JOB_KINDS } from '../../lib/server/jobs/queue';
import { HANDLERS } from '../../lib/server/jobs/handlers';

const MAIL = ['SMTP_HOST', 'MAIL_FROM', 'SMTP_USER'];
const saved = Object.fromEntries(MAIL.map((k) => [k, process.env[k]]));
const mailOn = () => { process.env.SMTP_HOST = 'smtp.test'; process.env.MAIL_FROM = 'books@example.com'; };
const mailOff = () => { for (const k of MAIL) delete process.env[k]; };
test.after(async () => {
  for (const k of MAIL) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await db.destroy();
});

interface Fixture { trx: Trx; orgId: number; invoiceId: number; draftId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Scheduled Email Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5', email: 'accounts@bonita.example',
      }).executeTakeFirstOrThrow()).insertId);
      const line = { itemId: null, description: 'Servicing', qty: 1, ratePaise: 100_000, gstRatePct: 18 };
      const base = { branchId, customerId, date: '2026-11-20', dueDate: '2026-12-20', lines: [line] };
      const issued = await createInvoice(trx, orgId, null, { ...base, status: 'approved' } as never);
      const draft = await createInvoice(trx, orgId, null, { ...base, status: 'draft' } as never);
      await fn({ trx, orgId, invoiceId: Number(issued.id), draftId: Number(draft.id) });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const NOW = new Date('2026-11-23T10:00:00Z');
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

test('an invoice email is scheduled for its time, listed, and claimed only when that time comes', async () => {
  mailOn();
  await withFixture(async ({ trx, orgId, invoiceId }) => {
    const s = await scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(3), { to: ['a@b.example'], message: 'Hello', now: NOW });
    assert.equal(s.at, inHours(3).toISOString());
    const listed = await scheduledInvoiceEmails(trx, orgId, invoiceId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].to, ['a@b.example']);
    assert.ok(JOB_KINDS.includes('mail.invoice'), 'the worker claims scheduled emails');
    assert.ok(typeof HANDLERS['mail.invoice'] === 'function', 'and knows how to send them');
    assert.equal(await claimDueJob(trx, 'test', inHours(1), { orgId }), null, 'not before its time');
    const due = await claimDueJob(trx, 'test', inHours(4), { orgId });
    assert.equal(due?.kind, 'mail.invoice');
    assert.equal(Number(due?.payload.invoiceId), invoiceId);
  });
});

test('the same time twice is refused; a past time, a draft and a void invoice are refused', async () => {
  mailOn();
  await withFixture(async ({ trx, orgId, invoiceId, draftId }) => {
    await scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(2), { now: NOW });
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(2), { now: NOW }), /already scheduled/);
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, invoiceId, new Date(NOW.getTime() + 10_000), { now: NOW }), /at least a minute/);
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(24 * 400), { now: NOW }), /a year ahead/);
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, draftId, inHours(2), { now: NOW }), /mark it as sent/);
    await trx.updateTable('invoices').set({ status: 'void' }).where('id', '=', invoiceId).execute();
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(5), { now: NOW }), /void/);
  });
});

test('nothing is scheduled when email is not set up', async () => {
  mailOff();
  await withFixture(async ({ trx, orgId, invoiceId }) => {
    await assert.rejects(scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(2), { now: NOW }), /not set up/);
  });
});

test('a scheduled email can be called off once, and then is not claimed', async () => {
  mailOn();
  await withFixture(async ({ trx, orgId, invoiceId }) => {
    const s = await scheduleInvoiceEmail(trx, orgId, null, invoiceId, inHours(2), { now: NOW });
    assert.deepEqual(await cancelScheduledEmail(trx, orgId, Number(s.id)), { invoiceId });
    assert.equal((await scheduledInvoiceEmails(trx, orgId, invoiceId)).length, 0);
    await assert.rejects(cancelScheduledEmail(trx, orgId, Number(s.id)), /already gone, or was called off/);
    assert.equal(await claimDueJob(trx, 'test', inHours(3), { orgId }), null);
    await assert.rejects(cancelScheduledEmail(trx, orgId + 999_999, Number(s.id)), /does not exist/, 'another book cannot touch it');
  });
});
