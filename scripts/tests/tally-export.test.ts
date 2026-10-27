// Our books, handed to TallyPrime.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tally-export.test.ts
//
// Real documents are posted through the services, then exported, and the file
// is read back and checked the way Tally would read it: every voucher balances,
// the party ledgers carry the right bill references, and the totals in the file
// are the totals in our journal. Inside transactions that are rolled back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { accountIds, CODE, installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { buildExport, defaultLedger, exportSummary, mastersXml, vouchersXml } from '../../lib/server/tally/export';
import { startFakeTally } from '../../connector/src/fake-tally';
import { postTally } from '../../connector/src/tally-client';

const FROM = '2026-08-01';
const TO = '2026-08-31';

interface Fixture {
  trx: Trx;
  orgId: number;
  branchId: number;
  acc: Record<string, number>;
  customerId: number;
  vendorId: number;
  bankId: number;
  itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Tally Export Test Co' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);
      const branch = await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      // A name with an ampersand, because that is what breaks an XML file.
      const customer = await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Sharma & Sons', gst_treatment: 'registered',
        gstin: '33AAACS2222B1Z5', state_code: '33', pan: 'AAACS2222B', email: 'ap@sharma.example',
        billing_address: '14 Mount Road, Chennai',
      }).executeTakeFirstOrThrow();
      const vendor = await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Bosch Distributors', gst_treatment: 'registered',
        gstin: '33AAACB6666F1Z5', state_code: '33',
      }).executeTakeFirstOrThrow();
      const bank = await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow();
      const item = await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake Pad Set', sku: 'BP-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '1000.0000', purchase_price: '600.0000', gst_rate_pct: 18,
        sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow();
      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1,
      }).execute();

      await fn({
        trx, orgId, branchId, acc,
        customerId: Number(customer.insertId), vendorId: Number(vendor.insertId),
        bankId: Number(bank.insertId), itemId: Number(item.insertId),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** A month of ordinary trading: an invoice, the money for it, a bill. */
async function aMonth(f: Fixture) {
  const invoice = await createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customerId, date: '2026-08-04', dueDate: '2026-09-03',
    status: 'approved', lines: [{ itemId: f.itemId, qty: 10 }],
  });
  const payment = await receivePayment(f.trx, f.orgId, null, {
    branchId: f.branchId, contactId: f.customerId, date: '2026-08-20', mode: 'neft',
    amountPaise: 5_000_00, bankAccountId: f.bankId,
    allocations: [{ targetType: 'invoice', targetId: invoice.id, amountPaise: 5_000_00 }],
  });
  const bill = await createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'BD/8821', date: '2026-08-06',
    dueDate: '2026-09-05', status: 'open', lines: [{ itemId: f.itemId, qty: 20, ratePaise: 600_00 }],
  });
  return { invoice, payment, bill };
}

// ── Reading the file back the way Tally reads it ─────────────────────────────

interface ReadVoucher {
  remoteId: string;
  type: string;
  number: string;
  date: string;
  party: string | null;
  entries: { ledger: string; amount: number; deemedPositive: boolean; bills: { name: string; type: string; amount: number }[] }[];
}

function readVouchers(xml: string): ReadVoucher[] {
  const out: ReadVoucher[] = [];
  const vouchers = xml.match(/<VOUCHER [\s\S]*?<\/VOUCHER>/g) ?? [];
  // Read the way Tally reads: escapes undone, so a name with an ampersand compares equal.
  const plain = (v: string) => v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const one = (s: string, tag: string) => {
    const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? plain(m[1]) : null;
  };
  for (const v of vouchers) {
    const entries = (v.match(/<ALLLEDGERENTRIES.LIST>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/g) ?? []).map((e) => ({
      ledger: one(e, 'LEDGERNAME') ?? '',
      amount: Number(one(e, 'AMOUNT')),
      deemedPositive: one(e, 'ISDEEMEDPOSITIVE') === 'Yes',
      bills: (e.match(/<BILLALLOCATIONS.LIST>[\s\S]*?<\/BILLALLOCATIONS.LIST>/g) ?? []).map((b) => ({
        name: one(b, 'NAME') ?? '', type: one(b, 'BILLTYPE') ?? '', amount: Number(one(b, 'AMOUNT')),
      })),
    }));
    out.push({
      remoteId: v.match(/REMOTEID="([^"]+)"/)?.[1] ?? '',
      type: one(v, 'VOUCHERTYPENAME') ?? '',
      number: one(v, 'VOUCHERNUMBER') ?? '',
      date: one(v, 'DATE') ?? '',
      party: one(v, 'PARTYLEDGERNAME'),
      entries,
    });
  }
  return out;
}

// ── The map ──────────────────────────────────────────────────────────────────

test('an account lands under the Tally group its kind belongs to', () => {
  const g = (code: string, name: string, type: string, subtype: string | null) =>
    defaultLedger({ id: 1, code, name, type, subtype }).parentGroup;
  assert.equal(g(CODE.BANK_DEFAULT, 'Bank', 'asset', 'bank'), 'Bank Accounts');
  assert.equal(g(CODE.CASH, 'Cash in Hand', 'asset', 'cash'), 'Cash-in-Hand');
  assert.equal(g(CODE.GST_CGST, 'Output CGST', 'liability', 'tax'), 'Duties & Taxes');
  assert.equal(g(CODE.ITC_IGST, 'Input IGST', 'asset', 'tax'), 'Duties & Taxes');
  assert.equal(g(CODE.AR, 'Accounts Receivable', 'asset', 'receivable'), 'Sundry Debtors');
  assert.equal(g(CODE.AP, 'Accounts Payable', 'liability', 'payable'), 'Sundry Creditors');
  assert.equal(g(CODE.SALES, 'Sales', 'income', null), 'Sales Accounts');
  assert.equal(g(CODE.PURCHASES, 'Purchases', 'expense', null), 'Purchase Accounts');
  assert.equal(g(CODE.RENT, 'Rent', 'expense', null), 'Indirect Expenses');
  assert.equal(g(CODE.FIXED_ASSETS, 'Furniture', 'asset', 'fixed_asset'), 'Fixed Assets');
  assert.equal(g(CODE.BANK_OD, 'Bank OD', 'liability', 'bank_od'), 'Bank OD A/c');
  assert.equal(g(CODE.SECURED_LOANS, 'Secured Loans', 'liability', 'loan'), 'Secured Loans');
  assert.equal(g(CODE.UNSECURED_LOANS, 'Unsecured Loans', 'liability', 'loan'), 'Unsecured Loans');
  assert.equal(g('2690', 'Car loan', 'liability', 'loan'), 'Loans (Liability)');
  assert.equal(g(CODE.PROVISIONS, 'Provisions', 'liability', 'provision'), 'Provisions');
  assert.equal(g(CODE.SECURITY_DEPOSITS, 'Security Deposits', 'asset', 'deposit'), 'Deposits (Asset)');
  assert.equal(g(CODE.LOANS_ADVANCES, 'Advances', 'asset', 'advance'), 'Loans & Advances (Asset)');
  assert.equal(g(CODE.INVESTMENTS, 'Investments', 'asset', 'investment'), 'Investments');
  assert.equal(g(CODE.MISC_EXPENSES_ASSET, 'Preliminary', 'asset', 'misc_expense'), 'Misc. Expenses (ASSET)');
  assert.equal(g(CODE.BRANCH_DIVISIONS, 'Branch', 'asset', 'branch'), 'Branch / Divisions');
  assert.equal(g(CODE.SUSPENSE, 'Suspense', 'asset', 'suspense'), 'Suspense A/c');
  assert.equal(g(CODE.DRAWINGS, 'Drawings', 'equity', 'drawings'), 'Capital Account');
  assert.equal(g(CODE.DISCOUNT_RECEIVED, 'Discount Received', 'income', null), 'Indirect Incomes');
  assert.equal(g(CODE.PROFIT_ON_ASSET_SALE, 'Profit on sale of assets', 'income', null), 'Indirect Incomes');
  assert.equal(defaultLedger({ id: 1, code: CODE.RENT, name: 'Rent', type: 'expense', subtype: null }).ledgerName, 'Rent');
});

// ── The vouchers ─────────────────────────────────────────────────────────────

test('a month of documents becomes the Tally vouchers an accountant expects', async () => {
  await withFixture(async (f) => {
    const { invoice, payment, bill } = await aMonth(f);
    const data = await buildExport(f.trx, f.orgId, { from: FROM, to: TO });
    const vouchers = readVouchers(vouchersXml(data));
    assert.equal(vouchers.length, 3, 'one voucher per posted document');

    const sale = vouchers.find((v) => v.type === 'Sales')!;
    assert.equal(sale.number, invoice.number);
    assert.equal(sale.date, '20260804', 'Tally reads a date as YYYYMMDD');
    assert.equal(sale.party, 'Sharma & Sons', 'the ampersand survived the file');
    assert.equal(sale.remoteId, `rekonza-${f.orgId}-${invoice.journalEntryId}`);

    // Dr the customer, Cr sales and the two taxes: ₹10,000 plus 18% GST.
    const party = sale.entries.find((e) => e.ledger === 'Sharma & Sons')!;
    assert.equal(party.amount, -11_800, 'a debit is negative in Tally');
    assert.equal(party.deemedPositive, true);
    assert.deepEqual(party.bills, [{ name: invoice.number, type: 'New Ref', amount: -11_800 }]);
    assert.equal(sale.entries.find((e) => e.ledger === 'Sales')?.amount, 10_000);
    assert.equal(sale.entries.find((e) => e.ledger === 'Output CGST Payable')?.amount, 900);
    assert.equal(sale.entries.find((e) => e.ledger === 'Output SGST/UTGST Payable')?.amount, 900);

    const receipt = vouchers.find((v) => v.type === 'Receipt')!;
    assert.equal(receipt.number, payment.number);
    assert.equal(receipt.entries.find((e) => e.ledger === 'Bank Account')?.amount, -5_000, 'money into the bank');
    const settled = receipt.entries.find((e) => e.ledger === 'Sharma & Sons')!;
    assert.deepEqual(
      settled.bills,
      [{ name: invoice.number, type: 'Agst Ref', amount: 5_000 }],
      'the receipt closes the same invoice it was allocated to here',
    );

    const purchase = vouchers.find((v) => v.type === 'Purchase')!;
    assert.equal(purchase.number, bill.internalNo);
    assert.equal(purchase.party, 'Bosch Distributors');
    assert.equal(purchase.entries.find((e) => e.ledger === 'Bosch Distributors')?.amount, 14_160);

    for (const v of vouchers) {
      assert.equal(v.entries.reduce((t, e) => t + e.amount, 0), 0, `${v.type} ${v.number} balances`);
      for (const e of v.entries) assert.equal(e.deemedPositive, e.amount < 0, 'Dr is flagged, Cr is not');
    }
  });
});

test('the file carries the same totals as the journal, and says so twice the same way', async () => {
  await withFixture(async (f) => {
    await aMonth(f);
    const data = await buildExport(f.trx, f.orgId, { from: FROM, to: TO });
    const xml = vouchersXml(data);

    const posted = await f.trx
      .selectFrom('journal_lines')
      .select(({ fn }) => [fn.sum<string>('debit').as('debits')])
      .where('org_id', '=', f.orgId).where('entry_date', '>=', FROM).where('entry_date', '<=', TO)
      .executeTakeFirstOrThrow();
    const exported = readVouchers(xml).reduce((t, v) => t + v.entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0), 0);
    assert.equal(exported, Number(posted.debits), 'every rupee posted in the period is in the file');

    // Built from the journal each time, so the same period gives the same file —
    // which is what lets Tally match on REMOTEID instead of duplicating a month.
    const again = vouchersXml(await buildExport(f.trx, f.orgId, { from: FROM, to: TO }));
    assert.equal(again, xml);
  });
});

test('the ledgers file describes the parties and the tax ledgers Tally needs', async () => {
  await withFixture(async (f) => {
    await aMonth(f);
    const data = await buildExport(f.trx, f.orgId, { from: FROM, to: TO });
    const xml = mastersXml(data);

    const ledger = (name: string) =>
      xml.match(new RegExp(`<LEDGER NAME="${name.replace('&', '&amp;')}"[\\s\\S]*?</LEDGER>`))?.[0] ?? '';
    const customer = ledger('Sharma & Sons');
    assert.match(customer, /<PARENT>Sundry Debtors<\/PARENT>/);
    assert.match(customer, /<ISBILLWISEON>Yes<\/ISBILLWISEON>/, 'bill-wise, or the outstanding cannot be tracked');
    assert.match(customer, /<PARTYGSTIN>33AAACS2222B1Z5<\/PARTYGSTIN>/);
    assert.match(customer, /<GSTREGISTRATIONTYPE>Regular<\/GSTREGISTRATIONTYPE>/);
    assert.match(customer, /<LEDSTATENAME>Tamil Nadu<\/LEDSTATENAME>/);

    const vendor = ledger('Bosch Distributors');
    assert.match(vendor, /<PARENT>Sundry Creditors<\/PARENT>/);

    const cgst = ledger('Output CGST Payable');
    assert.match(cgst, /<PARENT>Duties &amp; Taxes<\/PARENT>/);
    assert.match(cgst, /<TAXTYPE>GST<\/TAXTYPE><GSTDUTYHEAD>CGST<\/GSTDUTYHEAD>/, 'so Tally’s GST reports pick it up');

    // A bank added in the app gets a ledger account of its own name; this
    // fixture points at the chart's stock one, so that is the name here.
    assert.match(ledger('Bank Account'), /<PARENT>Bank Accounts<\/PARENT>/);
    assert.match(ledger('Sales'), /<PARENT>Sales Accounts<\/PARENT>/);
    assert.match(xml, /<REPORTNAME>All Masters<\/REPORTNAME>/);
    // The control account is never exported: in Tally the party ledgers are it.
    assert.ok(!xml.includes('>Accounts Receivable<'), 'no control account, the parties carry the balance');
  });
});

test('the summary counts what will be sent, and warns before two things become one ledger', async () => {
  await withFixture(async (f) => {
    await aMonth(f);
    const quiet = await exportSummary(f.trx, f.orgId, { from: FROM, to: TO });
    assert.equal(quiet.voucherCount, 3);
    assert.equal(quiet.partyCount, 2);
    assert.deepEqual(quiet.byType.map((t) => t.voucherType).sort(), ['Purchase', 'Receipt', 'Sales']);
    assert.deepEqual(quiet.warnings, []);
    assert.equal(quiet.lastExport, null);
    assert.ok(quiet.map.find((m) => m.code === CODE.SALES)?.isDefault);

    // Renaming an account onto a name a party already has is the one mistake
    // that cannot be undone after an import.
    await f.trx.insertInto('tally_ledger_map').values({
      org_id: f.orgId, account_id: f.acc[CODE.SALES], ledger_name: 'Sharma & Sons', parent_group: 'Sales Accounts',
    }).execute();
    const clash = await exportSummary(f.trx, f.orgId, { from: FROM, to: TO });
    assert.equal(clash.warnings.length, 1);
    assert.match(clash.warnings[0], /More than one account or party is called/);
    const sales = clash.map.find((m) => m.code === CODE.SALES)!;
    assert.equal(sales.isDefault, false);
    assert.equal(sales.ledgerName, 'Sharma & Sons');
    assert.ok(sales.used > 0, 'the screen says which ledgers the period actually touches');

    const renamed = readVouchers(vouchersXml(await buildExport(f.trx, f.orgId, { from: FROM, to: TO })));
    assert.ok(renamed.find((v) => v.type === 'Sales')!.entries.some((e) => e.ledger === 'Sharma & Sons' && e.amount === 10_000));
  });
});

test('a Tally on the other end takes the files and reports what it made of them', async () => {
  // Posted to a data port exactly as `npm run tally:import` posts to a real
  // TallyPrime — the stand-in reads the envelope, refuses anything that does
  // not balance, and answers with Tally's own counts.
  const tally = await startFakeTally({ today: TO });
  try {
    await withFixture(async (f) => {
      const { invoice } = await aMonth(f);
      const data = await buildExport(f.trx, f.orgId, { from: FROM, to: TO });
      const address = { host: '127.0.0.1', port: tally.port };

      const mastersReply = await postTally(mastersXml(data), address);
      assert.match(mastersReply, /<ERRORS>0<\/ERRORS>/);
      assert.deepEqual(tally.imported.ledgers.sort(), data.ledgers.map((l) => l.name).sort());

      const vouchersReply = await postTally(vouchersXml(data), address);
      assert.match(vouchersReply, /<ERRORS>0<\/ERRORS>/, 'every voucher was accepted');
      assert.equal(tally.imported.vouchers.length, 3);
      const sale = tally.imported.vouchers.find((v) => v.type === 'Sales')!;
      assert.equal(sale.number, invoice.number);
      assert.equal(sale.amountPaise, 11_800_00, 'the invoice arrived at its full value');
      assert.equal(sale.remoteId, `rekonza-${f.orgId}-${invoice.journalEntryId}`, 'and can be matched on a re-import');
      assert.deepEqual(tally.imported.errors, []);
    });
  } finally {
    await tally.close();
  }
});

test('nothing posted in the dates is not an empty file but no file', async () => {
  await withFixture(async (f) => {
    await aMonth(f);
    const data = await buildExport(f.trx, f.orgId, { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(data.vouchers, []);
    assert.deepEqual(data.ledgers, []);
  });
});

test.after(async () => {
  await db.destroy();
});
