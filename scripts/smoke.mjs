// Real-browser smoke test: visits every route, captures console errors and
// uncaught exceptions. Uses the Chrome already installed on the machine, so no
// browser download is needed.
//
//   node scripts/smoke.mjs            (expects the dev server on :5000)

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5001';

const ROUTES = [
  '/dashboard',
  // Sales
  '/sales/customers', '/sales/customers/new', '/sales/items',
  '/sales/estimates', '/sales/sales-orders', '/sales/challans',
  '/sales/invoices', '/sales/invoices/new', '/sales/retainers',
  '/sales/payments', '/sales/payments/new', '/sales/credit-notes',
  '/sales/recurring',
  // Purchases
  '/purchases/vendors', '/purchases/expenses', '/purchases/purchase-orders', '/purchases/goods-receipts', '/settings/invoice-print', '/approvals', '/settings/import',
  '/purchases/bills', '/purchases/bills/new', '/purchases/payments',
  '/purchases/payments/new', '/purchases/vendor-credits', '/purchases/msme-tracker',
  // Banking
  '/banking', '/banking/reconcile', '/banking/imports',
  '/banking/rules', '/banking/transfers', '/banking/cheques',
  // Accountant
  '/accountant/journals', '/accountant/recurring-journals',
  '/accountant/chart-of-accounts', '/accountant/opening-balances',
  '/accountant/budgets', '/accountant/transaction-locking',
  '/accountant/period-close', '/accountant/audit-trail',
  // GST
  '/gst/einvoices', '/gst/eway-bills', '/gst/gstr1', '/gst/gstr3b',
  '/gst/itc-reconciliation', '/gst/tds-tcs', '/gst/iff', '/gst/gstr9',
  // Inventory
  '/inventory/stock', '/inventory/adjustments', '/inventory/warehouses',
  // Reports
  '/reports', '/reports/profit-and-loss', '/reports/balance-sheet',
  '/reports/cash-flow', '/reports/trial-balance', '/reports/general-ledger',
  '/reports/day-book', '/reports/journal-report', '/reports/ar-ageing',
  '/reports/ap-ageing', '/reports/sales-by-customer', '/reports/sales-by-item',
  '/reports/purchases-by-vendor', '/reports/expenses-by-category',
  '/reports/account-transactions', '/reports/account-type-summary',
  '/reports/movement-of-equity', '/reports/business-ratios',
  '/reports/customer-balances', '/reports/vendor-balances',
  '/reports/invoice-details', '/reports/bill-details',
  '/reports/payments-received', '/reports/payments-made',
  '/reports/expense-details', '/reports/sales-by-salesperson',
  '/reports/credit-note-details', '/reports/ar-ageing-details',
  '/reports/retainer-details', '/reports/sales-order-details',
  '/reports/estimate-details', '/reports/time-to-get-paid',
  '/reports/refund-history', '/reports/schedule-iii',
  // Analytics
  '/analytics', '/analytics/new',
  // Depth
  '/ai', '/settings', '/settings/hsn-codes', '/settings/tax-rates', '/settings/billing', '/portal',
  // The signed-out surface. Visited last, and while signed in, which is fine:
  // none of the three redirects on a session, and a console error on the
  // landing page is the one a prospective customer would see first.
  '/', '/login', '/register',
];

/** Browser noise that says nothing about our code. */
const IGNORE = [
  /favicon/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /webpack-hmr/i,
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const problems = [];
let current = '';

page.on('console', (msg) => {
  if (msg.type() !== 'error' && msg.type() !== 'warning') return;
  const text = msg.text();
  if (IGNORE.some((re) => re.test(text))) return;
  problems.push({ route: current, kind: msg.type(), text: text.slice(0, 220) });
});
page.on('pageerror', (err) => {
  problems.push({ route: current, kind: 'exception', text: String(err.message).slice(0, 220) });
});

// ── Sign in once; the session cookie carries across the whole context.
current = '/login';
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
// Real credentials now — the role picker was a demo affordance and is gone.
await page.locator('#email').fill('arun@raceautospares.in');
await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.waitForURL('**/dashboard', { timeout: 30000 });
await page.waitForTimeout(1200);

const results = [];
for (const route of ROUTES) {
  current = route;
  const before = problems.length;
  let status = 'ok';
  let detail = '';
  try {
    const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
    if (resp && resp.status() >= 400) { status = 'http'; detail = `HTTP ${resp.status()}`; }
    // Next.js renders its error overlay into this element on a client crash.
    const overlay = await page.locator('nextjs-portal').count();
    const h1 = await page.locator('h1, h2').first().textContent({ timeout: 5000 }).catch(() => null);
    if (overlay > 0) {
      const overlayText = await page.locator('nextjs-portal').first().innerText().catch(() => '');
      if (/Console Error|Unhandled Runtime Error|Failed to compile/i.test(overlayText)) {
        status = 'overlay';
        detail = overlayText.split('\n').slice(0, 3).join(' | ').slice(0, 160);
      }
    }
    if (!h1 && status === 'ok') { status = 'blank'; detail = 'no heading rendered'; }
  } catch (e) {
    status = 'threw';
    detail = String(e.message).slice(0, 140);
  }
  const newProblems = problems.length - before;
  if (newProblems > 0 && status === 'ok') { status = 'console'; detail = `${newProblems} console message(s)`; }
  results.push({ route, status, detail });
  const mark = status === 'ok' ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${route}${detail ? '  — ' + detail : ''}`);
}

await browser.close();

const failed = results.filter((r) => r.status !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} routes clean.`);
if (problems.length) {
  console.log('\nConsole messages captured:');
  const seen = new Set();
  for (const p of problems) {
    const key = `${p.route}|${p.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${p.kind}] ${p.route}\n      ${p.text}`);
  }
}
process.exit(failed.length ? 1 : 0);
