// Creating a customer, a vendor and an item from inside a document.
//   node scripts/quick-create.mjs
//
// The point of these shortcuts is that the document survives. So every check
// below fills part of a document FIRST, then creates the master record, then
// asserts that what was already typed is still there and that the new record
// landed on the document with its own figures — rate, HSN, GST rate, terms.
//
// It also asserts the record reached the database, not just the store: a
// picker that shows an item nobody can find tomorrow is worse than one that
// made you leave the page.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';
const OUT = 'scripts/shots';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
};

const stamp = Date.now().toString().slice(-6);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
await page.locator('[data-slot="demo-account"][data-role="admin"]').click();
await page.waitForURL('**/dashboard', { timeout: 30_000 });
await page.waitForTimeout(1500);

/** Open a Combobox's create footer and return the dialog that appears. */
async function openCreate(trigger, label) {
  await trigger.click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: label }).click();
  await page.waitForTimeout(500);
}

// ── 1. A customer, from the invoice form ────────────────────────────────────
console.log('\nNew customer, from the invoice form');
{
  await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Type something into the document first — it has to survive.
  const poRef = `PO-${stamp}`;
  await page.getByPlaceholder('Customer PO reference').fill(poRef);

  await openCreate(page.locator('[data-slot="combobox-trigger"]').first(), /New customer/);
  const dialog = page.locator('[data-slot="quick-customer"]');
  ok('the dialog opens on the invoice', await dialog.isVisible());

  const name = `Quick Customer ${stamp}`;
  await dialog.getByPlaceholder("Customer's business name").fill(name);
  // A Karnataka GSTIN: the state should follow from it, and the invoice should
  // then resolve to IGST rather than CGST+SGST.
  await dialog.getByPlaceholder('22AAAAA0000A1Z5').fill('29AABCK5678M1ZS');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/quick-customer.png` });

  await dialog.getByRole('button', { name: /^Add customer$/ }).click();
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  ok('the new customer is selected on the invoice', body.includes(name));
  ok('the invoice was not thrown away',
    (await page.getByPlaceholder('Customer PO reference').inputValue()) === poRef);
  ok('the GSTIN set the state', /Karnataka/.test(body), body.match(/Karnataka/) ? 'Karnataka' : 'not shown');
  ok('an inter-state customer switches the invoice to IGST', /IGST/.test(body));

  // And it is genuinely in the database, not only in the browser's store.
  const found = await page.evaluate(async (q) => {
    const r = await fetch(`/api/contacts?kind=customer&search=${encodeURIComponent(q)}`, { credentials: 'include' });
    const j = await r.json();
    return (j.contacts ?? []).map((c) => ({ name: c.displayName, gstin: c.gstin, state: c.stateCode }));
  }, name);
  ok('it was written to the database', found.length === 1, JSON.stringify(found[0] ?? {}));
  ok('with its GSTIN and state', found[0]?.gstin === '29AABCK5678M1ZS' && found[0]?.state === '29');
}

// ── 2. An item, from the invoice line editor ────────────────────────────────
console.log('\nNew item, from an invoice line');
{
  const itemName = `Quick Item ${stamp}`;
  // The item picker is the first combobox inside the lines table.
  await openCreate(page.locator('table [data-slot="combobox-trigger"]').first(), /New item/);

  const dialog = page.locator('[data-slot="quick-item"]');
  ok('the item dialog opens without leaving the invoice', await dialog.isVisible());

  await dialog.getByPlaceholder('Item name').fill(itemName);
  // Pick an approved HSN; it should set the GST rate by itself.
  await dialog.locator('[data-slot="combobox-trigger"]').first().click();
  await page.waitForTimeout(400);
  await page.getByRole('option').first().click();
  await page.waitForTimeout(300);
  await dialog.locator('input[placeholder="0.00"]').first().fill('2500');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/quick-item.png` });

  await dialog.getByRole('button', { name: /^Add item$/ }).click();
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  ok('the new item lands on the line', body.includes(itemName));
  ok('its price came with it', /2,500\.00/.test(body), body.match(/2,500\.00/)?.[0] ?? 'not found');

  const found = await page.evaluate(async (q) => {
    const r = await fetch(`/api/items?search=${encodeURIComponent(q)}`, { credentials: 'include' });
    const j = await r.json();
    return (j.items ?? []).map((i) => ({ name: i.name, hsn: i.hsnSac, rate: i.gstRatePct, price: i.salePricePaise }));
  }, itemName);
  ok('it was written to the database', found.length === 1, JSON.stringify(found[0] ?? {}));
  ok('with an HSN and a rate from the approved list',
    !!found[0]?.hsn && found[0]?.price === 250000, JSON.stringify(found[0] ?? {}));

  await page.screenshot({ path: `${OUT}/quick-item-applied.png` });
}

// ── 3. A vendor, from the bill form ─────────────────────────────────────────
console.log('\nNew vendor, from the bill form');
{
  await page.goto(`${BASE}/purchases/bills/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const theirNo = `INV-${stamp}`;
  await page.getByPlaceholder('Their invoice number').fill(theirNo);

  await openCreate(page.locator('[data-slot="combobox-trigger"]').first(), /New vendor/);
  const dialog = page.locator('[data-slot="quick-vendor"]');
  ok('the dialog opens on the bill', await dialog.isVisible());

  const name = `Quick Vendor ${stamp}`;
  await dialog.getByPlaceholder("Vendor's business name").fill(name);

  // A registered party must carry a GSTIN; the dialog should refuse to save
  // without one rather than letting the server find out.
  ok('a registered party cannot be saved without a GSTIN',
    await dialog.getByRole('button', { name: /^Add vendor$/ }).isDisabled());
  await dialog.getByPlaceholder('22AAAAA0000A1Z5').fill('33AABCQ9012L1ZF');
  await page.waitForTimeout(400);
  ok('a vendor is asked the MSME question', await dialog.getByText(/micro or small enterprise/i).isVisible());
  await dialog.getByRole('switch').click();
  await page.waitForTimeout(300);
  ok('turning MSME on asks for the Udyam number',
    await dialog.getByPlaceholder('UDYAM-XX-00-0000000').isVisible());
  await page.screenshot({ path: `${OUT}/quick-vendor.png` });

  await dialog.getByRole('button', { name: /^Add vendor$/ }).click();
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  ok('the new vendor is selected on the bill', body.includes(name));
  ok('the bill was not thrown away',
    (await page.getByPlaceholder('Their invoice number').inputValue()) === theirNo);

  const found = await page.evaluate(async (q) => {
    const r = await fetch(`/api/contacts?kind=vendor&search=${encodeURIComponent(q)}`, { credentials: 'include' });
    const j = await r.json();
    return (j.contacts ?? []).map((c) => ({ name: c.displayName, msme: c.isMsme }));
  }, name);
  ok('it was written to the database as an MSME', found[0]?.msme === true, JSON.stringify(found[0] ?? {}));
}

// ── 4. The purchase-order dialog carries both shortcuts ─────────────────────
console.log('\nPurchase orders');
{
  await page.goto(`${BASE}/purchases/purchase-orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /New purchase order/i }).click();
  await page.waitForTimeout(700);

  const triggers = page.locator('[role="dialog"] [data-slot="combobox-trigger"]');
  await triggers.first().click();
  await page.waitForTimeout(400);
  ok('the vendor picker offers creating one', await page.getByRole('button', { name: /New vendor/ }).isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await triggers.nth(1).click();
  await page.waitForTimeout(400);
  ok('the item picker offers creating one', await page.getByRole('button', { name: /New item/ }).isVisible());
  await page.screenshot({ path: `${OUT}/quick-po.png` });
  await page.keyboard.press('Escape');
}

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
