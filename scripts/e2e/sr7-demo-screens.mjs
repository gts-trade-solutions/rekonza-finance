// The online demo copy: every screen behind the auditors' 14 items, each tab
// clicked, the first record of each kind opened. Fails on any /api reply the
// recording lacks (404 not_in_demo) or any other error, and on page errors.
//   BASE=http://localhost:5025 node scripts/e2e/sr7-demo-screens.mjs
import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://localhost:5025').replace(/\/$/, '');
const SHOTS = process.env.SHOTS;
const ROUTES = [
  '/dashboard', '/reports/consolidated', '/accountant/audit-trail', '/import/customers', '/import/history', '/settings?tab=import',
  '/accountant/journals', '/accountant/reversed-vouchers', '/reports/journal-report', '/reports/stock-reconciliation', '/reports/inventory-valuation',
  '/import/payments-received', '/purchases/payments/bulk', '/sales/payments/bulk', '/purchases/payment-batches', '/sales/credit-notes', '/approvals',
  '/purchases/duplicate-bills', '/purchases/bills', '/accountant/fixed-assets', '/payroll/statutory', '/payroll/form-16', '/payroll/runs',
  '/gst/gstr1', '/gst/gstr3b', '/gst/reconciliation', '/gst/itc-reconciliation', '/gst/gstr9', '/gst/gstr7', '/gst/gstr8', '/gst/return-status',
  '/accountant/budgets', '/reports/budget-vs-actuals', '/reports/custom-reports', '/reports/profit-and-loss', '/reports/balance-sheet',
  '/reports/trial-balance', '/reports/general-ledger', '/accountant/integration-check', '/payroll/import', '/sales/invoices', '/sales/items', '/settings?tab=controls',
];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const bad = [];
let where = '';
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/') && r.status() >= 400 && !/\/api\/auth\//.test(u.pathname)) bad.push(`${where} → ${r.status()} ${u.pathname}${u.search}`);
});
page.on('pageerror', (e) => bad.push(`${where} → page error: ${e.message.slice(0, 160)}`));
await page.goto(BASE + '/login?demo=1', { waitUntil: 'domcontentloaded' });
const ok = await page.evaluate(async () => (await fetch('/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) })).ok);
if (!ok) { console.log('FAIL: the demo book did not open'); process.exit(1); }

const settle = async () => { await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(500); };
const visit = async (route) => {
  where = route;
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await settle();
  const n = await page.getByRole('tab').count();
  for (let i = 0; i < n; i++) {
    const tab = page.getByRole('tab').nth(i);
    try {
      if (!(await tab.isVisible()) || (await tab.getAttribute('aria-selected')) === 'true') continue;
      where = `${route} [tab ${(await tab.innerText()).trim().slice(0, 30)}]`;
      await tab.click({ timeout: 3000 }); await settle();
      if (new URL(page.url()).pathname !== route.split('?')[0]) { await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(); }
    } catch { /* not clickable */ }
  }
  const text = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
  return text;
};
let screens = 0;
for (const r of ROUTES) {
  const text = await visit(r);
  screens++;
  if (/not in the online demo/i.test(text)) bad.push(`${r} → the screen says it is not in the demo`);
  if (text.length < 40 || /could not be found|404/i.test(text.slice(0, 200))) bad.push(`${r} → an empty or missing screen`);
  console.log(`${r}: ${text.length} chars`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-${r.replace(/\W+/g, '_')}.png` }).catch(() => {});
}
// The first record of a few kinds, opened from its list.
for (const [list, re] of [['/accountant/fixed-assets', /^\/accountant\/fixed-assets\/[^/]+$/], ['/sales/items', /^\/sales\/items\/[^/]+$/], ['/sales/credit-notes', /^\/sales\/credit-notes\/[^/]+$/], ['/payroll/runs', /^\/payroll\/runs\/[^/]+$/], ['/accountant/budgets', /^\/accountant\/budgets\/[^/]+$/]]) {
  await page.goto(BASE + list, { waitUntil: 'domcontentloaded' }); await settle();
  const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')));
  const href = hrefs.find((h) => re.test((h || '').split('?')[0]) && !/\/new$/.test(h));
  if (!href) { console.log(`${list}: no record link (opens in place)`); continue; }
  await visit(href); screens++;
  console.log(`${href}: opened`);
}
// An asset's window, from a register row: each of its tabs.
where = '/accountant/fixed-assets [an asset]';
await page.goto(BASE + '/accountant/fixed-assets', { waitUntil: 'domcontentloaded' }); await settle();
const assetRow = page.locator('main tbody tr').first();
if (await assetRow.count()) {
  await assetRow.click(); await settle();
  const dlg = page.getByRole('dialog');
  if (await dlg.count()) {
    for (const name of ['Details', 'Verify & dispose', 'History']) {
      const tab = dlg.getByRole('tab', { name });
      if (await tab.count()) { where = `/accountant/fixed-assets [asset tab ${name}]`; await tab.click(); await settle(); }
    }
    screens++;
    console.log('an asset window: opened with its tabs');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-asset-window.png` }).catch(() => {});
  } else bad.push('/accountant/fixed-assets → a register row opened no window');
}
await browser.close();
const uniq = [...new Set(bad)];
console.log(`\n${screens} screens; ${uniq.length} problem(s)`);
for (const b of uniq) console.log('  ' + b);
console.log(uniq.length ? 'FAIL' : 'PASS');
process.exit(uniq.length ? 1 : 0);
