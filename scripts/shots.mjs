// Captures screenshots of key screens so the UI can be reviewed visually.
//   node scripts/shots.mjs
// Writes PNGs to scripts/shots/ (gitignored).

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';
const OUT = 'scripts/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
// The one-click demo door, rather than typing credentials: it signs in against
// whichever organisation is flagged is_demo, so this keeps working if the
// seeded emails ever change.
await page.locator('[data-slot="demo-account"][data-role="admin"]').click();
await page.waitForURL('**/dashboard');
await page.waitForTimeout(1800);

const shot = async (name, url, prep) => {
  if (url) {
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
  }
  if (prep) await prep();
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
};

await shot('01-dashboard', '/dashboard');
await shot('02-invoice-list', '/sales/invoices');
await shot('03-invoice-new', '/sales/invoices/new');

// Combobox open — the piece the client called out.
await shot('04-combobox-open', '/sales/invoices/new', async () => {
  await page.locator('[data-slot="combobox-trigger"]').first().click();
  await page.waitForTimeout(700);
});

// Filled invoice, so the totals panel and item grid are populated.
await shot('05-invoice-filled', '/sales/invoices/new', async () => {
  await page.locator('[data-slot="combobox-trigger"]').first().click();
  await page.waitForTimeout(500);
  await page.getByRole('option', { name: /Sharma Traders/ }).click();
  await page.waitForTimeout(500);
  const itemTrigger = page.locator('table [data-slot="combobox-trigger"]').first();
  await itemTrigger.click();
  await page.waitForTimeout(500);
  await page.getByRole('option', { name: /Brake Pad Set/ }).click();
  await page.waitForTimeout(700);
});

await shot('06-banking', '/banking');
await shot('06b-reconcile', '/banking/reconcile');
await shot('07-reports', '/reports');
await shot('09-account-transactions', '/reports/account-transactions');
await shot('10-transaction-locking', '/accountant/transaction-locking');
await shot('08-trial-balance', '/reports/trial-balance');

await browser.close();
console.log('done');
