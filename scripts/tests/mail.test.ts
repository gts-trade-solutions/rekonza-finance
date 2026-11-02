// Outgoing email: refused clearly when no mail server is set up, logged when
// sent or refused, and addressed to the people marked to receive documents.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/mail.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { documentRecipients, sendMail, setMailTransport } from '../../lib/server/mail/mailer';

test('mail: not set up says so; sent and failed are both logged; documents go to the people marked', async () => {
  const rollback = Symbol('rollback');
  const saved = { host: process.env.SMTP_HOST, from: process.env.MAIL_FROM };
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Mail Co' }).executeTakeFirstOrThrow()).insertId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Kumar', state_code: '33', gst_treatment: 'unregistered', email: 'office@kumar.test' } as never).executeTakeFirstOrThrow()).insertId);

      delete process.env.SMTP_HOST;
      setMailTransport(null);
      await assert.rejects(sendMail(orgId, { to: ['a@b.test'], subject: 'Hi', text: 'Hi' }, { ex: trx }), (e: { code?: string }) => e.code === 'mail_not_configured');

      const out: { to: string[]; subject: string }[] = [];
      setMailTransport(async (m) => { out.push({ to: m.to, subject: m.subject }); return { messageId: '<1@test>' }; });
      await sendMail(orgId, { to: ['pay@kumar.test'], subject: 'Invoice INV-1', text: '…' }, { docType: 'invoice', docId: 7, ex: trx });
      await assert.rejects(sendMail(orgId, { to: ['not an address'], subject: 'x', text: 'x' }, { ex: trx }), /not an email address/);
      setMailTransport(async () => { throw new Error('550 mailbox unavailable'); });
      await assert.rejects(sendMail(orgId, { to: ['gone@kumar.test'], subject: 'Invoice INV-2', text: '…' }, { docType: 'invoice', docId: 8, ex: trx }), /refused the message: 550/);
      const log = await trx.selectFrom('email_log').select(['to_address', 'status', 'error', 'doc_id']).where('org_id', '=', orgId).orderBy('id').execute();
      assert.deepEqual(log.map((l) => [l.to_address, l.status, l.doc_id]), [['pay@kumar.test', 'sent', 7], ['gone@kumar.test', 'failed', 8]]);
      assert.match(log[1].error ?? '', /550/);
      assert.equal(out[0].subject, 'Invoice INV-1');

      // The contact's own address, until people are marked to receive documents.
      assert.deepEqual(await documentRecipients(trx, orgId, customer), ['office@kumar.test']);
      await trx.insertInto('contact_persons').values([
        { org_id: orgId, contact_id: customer, name: 'Accounts', email: 'accounts@kumar.test', is_primary: 1, receives_documents: 1 },
        { org_id: orgId, contact_id: customer, name: 'Owner', email: 'owner@kumar.test', is_primary: 0, receives_documents: 0 },
      ]).execute();
      assert.deepEqual(await documentRecipients(trx, orgId, customer), ['accounts@kumar.test']);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  } finally {
    setMailTransport(null);
    if (saved.host) process.env.SMTP_HOST = saved.host;
    if (saved.from) process.env.MAIL_FROM = saved.from;
  }
});

test.after(() => db.destroy());
