// Status review 7, item 3: bulk import validation, as the auditors test it.
//   FRESH=1 node scripts/e2e/sr7-3-import-validation.mjs   (a new company)
//   node scripts/e2e/sr7-3-import-validation.mjs           (the demo book)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, check, contact, enter, file, finish, goto, shot, start } from './sr7-b-lib.mjs';

const t = await start('3');
const { page } = t;

function gstin(first14) {
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = cs.indexOf(first14[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return first14 + cs[(36 - (sum % 36)) % 36];
}

/** Upload a file on an import screen and go to its Preview. */
async function upload(slug, filePath) {
  await goto(t, `/import/${slug}`);
  await page.locator('[data-slot="import-file-input"]').setInputFiles(filePath);
  await page.locator('[data-slot="import-file-name"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-counts"], [data-slot="import-demo-note"]').first().waitFor({ timeout: 120_000 });
}
const count = async (k) => Number(await page.locator(`[data-slot="import-count-${k}-value"]`).innerText());
const problems = async () => (await page.locator('[data-slot="import-errors"] [data-slot="import-error-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title') ?? ''))).concat(
  await page.locator('[data-slot="import-duplicates-list"] [data-slot="import-error-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title') ?? '')));

await enter(t);

if (process.env.FRESH === '1') {
  // 1. The sample files: CSV and Excel.
  await goto(t, '/import/customers');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-slot="sample-csv"]').click()]);
  const [xlsDl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-slot="sample-xls"]').click()]);
  check(t, '1. the sample CSV and Excel files download', /customers-sample\.csv$/.test(csvDl.suggestedFilename()) && /customers-sample\.xlsx$/.test(xlsDl.suggestedFilename()), `${csvDl.suggestedFilename()}, ${xlsDl.suggestedFilename()}`);
  const sampleXlsx = path.join(path.dirname(file('x', '')), `sample-customers.xlsx`);
  await xlsDl.saveAs(sampleXlsx);
  await shot(t, 'select-file');

  // 2. Good rows and bad ones, as a CSV.
  await contact(t, 'customer', 'Existing Motors');
  const good = gstin('33AABCG1234F1Z');
  const kar = gstin('29AACCK5678G1Z');
  const bad = `${good.slice(0, 14)}${good[14] === '9' ? '8' : '9'}`;
  const csv = [
    'Name,GSTIN,PAN,State,Email,Phone,PIN code',
    `Good Garage,${good},,,accounts@goodgarage.in,9840012345,600002`,
    ',,,33,,,',
    `Bad Check Digit,${bad},,,,,`,
    'Bad PAN Traders,,ABCDE12345,33,,,',
    `Wrong State Motors,${kar},,33,,,`,
    'Bad Contact Co,,,33,nope@,12345,06002',
    'Good Garage,,,33,,,',
    'Existing Motors,,,33,,,',
    'Second Good,,,Tamil Nadu,,04423456789,600017',
  ].join('\n');
  await upload('customers', file('customers.csv', `﻿${csv}\n`));
  const list = await problems();
  check(t, '4. counts: 9 rows, 2 valid, 5 with errors, 2 duplicates', (await count('rows')) === 9 && (await count('valid')) === 2 && (await count('invalid')) === 5 && (await count('dups')) === 2,
    `${await count('rows')}/${await count('valid')}/${await count('invalid')}/${await count('dups')}`);
  const has = (re) => list.some((x) => re.test(x));
  check(t, 'row 3: a mandatory field missing', has(/^Row 3, Name: Name is missing/));
  check(t, `row 4: "Row 4, GSTIN: ${bad} fails the GSTIN check digit"`, has(new RegExp(`^Row 4, GSTIN: ${bad} fails the GSTIN check digit`)));
  check(t, 'row 5: an invalid PAN', has(/^Row 5, PAN: ABCDE12345 is not a PAN/));
  check(t, 'row 6: the GSTIN\'s state is not the state given', has(/^Row 6, GSTIN: .* registered in state 29/));
  check(t, 'row 7: email, phone and PIN, each named', has(/^Row 7, Email/) && has(/^Row 7, Phone/) && has(/^Row 7, PIN code/));
  check(t, 'row 8: a duplicate within the file', has(/^Row 8, Name: "Good Garage" is already on row 2 of this file/));
  check(t, 'row 9: a duplicate of a customer already in the books', has(/^Row 9, Name: "Existing Motors" is already in your books/));
  await shot(t, 'preview-errors');
  const [report] = await Promise.all([page.waitForEvent('download'), page.locator('[data-slot="import-error-report-csv"]').click()]);
  const reportPath = path.join(path.dirname(sampleXlsx), 'error-report.csv');
  await report.saveAs(reportPath);
  const reportText = readFileSync(reportPath, 'utf8');
  check(t, '4. the error report is the file back with an Error column', /,Error\r?\n/.test(reportText.split('\n')[0] + '\n') && /fails the GSTIN check digit/.test(reportText));
  // The choice: stop, or import the valid rows and skip the rest.
  check(t, 'Stop (import nothing) keeps the Import button off', await page.locator('[data-slot="import-run"]').isDisabled());
  await page.locator('[data-slot="import-mode-valid"]').check();
  await page.locator('[data-slot="import-run"]').click();
  await page.waitForURL(/import\/history\?batch=\d+/, { timeout: 120_000 });
  await page.locator('[data-slot="import-batch-detail"]').waitFor();
  const detail = await page.locator('[data-slot="import-batch-detail"]').innerText();
  check(t, '4. after import, its history entry: who, when, the file, 2 imported, 7 left out with reasons', /customers\.csv/.test(detail) && /Audit Tester/.test(detail) && (await page.locator('[data-slot="batch-imported"]').innerText()) === '2' && (await page.locator('[data-slot="batch-failed"]').innerText()) === '7',
    detail.replace(/\s+/g, ' ').slice(0, 200));
  await shot(t, 'history-detail');

  // 3. The same through Excel: the .xlsx sample, and a real Zoho .xls export.
  await upload('customers', sampleXlsx);
  check(t, '3. an .xlsx file reads and checks (the sample: 1 row ready)', (await count('rows')) === 1 && (await count('valid')) === 1);
  await shot(t, 'xlsx-preview');
  await upload('customers', path.resolve('scripts/tests/fixtures/zoho-customers.xls'));
  check(t, '3. an .xls (Excel 97-2003) Zoho export reads and checks', (await count('rows')) > 0, `${await count('rows')} rows, ${await count('valid')} valid`);
  await shot(t, 'xls-preview');

  // Items: unknown unit, bad HSN, a rate that is no GST rate, negative stock, a bad number.
  await upload('items', file('items.csv', 'Name,Kind,HSN/SAC,Unit,GST rate,Opening quantity,Sale price\nBrake pad,goods,8708,pcs,18,10,850\nBucket item,goods,8708,BUCKET,18,,\nBad HSN item,goods,87A8,NOS,18,,\nOdd rate item,goods,8708,NOS,7,,\nMinus stock,goods,8708,NOS,18,-3,\nBad number,goods,8708,NOS,18,,abc\n'));
  const il = await problems();
  check(t, 'items: unit, HSN, GST rate, negative stock and a bad number each named', ['Unit', 'HSN/SAC', 'GST rate', 'Opening quantity', 'Sale price'].every((f) => il.some((x) => x.includes(`, ${f}:`))), il.join(' | ').slice(0, 300));
  await shot(t, 'items-errors');

  // Opening balances that do not balance.
  await upload('opening-balances', file('openings.csv', 'Account code,Debit,Credit\n3100,,500000\n1270,450000,\n'));
  const ol = await problems();
  check(t, 'opening balances that do not balance are refused, naming the difference', ol.some((x) => /do not balance: debits ₹4,50,000.00, credits ₹5,00,000.00/.test(x)), ol.join(' | ').slice(0, 200));
  await shot(t, 'openings-unbalanced');

  // An invoice import: bad date, negative quantity, unknown customer, unknown tax rate.
  await upload('invoices', file('invoices.csv', 'Invoice number,Date,Customer,Description,Quantity,Rate,GST rate\nIMP-1,2026-04-10,Good Garage,Service,1,1000,18\nIMP-2,31-02-2026,Good Garage,Service,1,1000,18\nIMP-3,2026-04-10,Good Garage,Part,-2,500,18\nIMP-4,2026-04-10,Nobody Ltd,Part,1,500,18\nIMP-5,2026-04-10,Good Garage,Part,1,500,7\n'));
  const vl = await problems();
  check(t, 'invoices: bad date, negative quantity, unknown customer and tax rate, each by row', [/^Row 3, Date/, /^Row 4, Quantity/, /^Row 5, Customer/, /^Row 6, GST rate/].every((re) => vl.some((x) => re.test(x.replace(/^Row (\d+), [^:]*: [^:]*: /, 'Row $1, ')) || vl.some((y) => re.test(y)))), vl.join(' | ').slice(0, 300));

  // The same rules as the single-record form: the form refuses what the import refuses.
  const form = await api(t, 'POST', '/api/contacts', { kind: 'customer', displayName: 'Form Check', gstTreatment: 'unregistered', stateCode: '33', billingPincode: '06002' });
  check(t, 'the customer form refuses the same PIN code with the same words', form.status === 400 && /06002 is not a PIN code: it is six digits, and does not start with 0/.test(form.json?.error ?? ''), form.json?.error);

  // Import History, and Delete (undo) of an unused import of masters.
  await goto(t, '/import/history');
  const row = page.locator('[data-slot="import-history-row"]').filter({ hasText: 'customers.csv' }).first();
  await shot(t, 'history-list');
  page.once('dialog', (d) => void d.accept());
  await row.locator('[data-slot="row-delete"]').click();
  await page.waitForTimeout(2500);
  const after = await page.locator('[data-slot="import-history-row"]').filter({ hasText: 'customers.csv' }).first().innerText();
  check(t, 'Delete undoes the unused import; the entry stays, marked undone', /Undone by/.test(after), after.replace(/\s+/g, ' ').slice(0, 160));
  await shot(t, 'history-undone');
} else {
  await goto(t, '/import/history');
  await page.locator('[data-slot="import-history-row"]').first().waitFor();
  const text = await page.locator('[data-slot="import-history-table"]').innerText();
  check(t, 'the demo Import History lists the imports with rows left out', /customers-november\.xlsx/.test(text) && /new-items\.csv/.test(text));
  await page.locator('[data-slot="import-history-row"]').filter({ hasText: 'customers-november' }).locator('[data-slot="import-history-view"]').click();
  await page.locator('[data-slot="batch-errors"]').waitFor();
  const errs = await page.locator('[data-slot="batch-errors"]').innerText();
  check(t, 'its rows left out, by row, field and reason', /PIN code/.test(errs) && /Email/.test(errs), errs.replace(/\s+/g, ' ').slice(0, 200));
  await shot(t, 'history');
  await goto(t, '/import/customers');
  await shot(t, 'select-file');
}
await finish(t);
