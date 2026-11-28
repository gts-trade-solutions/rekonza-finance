// Status review 7, item 6: bulk payment upload, as the auditors test it.
//   FRESH=1 node scripts/e2e/sr7-6-bulk-payments.mjs   (a new company)
//   node scripts/e2e/sr7-6-bulk-payments.mjs           (the demo book)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addDays, api, check, contact, enter, file, finish, goto, shot, start, today } from './sr7-b-lib.mjs';

const t = await start('6');
const { page } = t;
const d = today();
const dmy2 = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

async function upload(slug, filePath) {
  await goto(t, `/import/${slug}`);
  await page.locator('[data-slot="import-file-input"]').setInputFiles(filePath);
  await page.locator('[data-slot="import-file-name"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-counts"]').waitFor({ timeout: 120_000 });
}
const problems = async () => (await page.locator('[data-slot="import-errors"] [data-slot="import-error-row"], [data-slot="import-duplicates-list"] [data-slot="import-error-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title') ?? '')));
const owes = async (kind, id) => (await api(t, 'GET', `/api/${kind}/${id}`)).json?.balancePaise;

await enter(t);

if (process.env.FRESH === '1') {
  // Setup through the app's API: a bank account, customers, vendors with bank details, invoices and bills.
  const bank = await api(t, 'POST', '/api/banking/accounts', { kind: 'bank', name: 'HDFC Current', bankName: 'HDFC Bank', accountNumber: '50100123456789', ifsc: 'HDFC0000123', openingBalancePaise: 10_00_000_00 });
  check(t, 'a bank account is set up', bank.status === 200, JSON.stringify(bank.json).slice(0, 100));
  const bankId = bank.json.id;
  const buyer = await contact(t, 'customer', 'Sri Murugan Motors');
  await contact(t, 'customer', 'Velocity Auto Works');
  const lak = await contact(t, 'vendor', 'Lakshmi Auto', { bankAccountNo: '1234567890', bankIfsc: 'ICIC0001234', bankAccountName: 'Lakshmi Auto' });
  const brk = await contact(t, 'vendor', 'Brake Works', { bankAccountNo: '9876543210', bankIfsc: 'SBIN0004567', bankAccountName: 'Brake Works' });
  const sell = async (number, rupees) => (await api(t, 'POST', '/api/invoices', { customerId: buyer, number, date: addDays(d, -10), dueDate: d, status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }] })).json;
  const i1 = await sell('S-1', 10_000);
  const i2 = await sell('S-2', 5_000);
  const i3 = await sell('S-3', 2_000);
  const bill = async (vendorId, no, rupees) => (await api(t, 'POST', '/api/bills', { vendorId, vendorInvoiceNo: no, date: addDays(d, -9), dueDate: d, lines: [{ description: 'Parts', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }] })).json;
  const b1 = await bill(lak, 'LA-1', 8_000);
  const b2 = await bill(brk, 'BW-1', 20_000);
  const b3 = await bill(lak, 'LA-2', 3_000);
  const b4 = await bill(brk, 'BW-2', 2_50_000);
  check(t, 'three invoices and four bills to pay', !!(i1?.id && i2?.id && i3?.id && b1?.id && b2?.id && b3?.id && b4?.id));

  // 1 & 3. Customer receipts from a bank's file: logo rows, headings on row 4, ₹ and commas, dd/mm/yy, a byte-order mark.
  const receipts = [
    'HDFC BANK LTD — Collections',
    'Account No: 50100123456789,,Period: this month',
    '',
    'Txn Date,Remitter Name,Credit Amount,Payment Mode,UTR No,Deposit To,Invoice Number',
    `${dmy2(d)},Sri Murugan Motors,"₹ 15,000.00",NEFT,UTR001,HDFC Current,"S-1, S-2"`,
    `${dmy2(d)},Unknown Garage,"1,000.00",NEFT,UTR002,HDFC Current,`,
    `${dmy2(d)},Sri Murugan Motors,500.00,NEFT,UTR003,HDFC Current,S-1`,
    `${dmy2(d)},Sri Murugan Motors,"3,000.00",NEFT,UTR004,HDFC Current,S-3`,
    `${dmy2(d)},Sri Murugan Motors,100.00,NEFT,UTR005,SBI Savings,`,
    `${dmy2(d)},Sri Murugan Motors,200.00,NEFT,UTR001,HDFC Current,S-3`,
    `${dmy2(d)},Sri Murugan Motors,"1,500.00",UPI,UTR006,HDFC Current,S-3`,
  ].join('\r\n');
  await upload('payments-received', file('receipts.csv', `﻿${receipts}\r\n`));
  const rp = await problems();
  check(t, 'the headings are found under the bank\'s title rows and every column maps', (await page.locator('[data-slot="import-count-rows-value"]').innerText()) === '7');
  check(t, 'unknown customer refused by row', rp.some((x) => /^Row 6, Customer: "Unknown Garage" is not one of your customers/.test(x)), rp.join(' | ').slice(0, 300));
  check(t, 'invoice already paid refused by row', rp.some((x) => /^Row 7, Invoice: Invoice S-1 is paid already/.test(x)));
  check(t, 'amount over the balance refused by row', rp.some((x) => /^Row 8, Amount: .*more than the ₹2,000.00 still owed on S-3/.test(x)));
  check(t, 'unknown bank account refused by row', rp.some((x) => /^Row 9, Deposited to: "SBI Savings" is not one of your bank/.test(x)));
  check(t, 'a duplicate reference refused by row', rp.some((x) => /^Row 10, Reference: "UTR001" is already on row 5 of this file/.test(x)));
  await shot(t, 'receipts-preview');
  await page.locator('[data-slot="import-mode-valid"]').check();
  await page.locator('[data-slot="import-run"]').click();
  await page.waitForURL(/import\/history\?batch=/, { timeout: 120_000 });
  check(t, '4. the good receipts are applied to the right invoices: S-1 and S-2 settled, S-3 owes ₹500', (await owes('invoices', i1.id)) === 0 && (await owes('invoices', i2.id)) === 0 && (await owes('invoices', i3.id)) === 50_000,
    `${await owes('invoices', i1.id)}/${await owes('invoices', i2.id)}/${await owes('invoices', i3.id)}`);
  await shot(t, 'receipts-imported');

  // 2. Vendor payments with the bill numbers and TDS.
  await upload('payments-made', file('payments.csv', [
    'Date,Vendor Name,Amount,Payment Mode,Paid Through,Reference Number,TDS,Bill Number',
    `${d},Lakshmi Auto,"7,920.00",NEFT,HDFC Current,NEFT-77,80,LA-1`,
    `${d},Lakshmi Auto,100.00,NEFT,HDFC Current,NEFT-78,,LA-404`,
  ].join('\n') + '\n'));
  const pp = await problems();
  check(t, 'a bill number the vendor never sent is refused by row', pp.some((x) => /^Row 3, Bill: Bill LA-404 is not one of Lakshmi Auto's/.test(x)), pp.join(' | '));
  await page.locator('[data-slot="import-mode-valid"]').check();
  await page.locator('[data-slot="import-run"]').click();
  await page.waitForURL(/import\/history\?batch=/, { timeout: 120_000 });
  check(t, 'LA-1 is settled by ₹7,920 paid and ₹80 TDS', (await owes('bills', b1.id)) === 0, String(await owes('bills', b1.id)));

  // Record Bulk Payments: two vendors' bills at once.
  await goto(t, '/purchases/payments');
  await page.locator('[data-slot="payments-bulk"]').click();
  await page.waitForURL(/payments\/bulk/);
  await page.locator('[data-slot="bulk-pay-row"]').first().waitFor();
  for (const no of ['LA-2', 'BW-1']) await page.locator('[data-slot="bulk-pay-row"]').filter({ hasText: no }).locator('[data-slot="bulk-pay-tick"]').check();
  await page.locator('[data-slot="bulk-pay-ref"]').fill('RUN-27');
  await shot(t, 'bulk-payments');
  await page.locator('[data-slot="bulk-pay-save"]').click();
  await page.waitForURL(/\/purchases\/payments$/, { timeout: 120_000 });
  check(t, 'Record Bulk Payments: LA-2 and BW-1 paid, one payment per vendor', (await owes('bills', b3.id)) === 0 && (await owes('bills', b2.id)) === 0);

  // The bank's bulk upload file from a payment batch, and the bank's reply.
  const batch = await api(t, 'POST', '/api/payment-batches', { action: 'create', bankAccountId: bankId, payDate: d, lines: [{ billId: b4.id, amountPaise: 2_50_000_00 }] });
  check(t, 'a payment batch for BW-2 (₹2,50,000, by RTGS)', batch.status === 200, JSON.stringify(batch.json).slice(0, 100));
  await api(t, 'POST', '/api/payment-batches', { action: 'submit', id: batch.json.id });
  await goto(t, '/purchases/payment-batches');
  await page.locator('[data-slot="batch-format-select"]').first().selectOption('hdfc');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-slot="batch-bank-file"]').first().click()]);
  const filePath = path.join(path.dirname(file('x', '')), dl.suggestedFilename());
  await dl.saveAs(filePath);
  const hdfc = readFileSync(filePath, 'utf8');
  check(t, 'the HDFC ENet file: R (RTGS), the account, ₹2,50,000.00, the beneficiary', /^R,,9876543210,250000\.00,Brake Works,/.test(hdfc), hdfc.slice(0, 80));
  await shot(t, 'batch-bank-file');
  const number = (await api(t, 'GET', '/api/payment-batches')).json.batches.find((b) => b.id === String(batch.json.id)).number;
  const reply = file('reply.csv', `HDFC ENet Status\nCustomer Reference No,Amount,Status,UTR No,Reject Reason\n${number}/${brk},"2,50,000.00",Success,HDFCR52026112700077,\n`);
  await page.locator('[data-slot="batch-bank-reply-input"]').first().setInputFiles(reply);
  await page.waitForTimeout(4000);
  const st = await page.locator('[data-slot="batch-bank-status"]').first().innerText().catch(() => '');
  check(t, 'the bank\'s reply marks the transfer paid with its UTR', /Paid · UTR HDFCR52026112700077/.test(st), st);
  check(t, 'and BW-2 is settled', (await owes('bills', b4.id)) === 0);
  await shot(t, 'batch-bank-reply');

  // The bank account shows them for reconciliation, and they match the statement lines.
  const stmt = await api(t, 'POST', '/api/banking/import', { bankAccountId: bankId, filename: 'statement.csv', rows: [
    { date: d, narration: 'NEFT CR SRI MURUGAN MOTORS UTR001', reference: 'UTR001', depositPaise: 15_000_00 },
    { date: d, narration: 'RTGS DR BRAKE WORKS', reference: 'HDFCR52026112700077', withdrawalPaise: 2_50_000_00 },
  ] });
  check(t, 'a statement with the receipt and the RTGS: both matched to the payments entered', stmt.status === 200 && stmt.json.autoMatched === 2, JSON.stringify(stmt.json).slice(0, 120));
  await goto(t, `/banking`);
  await shot(t, 'banking');
} else {
  await goto(t, '/purchases/payment-batches');
  const st = await page.locator('[data-slot="batch-bank-status"]').allInnerTexts().catch(() => []);
  check(t, 'the demo batch shows the bank\'s reply: one paid with its UTR, one returned with the reason', st.some((x) => /Paid · UTR/.test(x)) && st.some((x) => /Returned: Beneficiary IFSC changed/.test(x)), st.join(' | '));
  await shot(t, 'batches');
  await goto(t, '/purchases/payments/bulk');
  await page.locator('[data-slot="bulk-pay-table"], [data-slot="bulk-pay-head"]').first().waitFor();
  await shot(t, 'bulk-payments');
}
await finish(t);
