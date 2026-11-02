// The fixes from the security review before production (migrations 103-104):
// staff notes stay off the portal; the demo book leads nowhere else and sends
// no mail; a two-step code guessed through a company switch is counted; sign-in
// answers the same for every failure and slows down per address and per email;
// the client's address is read from our own proxy's hop; vendor bank numbers
// are masked for those who do not pay vendors; a new email from the portal
// waits for approval; outside copies keep internal notes in; links to
// documents and payslips can be withdrawn; the go-live check runs.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/security-fixes.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db, transaction, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createEstimate } from '../../lib/server/services/sales-documents';
import {
  decidePortalRequest, listPortalRequests, portalComment, portalOverview, replyOnPortal, updatePortalProfile,
} from '../../lib/server/services/portal';
import { createCompany, myCompanies, switchCompany } from '../../lib/server/auth/companies';
import { setMailTransport, sendMail } from '../../lib/server/mail/mailer';
import { clientIp } from '../../lib/server/client-ip';
import { bucket, clear, count, overLimit } from '../../lib/server/auth/throttle';
import { bankNumberFor } from '../../lib/server/bank-mask';
import { runAs } from '../../lib/server/http';
import { seal } from '../../lib/server/crypto/fields';
import { createDocumentLink, openShareLink, revokeDocumentLinks } from '../../lib/server/services/sharing';
import { forOutside, printableDocument } from '../../lib/server/services/document-print';
import { goLiveChecks } from '../../lib/server/golive';
import { hashPassword } from '../../lib/server/auth/password';
import { MAX_ATTEMPTS } from '../../lib/server/auth/mfa';
import { POST as loginPost } from '../../app/api/auth/login/route';
import type { SessionUser } from '../../lib/server/auth/session';
import { wipeOrganizations } from '../../lib/server/seed/wipe';

async function withBook(fn: (trx: Trx, b: { orgId: number; branchId: number; customer: number; vendor: number }) => Promise<void>, demo = false) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Security Co', is_demo: demo ? 1 : 0 } as never).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const mk = (kind: string, name: string, extra: Record<string, unknown> = {}) =>
        trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered', ...extra } as never)
          .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      await fn(trx, { orgId, branchId, customer: await mk('customer', 'Kumar Stores', { email: 'old@kumar.test' }), vendor: await mk('vendor', 'Steel Co', { bank_account_no: seal('123456789012') }) });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const me = (orgId: number, userId: number, email: string): SessionUser => ({ userId, orgId, name: 'Tester', email, role: 'admin', homeBranchId: null, activeBranchId: null });

test('the portal shows its own conversation, never the staff notes on the same invoice', async () => {
  await withBook(async (trx, { orgId, branchId, customer }) => {
    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', dueDate: '2026-10-31', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }] });
    const staff = Number((await trx.insertInto('users').values({ org_id: orgId, email: `staff-${orgId}@x.test`, name: 'Asha', role: 'admin' } as never).executeTakeFirstOrThrow()).insertId);
    // A staff note, as /api/comments writes one.
    await trx.insertInto('comments').values({ org_id: orgId, target_type: 'invoice', target_id: inv.id, user_id: staff, author_name: 'Asha', body: 'Chase hard, they dispute everything' }).execute();
    await portalComment(trx, orgId, customer, 'customer', 'Kumar', { targetType: 'invoice', targetId: inv.id, body: 'Can we pay in two parts?' });
    await replyOnPortal(trx, orgId, customer, 'customer', { userId: staff, name: 'Asha' }, { targetType: 'invoice', targetId: inv.id, body: 'Yes, of course.' });
    const view = await portalOverview(trx, orgId, customer, 'customer');
    const thread = view.comments[`invoice:${inv.id}`].map((c) => c.body);
    assert.deepEqual(thread, ['Can we pay in two parts?', 'Yes, of course.']);
    assert.ok(!JSON.stringify(view).includes('Chase hard'), 'the staff note is nowhere in what the portal receives');
  });
});

test('the demo book leads nowhere else: no switching, no new company, only itself listed, and no mail', async () => {
  await withBook(async (trx, { orgId }) => {
    const email = `demo-${randomBytes(3).toString('hex')}@x.test`;
    const demoUser = Number((await trx.insertInto('users').values({ org_id: orgId, email, name: 'Demo', role: 'admin', is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
    const other = Number((await trx.insertInto('organizations').values({ name: 'Real Co' }).executeTakeFirstOrThrow()).insertId);
    await trx.insertInto('users').values({ org_id: other, email, name: 'Demo', role: 'admin', is_active: 1 } as never).execute();
    const session = me(orgId, demoUser, email);
    assert.deepEqual((await myCompanies(trx, email, orgId)).map((c) => c.orgId), [String(orgId)], 'the real company is not even named');
    assert.equal((await myCompanies(trx, email)).length, 2);
    await assert.rejects(switchCompany(trx, session, 'x'.repeat(64), other, { ip: null, userAgent: null }), /cannot open or create other companies/);
    await assert.rejects(createCompany(trx, session, { name: 'Mine Now', stateCode: '33' }), /cannot open or create other companies/);
    setMailTransport(async () => ({ messageId: 'never' }));
    try {
      await assert.rejects(sendMail(orgId, { to: ['victim@x.test'], subject: 'Your account', text: 'click here' }, { ex: trx }), /demo book does not send email/);
    } finally {
      setMailTransport(null);
    }
  }, true);
});

test('a two-step code guessed through a company switch is counted, and locks the account', async () => {
  await withBook(async (trx, { orgId }) => {
    const email = `mfa-${randomBytes(3).toString('hex')}@x.test`;
    const here = Number((await trx.insertInto('users').values({ org_id: orgId, email, name: 'Ravi', role: 'admin', is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
    const other = Number((await trx.insertInto('organizations').values({ name: 'Second Co' }).executeTakeFirstOrThrow()).insertId);
    const there = Number((await trx.insertInto('users').values({ org_id: other, email, name: 'Ravi', role: 'admin', is_active: 1, mfa_enabled_at: new Date(), mfa_secret: seal('JBSWY3DPEHPK3PXP') } as never).executeTakeFirstOrThrow()).insertId);
    const session = me(orgId, here, email);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await assert.rejects(switchCompany(trx, session, 'x'.repeat(64), other, { code: '000000', ip: null, userAgent: null }), /code is not right|locked/);
    }
    const u = await trx.selectFrom('users').select(['failed_logins', 'locked_until']).where('id', '=', there).executeTakeFirstOrThrow();
    assert.equal(u.failed_logins, MAX_ATTEMPTS);
    assert.ok(u.locked_until && new Date(u.locked_until) > new Date(), 'locked after the last wrong code');
    await assert.rejects(switchCompany(trx, session, 'x'.repeat(64), other, { code: '123456', ip: null, userAgent: null }), /locked for now/);
  });
});

test('the client address is our own proxy’s hop, not whatever the client wrote first', () => {
  const req = (h: Record<string, string>) => new Request('https://books.test/', { headers: h });
  const saved = { hops: process.env.TRUSTED_PROXY_HOPS, vercel: process.env.VERCEL };
  try {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(clientIp(req({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7' })), '203.0.113.7', 'a forged first entry is ignored');
    process.env.TRUSTED_PROXY_HOPS = '2';
    assert.equal(clientIp(req({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7, 172.16.0.2' })), '203.0.113.7');
    process.env.TRUSTED_PROXY_HOPS = '0';
    assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7' })), null, 'no proxy: nothing in the headers can be believed');
    process.env.VERCEL = '1';
    assert.equal(clientIp(req({ 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '198.51.100.4' })), '198.51.100.4');
  } finally {
    if (saved.hops === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = saved.hops;
    if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
  }
});

test('attempts are counted per window, and cleared on success', async () => {
  const name = bucket('test', randomBytes(6).toString('hex'));
  try {
    assert.equal(await overLimit(db, name, 3, 15), false);
    for (let i = 0; i < 3; i++) await count(db, name, 15);
    assert.equal(await overLimit(db, name, 3, 15), true);
    await sql`UPDATE auth_throttle SET window_start = NOW() - INTERVAL 16 MINUTE WHERE bucket = ${name}`.execute(db);
    assert.equal(await overLimit(db, name, 3, 15), false, 'an old window does not count');
    await count(db, name, 15);
    const { rows } = await sql<{ hits: number }>`SELECT hits FROM auth_throttle WHERE bucket = ${name}`.execute(db);
    assert.equal(Number(rows[0].hits), 1, 'and starts again');
  } finally {
    await clear(db, name);
  }
});

test('sign-in answers the same for an unknown email and an account with no password, and slows down either way', async () => {
  const tag = randomBytes(3).toString('hex');
  const ip = `198.51.100.${Number.parseInt(tag.slice(0, 2), 16) % 250}`;
  const login = (email: string, password: string) => loginPost(new Request('https://books.test/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  }), { params: Promise.resolve({}) });
  let orgId = 0;
  const invited = `invited-${tag}@x.test`;
  const nobody = `nobody-${tag}@x.test`;
  try {
    orgId = await transaction(async (trx) => {
      const id = Number((await trx.insertInto('organizations').values({ name: 'Login Co (temporary)' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('users').values({ org_id: id, email: invited, name: 'Invited', role: 'viewer', is_active: 1 } as never).execute();
      await trx.insertInto('users').values({ org_id: id, email: `real-${tag}@x.test`, name: 'Real', role: 'viewer', is_active: 1, password_hash: await hashPassword('Correct-Horse-9') } as never).execute();
      return id;
    });
    const a = await login(nobody, 'whatever-1');
    const b = await login(invited, 'whatever-1');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401, 'no 403 "not set up yet" to say the account exists');
    assert.deepEqual(await a.json(), await b.json());
    for (let i = 1; i < MAX_ATTEMPTS; i++) await login(nobody, `wrong-${i}`);
    const slowed = await login(nobody, 'one-more');
    assert.equal(slowed.status, 429, 'an email that is no account slows down too');
    assert.equal((await login(`real-${tag}@x.test`, 'Correct-Horse-9')).status, 200, 'another account from the same place still signs in');
  } finally {
    await clear(db, bucket('login-ip', ip));
    await clear(db, bucket('login-email', nobody));
    await clear(db, bucket('login-email', invited));
    await clear(db, bucket('login-email', `real-${tag}@x.test`));
    if (orgId) await wipeOrganizations(db, [orgId]);
  }
});

test('a vendor’s bank number in full only for those who pay vendors', async () => {
  const stored = seal('123456789012');
  assert.equal(await runAs('admin', null, async () => bankNumberFor('admin', stored)), '123456789012');
  assert.equal(await runAs('sales', null, async () => bankNumberFor('sales', stored)), '••••9012');
  assert.equal(await runAs('viewer', null, async () => bankNumberFor('viewer', stored)), '••••9012');
  assert.equal(bankNumberFor('viewer', null), null);
});

test('a new email from the portal waits for approval; other details change at once', async () => {
  await withBook(async (trx, { orgId, customer }) => {
    const r = await updatePortalProfile(trx, orgId, customer, { email: 'thief@evil.test', phone: '9000000001' });
    assert.equal(r.emailPending, 'thief@evil.test');
    assert.deepEqual(r.changed, ['phone']);
    let c = await trx.selectFrom('contacts').select(['email', 'phone']).where('id', '=', customer).executeTakeFirstOrThrow();
    assert.deepEqual([c.email, c.phone], ['old@kumar.test', '9000000001'], 'invoices still go to the old address');
    const [req] = (await listPortalRequests(trx, orgId, customer)).filter((x) => x.kind === 'email');
    assert.equal(req.email, 'thief@evil.test');
    const staff = Number((await trx.insertInto('users').values({ org_id: orgId, email: `st-${orgId}@x.test`, name: 'Asha', role: 'admin' } as never).executeTakeFirstOrThrow()).insertId);
    await decidePortalRequest(trx, orgId, staff, Number(req.id), 'rejected');
    c = await trx.selectFrom('contacts').select(['email', 'phone']).where('id', '=', customer).executeTakeFirstOrThrow();
    assert.equal(c.email, 'old@kumar.test');
    await updatePortalProfile(trx, orgId, customer, { email: 'new@kumar.test' });
    const [again] = (await listPortalRequests(trx, orgId, customer)).filter((x) => x.kind === 'email' && x.status === 'pending');
    await decidePortalRequest(trx, orgId, staff, Number(again.id), 'applied');
    assert.equal((await trx.selectFrom('contacts').select('email').where('id', '=', customer).executeTakeFirstOrThrow()).email, 'new@kumar.test');
  });
});

test('outside copies keep internal notes in; links to a document or a payslip can be withdrawn', async () => {
  await withBook(async (trx, { orgId, branchId, customer }) => {
    const est = await createEstimate(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', expiryDate: '2026-10-16', lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }], notes: 'Delivery in a week', status: 'sent' });
    const quote = await printableDocument(trx, orgId, 'estimate', est.id);
    assert.equal(forOutside(quote).notes, 'Delivery in a week', 'a quote’s notes are for the customer');
    assert.equal(forOutside({ ...quote, kind: 'bill', notes: 'Disputed: hold payment' }).notes, null);
    assert.equal(forOutside({ ...quote, kind: 'payment-made', notes: 'Paid late on purpose' }).notes, null);

    const link = await createDocumentLink(trx, orgId, null, { kind: 'estimate', id: est.id });
    const token = link.path.split('/').pop()!;
    assert.ok(await openShareLink(trx, token));
    assert.equal(await revokeDocumentLinks(trx, orgId, 'estimate', est.id), 1);
    assert.equal(await openShareLink(trx, token), null, 'a withdrawn link opens nothing');
  });
});

test('the go-live check runs and says what is missing without showing any secret', async () => {
  const checks = await goLiveChecks();
  const ids = checks.map((c) => c.id);
  for (const id of ['app-env', 'demo-mode', 'database', 'migrations', 'encryption-key', 'cron', 'site-url', 'files', 'backups', 'email', 'gst', 'einvoice', 'company']) {
    assert.ok(ids.includes(id), `${id} is checked`);
  }
  assert.equal(checks.find((c) => c.id === 'database')?.status, 'ok');
  assert.equal(checks.find((c) => c.id === 'migrations')?.status, 'ok', 'every migration here is applied');
  const key = process.env.FIELD_ENCRYPTION_KEY;
  if (key) assert.ok(!JSON.stringify(checks).includes(key), 'the key itself is never in the answer');
  assert.ok(!JSON.stringify(checks).includes(process.env.DB_PASSWORD || '\u0000never'), 'nor the database password');
});

test.after(async () => {
  await db.destroy();
});
