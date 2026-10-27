// The Tally connector: what it asks Tally, how it reads the answers, and a
// whole sync against the stand-in TallyPrime into the real database.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tally-connector.test.ts
//
// The end-to-end tests run the connector exactly as it runs on a customer's
// PC — HTTP to a Tally data port in UTF-16, then protocol messages — with the
// portal's own sync code applying the messages inside a transaction that is
// rolled back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { db, type Trx } from '../../lib/server/db';
import { authenticateConnector, createPairingCode, redeemPairingCode } from '../../lib/server/tally/connectors';
import { applySync } from '../../lib/server/tally/sync';
import { companyFor, ledgerList, ledgerVouchers, profitAndLoss, stockSummary, trialBalance } from '../../lib/server/tally/reports';
import { SyncMessage } from '../../lib/tally/protocol';
import { NULL_MARK, reportRequest, requests, tdlDate } from '../../connector/src/tally-requests';
import { parseRows, TallyRefused } from '../../connector/src/tally-client';
import { baseTypeOf, currentFyStart, debitPaise, months, natureOf, toVouchers } from '../../connector/src/mapper';
import { syncOnce } from '../../connector/src/sync';
import type { PortalLink } from '../../connector/src/portal';
import type { CompanyState } from '../../connector/src/config';
import { startFakeTally } from '../../connector/src/fake-tally';
import { SAMPLE_COMPANY_GUID, SAMPLE_FY_FROM, sampleCompany } from '../tally/sample-company';

const AS_OF = '2026-09-15';

// ── Asking Tally ─────────────────────────────────────────────────────────────

test('a request names the company safely, reads the right period, and filters by AlterID', () => {
  const xml = reportRequest(requests.vouchers('Sharma & Sons "Chennai"', '2026-04-01', '2026-09-15', 812));
  assert.match(xml, /<SVCURRENTCOMPANY>Sharma &amp; Sons &quot;Chennai&quot;<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<SVFROMDATE>1-Apr-2026<\/SVFROMDATE><SVTODATE>15-Sep-2026<\/SVTODATE>/);
  assert.match(xml, /<SYSTEM TYPE="Formulae" NAME="RkFilter01">\$AlterID &gt; 812<\/SYSTEM>/);
  assert.match(xml, /<XMLTAG>F10<\/XMLTAG>/, 'one numbered tag per column');
  assert.equal(tdlDate('2026-12-05'), '5-Dec-2026');

  const entries = reportRequest(requests.entries('X', '2026-04-01', '2026-04-30', 0));
  assert.match(entries, /<REPEAT>RkLine01 : RkCollection<\/REPEAT>.*<REPEAT>RkLine02 : AllLedgerEntries<\/REPEAT>/, 'a voucher route explodes into its entries');
  assert.match(entries, /<EXPLODE>RkPart02<\/EXPLODE>/);
});

test('an answer is read into named columns, with escapes undone and empty dates as null', () => {
  const cols = ['guid', 'name', 'date', 'amount'] as const;
  const xml = `<ENVELOPE>\r\n<F01>g-1</F01><F02>Sharma &amp; Sons&#4;</F02><F03>${NULL_MARK}</F03><F04>-1250.50</F04>\r\n<F01>g-2</F01><F02/><F03>2026-04-01</F03><F04></F04>\r\n</ENVELOPE>`;
  const rows = parseRows(xml, cols);
  assert.deepEqual(rows, [
    { guid: 'g-1', name: 'Sharma & Sons', date: null, amount: '-1250.50' },
    { guid: 'g-2', name: null, date: '2026-04-01', amount: null },
  ]);
  assert.throws(() => parseRows("<ENVELOPE><LINEERROR>Could not find Company 'X'</LINEERROR></ENVELOPE>", cols), TallyRefused);
});

// ── Converting ───────────────────────────────────────────────────────────────

test('Tally’s signed rupees become paise with debits positive', () => {
  assert.equal(debitPaise('-1234.56'), 123_456, 'a debit');
  assert.equal(debitPaise('1234.56'), -123_456, 'a credit');
  assert.equal(debitPaise('-0.10'), 10);
  assert.equal(debitPaise('1,23,456.00'), -12_345_600, 'grouping commas are tolerated');
  assert.equal(debitPaise(null), 0);
});

test('a group’s nature, a voucher’s base type, and the financial year', () => {
  assert.equal(natureOf(false, true), 'assets');
  assert.equal(natureOf(false, false), 'liabilities');
  assert.equal(natureOf(true, true), 'expenses');
  assert.equal(natureOf(true, false), 'income');

  const parents = new Map<string, string | null>([['GST Sales', 'Local Sales'], ['Local Sales', 'Sales'], ['Sales', 'Sales']]);
  assert.equal(baseTypeOf('GST Sales', parents), 'Sales');
  assert.equal(baseTypeOf('Loose Type', parents), 'Loose Type', 'an unknown chain keeps its own name');

  assert.equal(currentFyStart('2019-04-01', '2026-09-15'), '2026-04-01');
  assert.equal(currentFyStart('2019-04-01', '2027-02-01'), '2026-04-01');
  assert.equal(currentFyStart('2019-01-01', '2026-09-15'), '2026-01-01', 'a calendar-year company');
  assert.deepEqual(months('2026-01-15', '2026-03-10'), [
    { from: '2026-01-15', to: '2026-01-31' },
    { from: '2026-02-01', to: '2026-02-28' },
    { from: '2026-03-01', to: '2026-03-10' },
  ]);
});

test('vouchers are joined to their entries, and a cancelled one keeps none', () => {
  const vouchers = toVouchers(
    [
      { guid: 'v1', alterId: '7', type: 'GST Sales', date: '2026-04-02', number: 'S/1', party: 'Apex', narration: null, reference: null, cancelled: '0', optional: '0' },
      { guid: 'v2', alterId: '8', type: 'Sales', date: '2026-04-02', number: 'S/2', party: 'Apex', narration: null, reference: null, cancelled: '1', optional: '0' },
    ],
    [
      { guid: 'v1', ledger: 'Apex', amount: '-1180.00' },
      { guid: 'v1', ledger: 'Sales', amount: '1000.00' },
      { guid: 'v1', ledger: 'Output IGST', amount: '180.00' },
      { guid: 'v2', ledger: 'Apex', amount: '-500.00' },
    ],
    new Map([['GST Sales', 'Sales']]),
  );
  assert.equal(vouchers[0].baseType, 'Sales');
  assert.deepEqual(vouchers[0].entries[0], { ledger: 'Apex', debitPaise: 118_000, creditPaise: 0 });
  assert.equal(vouchers[0].entries.reduce((t, e) => t + e.debitPaise - e.creditPaise, 0), 0, 'it balances');
  assert.equal(vouchers[1].isCancelled, true);
  assert.deepEqual(vouchers[1].entries, []);
});

// ── A whole sync ─────────────────────────────────────────────────────────────

async function withPortal(fn: (ctx: { trx: Trx; orgId: number; portal: PortalLink; sent: string[] }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Connector Test Co', pan: 'AAAAA0000A' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);
      const { code } = await createPairingCode(trx, orgId, null);
      const { token } = await redeemPairingCode(trx, { code, machineName: 'TEST-PC', connectorVersion: 'test' });
      const auth = await authenticateConnector(trx, `Bearer ${token}`);
      const sent: string[] = [];
      const portal: PortalLink = {
        send: async <T,>(message: unknown) => {
          const parsed = SyncMessage.parse(message);
          sent.push(parsed.kind);
          return (await applySync(trx, auth, parsed)) as T;
        },
      };
      await fn({ trx, orgId, portal, sent });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('the first sync sends the whole year, and the portal’s reports agree with Tally’s', async () => {
  const tally = await startFakeTally({ today: AS_OF });
  try {
    await withPortal(async ({ trx, orgId, portal }) => {
      const state: Record<string, CompanyState> = {};
      const summary = await syncOnce({ tally: { host: '127.0.0.1', port: tally.port }, portal, state, machineName: 'TEST-PC', connectorVersion: 'test', today: AS_OF });
      const expected = sampleCompany(AS_OF);

      assert.equal(summary.tallyError, undefined);
      const [company] = summary.companies;
      assert.equal(company.error, undefined, company.error);
      assert.equal(company.vouchersSent, expected.vouchers.length);
      assert.deepEqual(company.vouchersRejected, []);
      assert.equal(company.mastersSent, true);
      assert.equal(state[SAMPLE_COMPANY_GUID].mastersSentOn, AS_OF);

      const row = await trx.selectFrom('tally_companies').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
      const c = await companyFor(trx, orgId, row.id);
      assert.equal(c.fyFrom, SAMPLE_FY_FROM, 'the year worked out from the day the company’s year begins');
      assert.equal(c.maintainsInventory, true);

      assert.equal((await trialBalance(trx, c)).differencePaise, 0);
      assert.equal((await profitAndLoss(trx, c)).netProfitPaise, expected.expected.netProfitPaise);
      assert.equal((await stockSummary(trx, c)).totalValuePaise, expected.expected.closingStockPaise);

      const bank = (await ledgerList(trx, c)).rows.find((r) => r.name === 'HDFC Bank')!;
      assert.equal(bank.openingPaise, 450_000_00, 'the opening as at the start of the year, not of the books');
      const vouchers = await ledgerVouchers(trx, c, Number(bank.id), SAMPLE_FY_FROM, AS_OF);
      assert.equal(vouchers.check?.matches, true);
    });
  } finally {
    await tally.close();
  }
});

test('a second sync sends only what changed, and a deletion in Tally is noticed', async () => {
  const tally = await startFakeTally({ today: AS_OF });
  try {
    await withPortal(async ({ trx, orgId, portal }) => {
      const state: Record<string, CompanyState> = {};
      const run = () => syncOnce({ tally: { host: '127.0.0.1', port: tally.port }, portal, state, machineName: 'TEST-PC', connectorVersion: 'test', today: AS_OF });
      await run();

      tally.requests.length = 0;
      const quiet = (await run()).companies[0];
      assert.deepEqual([quiet.vouchersSent, quiet.mastersSent, quiet.deletions], [0, false, 0]);
      assert.ok(!tally.requests.includes('RekonzaVouchers'), 'nothing changed, so no vouchers were read');

      tally.data.addVoucher({
        guid: 'entered-later-1', voucherType: 'Receipt', baseType: 'Receipt', number: 'RCT/26-27/9001', date: AS_OF,
        party: 'Apex Motors', narration: 'Cheque received', reference: null, isCancelled: false, isOptional: false,
        entries: [
          { ledger: 'HDFC Bank', debitPaise: 10_000_00, creditPaise: 0 },
          { ledger: 'Apex Motors', debitPaise: 0, creditPaise: 10_000_00 },
        ],
      });
      const after = (await run()).companies[0];
      assert.equal(after.vouchersSent, 1, 'only the new voucher');
      assert.equal(after.mastersSent, true, 'balances moved with it');

      const row = await trx.selectFrom('tally_companies').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
      const c = await companyFor(trx, orgId, row.id);
      const bank = (await ledgerList(trx, c)).rows.find((r) => r.name === 'HDFC Bank')!;
      assert.equal((await ledgerVouchers(trx, c, Number(bank.id), SAMPLE_FY_FROM, AS_OF)).check?.matches, true);

      tally.data.deleteVoucher('entered-later-1');
      state[SAMPLE_COMPANY_GUID].indexSentOn = undefined;
      const deleted = (await run()).companies[0];
      assert.equal(deleted.deletions, 1);
    });
  } finally {
    await tally.close();
  }
});

test('a Tally that ignores the period it was given still sends each voucher once', async () => {
  // What real TallyPrime does when asked for the month its books begin in: it
  // answers with every voucher the company has. The connector keeps only the
  // ones inside the window, so nothing is sent a second time and the list used
  // to spot deletions never reaches past the month it describes.
  const tally = await startFakeTally({ today: AS_OF });
  tally.data.periodBlind = true;
  try {
    await withPortal(async ({ trx, orgId, portal }) => {
      const state: Record<string, CompanyState> = {};
      const summary = await syncOnce({ tally: { host: '127.0.0.1', port: tally.port }, portal, state, machineName: 'TEST-PC', connectorVersion: 'test', today: AS_OF });
      const expected = sampleCompany(AS_OF);

      assert.equal(summary.companies[0].error, undefined);
      assert.equal(summary.companies[0].vouchersSent, expected.vouchers.length, 'each voucher once, not once per window');
      assert.equal(summary.companies[0].deletions, 0, 'and nothing was read as deleted');

      const row = await trx.selectFrom('tally_companies').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
      const stored = await trx.selectFrom('tally_vouchers').select(({ fn }) => [fn.countAll<number>().as('n')])
        .where('company_id', '=', row.id).executeTakeFirstOrThrow();
      assert.equal(Number(stored.n), expected.vouchers.length);
    });
  } finally {
    await tally.close();
  }
});

test('Tally being closed is reported to the portal, not thrown', async () => {
  const tally = await startFakeTally({ today: AS_OF });
  const port = tally.port;
  await tally.close();
  await withPortal(async ({ portal, sent }) => {
    const summary = await syncOnce({ tally: { host: '127.0.0.1', port, timeoutMs: 3000 }, portal, state: {}, machineName: 'TEST-PC', connectorVersion: 'test', today: AS_OF });
    assert.match(summary.tallyError ?? '', /not answering/);
    assert.deepEqual(sent, ['status']);
  });
});

test.after(async () => {
  await db.destroy();
});
