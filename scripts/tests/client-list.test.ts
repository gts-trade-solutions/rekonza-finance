// The client's items 7 to 24 (migrations 107 and 108): a sales order's stages,
// Ready for delivery raising the invoice and its challan, the bank statement
// as on a date, invoice payment statuses, and the company profile lists.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/client-list.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createSalesOrder } from '../../lib/server/services/sales-documents';
import { invoiceFromChallan } from '../../lib/server/services/order-flow';
import { raiseProforma, setOrderStage } from '../../lib/server/services/order-stages';
import { postManualJournal } from '../../lib/server/services/journals';
import { bankStatementAsOn } from '../../lib/server/reports/bank-statement';
import { printableDocument } from '../../lib/server/services/document-print';
import { daysOverdue, paymentStatusOf } from '../../components/shared/invoice-status';
import { companyTypeFrom, COMPANY_TYPES, BUSINESS_NATURES } from '../../lib/company-profile';
import { COUNTRIES, countryCurrency, countryName } from '../../lib/countries';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Client List Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const acc = await accountIds(trx, orgId);
  const customerId = Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind: 'customer', display_name: 'Order Customer', gst_treatment: 'unregistered', state_code: '33', payment_terms: 'net_15',
  } as never).executeTakeFirstOrThrow()).insertId);
  const item = (values: Record<string, unknown>) => trx.insertInto('items').values({
    org_id: orgId, uqc: 'NOS', purchase_price: '0.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES], ...values,
  } as never).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
  await trx.insertInto('hsn_codes').values([
    { org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 },
    { org_id: orgId, code: '998714', kind: 'sac', description: 'Maintenance and repair of vehicles', gst_rate_pct: 18, is_active: 1 },
  ]).execute();
  const goods = await item({ kind: 'goods', name: 'Brake pad set', hsn_sac: '8708', sale_price: '1000.0000' });
  const service = await item({ kind: 'service', name: 'Fitting labour', hsn_sac: '998714', sale_price: '500.0000', uqc: 'OTH' });
  return { orgId, branchId, acc, customerId, goods, service };
}

test('an order goes proforma → work in process → ready, and ready raises the invoice with a challan for the goods', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [
        { itemId: b.goods, qty: 4, ratePaise: 1000_00, gstRatePct: 18, discountPct: 10 },
        { itemId: b.service, qty: 2, ratePaise: 500_00, gstRatePct: 18 },
      ],
    });

    const pi = await raiseProforma(trx, b.orgId, so.id, '2026-06-02');
    assert.match(pi.number, /^PI/);
    assert.equal(pi.stage, 'proforma');
    assert.equal((await raiseProforma(trx, b.orgId, so.id, '2026-06-05')).number, pi.number, 'raised again, the same proforma');
    const printed = await printableDocument(trx, b.orgId, 'sales-order', so.id, { proforma: true });
    assert.equal(printed.title, 'Proforma Invoice');
    assert.equal(printed.number, pi.number);
    assert.ok(printed.facts.some((f) => f.label === 'Against order' && f.value === so.number));

    assert.equal((await setOrderStage(trx, b.orgId, null, so.id, 'in_process', '2026-06-03')).stage, 'in_process');

    const ready = await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-10');
    assert.equal(ready.stage, 'ready');
    const inv = ready.ready!.invoice!;
    assert.ok(inv, 'an invoice was raised');
    const invRow = await trx.selectFrom('invoices').select(['status', 'due_date', 'source_doc_type', 'source_doc_id', 'subtotal'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(invRow.source_doc_type, 'sales_order');
    assert.equal(Number(invRow.source_doc_id), so.id);
    assert.equal(String(invRow.due_date).slice(0, 10), '2026-06-25', 'net 15 from the customer');
    const invLines = await trx.selectFrom('invoice_lines').select(['item_id', 'qty', 'discount_pct']).where('invoice_id', '=', inv.id).orderBy('line_no').execute();
    assert.deepEqual(invLines.map((l) => [l.item_id, Number(l.qty), Number(l.discount_pct)]), [[b.goods, 4, 10], [b.service, 2, 0]], 'every line, the discount kept');
    assert.equal(Number(invRow.subtotal), 4 * 1000 * 0.9 + 2 * 500);

    // The challan carries the goods only, names the invoice, and is invoiced already.
    const dc = ready.ready!.challan!;
    const dcRow = await trx.selectFrom('delivery_challans').select(['status', 'invoice_id', 'source_so_id']).where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.deepEqual([dcRow.status, Number(dcRow.invoice_id), Number(dcRow.source_so_id)], ['invoiced', inv.id, so.id]);
    const dcLines = await trx.selectFrom('challan_lines').select(['item_id', 'qty', 'qty_invoiced']).where('challan_id', '=', dc.id).execute();
    assert.deepEqual(dcLines.map((l) => [l.item_id, Number(l.qty), Number(l.qty_invoiced)]), [[b.goods, 4, 4]]);
    await assert.rejects(invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-11', dueDate: '2026-06-26' }), /invoiced|Nothing is left/);
    const dcPrint = await printableDocument(trx, b.orgId, 'challan', dc.id);
    assert.ok(dcPrint.facts.some((f) => f.label === 'Invoice no.' && f.value === inv.number), 'the challan prints its invoice');
    assert.ok(dcPrint.facts.some((f) => f.label === 'Sales order' && f.value === so.number));

    const after = await trx.selectFrom('sales_orders').select(['status', 'stage']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([after.status, after.stage], ['invoiced', 'ready']);
    await assert.rejects(setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-12'), /already ready/);
    await assert.rejects(setOrderStage(trx, b.orgId, null, so.id, 'in_process', '2026-06-12'), /cannot go back/);
    await assert.rejects(raiseProforma(trx, b.orgId, (await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 1, ratePaise: 1000_00, gstRatePct: 18 }],
    })).id, '2026-06-02').then(() => raiseProforma(trx, b.orgId, so.id, '2026-06-13')), /already invoiced/);
  });
});

test('a services-only order made ready is invoiced without a challan', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [{ itemId: b.service, qty: 3, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const ready = await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-04');
    assert.ok(ready.ready!.invoice);
    assert.equal(ready.ready!.challan, null);
  });
});

test('the bank statement as on a date works the books through to the bank', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const bankId = Number((await trx.insertInto('bank_accounts').values({
      org_id: b.orgId, kind: 'bank', name: 'Current Account', ledger_account_id: b.acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
    }).executeTakeFirstOrThrow()).insertId);
    const bank = b.acc[CODE.BANK_DEFAULT];
    const post = (date: string, memo: string, dr: number, cr: number) => postManualJournal(trx, b.orgId, null, {
      branchId: b.branchId, date, memo, approved: true,
      lines: dr ? [{ accountId: bank, debitPaise: dr }, { accountId: b.acc[CODE.SALES], creditPaise: dr }]
        : [{ accountId: b.acc[CODE.RENT], debitPaise: cr }, { accountId: bank, creditPaise: cr }],
    });
    const deposit = await post('2026-07-01', 'Cash sale banked', 50_000_00, 0);
    const lateDeposit = await post('2026-07-30', 'Cheque deposited', 8_000_00, 0);
    const cleared = await post('2026-07-05', 'Rent by cheque 101', 0, 20_000_00);
    await post('2026-07-28', 'Cheque 102 to landlord', 0, 5_000_00);

    let n = 0;
    const line = (date: string, narration: string, deposit: number, withdrawal: number, balance: number, matched?: number) =>
      trx.insertInto('bank_transactions').values({
        org_id: b.orgId, bank_account_id: bankId, txn_date: date, narration, dedupe_hash: `h${++n}`,
        deposit: (deposit / 100).toFixed(4), withdrawal: (withdrawal / 100).toFixed(4), running_balance: (balance / 100).toFixed(4),
        status: matched ? 'matched' : 'unmatched', matched_type: matched ? 'journal_entry' : null, matched_id: matched ?? null,
      }).execute();
    await line('2026-07-01', 'BY CASH', 50_000_00, 0, 50_000_00, Number(deposit.id));
    await line('2026-07-06', 'CHQ 101', 0, 20_000_00, 30_000_00, Number(cleared.id));
    await line('2026-07-29', 'SMS CHARGES', 0, 59_00, 29_941_00);
    await line('2026-07-31', 'INTEREST', 120_00, 0, 30_061_00);

    const s = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-31');
    assert.equal(s.bookPaise, 50_000_00 + 8_000_00 - 20_000_00 - 5_000_00);
    assert.deepEqual(s.notPresented.map((i) => i.amountPaise), [5_000_00], 'cheque 102 not presented');
    assert.deepEqual(s.notCredited.map((i) => i.amountPaise), [8_000_00], 'the cheque deposited not credited');
    assert.equal(s.notCredited[0].entryId, String(lateDeposit.id));
    assert.deepEqual(s.bankDebits.map((i) => i.amountPaise), [59_00]);
    assert.deepEqual(s.bankCredits.map((i) => i.amountPaise), [120_00]);
    assert.equal(s.computedPaise, 30_061_00);
    assert.equal(s.statementPaise, 30_061_00);
    assert.equal(s.differencePaise, 0, 'agrees to the paisa');

    // As on an earlier day: only what had happened by then.
    const early = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-05');
    assert.equal(early.bookPaise, 30_000_00);
    assert.deepEqual(early.notPresented.map((i) => i.amountPaise), [20_000_00], 'cheque 101 cleared on the 6th, not by the 5th');
    assert.equal(early.statementPaise, 50_000_00);
    assert.equal(early.differencePaise, 0);
  });
});

test('invoices are paid, partially paid or unpaid; overdue is days past the due date', () => {
  assert.deepEqual(['paid', 'partially_paid', 'sent', 'approved', 'overdue', 'draft', 'void'].map(paymentStatusOf),
    ['paid', 'partially_paid', 'unpaid', 'unpaid', 'unpaid', 'draft', 'cancelled']);
  const t = new Date(2026, 10, 3);
  assert.equal(daysOverdue('2026-10-24', 500_00, t), 10);
  assert.equal(daysOverdue('2026-11-10', 500_00, t), 0, 'not yet due');
  assert.equal(daysOverdue('2026-10-24', 0, t), 0, 'nothing owed');
});

test('the company profile lists, and the country list', () => {
  assert.equal(COMPANY_TYPES.length, 8);
  assert.equal(BUSINESS_NATURES.length, 8);
  assert.equal(companyTypeFrom('Private Limited Company'), 'Private limited company');
  assert.equal(companyTypeFrom('Partnership firm or LLP'), 'Limited liability partnership (LLP)');
  assert.equal(companyTypeFrom('Proprietorship'), 'Sole proprietorship');
  assert.equal(companyTypeFrom('One person company'), 'One person company (OPC)');
  assert.equal(companyTypeFrom(''), null);
  assert.equal(countryName('AE'), 'United Arab Emirates');
  assert.equal(countryCurrency('AE'), 'AED');
  assert.equal(countryCurrency('DE'), 'EUR');
  assert.ok(!COUNTRIES.some((c) => c.code === 'IN'), 'India is not an international country');
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length, 'no country twice');
});

test.after(() => db.destroy());
