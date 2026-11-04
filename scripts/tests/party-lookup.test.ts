// Filling a customer or vendor in from its GSTIN or CIN (lib/server/integrations/
// party-lookup.ts), and a contact's several TDS sections (migration 106). The
// lookup services are answered here by a stand-in, so nothing goes to the network.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/party-lookup.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cinFacts, fromGstRecord, gstinFacts, isoDate, lookupCompany, lookupParty, lookupServices, setLookupFetcher,
} from '../../lib/server/integrations/party-lookup';
import { joinSections, parseSections } from '../../lib/tax/tds';
import { pool } from '../../lib/server/db';

// Real check digits, so the checksum passes.
const COMPANY = '29AAACR1234A1ZZ';
const PROPRIETOR = '33ABCPK1234L1ZZ';
const FIRM = '27AAFFR1234B1ZQ';

const ENV = ['GSTIN_LOOKUP_URL', 'GSTIN_LOOKUP_KEY', 'GSTIN_LOOKUP_HEADERS', 'GSTIN_LOOKUP_BODY', 'COMPANY_LOOKUP_URL', 'COMPANY_LOOKUP_KEY', 'COMPANY_LOOKUP_HEADERS', 'COMPANY_LOOKUP_BODY'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function setEnv(values: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, values);
}
test.afterEach(() => { setLookupFetcher(null); setEnv({}); });
test.after(async () => {
  // Nothing here queries, so the pool was never handed to Kysely: end it directly.
  await pool.end();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** A stand-in service: records each call and answers with `reply`. */
function standIn(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  setLookupFetcher(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

test('a GSTIN by itself gives the state, the PAN and the kind of business', () => {
  const c = gstinFacts(` ${COMPANY.toLowerCase()} `);
  assert.equal(c.gstin, COMPANY);
  assert.equal(c.pan, 'AAACR1234A');
  assert.equal(c.address?.stateCode, '29');
  assert.equal(c.constitution, 'Company');
  assert.equal(c.fromPortal, false);
  assert.equal(c.source, 'number');
  assert.equal(gstinFacts(PROPRIETOR).constitution, 'Proprietorship');
  assert.equal(gstinFacts(FIRM).constitution, 'Partnership firm or LLP');
});

test('a GSTIN with a typo is refused, not looked up', async () => {
  assert.throws(() => gstinFacts('29AAACR1234A1ZA'), /does not match the rest/);
  assert.throws(() => gstinFacts('29AAACR1234'), /not a GSTIN/);
  const calls = standIn({});
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/{gstin}' });
  await assert.rejects(lookupParty('29AAACR1234A1ZA', null), /does not match/);
  assert.equal(calls.length, 0);
});

test('dates in any of the GST system’s spellings', () => {
  assert.equal(isoDate('21/07/2017'), '2017-07-21');
  assert.equal(isoDate('1-7-2017'), '2017-07-01');
  assert.equal(isoDate('2017-07-21T00:00:00Z'), '2017-07-21');
  assert.equal(isoDate(''), null);
  assert.equal(isoDate('July 2017'), null);
  assert.equal(isoDate(null), null);
});

test('with no service set up, the number’s own facts come back', async () => {
  setEnv({});
  const calls = standIn({});
  const d = await lookupParty(COMPANY, null);
  assert.equal(d.source, 'number');
  assert.equal(d.legalName, null);
  assert.equal(d.pan, 'AAACR1234A');
  assert.equal(calls.length, 0);
  assert.deepEqual(lookupServices(), { gstin: false, company: false });
});

test('a lookup service’s reply, in the GST system’s format, fills the name, address and registration date', async () => {
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/v1/{gstin}?key={key}', GSTIN_LOOKUP_KEY: 'k&1', GSTIN_LOOKUP_HEADERS: '{"x-api-key":"{key}"}' });
  const calls = standIn({
    success: true,
    data: {
      taxpayerInfo: {
        gstin: COMPANY, lgnm: 'RAJ AUTO COMPONENTS PRIVATE LIMITED', tradeNam: 'RAJ AUTO', sts: 'Active',
        dty: 'Regular', ctb: 'Private Limited Company', rgdt: '01/07/2017', cxdt: '',
        pradr: { addr: { bno: '12', bnm: 'Peenya Plaza', st: '4th Phase', loc: 'Peenya', dst: 'Bengaluru Urban', city: '', pncd: '560058' } },
      },
    },
  });
  const d = await lookupParty(COMPANY, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://lookup.test/v1/29AAACR1234A1ZZ?key=k%261', 'the key is escaped in the URL');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'k&1', 'and sent as it is in a header');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(d.source, 'lookup-service');
  assert.equal(d.fromPortal, true);
  assert.equal(d.legalName, 'RAJ AUTO COMPONENTS PRIVATE LIMITED');
  assert.equal(d.tradeName, 'RAJ AUTO');
  assert.equal(d.status, 'Active');
  assert.equal(d.constitution, 'Private Limited Company');
  assert.equal(d.registeredOn, '2017-07-01');
  assert.equal(d.cancelledOn, null);
  assert.equal(d.pan, 'AAACR1234A');
  assert.equal(d.address?.line, '12, Peenya Plaza, 4th Phase, Peenya');
  assert.equal(d.address?.city, 'Bengaluru Urban');
  assert.equal(d.address?.pincode, '560058');
  assert.equal(d.address?.stateCode, '29', 'the state is the GSTIN’s, whatever the reply says');

  // Asked again: kept, not paid for twice.
  await lookupParty(COMPANY, null);
  assert.equal(calls.length, 1);
});

test('a service set to POST sends the body with the number in it', async () => {
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/search', GSTIN_LOOKUP_BODY: '{"gstin":"{gstin}","token":"{key}"}', GSTIN_LOOKUP_KEY: 'abc' });
  const calls = standIn([{ legal_name: 'Raj Firm', status: 'Active', registration_date: '2019-04-01' }]);
  const d = await lookupParty(FIRM, null);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { gstin: FIRM, token: 'abc' });
  assert.equal(d.legalName, 'Raj Firm');
  assert.equal(d.registeredOn, '2019-04-01');
  assert.equal(d.constitution, 'Partnership firm or LLP', 'kept from the PAN when the reply has none');

  // Another number to the same URL is asked for afresh, not answered from the first one's reply.
  await lookupParty(COMPANY, null);
  assert.equal(calls.length, 2, 'a POST lookup is kept by its body as well as its URL');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { gstin: COMPANY, token: 'abc' });
  await lookupParty(FIRM, null);
  assert.equal(calls.length, 2, 'the same number again is kept');
});

test('a number the service does not know falls back to the number; a failing service says so', async () => {
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/{gstin}' });
  standIn({ error: 'not found' }, 404);
  assert.equal((await lookupParty(COMPANY, null)).source, 'number');
  setLookupFetcher(null);
  standIn({ error: 'quota' }, 429);
  await assert.rejects(lookupParty(PROPRIETOR, null), /answered 429/);
  setLookupFetcher(null);
  standIn({ message: 'ok but empty' });
  assert.equal((await lookupParty(FIRM, null)).source, 'number', 'a reply with no taxpayer in it changes nothing');
});

test('the GST system, when connected, is asked before any service', async () => {
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/{gstin}' });
  const calls = standIn({ lgnm: 'From the service' });
  const d = await lookupParty(COMPANY, async (gstin) => ({
    gstin, legalName: 'From the GST system', tradeName: null, status: 'Active', taxpayerType: 'Regular',
    constitution: null, registeredOn: '05/08/2018', cancelledOn: null,
    address: { line: 'Peenya', city: 'Bengaluru', district: null, stateCode: '29', pincode: '560058' }, fromPortal: true,
  }));
  assert.equal(calls.length, 0);
  assert.equal(d.source, 'gst-system');
  assert.equal(d.legalName, 'From the GST system');
  assert.equal(d.registeredOn, '2018-08-05');
  assert.equal(d.constitution, 'Company', 'from the PAN when the GST system leaves it out');
  assert.equal(d.pan, 'AAACR1234A');
});

test('fromGstRecord finds the taxpayer however deep it sits', () => {
  const base = gstinFacts(COMPANY);
  assert.equal(fromGstRecord({ result: { items: [{ meta: 1 }, { lgnm: 'Deep Co' }] } }, base, 'lookup-service')?.legalName, 'Deep Co');
  assert.equal(fromGstRecord({ nothing: true }, base, 'lookup-service'), null);
});

test('a CIN by itself gives listed or not, the state, the year and the kind', () => {
  const c = cinFacts('u74999tn2015ptc123456');
  assert.deepEqual(
    [c.cin, c.listed, c.state, c.incorporatedYear, c.kind, c.incorporatedOn, c.source],
    ['U74999TN2015PTC123456', false, 'Tamil Nadu', 2015, 'Private limited company', null, 'number'],
  );
  assert.equal(cinFacts('L65110MH1994PLC080618').listed, true);
  assert.equal(cinFacts('L65110MH1994PLC080618').kind, 'Public limited company');
  assert.throws(() => cinFacts('U74999TN2015PTC12345'), /not a CIN/);
  assert.throws(() => cinFacts('U74999TN2999PTC123456'), /year of incorporation/);
});

test('a company lookup service gives the exact date of incorporation', async () => {
  setEnv({});
  const none = await lookupCompany('U74999TN2015PTC123456');
  assert.equal(none.incorporatedOn, null);
  assert.equal(none.incorporatedYear, 2015);

  setEnv({ COMPANY_LOOKUP_URL: 'https://mca.test/company/{cin}', COMPANY_LOOKUP_HEADERS: '{"authorization":"Bearer {key}"}', COMPANY_LOOKUP_KEY: 't0k' });
  const calls = standIn({ data: { company: { company_name: 'RAJ AUTO COMPONENTS PRIVATE LIMITED', date_of_incorporation: '14/03/2015', company_status: 'Active' } } });
  const d = await lookupCompany('U74999TN2015PTC123456');
  assert.equal(calls[0].url, 'https://mca.test/company/U74999TN2015PTC123456');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer t0k');
  assert.equal(d.incorporatedOn, '2015-03-14');
  assert.equal(d.name, 'RAJ AUTO COMPONENTS PRIVATE LIMITED');
  assert.equal(d.status, 'Active');
  assert.equal(d.source, 'lookup-service');
  assert.equal(d.state, 'Tamil Nadu');
  assert.deepEqual(lookupServices(), { gstin: false, company: true });
});

test('the online demo answers from the number alone: no sign-in, no paid lookup', async () => {
  const { GET: gstinGet } = await import('../../app/api/gst/portal/gstin/route');
  const { GET: cinGet } = await import('../../app/api/company-lookup/route');
  const ctx = { params: Promise.resolve({}) };
  setEnv({ GSTIN_LOOKUP_URL: 'https://lookup.test/{gstin}', COMPANY_LOOKUP_URL: 'https://mca.test/{cin}' });
  const calls = standIn({ lgnm: 'Should not be asked' });
  const flag = process.env.DEMO_SNAPSHOT;
  process.env.DEMO_SNAPSHOT = '1';
  try {
    const g = await gstinGet(new Request(`https://demo.test/api/gst/portal/gstin?gstin=${COMPANY}`), ctx);
    assert.equal(g.status, 200);
    const gb = await g.json();
    assert.deepEqual([gb.pan, gb.address.stateCode, gb.constitution, gb.legalName, gb.fromPortal], ['AAACR1234A', '29', 'Company', null, false]);
    const typo = await gstinGet(new Request('https://demo.test/api/gst/portal/gstin?gstin=29AAACR1234A1ZA'), ctx);
    assert.equal(typo.status, 400);
    const c = await cinGet(new Request('https://demo.test/api/company-lookup?cin=U74999TN2015PTC123456'), ctx);
    assert.equal(c.status, 200);
    assert.equal((await c.json()).incorporatedYear, 2015);
    assert.equal(calls.length, 0, 'no service is called from the open demo');
  } finally {
    if (flag === undefined) delete process.env.DEMO_SNAPSHOT; else process.env.DEMO_SNAPSHOT = flag;
  }
});

test('TDS sections: several kept in order, the first the default', () => {
  assert.deepEqual(parseSections('194J, 194c,194J,,'), ['194J', '194C']);
  assert.deepEqual(parseSections(null), []);
  assert.deepEqual(parseSections(''), []);
  assert.equal(joinSections(['194J', '194C']), '194J,194C');
  assert.equal(joinSections([]), null);
  assert.deepEqual(parseSections(joinSections(['194H', '194J', '194C'])), ['194H', '194J', '194C']);
});
