// Importing from spreadsheets and from Tally.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/imports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { runImport } from '../../lib/server/imports/run';
import { importTally, parseTallyMastersXml } from '../../lib/server/imports/tally';
import { openingSummary, setBooksStartDate } from '../../lib/server/services/opening-balances';

interface Fixture { trx: Trx; orgId: number; branchId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Import Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await setBooksStartDate(trx, orgId, '2026-04-01');
      await fn({ trx, orgId, branchId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
const ctx = (f: Fixture) => ({ orgId: f.orgId, userId: null, branchId: f.branchId, onDuplicate: 'skip' as const });

test('contacts: good rows go in, a bad one is reported by its row number', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'contacts', [
      { type: 'customer', name: 'Sri Murugan Motors', state: 'Tamil Nadu' },
      { type: 'vendor', name: 'Lakshmi Auto', gstin: '33AABCL1234A1Z0' },
      { type: 'customer', name: 'Kerala Traders', state: '32', credit_days: '30' },
    ]);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].row, 3, 'the second data row, under the heading');
    assert.match(out.errors[0].message, /checksum/);
    assert.equal(out.created, 2);

    const again = await runImport(f.trx, ctx(f), 'contacts', [{ type: 'customer', name: 'sri murugan  motors', state: '33' }]);
    assert.equal(again.skipped, 1, 'already there, by name');
  });
});

test('items: a new HSN code is added to the list with the row\'s rate', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'items', [
      { name: 'Clutch plate', hsn_sac: '8708', gst_rate: '28', purchase_price: '1,200', opening_qty: '5' },
      { name: 'Bad rate', gst_rate: '17' },
    ]);
    assert.equal(out.created, 1);
    assert.match(out.errors[0].message, /17% is not a GST rate/);
    const hsn = await f.trx.selectFrom('hsn_codes').select(['gst_rate_pct']).where('org_id', '=', f.orgId).where('code', '=', '8708').executeTakeFirstOrThrow();
    assert.equal(Number(hsn.gst_rate_pct), 28);
    const item = await f.trx.selectFrom('items').select(['opening_stock_rate', 'track_inventory']).where('org_id', '=', f.orgId).where('name', '=', 'Clutch plate').executeTakeFirstOrThrow();
    assert.equal(Number(item.opening_stock_rate), 1200, 'opening at the purchase price');
    assert.equal(item.track_inventory, 1);
  });
});

test('journals: rows group into vouchers, and a voucher must balance', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'journals', [
      { voucher_no: 'JV-1', date: '30-04-2026', account_code: '6100', debit: '45000', narration: 'April rent' },
      { voucher_no: 'JV-1', date: '30-04-2026', account_code: '1210', credit: '45000' },
      { voucher_no: 'JV-2', date: '2026-04-30', account_code: '6100', debit: '100' },
      { voucher_no: 'JV-2', date: '2026-04-30', account_code: '1210', credit: '90' },
    ]);
    assert.equal(out.created, 1);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].row, 4, 'the first row of JV-2');
    assert.match(out.errors[0].message, /JV-2/);
  });
});

const TALLY = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><GROUP NAME="Chennai Debtors"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Sri Murugan Motors"><PARENT>Chennai Debtors</PARENT><OPENINGBALANCE>-15000.00</OPENINGBALANCE>
  <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
  <BILLALLOCATIONS.LIST><NAME>INV/412</NAME><BILLDATE>20260210</BILLDATE><OPENINGBALANCE>-10000.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
  <BILLALLOCATIONS.LIST><NAME>INV/430</NAME><BILLDATE>20260305</BILLDATE><OPENINGBALANCE>-5000.00</OPENINGBALANCE></BILLALLOCATIONS.LIST>
</LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Lakshmi Auto &amp; Co"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>8000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="HDFC Current"><PARENT>Bank Accounts</PARENT><OPENINGBALANCE>-200000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Output CGST"><PARENT>Duties &amp; Taxes</PARENT><OPENINGBALANCE>1500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Proprietor Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>300000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Workshop Equipment"><PARENT>Fixed Assets</PARENT><OPENINGBALANCE>-44500.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Sales @18%"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><STOCKITEM NAME="Brake Pad"><BASEUNITS>Nos</BASEUNITS><OPENINGBALANCE> 10 Nos</OPENINGBALANCE><OPENINGVALUE>-50000.00</OPENINGVALUE>
  <GSTDETAILS.LIST><HSNCODE>8708</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
</STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

test('Tally: the XML reads with debits positive', () => {
  const m = parseTallyMastersXml(TALLY);
  const murugan = m.ledgers.find((l) => l.name === 'Sri Murugan Motors')!;
  assert.equal(murugan.balancePaise, 15_000_00);
  assert.equal(murugan.bills.length, 2);
  assert.equal(murugan.bills[0].date, '2026-02-10');
  assert.ok(m.ledgers.some((l) => l.name === 'Lakshmi Auto & Co'), 'entities decoded');
  assert.deepEqual(m.stockItems[0], { name: 'Brake Pad', unit: 'Nos', hsn: '8708', gstRatePct: 18, qty: 10, valuePaise: 50_000_00 });
});

test('Tally: a company comes across, and its openings agree', async () => {
  await withFixture(async (f) => {
    const outcomes = await importTally(f.trx, ctx(f), parseTallyMastersXml(TALLY));
    for (const o of outcomes) assert.deepEqual(o.errors, [], `${o.kind} imported cleanly`);

    const parties = await f.trx.selectFrom('contacts').select(['display_name', 'kind']).where('org_id', '=', f.orgId).orderBy('display_name').execute();
    assert.deepEqual(parties.map((p) => [p.display_name, p.kind]), [['Lakshmi Auto & Co', 'vendor'], ['Sri Murugan Motors', 'customer']]);

    const s = await openingSummary(f.trx, f.orgId);
    assert.equal(s.receivablesPaise, 15_000_00, 'two bills, bill by bill');
    assert.equal(s.payablesPaise, 8_000_00);
    assert.equal(s.stockPaise, 50_000_00);
    // Dr 2,00,000 bank + 15,000 debtors + 44,500 equipment + 50,000 stock
    // = Cr 3,00,000 capital + 8,000 creditors + 1,500 CGST: the books balance.
    assert.equal(s.differencePaise, 0);

    const cgst = s.accounts.find((a) => a.code === '2210')!;
    assert.equal(cgst.netPaise, -1_500_00, 'onto this book\'s own output CGST ledger');
    const capital = s.accounts.find((a) => a.code === '3100')!;
    assert.equal(capital.netPaise, -3_00_000_00);
  });
});

test.after(async () => {
  await db.destroy();
});
