// The Zoho Books look and behaviour, checked in a real browser.
//
//   BASE=http://localhost:5003 node scripts/zoho-ui.mjs
//   BASE=http://localhost:5005 ZOHO_LOGIN=demo node scripts/zoho-ui.mjs   (the online demo, in by its door)
//
// Read-only: every request that would write is refused before it leaves the
// browser (signing in and out apart), so it can run against any book. What it
// checks is what the client compares with Zoho's own demo: the frame and its
// colours, the menu in Zoho's order, the lists (view menu, top-bar search,
// Customize Columns, Payment Summary), the split view, Home's cards and tabs,
// the Reports Center, the Banking Overview and the settings mode — and that
// the figures on the Zoho cards agree with the books.

import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://localhost:5003').replace(/\/$/, '');
const DEMO = process.env.ZOHO_LOGIN === 'demo';
const PASSWORD = process.env.DEMO_PASSWORD || 'Rekonza@2026';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failures++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};
const money = (s) => Math.round(Number(String(s).replace(/[^0-9.-]/g, '')) * 100);
const errors = [];
let blocked = [];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(30000);

await context.route(`${BASE}/api/**`, (r) => {
  const req = r.request();
  const p = new URL(req.url()).pathname;
  if (req.method() === 'GET' || ['/api/auth/login', '/api/auth/logout', '/api/auth/demo'].includes(p)) return r.continue();
  blocked.push(`${req.method()} ${p}`);
  return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Read-only check', code: 'read_only' }) });
});
page.on('pageerror', (e) => errors.push(`${page.url()}  ${String(e.message).slice(0, 200)}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource.*(403|401)/.test(t)) return;
  errors.push(`${page.url()}  console: ${t.slice(0, 200)}`);
});

/** Opens a screen and waits for its data, not for a fixed time. */
async function open(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(600);
  await page.waitForFunction(() => !document.querySelector('[data-slot=skeleton], .animate-pulse'), null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(400);
}
const css = (sel, prop) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop).catch(() => null);
const box = (sel) => page.locator(sel).first().boundingBox().catch(() => null);
const api = (url) => page.evaluate(async (u) => (await fetch(u)).json(), url);

async function signIn(email) {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })).catch(() => {});
  if (DEMO) {
    await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
    await page.locator('[data-slot="demo-account"]').first().click();
  } else {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
  }
  await page.waitForURL('**/dashboard', { timeout: 60000 });
  await page.evaluate(() => {
    // Start from Zoho's defaults: unfolded menu, no chosen columns, no favourites.
    for (const k of Object.keys(localStorage)) if (/^rekonza[.-](nav-collapsed|columns|reports|report-favourites|theme)/.test(k)) localStorage.removeItem(k);
  });
}

// ── A. Sign in ─────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await signIn('arun@raceautospares.in');
check('Signs in to Home', page.url().includes('/dashboard'));

// ── B. The frame ───────────────────────────────────────────────────────────
await open('/sales/invoices');
check("Top bar is Zoho's navy #21263c", (await css('[data-slot=topbar]', 'backgroundColor')) === 'rgb(33, 38, 60)');
check('Top bar is 48px tall', Math.round((await box('[data-slot=topbar]'))?.height ?? 0) === 48);
check("Sidebar is Zoho's lavender #f7f7fe", (await css('[data-slot=sidebar]', 'backgroundColor')) === 'rgb(247, 247, 254)');
check('Sidebar is 220px wide', Math.round((await box('aside'))?.width ?? 0) === 220);
const font = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize }));
check('Body text is Inter at 13px', /Inter/i.test(font.family) && font.size === '13px', `${font.family.slice(0, 40)} ${font.size}`);
check("Buttons are Zoho's blue #408dfb", (await css('[data-slot=page-actions] a[href="/sales/invoices/new"]', 'backgroundColor')) === 'rgb(64, 141, 251)');
check("Table headings are 11px uppercase grey", await page.locator('thead th').nth(1).evaluate((el) => {
  const s = getComputedStyle(el); return s.fontSize === '11px' && s.textTransform === 'uppercase' && s.color === 'rgb(108, 113, 138)';
}));

const zohoRows = await page.evaluate(() => {
  const nav = document.querySelector('[data-slot=sidebar] nav');
  const extras = nav.querySelector('[data-slot=sidebar-extras]');
  const out = [];
  for (const el of nav.children) {
    if (el === extras) break;
    const t = (el.querySelector('a, button')?.textContent || el.textContent || '').trim();
    if (t) out.push(t.replace(/\d+$/, '').trim());
  }
  return out;
});
const zohoTop = zohoRows.map((t) => t.split('\n')[0]).filter((t, i, a) => a.indexOf(t) === i);
check("Menu starts with Zoho's nine, in Zoho's order",
  ['Home', 'Items', 'Sales', 'Purchases', 'Time Tracking', 'Banking', 'Accountant', 'Reports', 'Documents'].every((l, i) => zohoTop[i]?.startsWith(l)),
  zohoTop.slice(0, 9).join(' | '));
const extrasText = await page.locator('[data-slot=sidebar-extras]').innerText();
check("Rekonza's extras sit below the rule", ['GST & Taxes', 'Tally', 'Software Checklist', 'AI Assistant'].every((l) => extrasText.includes(l)));
check('Settings is not in the sidebar; the gear is in the top bar',
  (await page.locator('[data-slot=sidebar] a[href="/settings"]').count()) === 0 && (await page.getByRole('button', { name: 'Settings' }).count()) > 0);
check('The screen you are on is filled in blue', (await css('[data-slot=sidebar] a[data-active="1"]', 'backgroundColor')) === 'rgb(64, 141, 251)',
  await page.locator('[data-slot=sidebar] a[data-active="1"]').first().innerText().catch(() => ''));
check('Sales is open on a Sales screen', await page.locator('[data-slot=sidebar] a[href="/sales/customers"]').isVisible());
await page.locator('[data-slot=sidebar] button', { hasText: /^Items$/ }).click();
await page.waitForTimeout(300);
check('Opening Items closes Sales (one group open at a time)',
  (await page.locator('[data-slot=sidebar] a[href="/sales/price-lists"]').isVisible()) && !(await page.locator('[data-slot=sidebar] a[href="/sales/customers"]').isVisible()));

// Fold to the rail, remembered.
await page.getByRole('button', { name: 'Collapse the menu' }).click();
await page.waitForTimeout(400);
check('The menu folds to the 72px rail', Math.round((await box('aside'))?.width ?? 0) === 72);
await open('/sales/invoices');
check('The rail is remembered after a reload', Math.round((await box('aside'))?.width ?? 0) === 72);
await page.locator('[data-slot=sidebar] button', { hasText: 'Purchases' }).hover();
await page.waitForTimeout(600);
const flyout = page.locator('[data-slot=popover-content] a[href="/purchases/bills"]');
check("A rail group opens its screens beside the rail", await flyout.isVisible().catch(() => false));
if (await flyout.isVisible().catch(() => false)) {
  await flyout.click();
  await page.waitForURL('**/purchases/bills');
  check('Choosing from the rail menu opens the screen', page.url().endsWith('/purchases/bills'));
}
await page.getByRole('button', { name: 'Expand the menu' }).click();
await page.waitForTimeout(400);
check('The menu unfolds again', Math.round((await box('aside'))?.width ?? 0) === 220);
check('Configure Features leads to the features switches',
  (await page.locator('[data-slot=sidebar] a', { hasText: 'Configure Features' }).getAttribute('href')) === '/settings?tab=policies');

// ── C. Lists ───────────────────────────────────────────────────────────────
await open('/sales/invoices');
check('The title is the view menu: "All Invoices"', (await page.locator('[data-slot=view-picker]').innerText()).trim() === 'All Invoices');
check('The top bar searches this list', (await page.locator('[data-slot=topbar-search-input]').getAttribute('placeholder')) === 'Search in Invoices ( / )');
check('The list has no second search box of its own', (await page.locator('[data-slot=data-table] input[placeholder^="Search"]').count()) === 0);
check('The list runs edge to edge', Math.round((await box('[data-slot=data-table-grid]'))?.x ?? 0) === 220);

// Payment summary against the books.
const openInv = await api('/api/invoices?open=true&limit=500');
const outstanding = openInv.invoices.filter((i) => i.balancePaise > 0 && !['draft', 'void'].includes(i.status)).reduce((t, i) => t + i.balancePaise, 0);
const summaryText = await page.locator('[data-slot=payment-summary]').innerText();
const shownTotal = money(summaryText.split('Total Outstanding Receivables')[1].split('\n').find((l) => /₹/.test(l)));
check('Payment Summary: total outstanding agrees with the open invoices', shownTotal === outstanding, `₹${shownTotal / 100} vs ₹${outstanding / 100}`);
check('Payment Summary shows Due Today, Due Within 30 Days and Overdue',
  ['Due Today', 'Due Within 30 Days', 'Overdue Invoice'].every((l) => summaryText.includes(l)));

// Top-bar search filters the list.
const allRows = await page.locator('tbody tr').count();
const firstCustomer = (await page.locator('tbody tr').first().locator('td').nth(2).innerText()).trim();
await page.keyboard.press('/');
check('"/" goes to the top bar search', await page.evaluate(() => document.activeElement?.getAttribute('data-slot') === 'topbar-search-input'));
await page.keyboard.type(firstCustomer.slice(0, 6));
await page.waitForTimeout(400);
const filteredCells = await page.locator('tbody tr').allInnerTexts();
check('Typing in the top bar filters the list', filteredCells.length > 0 && filteredCells.length <= allRows
  && filteredCells.every((t) => t.toLowerCase().includes(firstCustomer.slice(0, 6).toLowerCase())), `${filteredCells.length} of ${allRows}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape clears it', (await page.locator('tbody tr').count()) === allRows);

// The view menu.
await page.locator('[data-slot=view-picker]').click();
await page.waitForTimeout(300);
check('The view menu lists the views with counts', (await page.locator('[data-slot=table-tab]', { hasText: /^All\s*\d+$/ }).count()) === 1);
await page.locator('[data-slot=table-tab][data-tab=paid]').click();
await page.waitForTimeout(1500);
await page.waitForFunction(() => !document.querySelector('[data-slot=skeleton]'), null, { timeout: 20000 }).catch(() => {});
check('Choosing a view renames the title ("Paid Invoices")', (await page.locator('[data-slot=view-picker]').innerText()).trim() === 'Paid Invoices');
const statuses = await page.locator('[data-slot=invoice-status]').allInnerTexts();
check('…and shows only those', statuses.length > 0 && statuses.every((s) => /^PAID/.test(s.trim())), `${statuses.length} rows`);
await page.locator('[data-slot=view-picker]').click();
await page.locator('[data-slot=table-tab][data-tab=all]').click();
await page.waitForTimeout(1200);

// Customize Columns.
check('Status reads as Zoho capitals in colour', await page.locator('[data-slot=invoice-status] span').first().evaluate((el) => {
  const s = getComputedStyle(el); return s.textTransform === 'uppercase' && s.color !== 'rgb(0, 0, 0)';
}).catch(() => false));
await page.locator('[data-slot=columns-menu]').click();
await page.waitForTimeout(300);
await page.getByRole('menuitemcheckbox', { name: /supply/i }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Customize Columns hides a column', (await page.locator('thead th', { hasText: /^Supply$/i }).count()) === 0);
await open('/sales/invoices');
check('…and remembers it', (await page.locator('thead th', { hasText: /^Supply$/i }).count()) === 0);
await page.locator('[data-slot=columns-menu]').click();
await page.getByRole('menuitemcheckbox', { name: /supply/i }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('…and shows it again', (await page.locator('thead th', { hasText: /^Supply$/i }).count()) === 1);

// ── D. Split view ──────────────────────────────────────────────────────────
// A record row in the list beside the record.
const ROW = '[data-slot=split-list] [data-slot=split-row], [data-slot=split-list] .thin-scroll > a';
for (const [list, re, label] of [
  ['/sales/invoices', /\/sales\/invoices\/\d+$/, 'Invoices'],
  ['/purchases/bills', /\/purchases\/bills\/\d+$/, 'Bills'],
  ['/sales/customers', /\/sales\/customers\/\d+$/, 'Customers'],
  ['/purchases/vendors', /\/purchases\/vendors\/\d+$/, 'Vendors'],
]) {
  await open(list);
  await page.locator('tbody tr').first().click();
  await page.waitForURL((u) => re.test(u.toString()), { timeout: 30000 });
  await page.waitForSelector(`:is(${ROW})[data-active="1"]`, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  check(`${label}: a record opens beside the list`, (await page.locator('[data-slot=split-list]').isVisible()) && (await page.locator(`:is(${ROW})[data-active="1"]`).count()) === 1);
  check(`${label}: the sidebar folds to the rail while it is open`, Math.round((await box('aside'))?.width ?? 0) === 72);
  check(`${label}: the record's actions sit on Zoho's grey bar`, (await css('.split-page > [data-slot=page-header] > [data-slot=page-actions]', 'backgroundColor')) === 'rgb(247, 248, 252)');
  check(`${label}: the top bar searches the list beside it`, (await page.locator('[data-slot=topbar-search-input]').getAttribute('placeholder')) === `Search in ${label} ( / )`);
  // The list stays loaded when moving to another record.
  await page.locator('[data-slot=split-list]').evaluate((el) => { el.dataset.marker = 'kept'; });
  const second = page.locator(`:is(${ROW}):not([data-active="1"])`).first();
  if (await second.count()) {
    const before = page.url();
    await second.click();
    await page.waitForURL((u) => u.toString() !== before, { timeout: 30000 });
    await page.waitForTimeout(800);
    check(`${label}: moving to another record keeps the list loaded`, (await page.locator('[data-slot=split-list]').getAttribute('data-marker')) === 'kept');
  }
  await page.getByRole('link', { name: `Close and go back to ${label}` }).click();
  await page.waitForURL((u) => u.pathname === list, { timeout: 30000 });
  await page.waitForTimeout(500);
  check(`${label}: X goes back to the list and unfolds the sidebar`, Math.round((await box('aside'))?.width ?? 0) === 220);
}
const inv1 = openInv.invoices[0]?.id ?? (await api('/api/invoices?limit=1')).invoices[0].id;
await open(`/sales/invoices/${inv1}/print`);
check("A record's print view is not split", (await page.locator('[data-slot=split-list]').count()) === 0);
await open('/sales/invoices/new');
check('The new-invoice form is not split', (await page.locator('[data-slot=split-list]').count()) === 0 && (await page.locator('[data-slot=document-form]').count()) === 1);
check("The form's required labels are Zoho's red", (await css('[data-slot=document-form] label.text-required', 'color')) === 'rgb(214, 20, 29)');

// ── E. Customers, as in Zoho's link ────────────────────────────────────────
await open('/sales/customers');
check('Customers open on "Active Customers"', (await page.locator('[data-slot=view-picker]').innerText()).trim() === 'Active Customers');
const heads = (await page.locator('thead th').allInnerTexts()).map((t) => t.trim().toUpperCase()).filter(Boolean);
check("Customers show Zoho's columns", ['NAME', 'COMPANY NAME', 'EMAIL', 'WORK PHONE', 'RECEIVABLES'].every((h) => heads.includes(h)), heads.join(', '));
check('GSTIN waits under Customize Columns', !heads.some((h) => h.startsWith('GSTIN')));
await page.locator('[data-slot=view-picker]').click();
await page.waitForTimeout(400);
const views = (await page.locator('[data-slot=table-tab]').allInnerTexts()).map((t) => t.trim().split(/\s/)[0]);
check('Active, Inactive and All are offered', views.join(',') === 'Active,Inactive,All', views.join(','));
await page.keyboard.press('Escape');

// ── F. Home ────────────────────────────────────────────────────────────────
await open('/dashboard');
await page.waitForSelector('[data-slot=zoho-home-cards]', { timeout: 60000 }).catch(() => {});
const tabs = await page.locator('[data-slot=home-tabs] [role=tab]').allInnerTexts();
check("Home has Zoho's tabs and the Software Checklist", tabs.join('|') === 'Dashboard|Getting Started|Recent Updates|Software Checklist', tabs.join('|'));
for (const slot of ['home-receivables', 'home-payables', 'home-cash-flow', 'home-income-expense', 'home-top-expenses', 'home-banks']) {
  check(`Home shows ${slot.replace('home-', '').replace('-', ' ')}`, (await page.locator(`[data-slot=${slot}]`).count()) === 1);
}
const recvCard = money(await page.locator('[data-slot=home-receivables] [data-slot=home-total]').innerText());
check('Total Receivables agrees with the open invoices', recvCard === outstanding, `₹${recvCard / 100} vs ₹${outstanding / 100}`);
const openBills = await api('/api/bills?open=true&limit=500');
const payable = openBills.bills.filter((b) => b.balancePaise > 0 && !['draft', 'void'].includes(b.status)).reduce((t, b) => t + b.balancePaise, 0);
const payCard = money(await page.locator('[data-slot=home-payables] [data-slot=home-total]').innerText());
check('Total Payables agrees with the open bills', payCard === payable, `₹${payCard / 100} vs ₹${payable / 100}`);
const cf = (await page.locator('[data-slot=home-cash-flow] [data-slot=home-cash-figure]').allInnerTexts()).map(money);
check('Cash Flow adds up: opening + incoming − outgoing = closing', cf.length >= 4 && cf[0] + cf[1] - cf[2] === cf[3], cf.map((v) => v / 100).join(' / '));
const dashText = await page.locator('main').innerText();
check("Rekonza's own dashboard figures follow Zoho's cards", dashText.includes('Who owes us the most') && dashText.includes('Billed vs collected'));
await page.getByRole('tab', { name: 'Getting Started' }).click();
await page.waitForTimeout(500);
check('Getting Started lists the steps', (await page.locator('[data-slot=home-getting-started] li').count()) === 8);
await page.getByRole('tab', { name: 'Recent Updates' }).click();
await page.waitForTimeout(500);
check('Recent Updates lists the latest invoices', (await page.locator('[data-slot=home-recent-updates] tbody tr').count()) > 0);
await page.getByRole('tab', { name: 'Software Checklist' }).click();
await page.waitForSelector('[data-slot=checklist-area]', { timeout: 60000 }).catch(() => {});
check('The Software Checklist tab shows every area', (await page.locator('[data-slot=checklist-area]').count()) >= 10, `${await page.locator('[data-slot=checklist-area]').count()} areas`);
check('…and the address says so', page.url().includes('tab=checklist'));
await open('/dashboard?tab=checklist');
await page.waitForSelector('[data-slot=checklist-area]', { timeout: 60000 }).catch(() => {});
check('A link to ?tab=checklist opens the board', (await page.locator('[data-slot=checklist-area]').count()) >= 10);

// ── G. Reports Center ──────────────────────────────────────────────────────
await open('/reports');
check('Reports Center folds the sidebar, as Zoho does', Math.round((await box('aside'))?.width ?? 0) === 72);
check("Reports Center lists Zoho's categories", (await page.locator('[data-slot=report-category]').count()) >= 11);
const allReports = await page.locator('[data-slot=report-row]').count();
await page.locator('[data-slot=report-category]', { hasText: /^Receivables$/ }).click();
await page.waitForTimeout(300);
const recvRows = await page.locator('[data-slot=report-row] td:nth-child(2)').allInnerTexts();
check('A category shows only its reports', recvRows.length > 0 && recvRows.length < allReports && recvRows.every((t) => t.trim() === 'Receivables'), `${recvRows.length} of ${allReports}`);
await page.locator('[data-slot=report-search]').fill('ageing');
await page.waitForTimeout(300);
check('Report search finds ageing reports', (await page.locator('[data-slot=report-row]', { hasText: 'AR Ageing Summary' }).count()) === 1);
await page.locator('[data-slot=report-search]').fill('');
await page.locator('[data-slot=report-category]', { hasText: /^Home$/ }).click();
await page.locator('[data-slot=report-row] button[aria-label="Add to favourites"]').first().click();
check('Starring a report counts it under Favorites', (await page.locator('[data-slot=report-category]', { hasText: /Favorites\s*1/ }).count()) === 1);
const firstReport = page.locator('[data-slot=report-row] a').first();
const reportHref = await firstReport.getAttribute('href');
await firstReport.click();
await page.waitForURL((u) => u.pathname === reportHref.split('?')[0], { timeout: 30000 });
await page.waitForTimeout(600);
check('Leaving the Reports Center unfolds the sidebar', Math.round((await box('aside'))?.width ?? 0) === 220);
await open('/reports');
check('Last Visited records the report just opened', (await page.locator('[data-slot=report-row]').first().locator('td').nth(3).innerText()).trim().length > 0);

// ── H. Banking Overview ────────────────────────────────────────────────────
await open('/banking');
check('Banking Overview, titled as in Zoho', (await page.locator('h1').first().innerText()).trim() === 'Banking Overview');
check('The four balances are shown', (await page.locator('[data-slot=banking-total]').count()) === 4);
const banks = await api('/api/banking/accounts');
check('Active Accounts lists every account', (await page.locator('[data-slot=bank-account-row]').count()) === banks.accounts.length, `${banks.accounts.length} accounts`);
await page.locator('[data-slot=banking-more]').click();
await page.waitForTimeout(300);
check("More holds Rekonza's banking tools", (await page.locator('[data-slot=dropdown-menu-content] a').count()) >= 6);
await page.keyboard.press('Escape');

// ── I. Settings mode ───────────────────────────────────────────────────────
await open('/settings');
check('Settings has its own header and no sidebar', (await page.locator('[data-slot=settings-topbar]').count()) === 1 && (await page.locator('[data-slot=sidebar]').count()) === 0);
check('All Settings shows the groups', (await page.locator('[data-slot=settings-group]').count()) >= 8);
await page.locator('[data-slot=settings-search]').fill('tag');
await page.waitForTimeout(300);
const tagLinks = await page.locator('[data-slot=settings-link]').allInnerTexts();
check('Searching settings narrows the grid', tagLinks.length > 0 && tagLinks.every((t) => /tag/i.test(t)), tagLinks.join(', '));
await page.locator('[data-slot=settings-search]').fill('');
await page.locator('[data-slot=settings-link]', { hasText: /^Profile$/ }).click();
await page.waitForURL('**/settings?tab=org');
await page.waitForTimeout(800);
check('A setting opens with the settings menu beside it', (await page.locator('[data-slot=settings-nav] a[data-active="1"]').innerText()).trim() === 'Profile');
check('…under its Zoho title', (await page.locator('h1').first().innerText()).trim() === 'Organization Profile');
await page.locator('[data-slot=settings-nav] button', { hasText: 'Users & Roles' }).click();
await page.locator('[data-slot=settings-nav] a', { hasText: /^Users$/ }).click();
await page.waitForURL('**/settings?tab=users');
await page.waitForTimeout(800);
check('The settings menu moves between settings', (await page.locator('h1').first().innerText()).trim() === 'Users & Roles');
await page.locator('[data-slot=close-settings]').click();
await page.waitForURL('**/dashboard');
await page.waitForTimeout(500);
check('Close Settings returns with the sidebar', (await page.locator('[data-slot=sidebar]').count()) === 1);

// ── J. Top bar ─────────────────────────────────────────────────────────────
await page.getByRole('button', { name: 'Recent pages' }).click();
await page.waitForTimeout(300);
const recent = await page.locator('[data-slot=dropdown-menu-content]').innerText();
check('Recent pages remembers the screens opened', /Home/.test(recent) && /Banking Overview/.test(recent), recent.replace(/\n/g, ' | ').slice(0, 120));
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Search the whole book' }).click();
await page.waitForTimeout(500);
check('The magnifier opens the search across the book', await page.locator('[role=dialog]').isVisible());
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Account', exact: true }).click();
await page.locator('[data-slot=theme-toggle]').click();
await page.waitForTimeout(300);
check('Dark mode is chosen from the account menu', await page.evaluate(() => document.documentElement.classList.contains('dark')));
await page.getByRole('button', { name: 'Account', exact: true }).click();
await page.locator('[data-slot=theme-toggle]').click();
await page.waitForTimeout(300);
check('…and back to light', !(await page.evaluate(() => document.documentElement.classList.contains('dark'))));

// ── K. A narrower role (not on the online demo, which has one door) ─────────
if (!DEMO) {
  await signIn('vikram@raceautospares.in');
  await open('/sales/invoices');
  check('The Sales role does not see Banking in the menu', (await page.locator('[data-slot=sidebar] a[href="/banking"]').count()) === 0);
  check('…nor Accountant', (await page.locator('[data-slot=sidebar] button', { hasText: /^Accountant$/ }).count()) === 0);
  check('…but has its own screens, in Zoho style', (await page.locator('[data-slot=view-picker]').count()) === 1);
  await signIn('arun@raceautospares.in');
}

// ── L. A phone ─────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await open('/sales/invoices');
check('On a phone the top bar fits the screen', await page.locator('[data-slot=topbar]').evaluate((el) => el.scrollWidth <= 392));
await page.getByRole('button', { name: 'Open navigation' }).click();
await page.waitForTimeout(500);
check('On a phone the menu opens as a drawer', await page.locator('[data-slot=sheet-content] [data-slot=sidebar]').isVisible().catch(() => false)
  || await page.locator('[role=dialog] [data-slot=sidebar]').isVisible().catch(() => false));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Search', exact: true }).click();
await page.waitForTimeout(400);
check('On a phone search opens from its button', await page.locator('[role=dialog]').isVisible());
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1440, height: 900 });

// ── The run as a whole ─────────────────────────────────────────────────────
check('No page errors or console errors', errors.length === 0, errors.slice(0, 5).join(' || '));
check('Nothing tried to write', blocked.length === 0, blocked.slice(0, 5).join(', '));

await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (/^rekonza[.-](nav-collapsed|columns|reports|report-favourites|theme)/.test(k)) localStorage.removeItem(k);
}).catch(() => {});
await browser.close();
console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
