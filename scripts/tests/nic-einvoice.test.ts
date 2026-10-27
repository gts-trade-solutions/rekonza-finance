// The NIC e-invoice connector, against a simulated NIC.
//   npx tsx --conditions=react-server --test scripts/tests/nic-einvoice.test.ts
//
// There is no sandbox account yet, so the connector cannot be tested against
// the real portal. What it can be tested against is a portal that follows
// NIC's published protocol to the letter: it holds its own RSA key pair,
// decrypts our login with the private half, issues a session key wrapped in our
// AppKey, decrypts the invoice we send under that session key, and replies
// encrypted the same way. If any link in our encryption chain is wrong — the
// base64 step before RSA, the padding, the ECB mode, the SEK unwrapping — this
// server cannot read us and the tests fail.
//
// What it cannot prove is that NIC behaves as its documentation says. That is
// the first real sandbox call's job.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt,
  randomBytes, type KeyObject,
} from 'node:crypto';

import { NicEinvoiceProvider, nicConfigFromEnv, readDuplicate, readErrors, type NicConfig } from '../../lib/server/integrations/gst/nic-einvoice';
import {
  aesDecrypt, aesEncryptBase64, decryptSessionKey, loadPublicKey,
} from '../../lib/server/integrations/gst/nic-crypto';
import {
  PortalAuthFailed, PortalDuplicate, PortalRejection, PortalUnavailable,
  formatPortalTimestamp, parsePortalTimestamp,
  type ProviderContext, type SessionStore,
} from '../../lib/server/integrations/gst/provider';
import { buildEinvoicePayload, type EinvoiceSource } from '../../lib/server/integrations/gst/einvoice-payload';
import { financialYear } from '../../lib/server/integrations/gst/fake';

// ── A portal that follows the published protocol ─────────────────────────────

const GSTIN = '33AABCU9603R1ZU';
const CLIENT_ID = 'TEST-CLIENT';
const CLIENT_SECRET = 'TEST-SECRET';
const USERNAME = 'coastal_api';
const PASSWORD = 'Portal@2026';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/**
 * PKCS#1 v1.5 decryption, done by hand if Node refuses to.
 *
 * Recent Node releases disable PKCS#1 v1.5 for *private* decryption to close a
 * timing attack. That only matters for the real portal's side of the
 * exchange, which this is standing in for, so the padding is stripped
 * manually here. The connector only ever encrypts, which is unaffected.
 */
function rsaDecryptPkcs1(key: KeyObject, data: Buffer): Buffer {
  try {
    return privateDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, data);
  } catch {
    const raw = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, data);
    // 0x00 0x02 [non-zero padding] 0x00 [message]
    assert.equal(raw[0], 0x00);
    assert.equal(raw[1], 0x02);
    const sep = raw.indexOf(0x00, 2);
    return raw.subarray(sep + 1);
  }
}

const aesEcbDecrypt = (key: Buffer, b64: string) => {
  const d = createDecipheriv('aes-256-ecb', key, null);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]);
};
const aesEcbEncrypt = (key: Buffer, data: Buffer | string) => {
  const c = createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([c.update(data), c.final()]).toString('base64');
};

interface Portal {
  fetch: typeof fetch;
  /** Every request, in order, for asserting on what was sent. */
  calls: { path: string; headers: Record<string, string> }[];
  /** Drop the current token, as if it expired server-side. */
  expireToken(): void;
  issued: Map<string, { ackNo: string; ackDt: string }>;
  failNextWith?: { status?: number; network?: boolean };
}

function simulatedNic(opts: { sekAsBase64?: boolean } = {}): Portal {
  let token: string | null = null;
  let sek: Buffer | null = null;
  const issued = new Map<string, { ackNo: string; ackDt: string }>();
  const calls: Portal['calls'] = [];

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (code: string, message: string, info?: unknown) =>
    reply({ status: '0', Data: null, ErrorDetails: [{ ErrorCode: code, ErrorMessage: message }], InfoDtls: info ?? null });

  const portal: Portal = {
    calls,
    issued,
    expireToken: () => { token = null; },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      calls.push({ path: url.pathname, headers });

      if (portal.failNextWith?.network) {
        portal.failNextWith = undefined;
        throw new TypeError('fetch failed');
      }
      if (portal.failNextWith?.status) {
        const s = portal.failNextWith.status;
        portal.failNextWith = undefined;
        return new Response('upstream trouble', { status: s });
      }
      if (headers.client_id !== CLIENT_ID || headers.client_secret !== CLIENT_SECRET) {
        return fail('1009', 'Invalid client id or client secret');
      }
      const body = JSON.parse(String(init?.body)) as { Data: string };

      if (url.pathname === '/eivital/v1.04/auth') {
        // v1.04: base64(JSON), then RSA with the portal's public key.
        const b64 = rsaDecryptPkcs1(privateKey, Buffer.from(body.Data, 'base64')).toString('utf8');
        const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        if (creds.UserName !== USERNAME || creds.Password !== PASSWORD) {
          return fail('1008', 'Invalid login credentials');
        }
        const appKey = Buffer.from(creds.AppKey, 'base64');
        assert.equal(appKey.length, 32, 'AppKey must be 32 bytes, sent as 44 base64 characters');
        sek = randomBytes(32);
        token = randomBytes(16).toString('hex');
        const wrapped = opts.sekAsBase64
          ? aesEcbEncrypt(appKey, sek.toString('base64'))
          : aesEcbEncrypt(appKey, sek);
        return reply({
          Status: 1,
          Data: {
            ClientId: CLIENT_ID, UserName: USERNAME, AuthToken: token, Sek: wrapped,
            TokenExpiry: formatPortalTimestamp(new Date(Date.now() + 60 * 60_000)),
          },
          ErrorDetails: null,
          InfoDtls: null,
        });
      }

      if (!token || headers.AuthToken !== token) return fail('1005', 'Invalid Token');
      if (headers.Gstin !== GSTIN || headers.user_name !== USERNAME) {
        return fail('1004', 'Header GSTIN or user name does not match the token');
      }
      const doc = JSON.parse(aesEcbDecrypt(sek!, body.Data).toString('utf8'));

      if (url.pathname === '/eicore/v1.03/Invoice') {
        const [d, m, y] = doc.DocDtls.Dt.split('/');
        const irn = createHash('sha256')
          .update(`${doc.SellerDtls.Gstin}${doc.DocDtls.Typ}${doc.DocDtls.No}${financialYear(`${y}-${m}-${d}`)}`)
          .digest('hex');
        const prior = issued.get(irn);
        if (prior) {
          return fail('2150', 'Duplicate IRN', [{ InfCd: 'DUPIRN', Desc: { AckNo: prior.ackNo, AckDt: prior.ackDt, Irn: irn } }]);
        }
        const ack = { ackNo: '112610000012345', ackDt: '2026-09-11 14:18:00' };
        issued.set(irn, ack);
        return reply({
          Status: '1',
          Data: aesEcbEncrypt(sek!, JSON.stringify({
            AckNo: Number(ack.ackNo), AckDt: ack.ackDt, Irn: irn,
            SignedInvoice: 'eyJhbGciOiJSUzI1NiJ9.signed-invoice.sig',
            SignedQRCode: 'eyJhbGciOiJSUzI1NiJ9.signed-qr.sig',
            Status: 'ACT',
            EwbNo: doc.EwbDtls ? 331009876543 : null,
            EwbDt: doc.EwbDtls ? '2026-09-11 14:18:00' : null,
            EwbValidTill: doc.EwbDtls ? '2026-09-12 23:59:00' : null,
            Remarks: null,
          })),
          ErrorDetails: null,
          InfoDtls: null,
        });
      }

      if (url.pathname === '/eicore/v1.03/Invoice/Cancel') {
        assert.ok(['1', '2', '3', '4'].includes(doc.CnlRsn));
        assert.ok(doc.CnlRem.length <= 100);
        return reply({
          Status: '1',
          Data: aesEcbEncrypt(sek!, JSON.stringify({ Irn: doc.Irn, CancelDate: '2026-09-11 15:00:00' })),
        });
      }

      if (url.pathname === '/eiewb/v1.03/ewaybill') {
        // Only for an IRN this portal issued, and only with Part B.
        if (!issued.has(doc.Irn)) return fail('4002', 'Irn is not found');
        assert.ok(doc.VehNo || doc.TransDocNo, 'Part B: a vehicle or a transport document');
        assert.ok(['1', '2', '3', '4'].includes(doc.TransMode));
        return reply({
          Status: '1',
          Data: aesEcbEncrypt(sek!, JSON.stringify({
            EwbNo: 341000123456, EwbDt: '2026-09-11 16:00:00', EwbValidTill: '2026-09-12 23:59:00', Remarks: null,
          })),
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  };
  return portal;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function config(over: Partial<NicConfig> = {}): NicConfig {
  return {
    baseUrl: 'https://einv-apisandbox.nic.in',
    declaredEnvironment: null,
    environmentError: null,
    authPath: '/eivital/v1.04/auth',
    invoicePath: '/eicore/v1.03/Invoice',
    cancelPath: '/eicore/v1.03/Invoice/Cancel',
    ewbPath: '/eiewb/v1.03/ewaybill',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicKey,
    publicKeyError: null,
    timeoutMs: 5_000,
    ...over,
  };
}

function memorySessions(): SessionStore & { writes: number } {
  const m = new Map<number, { authToken: string; sessionKey: string }>();
  const store = {
    writes: 0,
    async get(id: number) { return m.get(id) ?? null; },
    async set(id: number, s: { authToken: string; sessionKey: string }) { store.writes++; m.set(id, s); },
    async clear(id: number) { m.delete(id); },
  };
  return store;
}

function ctx(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    orgId: 1,
    connectionId: 7,
    gstin: GSTIN,
    credentials: { username: USERNAME, password: PASSWORD },
    sessions: memorySessions(),
    ...over,
  };
}

function invoice(over: Partial<EinvoiceSource> = {}): EinvoiceSource {
  return {
    docType: 'INV', number: 'INV/2026/0042', date: '2026-09-01',
    supplyType: 'intra', supplyKind: 'goods', placeOfSupply: '33',
    seller: { gstin: GSTIN, legalName: 'Coastal Furnishings Pvt Ltd', address1: '14 Anna Salai', city: 'Chennai', pincode: '600002', stateCode: '33' },
    buyer: { gstin: '33AAACR5055K1ZE', legalName: 'Ridge Office Supplies LLP', address1: '9 Mount Road', city: 'Chennai', pincode: '600006', stateCode: '33' },
    lines: [{
      lineNo: 1, description: 'Office chair', hsnSac: '940130', qty: 10, uqc: 'NOS',
      ratePaise: 1_500_00, discountPaise: 0, taxablePaise: 15_000_00, gstRatePct: 18,
      cgstPaise: 1_350_00, sgstPaise: 1_350_00, igstPaise: 0, cessPaise: 0, lineTotalPaise: 17_700_00,
    }],
    docDiscountPaise: 0, shippingChargePaise: 0, adjustmentPaise: 0, roundOffPaise: 0,
    totalPaise: 17_700_00,
    ...over,
  };
}

const authCalls = (p: Portal) => p.calls.filter((c) => c.path.endsWith('/auth')).length;

// ── The exchange ─────────────────────────────────────────────────────────────

test('logging in: the portal can read our credentials, and we can read its session key', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const c = ctx();

  const r = await nic.verify(c);
  assert.ok(r.expiresAt, 'the portal says when the token expires');
  assert.equal(authCalls(portal), 1);

  const h = portal.calls[0].headers;
  assert.equal(h.client_id, CLIENT_ID);
  assert.equal(h.Gstin, GSTIN);
  assert.ok(await c.sessions!.get(7), 'the session is kept for the next call');
});

test('registering an invoice end to end, under the session key', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);

  const r = await nic.generateIrn(buildEinvoicePayload(invoice()), ctx());

  // The IRN is the portal's own fingerprint of the document — the simulated
  // portal computes it from what it decrypted, so matching it proves the
  // invoice arrived intact.
  const expected = createHash('sha256').update(`${GSTIN}INVINV/2026/00422026-27`).digest('hex');
  assert.equal(r.irn, expected);
  assert.equal(r.ackNo, '112610000012345', 'a numeric AckNo comes back as a string');
  assert.equal(r.ackDate, '2026-09-11 14:18:00');
  assert.match(r.signedQr ?? '', /^eyJ/);
  assert.match(r.signedInvoice ?? '', /^eyJ/);
  assert.equal(r.ewbNo, null, 'no transport details, no e-way bill');

  const call = portal.calls.find((x) => x.path === '/eicore/v1.03/Invoice')!;
  assert.equal(call.headers.user_name, USERNAME);
  assert.ok(call.headers.AuthToken, 'the token rides in the AuthToken header');
});

test('transport details come back as an e-way bill from the same call', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const r = await nic.generateIrn(
    buildEinvoicePayload(invoice({ transport: { vehicleNo: 'TN01AB1234', distanceKm: 320, mode: 'road' } })),
    ctx(),
  );
  assert.equal(r.ewbNo, '331009876543');
  assert.equal(r.ewbValidUntil, '2026-09-12 23:59:00');
});

const byIrn = (irn: string) => ({
  irn, distanceKm: 320, mode: 'road' as const, vehicleNo: 'TN01AB1234', transporterId: null,
  transporterName: null, transportDocNo: null, transportDocDate: null, isOverDimensional: false,
});

test('an e-way bill for an invoice already registered, from the invoice portal', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const c = ctx();
  const { irn } = await nic.generateIrn(buildEinvoicePayload(invoice()), c);

  const ewb = await nic.generateEwbByIrn(byIrn(irn), c);
  assert.equal(ewb.ewbNo, '341000123456', 'a numeric EwbNo comes back as a string');
  assert.equal(ewb.validUntil, '2026-09-12 23:59:00');
  assert.equal(ewb.generatedAt, '2026-09-11 16:00:00');
  assert.equal(authCalls(portal), 1, 'the same session as the registration');
});

test('an e-way bill against an IRN the portal does not hold is refused', async () => {
  const nic = new NicEinvoiceProvider(config(), simulatedNic().fetch);
  await assert.rejects(
    () => nic.generateEwbByIrn(byIrn('f'.repeat(64)), ctx()),
    (err: unknown) => err instanceof PortalRejection && err.code === '4002',
  );
});

test('the session is reused, not a login per invoice', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const c = ctx();
  await nic.generateIrn(buildEinvoicePayload(invoice({ number: 'INV/1' })), c);
  await nic.generateIrn(buildEinvoicePayload(invoice({ number: 'INV/2' })), c);
  await nic.generateIrn(buildEinvoicePayload(invoice({ number: 'INV/3' })), c);
  assert.equal(authCalls(portal), 1, 'three invoices, one login');
});

test('a token the portal dropped is replaced once, and the invoice still goes through', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const c = ctx();
  await nic.generateIrn(buildEinvoicePayload(invoice({ number: 'INV/1' })), c);

  portal.expireToken();
  const r = await nic.generateIrn(buildEinvoicePayload(invoice({ number: 'INV/2' })), c);
  assert.equal(r.irn.length, 64);
  assert.equal(authCalls(portal), 2, 'exactly one fresh login, not a loop');
});

test('a session key sent back base64-wrapped is still unwrapped correctly', async () => {
  // Some descriptions of the API have the SEK arrive base64 inside its
  // ciphertext. The connector accepts both, and this is the proof.
  const portal = simulatedNic({ sekAsBase64: true });
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const r = await nic.generateIrn(buildEinvoicePayload(invoice()), ctx());
  assert.equal(r.irn.length, 64);
});

test('a duplicate hands back the IRN the portal already holds', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const first = await nic.generateIrn(buildEinvoicePayload(invoice()), ctx());

  await assert.rejects(
    () => nic.generateIrn(buildEinvoicePayload(invoice()), ctx()),
    (err: unknown) => {
      assert.ok(err instanceof PortalDuplicate, 'recognised as a duplicate, not a plain refusal');
      assert.equal(err.irn, first.irn, 'the existing IRN is recovered');
      assert.equal(err.ackNo, '112610000012345');
      assert.equal(err.code, '2150');
      return true;
    },
  );
});

test('cancelling within the portal rules', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  const { irn } = await nic.generateIrn(buildEinvoicePayload(invoice()), ctx());
  const r = await nic.cancelIrn(irn, '2', 'x'.repeat(250), ctx());
  assert.equal(r.cancelledAt, '2026-09-11 15:00:00');
});

// ── Refusals, and telling them apart ─────────────────────────────────────────

test('a wrong password is an authentication failure, carrying the portal reason', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);
  await assert.rejects(
    () => nic.verify(ctx({ credentials: { username: USERNAME, password: 'wrong' } })),
    (err: unknown) =>
      err instanceof PortalAuthFailed && /\[1008\] Invalid login credentials/.test(err.message),
  );
});

test('a wrong client secret is an authentication failure too', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config({ clientSecret: 'nope' }), portal.fetch);
  await assert.rejects(() => nic.verify(ctx()), PortalAuthFailed);
});

test('the connection-level client id overrides the server default', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config({ clientId: 'WRONG', clientSecret: 'WRONG' }), portal.fetch);
  await nic.verify(ctx({
    credentials: { username: USERNAME, password: PASSWORD, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
  }));
  assert.equal(portal.calls[0].headers.client_id, CLIENT_ID);
});

test('an unreachable portal is retryable; a server error is too', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config(), portal.fetch);

  portal.failNextWith = { network: true };
  await assert.rejects(() => nic.verify(ctx()), (e: unknown) => e instanceof PortalUnavailable && e.retryable);

  portal.failNextWith = { status: 502 };
  await assert.rejects(() => nic.verify(ctx()), PortalUnavailable);
});

test('a wrong path says so, rather than reading as a missing document', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config({ invoicePath: '/eicore/v9/Nope' }), portal.fetch);
  await assert.rejects(
    () => nic.generateIrn(buildEinvoicePayload(invoice()), ctx()),
    (err: unknown) => err instanceof PortalRejection && /no endpoint at \/eicore\/v9\/Nope/.test(err.message),
  );
});

test('a missing public key is reported before any call is made', async () => {
  const portal = simulatedNic();
  const nic = new NicEinvoiceProvider(config({ publicKey: null }), portal.fetch);
  assert.match(nic.missingConfiguration().join(), /NIC_EINV_PUBLIC_KEY is not set/);
  await assert.rejects(() => nic.verify(ctx()), PortalAuthFailed);
  assert.equal(portal.calls.length, 0, 'nothing left the app');
});

test('no stored credentials is refused with a pointer to Settings', async () => {
  const nic = new NicEinvoiceProvider(config(), simulatedNic().fetch);
  await assert.rejects(
    () => nic.verify(ctx({ credentials: undefined })),
    (err: unknown) => err instanceof PortalAuthFailed && /Settings → Integrations/.test(err.message),
  );
});

test('stand-alone e-way bills are refused, with the reason and the alternative', async () => {
  const nic = new NicEinvoiceProvider(config(), simulatedNic().fetch);
  await assert.rejects(
    () => nic.generateEwayBill(),
    (err: unknown) => err instanceof PortalRejection && /separate connection/.test(err.message),
  );
});

// ── Environment ──────────────────────────────────────────────────────────────

test('the sandbox is a real connection that files nothing', () => {
  const sandbox = new NicEinvoiceProvider(config());
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(sandbox.live, false);

  const prod = new NicEinvoiceProvider(config({ baseUrl: 'https://einvoice1.gst.gov.in', declaredEnvironment: 'production' }));
  assert.equal(prod.environment, 'production');
  assert.equal(prod.live, true);
  assert.deepEqual(prod.missingConfiguration(), []);
});

test("an address that is not NIC's sandbox files only once it is declared production", () => {
  const gsp = new NicEinvoiceProvider(config({ baseUrl: 'https://gsp.example.in/einvoice' }));
  assert.equal(gsp.live, false, 'undeclared is never reported as filing');
  assert.match(gsp.missingConfiguration().join(' '), /NIC_EINV_ENV/);

  const gspTest = new NicEinvoiceProvider(config({ baseUrl: 'https://gsp.example.in/einvoice', declaredEnvironment: 'sandbox' }));
  assert.equal(gspTest.environment, 'sandbox');
  assert.deepEqual(gspTest.missingConfiguration(), []);

  const mislabelled = new NicEinvoiceProvider(config({ baseUrl: 'https://einvoice1.gst.gov.in', declaredEnvironment: 'sandbox' }));
  assert.equal(mislabelled.live, false);
  assert.match(mislabelled.missingConfiguration().join(' '), /live government portal/);
});

test('the environment is read from NIC_EINV_ENV, and a typo is named', () => {
  assert.equal(nicConfigFromEnv({ NIC_EINV_ENV: 'Production' } as unknown as NodeJS.ProcessEnv).declaredEnvironment, 'production');
  const typo = nicConfigFromEnv({ NIC_EINV_ENV: 'prod' } as unknown as NodeJS.ProcessEnv);
  assert.equal(typo.declaredEnvironment, null);
  assert.match(typo.environmentError ?? '', /must be sandbox or production/);
});

// ── The pieces, on their own ─────────────────────────────────────────────────

test('the public key is accepted as PEM, as bare base64, and as a file path', async () => {
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const fp = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

  assert.equal(fp(loadPublicKey(pem)), der);
  assert.equal(fp(loadPublicKey(der)), der);
  assert.equal(fp(loadPublicKey(`  ${der.match(/.{1,64}/g)!.join('\n')}  `)), der, 'wrapped, as pasted');

  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'nic-')), 'einv_sandbox.pem');
  writeFileSync(file, pem);
  assert.equal(fp(loadPublicKey(file)), der);
});

test('the session key unwraps from either shape, and refuses anything else', () => {
  const appKey = randomBytes(32);
  const sek = randomBytes(32);
  assert.deepEqual(decryptSessionKey(appKey, aesEncryptBase64(appKey, sek)), sek);
  assert.deepEqual(decryptSessionKey(appKey, aesEncryptBase64(appKey, sek.toString('base64'))), sek);
  assert.throws(() => decryptSessionKey(appKey, aesEncryptBase64(appKey, randomBytes(20))), /not 32/);
});

test('AES-256-ECB round trips, and is what the portal would decrypt', () => {
  const key = randomBytes(32);
  const text = JSON.stringify({ hello: 'निर्यात', n: 1 });
  assert.equal(aesDecrypt(key, aesEncryptBase64(key, text)).toString('utf8'), text);
  assert.equal(aesEcbDecrypt(key, aesEncryptBase64(key, text)).toString('utf8'), text);
});

test('portal errors are read whichever shape they arrive in', () => {
  const list = [{ ErrorCode: '2150', ErrorMessage: 'Duplicate IRN' }];
  assert.deepEqual(readErrors(list), list);
  assert.deepEqual(readErrors(JSON.stringify(list)), list);
  assert.deepEqual(readErrors(Buffer.from(JSON.stringify(list)).toString('base64')), list);
  assert.deepEqual(readErrors(null), []);
});

test('a duplicate is recognised from InfoDtls in either shape', () => {
  const irn = 'a'.repeat(64);
  const info = [{ InfCd: 'DUPIRN', Desc: { AckNo: 1234, AckDt: '2026-09-11 14:18:00', Irn: irn } }];
  assert.deepEqual(readDuplicate(info), { irn, ackNo: '1234', ackDate: '2026-09-11 14:18:00' });
  assert.equal(readDuplicate(JSON.stringify(info))?.irn, irn);
  assert.equal(readDuplicate([{ InfCd: 'EWBERR', Desc: 'something else' }]), null);
});

test('portal timestamps are IST whatever zone the server runs in', () => {
  // 14:18 in India is 08:48 UTC. Parsing it as local time would be right on a
  // machine in India and five and a half hours out on a UTC cloud host.
  const d = parsePortalTimestamp('2026-09-11 14:18:00');
  assert.equal(d.toISOString(), '2026-09-11T08:48:00.000Z');
  assert.equal(formatPortalTimestamp(d), '2026-09-11 14:18:00');
  assert.throws(() => parsePortalTimestamp('yesterday'), /Unreadable/);
});
