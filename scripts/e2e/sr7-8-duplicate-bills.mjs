// Status review 7, item 8: duplicate invoice detection, as the auditors test it.
//   FRESH=1 node scripts/e2e/sr7-8-duplicate-bills.mjs   (a new company)
//   node scripts/e2e/sr7-8-duplicate-bills.mjs           (the demo book)

import { BASE, FRESH, addDays, api, check, contact, enter, file, finish, goto, pick, shot, start, today } from './sr7-b-lib.mjs';

const t = await start('8');
const { page } = t;
await enter(t);

/** The bill form, filled: vendor, the supplier's number, the date and one line. */
async function billForm(vendor, number, date, rupees) {
  await goto(t, '/purchases/bills/new');
  await pick(t, page, 'Select or add a vendor', vendor, new RegExp(vendor), 'Search vendors by name or GSTIN');
  await page.locator('[data-slot="bill-vendor-invoice-no"]').fill(number);
  await page.locator('input[type="date"]').first().fill(date);
  const row = page.locator('tr', { has: page.locator('textarea[placeholder="Add a description"]') }).first();
  await row.locator('textarea[placeholder="Add a description"]').fill('Brake parts');
  await row.locator('input[type="number"]').first().fill('1');
  await row.locator('input[placeholder="0.00"]').first().fill(String(rupees));
  await page.waitForTimeout(900); // the duplicate check runs as the number is typed
}
/** Save Bill: wait for the saved bill's page, or for the refusal shown on the form. */
const save = async (expectSaved = false) => {
  await page.getByRole('button', { name: /^Save Bill$/ }).click();
  if (expectSaved) { await page.waitForURL(/\/purchases\/bills\/\d+$/, { timeout: 90_000 }).catch(() => {}); return; }
  await Promise.race([
    page.waitForURL(/\/purchases\/bills\/\d+$/, { timeout: 90_000 }),
    page.locator('[data-slot="bill-duplicate-refusal"]').waitFor({ timeout: 90_000 }),
  ]).catch(() => {});
  await page.waitForTimeout(300);
};

if (FRESH) {
  const d = today();
  await contact(t, 'vendor', 'Vendor X Auto Parts');
  await contact(t, 'vendor', 'Vendor Y Traders');
  await contact(t, 'customer', 'PO Customer');

  // 1. Bill INV-001 from Vendor X.
  await billForm('Vendor X Auto Parts', 'INV-001', d, 1000);
  await save(true);
  check(t, 'bill INV-001 from Vendor X is saved', /\/purchases\/bills\/\d+/.test(page.url()), page.url());
  const firstUrl = page.url();
  await shot(t, 'first-bill');

  // 2-3. The same number again, and written differently: refused, on the form, with a link to the first.
  for (const v of ['INV-001', 'INV001', 'inv-001', ' INV/001 ']) {
    await billForm('Vendor X Auto Parts', v, d, 500);
    const red = page.locator('[data-slot="bill-duplicate"]');
    const shown = await red.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const link = shown ? await red.locator('a').first().getAttribute('href') : null;
    check(t, `"${v}" for Vendor X: shown on the form as already in the books, linked to the first bill`, shown && !!link && firstUrl.endsWith(link), link ?? '');
    if (v === 'INV001') await shot(t, 'same-number-refused');
    await save();
    const refused = await page.locator('[data-slot="bill-duplicate-refusal"]').innerText().catch(() => '');
    check(t, `"${v}": saving is refused with a clear message`, /already in your books as BILL/.test(refused) && page.url().endsWith('/new'), refused.slice(0, 120));
  }

  // 4. Same vendor, same amount, two days later, another number: a likely duplicate needing a reason.
  await billForm('Vendor X Auto Parts', 'INV-002', addDays(d, 2), 1000);
  await page.locator('[data-slot="bill-likely-duplicate"]').waitFor({ timeout: 30_000 }).catch(() => {});
  const amber = await page.locator('[data-slot="bill-likely-duplicate"]').innerText().catch(() => '');
  check(t, 'same vendor and amount two days apart: warned as a possible duplicate on the form', /Possible duplicate/.test(amber) && /same amount 2 day/.test(amber), amber.slice(0, 160));
  await save();
  const ask = await page.locator('[data-slot="bill-duplicate-refusal"]').innerText().catch(() => '');
  check(t, 'saving without a reason is refused, asking for one', /say why and save again/.test(ask), ask.slice(0, 120));
  await page.locator('[data-slot="bill-duplicate-reason-input"]').fill('Second delivery, separate invoice from Vendor X');
  await shot(t, 'likely-duplicate-reason');
  await save(true);
  check(t, 'with a reason it is saved', /\/purchases\/bills\/\d+/.test(page.url()), page.url());
  const secondId = page.url().match(/bills\/(\d+)/)?.[1];

  // 5. The same number for another vendor: allowed.
  await billForm('Vendor Y Traders', 'INV-001', d, 1000);
  check(t, 'INV-001 for Vendor Y: no warning', !(await page.locator('[data-slot="bill-duplicate"]').isVisible().catch(() => false)));
  await save(true);
  check(t, 'INV-001 for Vendor Y is saved', /\/purchases\/bills\/\d+/.test(page.url()), page.url());

  // 7. Edit: changing the number to one that exists is refused.
  await goto(t, `/purchases/bills/${secondId}/edit`);
  await page.locator('[data-slot="bill-vendor-invoice-no"]').fill('inv/001');
  check(t, 'editing INV-002 to "inv/001" shows it as already in the books', await page.locator('[data-slot="bill-duplicate"]').waitFor({ timeout: 30_000 }).then(() => true, () => false));
  await page.getByRole('button', { name: /^Save$/ }).click();
  await page.locator('[data-slot="bill-duplicate-refusal"]').waitFor({ timeout: 60_000 }).catch(() => {});
  const editRefused = await page.locator('[data-slot="bill-duplicate-refusal"]').innerText().catch(() => '');
  check(t, 'the edit is refused', /already in your books/.test(editRefused), editRefused.slice(0, 100));
  await shot(t, 'edit-refused');

  // 6. Through the bulk bills import: the duplicate is refused row by row, the new one goes in.
  await goto(t, '/import/bills');
  const csv = file('bills.csv', "Supplier's bill number,Date,Vendor,Description,Quantity,Rate\nINV/001," + d + ",Vendor X Auto Parts,Parts,1,700\nINV-077," + d + ",Vendor X Auto Parts,Parts,3,333\n");
  await page.locator('[data-slot="import-file-input"]').setInputFiles(csv);
  await page.waitForTimeout(800);
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-next"]').click();
  await page.locator('[data-slot="import-counts"]').waitFor();
  const dupRows = await page.locator('[data-slot="import-skipped"] [data-slot="import-error-row"], [data-slot="import-duplicates-list"] [data-slot="import-error-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title') ?? ''));
  check(t, 'the import leaves INV/001 out as a duplicate, by its row, naming the first bill', dupRows.some((r) => /^Row 2(, Supplier's bill number)?: INV\/001 from Vendor X Auto Parts is already in your books as BILL/.test(r)), dupRows.join(' | ').slice(0, 200));
  check(t, 'and says so, instead of "all ready"', await page.locator('[data-slot="import-ready-skipping"]').isVisible());
  await shot(t, 'import-duplicates');

  // 8. An expense carrying Vendor X's invoice number INV-001 is refused too (through the app's API, as the Expenses form posts it).
  const bank = (await api(t, 'POST', '/api/banking/accounts', { kind: 'bank', name: 'HDFC Current', openingBalancePaise: 0 })).json?.id;
  const branchId = ((await api(t, 'GET', '/api/settings')).json?.branches ?? [])[0]?.id;
  const accounts = await api(t, 'GET', '/api/accounts');
  const rent = (accounts.json?.accounts ?? []).find((a) => a.code === '6100')?.id;
  const vendors = await api(t, 'GET', '/api/contacts?kind=vendor');
  const vx = (vendors.json?.contacts ?? []).find((c) => c.displayName === 'Vendor X Auto Parts')?.id;
  const exp = await api(t, 'POST', '/api/expenses', { branchId: String(branchId), date: d, accountId: String(rent), paidThroughBankAccountId: String(bank), amountPaise: 50_000, vendorId: String(vx), reference: 'INV 001' });
  check(t, 'an expense with Vendor X\'s INV 001 is refused as already in the books', exp.status === 409 && /already in your books/.test(exp.json?.error ?? ''), `${exp.status} ${exp.json?.error ?? ''}`.slice(0, 140));

  // 9. The register: the near miss, with the reason given, cleared by an accountant with a note.
  await goto(t, '/purchases/duplicate-bills');
  const row = page.locator('[data-slot="dup-row"]').first();
  const rowText = await row.innerText().catch(() => '');
  check(t, 'Possible Duplicate Bills lists the near miss with its reason', /Second delivery, separate invoice/.test(rowText) && /same amount/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 160));
  await shot(t, 'register-open');
  await row.locator('[data-slot="dup-note"]').fill('Checked with Vendor X: two deliveries');
  await row.locator('[data-slot="dup-clear"]').click();
  await page.getByText('Cleared: not a duplicate.').waitFor({ timeout: 120_000 }).catch(() => {});
  await page.locator('[data-slot="dup-filter-cleared"]').click();
  await page.locator('[data-slot="dup-row"][data-status="cleared"]').first().waitFor({ timeout: 60_000 }).catch(() => {});
  const cleared = await page.locator('[data-slot="dup-row"][data-status="cleared"]').first().innerText().catch(() => '');
  check(t, 'cleared, with who and the note', /Checked with Vendor X/.test(cleared), cleared.replace(/\s+/g, ' ').slice(0, 160));
  await shot(t, 'register-cleared');

  // Sales: an invoice number is used once; a customer PO used twice is warned on the form.
  const cust = (await api(t, 'GET', '/api/contacts?kind=customer')).json?.contacts?.find((c) => c.displayName === 'PO Customer')?.id;
  const inv = await api(t, 'POST', '/api/invoices', { customerId: cust, date: d, dueDate: d, status: 'approved', orderNumber: 'PO-4471', number: `INV-T-${Date.now() % 100000}`, lines: [{ description: 'Service', qty: 1, ratePaise: 100_000, gstRatePct: 18 }] });
  check(t, 'an invoice with customer PO-4471 is saved', inv.status === 200, `${inv.status} ${JSON.stringify(inv.json).slice(0, 120)}`);
  const again = await api(t, 'POST', '/api/invoices', { customerId: cust, date: d, dueDate: d, status: 'approved', number: inv.json?.number, lines: [{ description: 'Service', qty: 1, ratePaise: 100_000, gstRatePct: 18 }] });
  check(t, 'the same invoice number again is refused by name', again.status === 409 && /already used/.test(again.json?.error ?? ''), again.json?.error?.slice(0, 120));
  await goto(t, '/sales/invoices/new');
  await pick(t, page, 'Select or add a customer', 'PO Customer', /PO Customer/, 'Search customers by name or GSTIN');
  await page.locator('[data-slot="invoice-order-number"]').fill('po 4471');
  await page.locator('[data-slot="invoice-po-twin"]').waitFor({ timeout: 30_000 }).catch(() => {});
  const poWarn = await page.locator('[data-slot="invoice-po-twin"]').innerText().catch(() => '');
  check(t, 'the same customer PO on a new invoice is warned on the form', /already on/.test(poWarn), poWarn.slice(0, 120));
  await shot(t, 'customer-po-warned');
} else {
  // The demo book: the register with the seeded near miss, and the form refusing a number Bosch already used.
  await goto(t, '/purchases/duplicate-bills');
  const rowText = await page.locator('[data-slot="dup-row"]').first().innerText().catch(() => '');
  check(t, 'the demo register shows a near miss with its reason', /Second delivery of the monthly consumables/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 160));
  await shot(t, 'register');
  await billForm('Bosch Automotive Distributors', 'bos/26-27/0771', today(), 100);
  check(t, 'Bosch\'s BOS/26-27/0771 written another way is shown as already in the books', await page.locator('[data-slot="bill-duplicate"]').waitFor({ timeout: 30_000 }).then(() => true, () => false));
  await shot(t, 'bill-form-duplicate');
  await goto(t, '/purchases/bills');
  check(t, 'the Bills list has a Possible duplicates button', await page.locator('[data-slot="bills-possible-duplicates"]').isVisible());
}
void BASE;
await finish(t);
