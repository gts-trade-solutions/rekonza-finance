// Filing GST returns through the GST system's API (integrations/gst/gstn-returns.ts,
// returns-provider.ts, returns-service.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gst-returns-api.test.ts
//
// No GSP is reachable from a test, so a fake of the GST system's taxpayer API
// stands in for one — doing the real encryption: the app key RSA-sealed with
// its public key, the OTP and session key AES-sealed, every payload sealed
// with the session key and signed with HMAC, every reply sealed with its own
// key. What is proved is that the app speaks that protocol, and that the
// whole flow — connect, OTP, push, status, EVC filing, GSTR-2B, GSTIN lookup —
// lands where it should. A live GSP's sandbox is the remaining check.
//
// The service writes through the shared connection (sessions and the call log
// must survive a rollback), so the service tests make their own company and
// remove every row of it afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, privateDecrypt, randomBytes, constants } from 'node:crypto';

// ── A fake GST system ────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const enc = (key: Buffer, data: Buffer | string) => { const c = createCipheriv('aes-256-ecb', key, null); return Buffer.concat([c.update(data), c.final()]).toString('base64'); };
const dec = (key: Buffer, b64: string) => { const d = createDecipheriv('aes-256-ecb', key, null); return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]); };
const mac = (key: Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('base64');

interface Fake {
  fetch: typeof fetch;
  saved: Map<string, unknown>;
  calls: { method: string; path: string; action: string | null; headers: Record<string, string> }[];
  filed: string[];
}

function fakeGstn(opts: { otp?: string } = {}): Fake {
  const OTP = opts.otp ?? '575757';
  const sessions = new Map<string, Buffer>(); // auth token → EK
  const pendingKeys = new Map<string, Buffer>(); // username → app key
  const saved = new Map<string, unknown>();
  const calls: Fake['calls'] = [];
  const filed: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const sealed = (ek: Buffer, data: unknown) => {
    const rek = randomBytes(32);
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
    return reply({ status_cd: '1', rek: enc(ek, rek), data: enc(rek, b64), hmac: mac(rek, b64) });
  };
  const fail = (code: string, message: string) => reply({ status_cd: '0', error: { error_cd: code, message } });

  const impl = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const action = url.searchParams.get('action') ?? body.action ?? null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, action, headers });
    if (headers.clientid !== 'gsp-client' || headers['client-secret'] !== 'gsp-secret') return fail('GSP401', 'Unknown GSP client.');

    if (url.pathname === '/commonapi/v1.1/search') {
      const data = { gstin: url.searchParams.get('gstin'), lgnm: 'SRI MURUGAN MOTORS PRIVATE LIMITED', tradeNam: 'Sri Murugan Motors', sts: 'Active', dty: 'Regular', ctb: 'Private Limited Company', rgdt: '01/07/2017', pradr: { addr: { bno: '12', st: 'Anna Salai', loc: 'Teynampet', dst: 'Chennai', stcd: 'Tamil Nadu', pncd: '600018' } } };
      return reply({ status_cd: '1', data: Buffer.from(JSON.stringify(data)).toString('base64') });
    }
    if (url.pathname === '/commonapi/v1.0/returns') {
      return reply({ status_cd: '1', data: Buffer.from(JSON.stringify({ EFiledlist: [{ rtntype: 'GSTR3B', ret_prd: '082026', status: 'Filed', arn: 'AA330826000001Z', dof: '19-09-2026', mof: 'EVC' }] })).toString('base64') });
    }
    if (url.pathname === '/taxpayerapi/v1.0/authenticate' && (init?.method ?? 'GET') === 'POST') {
      const appKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(body.app_key, 'base64'));
      if (body.action === 'OTPREQUEST') {
        pendingKeys.set(body.username, appKey);
        return reply({ status_cd: '1' });
      }
      if (body.action === 'AUTHTOKEN') {
        if (!pendingKeys.get(body.username)?.equals(appKey)) return fail('AUTH4038', 'Ask for an OTP first.');
        if (dec(appKey, body.otp).toString('utf8') !== OTP) return fail('AUTH4033', 'Invalid OTP');
        const ek = randomBytes(32);
        const token = randomBytes(16).toString('hex');
        sessions.set(token, ek);
        return reply({ status_cd: '1', auth_token: token, expiry: 360, sek: enc(appKey, ek) });
      }
    }
    const ek = sessions.get(headers['auth-token'] ?? '');
    if (!ek) return fail('AUTH158', 'The session has expired.');
    const open = () => {
      const b64 = dec(ek, body.data).toString('utf8');
      assert.equal(mac(ek, b64), body.hmac, 'the payload carries a valid HMAC');
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    };
    const ret = url.pathname.split('/').pop()!;
    if (action === 'EVCOTP') return reply({ status_cd: '1' });
    if (action === 'RETSAVE') {
      const payload = open();
      const period = headers.ret_period;
      if ((payload.fp ?? payload.ret_period) !== period) return fail('RET11403', 'The return period does not match.');
      if (payload.gstin !== headers.gstin) return fail('RET11402', 'The GSTIN does not match.');
      const ref = `REF${period}${randomBytes(3).toString('hex')}`;
      saved.set(`${ret}|${period}`, payload);
      saved.set(ref, payload);
      return sealed(ek, { reference_id: ref });
    }
    if (action === 'RETSTATUS') {
      const ref = url.searchParams.get('ref_id')!;
      return saved.has(ref) ? sealed(ek, { status_cd: 'P' }) : sealed(ek, { status_cd: 'ER', error_report: { error_cd: 'RET191106', error_msg: 'Unknown reference' } });
    }
    if (action === 'RETSUM') return sealed(ek, { gstin: headers.gstin, ret_period: headers.ret_period, summary: { ttl_tax: 1234.5 } });
    if (action === 'RETFILE') {
      const summary = open();
      const [pan, otp] = String(body.sid).split('|');
      if (otp !== OTP) return fail('RET13510', 'Invalid EVC OTP');
      if (pan !== headers.gstin.slice(2, 12)) return fail('RET13509', 'Not an authorised signatory');
      const expected = createHmac('sha256', Buffer.from(otp)).update(Buffer.from(JSON.stringify(summary)).toString('base64'), 'utf8').digest('base64');
      if (body.sign !== expected) return fail('RET13511', 'The EVC signature does not match.');
      filed.push(`${ret}|${headers.ret_period}`);
      return sealed(ek, { ack_num: `AA33${headers.ret_period.slice(0, 2)}${headers.ret_period.slice(4)}1234567Z` });
    }
    if (action === 'GET2B') {
      return sealed(ek, { data: { gstin: headers.gstin, rtnprd: url.searchParams.get('rtnprd'), docdata: { b2b: [{ ctin: '33AAACS3333S1Z3', trdnm: 'Supplier', inv: [{ inum: 'S-77', dt: '05-08-2026', txval: 1000, cgst: 90, sgst: 90, igst: 0, cess: 0, itcavl: 'Y', rev: 'N' }] }] } } });
    }
    return fail('NOTFOUND', `No such call: ${init?.method} ${url.pathname} ${action}`);
  };
  return { fetch: impl as unknown as typeof fetch, saved, calls, filed };
}

const ENV = {
  GST_API_BASE_URL: 'https://gsp.example', GST_API_CLIENT_ID: 'gsp-client', GST_API_CLIENT_SECRET: 'gsp-secret',
  GST_API_PUBLIC_KEY: PUBLIC_PEM, GST_API_ENV: 'sandbox',
} as unknown as NodeJS.ProcessEnv;

// ── The adapter alone ────────────────────────────────────────────────────────

test('the GSTN adapter signs in with an OTP, saves, follows, files with EVC and fetches 2B', async () => {
  const { GstnReturnsProvider, gstnConfigFromEnv } = await import('../../lib/server/integrations/gst/gstn-returns');
  const fake = fakeGstn();
  const p = new GstnReturnsProvider(gstnConfigFromEnv(ENV), fake.fetch);
  assert.deepEqual(p.missingConfiguration(), []);
  const ctx = { gstin: '33AABCG7070K1Z2', username: 'raceauto', ipUser: '203.0.113.9' };

  const { pending } = await p.requestOtp(ctx);
  await assert.rejects(p.verifyOtp(ctx, pending, '111111'), (e: Error) => e.name === 'PortalAuthFailed' && /Invalid OTP/.test(e.message));
  const s = await p.verifyOtp(ctx, pending, '575757');
  assert.equal(Buffer.from(s.sessionKey, 'base64').length, 32, 'the session key came out of its wrapping');
  assert.ok(new Date(s.expiresAt).getTime() > Date.now() + 5 * 3600_000, 'six hours');

  const payload = { gstin: ctx.gstin, fp: '082026', b2b: [] };
  const { referenceId } = await p.saveReturn(ctx, s, 'GSTR1', '082026', payload);
  assert.deepEqual(fake.saved.get('gstr1|082026'), payload, 'the portal received exactly the return');
  assert.equal((await p.returnStatus(ctx, s, '082026', referenceId)).status, 'processed');
  const bad = await p.returnStatus(ctx, s, '082026', 'nope');
  assert.equal(bad.status, 'error');
  assert.ok(bad.errorReport);
  await assert.rejects(p.saveReturn(ctx, s, 'GSTR1', '092026', payload), (e: Error & { code?: string }) => e.name === 'PortalRejection' && e.code === 'RET11403');

  await p.requestEvcOtp(ctx, s, 'GSTR1', 'AABCG7070K');
  await assert.rejects(p.fileReturn(ctx, s, 'GSTR1', '082026', { pan: 'AABCG7070K', otp: '000000' }), /Invalid EVC OTP/);
  const filed = await p.fileReturn(ctx, s, 'GSTR1', '082026', { pan: 'AABCG7070K', otp: '575757' });
  assert.equal(filed.arn, 'AA3308261234567Z');

  const twoB = await p.fetchGstr2b(ctx, s, '082026') as { data: { docdata: unknown } };
  assert.ok(twoB.data.docdata);
  const found = await p.searchTaxpayer({}, '33AAACS1234F1ZZ');
  assert.equal(found.legalName, 'SRI MURUGAN MOTORS PRIVATE LIMITED');
  assert.equal(found.address?.pincode, '600018');
  assert.equal((await p.trackReturns({}, ctx.gstin, '2026-27'))[0].arn, 'AA330826000001Z');

  const save = fake.calls.find((c) => c.action === 'RETSAVE')!;
  assert.equal(save.headers['state-cd'], '33');
  assert.equal(save.headers['ip-usr'], '203.0.113.9');
  assert.equal(save.headers.username, 'raceauto');
  assert.equal(save.headers.ret_period, '082026');
});

test('the stand-in behaves like the GSTN sandbox and files nothing', async () => {
  const { standinReturns, STANDIN_OTP } = await import('../../lib/server/integrations/gst/returns-provider');
  const ctx = { gstin: '33AABCG7070K1Z2', username: 'raceauto' };
  const { pending } = await standinReturns.requestOtp(ctx);
  await assert.rejects(standinReturns.verifyOtp(ctx, pending, '123456'));
  const s = await standinReturns.verifyOtp(ctx, pending, STANDIN_OTP);
  await assert.rejects(standinReturns.fileReturn(ctx, s, 'GSTR3B', '082026', { pan: 'AABCG7070K', otp: STANDIN_OTP }), /Push GSTR3B/);
  await standinReturns.saveReturn(ctx, s, 'GSTR3B', '082026', { gstin: ctx.gstin, ret_period: '082026' });
  const f = await standinReturns.fileReturn(ctx, s, 'GSTR3B', '082026', { pan: 'AABCG7070K', otp: STANDIN_OTP });
  assert.match(f.arn, /^AA330826\d{7}[A-Z]$/, 'an ARN in the real shape');
  assert.equal(standinReturns.live, false);
  const d = await standinReturns.searchTaxpayer({}, '33AABCG7070K1Z2');
  assert.equal(d.fromPortal, false);
  assert.equal(d.legalName, null, 'it does not invent a name');
  assert.equal(d.constitution, 'Private Limited Company', 'the PAN’s fourth letter says what kind of holder it is');
});

// ── The whole flow, through the service ──────────────────────────────────────

test('connect, sign in, push GSTR-3B, file with EVC: the ARN is kept and the period marked done', async () => {
  const fake = fakeGstn();
  Object.assign(process.env, ENV);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  const { db } = await import('../../lib/server/db');
  const svc = await import('../../lib/server/integrations/gst/returns-service');
  const { installChartOfAccounts } = await import('../../lib/server/ledger/chart-of-accounts');
  const orgId = Number((await db.insertInto('organizations').values({ name: 'GST Portal Test Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await db.insertInto('branches').values({ org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1, gstin: '33AABCG7070K1Z2' }).executeTakeFirstOrThrow()).insertId);
  const userId = Number((await db.selectFrom('users').select('id').orderBy('id').limit(1).executeTakeFirstOrThrow()).id);
  try {
    await db.transaction().execute((trx) => installChartOfAccounts(trx, orgId));
    // Not connected yet.
    await assert.rejects(svc.pushReturn(orgId, branchId, userId, 'GSTR3B', '2026-08'), /not connected/);

    await db.transaction().execute((trx) => svc.setReturnsUser(trx, orgId, userId, branchId, { username: 'raceauto', provider: 'gstn' }));
    let view = (await svc.returnsConnections(db, orgId))[0];
    assert.equal(view.username, 'raceauto');
    assert.equal(view.connected, false);
    assert.equal(view.environment, 'sandbox');

    await svc.requestOtp(orgId, branchId, '203.0.113.9');
    assert.equal((await svc.returnsConnections(db, orgId))[0].awaitingOtp, true);
    await assert.rejects(svc.verifyOtp(orgId, branchId, '111111'), /Invalid OTP/);
    const signedIn = await svc.verifyOtp(orgId, branchId, '575757');
    view = (await svc.returnsConnections(db, orgId))[0];
    assert.equal(view.connected, true);
    assert.equal(view.sessionExpiresAt, signedIn.expiresAt);

    // The session is sealed: nothing readable in the table.
    const raw = await db.selectFrom('integration_sessions as s').innerJoin('integration_connections as c', 'c.id', 's.connection_id').select('s.ciphertext').where('c.org_id', '=', orgId).executeTakeFirstOrThrow();
    assert.equal(Buffer.from(raw.ciphertext as unknown as Uint8Array).toString('latin1').includes('auth'), false);

    const pushed = await svc.pushReturn(orgId, branchId, userId, 'GSTR3B', '2026-08');
    assert.equal(pushed.status, 'processed', 'the status was asked for straight away');
    assert.equal(pushed.period, '082026');
    assert.ok(fake.saved.get('gstr3b|082026'), 'the GSTR-3B JSON reached the portal');
    assert.equal((fake.saved.get('gstr3b|082026') as { ret_period: string }).ret_period, '082026');

    await svc.requestEvcOtp(orgId, branchId, 'GSTR3B');
    const filed = await svc.fileReturn(orgId, branchId, userId, 'GSTR3B', '2026-08', '575757');
    assert.equal(filed.status, 'filed');
    assert.equal(filed.arn, 'AA3308261234567Z');
    const done = await db.selectFrom('compliance_filings').selectAll().where('org_id', '=', orgId).where('item_key', '=', 'gstr3b').where('period', '=', '2026-08').executeTakeFirst();
    assert.equal(done?.reference, 'AA3308261234567Z', 'the compliance calendar shows it filed, with the ARN');

    const twoB = await svc.fetchGstr2bFromPortal(orgId, branchId, '2026-08');
    assert.equal(twoB.inserted, 1, 'GSTR-2B went into the reconciliation');

    const details = await svc.lookupGstin('33AAACS1234F1ZZ');
    assert.equal(details.tradeName, 'Sri Murugan Motors');

    const log = await db.selectFrom('integration_calls').select(['operation', 'outcome', 'request_json']).where('org_id', '=', orgId).orderBy('id').execute();
    assert.deepEqual(log.map((l) => l.operation), ['otp_request', 'otp_verify', 'otp_verify', 'save_gstr3b', 'return_status', 'evc_otp', 'file_gstr3b', 'fetch_gstr2b']);
    assert.equal(log[1].outcome, 'error', 'the wrong OTP is in the log too');
    assert.equal(JSON.stringify(log).includes('575757'), false, 'no OTP is ever written to the log');

    const subs = await svc.listSubmissions(db, orgId, { branchId });
    assert.deepEqual(subs.map((s) => s.action), ['file', 'save']);
  } finally {
    globalThis.fetch = realFetch;
    // Every row of the test company goes, in the order the keys allow.
    const conns = (await db.selectFrom('integration_connections').select('id').where('org_id', '=', orgId).execute()).map((c) => c.id);
    await db.deleteFrom('integration_calls').where('org_id', '=', orgId).execute();
    if (conns.length) await db.deleteFrom('integration_sessions').where('connection_id', 'in', conns).execute();
    await db.deleteFrom('integration_connections').where('org_id', '=', orgId).execute();
    await db.deleteFrom('gst_return_submissions').where('org_id', '=', orgId).execute();
    await db.deleteFrom('compliance_filings').where('org_id', '=', orgId).execute();
    await db.deleteFrom('gstr2b_entries').where('org_id', '=', orgId).execute().catch(() => undefined);
    await db.deleteFrom('accounts').where('org_id', '=', orgId).execute().catch(() => undefined);
    await db.deleteFrom('branches').where('org_id', '=', orgId).execute();
    await db.deleteFrom('organizations').where('id', '=', orgId).execute();
    await db.destroy();
  }
});
