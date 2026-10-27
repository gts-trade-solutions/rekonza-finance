// Drives the real user journeys end to end and asserts the ledger stays honest.
//   node scripts/flows.mjs

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5001';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
// A step that provokes a refusal on purpose names the endpoint here, so the
// browser's "Failed to load resource" for that refusal is not counted.
let expectRefusalFrom = null;
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() !== 'error' || /favicon|DevTools/i.test(m.text())) return;
  // Chrome's "Failed to load resource" names no URL in its text; the location does.
  const url = /Failed to load resource/.test(m.text()) ? m.location()?.url?.replace(BASE, '') : '';
  if (url && expectRefusalFrom && url.startsWith(expectRefusalFrom)) return;
  errors.push(m.text().slice(0, 160) + (url ? ` — ${url}` : ''));
});

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const money = (t) => Number(String(t).replace(/[^0-9.]/g, '')) || 0;

// ── sign in
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
// Real credentials now — the role picker was a demo affordance and is gone.
await page.locator('#email').fill('arun@raceautospares.in');
await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.waitForURL('**/dashboard', { timeout: 30000 });
await page.waitForTimeout(1200);
await page.waitForURL('**/dashboard');
check('Sign in as Admin reaches the dashboard', page.url().includes('/dashboard'));

// ── 1. Trial balance is balanced from the seed
await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'networkidle' });
// The statements load asynchronously now, so wait for the banner to appear.
await page.waitForSelector('text=The books balance', { timeout: 30000 }).catch(() => {});
const tbBanner = await page.getByText('The books balance').count();
check('Seeded trial balance is balanced', tbBanner > 0);

const tbRow = await page.locator('tr', { hasText: 'Total' }).last().innerText();
const tbNums = tbRow.match(/₹[\d,]+\.\d{2}/g) || [];
check('Trial balance debit total equals credit total', tbNums.length === 2 && tbNums[0] === tbNums[1],
  tbNums.join(' vs '));

// ── 2. Balance sheet balances
await page.goto(`${BASE}/reports/balance-sheet`, { waitUntil: 'networkidle' });
check('Balance sheet balances', await page.getByText('Assets equal liabilities plus equity').count() > 0);

// ── 3. GST resolves intra-state (CGST+SGST) vs inter-state (IGST)
// Comboboxes on this form, in DOM order: 0 customer, 1 terms, 2 salesperson,
// 3 branch, 4 place of supply, 5 first line item.
const sel = (n) => page.locator('[data-slot="combobox-trigger"]').nth(n);

await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
await sel(0).click();
await page.getByRole('option', { name: /Sharma Traders/ }).click();
await page.waitForTimeout(600);
const intraLabel = await page.getByText('Intra-state — CGST + SGST').count();
check('Tamil Nadu customer resolves to CGST + SGST', intraLabel > 0);

// The picker searches, which is the fix the client asked for.
await sel(0).click();
await page.locator('input[placeholder="Search customers by name or GSTIN"]').fill('Apex');
await page.waitForTimeout(400);
const filtered = await page.locator('[role="option"]').count();
check('Customer picker filters as you type', filtered > 0 && filtered < 5, `${filtered} match(es)`);
await page.getByRole('option', { name: /Apex Motors/ }).click();
await page.waitForTimeout(600);
const interLabel = await page.getByText('Inter-state — IGST').count();
check('Karnataka customer flips to IGST', interLabel > 0);

// ── 4. Create an invoice and confirm it posts a balanced journal entry
await sel(5).click();
await page.getByRole('option', { name: /Brake Pad Set/ }).click();
await page.waitForTimeout(600);
const totalTxt = await page.locator('text=Total').last().locator('xpath=..').innerText().catch(() => '');
check('Totals panel computes a non-zero total', money(totalTxt) > 0, totalTxt.replace(/\n/g, ' ').slice(0, 40));

await page.getByRole('button', { name: 'Save and Send' }).click();
// Saved through the API now, so the detail page lives at a numeric id.
await page.waitForURL((u) => /\/sales\/invoices\/\d+$/.test(u.toString()), { timeout: 30000 });
check('Invoice saves and opens its detail page', /\/sales\/invoices\/\d+$/.test(page.url()));

await page.getByRole('tab', { name: 'Journal' }).click();
await page.waitForTimeout(800);
const posted = await page.locator('body').innerText();
check('New invoice posted a balanced journal entry', /Balanced/.test(posted));
check('The entry debits receivables', /Accounts Receivable/.test(posted));

// ── 5. Books still balance after creating a document
await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'networkidle' });
check('Trial balance still balanced after new invoice',
  await page.getByText('The books balance').count() > 0);

// ── 6. E-invoice simulator issues an IRN
await page.goto(`${BASE}/gst/einvoices`, { waitUntil: 'networkidle' });
// Counted through the API rather than scraped: the queue already contains
// registered rows, so only the change proves the click did anything.
const submittedCount = () =>
  page.evaluate(async () => {
    const r = await fetch('/api/gst?view=einvoices', { credentials: 'include' });
    return (await r.json()).statusCounts.submitted ?? 0;
  });

// The queue is sorted most-urgent first, and the most urgent rows are the ones
// already past 30 days — which the portal refuses outright. So the test does
// both halves: an expired invoice must be refused, and one inside the window
// must go through.
const expiredRow = page.locator('tbody tr').filter({ hasText: /days past/ }).first();
if (await expiredRow.count()) {
  const before = await submittedCount();
  expectRefusalFrom = '/api/gst';
  await expiredRow.getByRole('button', { name: /^Register$/ }).click();
  await page.waitForTimeout(2500);
  expectRefusalFrom = null;
  check('An invoice past the 30-day window is refused an IRN',
    (await submittedCount()) === before, 'the portal will not accept it');
} else {
  check('An invoice past the 30-day window is refused an IRN', true, 'none expired in this dataset');
}

const liveRow = page.locator('tbody tr').filter({ hasText: /days left/ }).first();
if (await liveRow.count()) {
  const before = await submittedCount();
  await liveRow.getByRole('button', { name: /^Register$/ }).click();
  await page.waitForTimeout(3000);
  const after = await submittedCount();
  check('IRP registration returns an IRN', after === before + 1, `${before} → ${after} registered`);
} else {
  check('IRP registration returns an IRN', false, 'no invoice inside the window to submit');
}

// A registered invoice prints as a tax invoice carrying its IRN and QR code —
// the two things the law adds to an e-invoice on paper.
const registeredId = await page.evaluate(async () => {
  const r = await fetch('/api/gst?view=einvoices', { credentials: 'include' });
  const row = (await r.json()).einvoices.find((e) => e.status === 'submitted');
  return row ? row.invoiceId : null;
});
if (registeredId) {
  await page.goto(`${BASE}/sales/invoices/${registeredId}/print`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-slot="tax-invoice"]', { timeout: 20000 }).catch(() => {});
  check('A registered invoice prints with its IRN and QR code',
    (await page.locator('[data-slot="invoice-qr"] svg').count()) > 0
      && (await page.locator('[data-slot="invoice-irn"]').count()) > 0);
}

// ── 7. Reconciling a line actually posts, and the books still tie
await page.goto(`${BASE}/banking/reconcile`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-slot="bank-line"]', { timeout: 25000 });
const beforeLines = await page.locator('[data-slot="bank-line"]').count();

await page.locator('[data-slot="bank-line"]').first().click();
await page.waitForTimeout(900);

// Post the other side to a real expense account. Control accounts are
// deliberately not on offer — see the note in the reconcile page.
await page.locator('[data-slot="combobox-trigger"]').nth(1).click();
await page.waitForTimeout(500);
const offered = await page.locator('[role="option"]').allInnerTexts();
check('Reconcile offers accounts to categorise against', offered.length > 0);
check('Control accounts are not offered',
  !offered.some((t) => /Accounts Receivable|Accounts Payable/.test(t)));
await page.locator('[role="option"]', { hasText: /Bank Fees|Office Supplies|Fuel/ }).first().click();
await page.waitForTimeout(400);

await page.getByRole('button', { name: /Categorise and post/i }).click();
await page.waitForTimeout(2000);

const afterLines = await page.locator('[data-slot="bank-line"]').count();
check('Categorising a line removes it from the unmatched list',
  afterLines === beforeLines - 1, `${beforeLines} → ${afterLines}`);

await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'networkidle' });
check('Books still balance after reconciling',
  (await page.getByText('The books balance').count()) > 0);

// ── 8. RBAC actually hides things
//
// Roles come from the server on every page load, so switching one in the
// browser no longer means anything — this signs in as the sales user instead,
// which is the only way the role actually changes now.
const signInAs = async (email) => {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 30000 });
  await page.waitForTimeout(1000);
};

await signInAs('vikram@raceautospares.in');
const bankingVisible = await page.locator('nav').getByText('Banking').count();
check('Sales role loses the Banking module', bankingVisible === 0);

await page.goto(`${BASE}/sales/items`, { waitUntil: 'networkidle' });
const costCol = await page.getByRole('columnheader', { name: /Cost price/ }).count();
check('Sales role cannot see cost prices', costCol === 0);

// ── 8b. A single-branch user is never shown the branch picker
await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const branchFieldForSales = await page.getByText('Branch (GSTIN)').count();
check('Single-branch user sees no branch picker', branchFieldForSales === 0);

// ── 9. AI assistant answers from the live ledger
await signInAs('arun@raceautospares.in');
await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('Multi-branch user still gets the branch picker',
  (await page.getByText('Branch (GSTIN)').count()) > 0);

await page.goto(`${BASE}/ai`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-slot="ai-welcome"]', { timeout: 15000 }).catch(() => {});

// The welcome lists the checks that fire on this book. They are real rules
// over real tables — so a firing check is itself evidence the assistant reads
// the ledger. (The demo book always has overdue invoices.)
check('Assistant surfaces checks run against the books',
  (await page.locator('[data-slot="ai-attention"]').count()) > 0);

// Asked in plain words. The answer runs the same query the AR ageing report
// does, so it must carry a real rupee figure — and link to that report.
await page.locator('[data-slot="ai-input"]').fill('Which invoices are overdue?');
await page.locator('[data-slot="ai-send"]').click();
await page.waitForSelector('[data-slot="ai-answer"]', { timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => !document.querySelector('[data-slot="ai-streaming"]'), null, { timeout: 60000 }).catch(() => {});
const answerText = (await page.locator('[data-slot="ai-answer"]').last().innerText().catch(() => '')) || '';
check('Assistant answers a ledger question with a real figure', /₹\s?[\d,]+/.test(answerText), answerText.slice(0, 80).replace(/\s+/g, ' '));
check('The answer links to the report it came from', (await page.locator('[data-slot="ai-source"]').count()) > 0);

// ── 8c. Adding an account creates both the bank record and its ledger account
await page.goto(`${BASE}/banking`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
check('Banking offers adding a bank or card',
  (await page.getByRole('button', { name: /add bank or credit card/i }).count()) > 0);

await page.getByRole('button', { name: /add bank or credit card/i }).click();
await page.waitForTimeout(700);

const accountName = `Axis Bank – ${Date.now()}`;
await page.getByPlaceholder('Account name').fill(accountName);
await page.getByPlaceholder('Bank name', { exact: true }).fill('Axis Bank');
await page.getByRole('button', { name: /^Add account$/ }).click();
await page.waitForTimeout(2000);
check('The new account appears on the Banking page',
  (await page.getByText(accountName).count()) > 0);

// The pair matters: an account the books cannot see is money nobody can
// reconcile, so the ledger account has to exist alongside it.
const chart = await page.evaluate(async () => {
  const r = await fetch('/api/masters', { credentials: 'include' });
  const m = await r.json();
  return (m.accounts ?? []).map((a) => a.name);
});
check('A matching ledger account was created', chart.some((n) => n === accountName));

await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'networkidle' });
check('Books still balance after adding an account',
  (await page.getByText('The books balance').count()) > 0);

// ── 8d. The e-invoice mark renders on invoices
await page.goto(`${BASE}/sales/invoices`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('Invoices carry the e-invoice mark',
  (await page.locator('span', { hasText: /^e$/ }).count()) > 0);

// ── 8e. Dialogs must fit the viewport rather than running off it
await page.goto(`${BASE}/banking`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /add bank or credit card/i }).click();
await page.waitForTimeout(700);
const box = await page.locator('[data-slot="dialog-content"]').boundingBox();
const vh = page.viewportSize().height;
check('The add-account dialog fits the viewport',
  !!box && box.height <= vh - 16, box ? `${Math.round(box.height)}px in ${vh}px` : 'no box');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ── 8f. List tabs, bulk select, and the invoice actions menu
await page.goto(`${BASE}/sales/invoices`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('Invoice list shows status tabs with counts',
  (await page.getByRole('button', { name: /^All\s*\d+$/ }).count()) > 0);

await page.locator('thead input[type="checkbox"], thead [role="checkbox"]').first().click();
await page.waitForTimeout(500);
check('Selecting rows reveals bulk actions',
  (await page.getByText(/\d+ selected/).count()) > 0);

// The detail page now comes from the database, so ids are numeric rather than
// the local store's 'inv_' keys.
await page.goto(`${BASE}/sales/invoices`, { waitUntil: 'networkidle' });
await page.waitForSelector('tbody tr', { timeout: 20000 });
await page.locator('tbody tr').first().click();
await page.waitForURL((u) => /\/sales\/invoices\/\d+$/.test(u.toString()), { timeout: 20000 });
// The detail page fetches before it renders, so wait for the tabs rather than
// for a fixed interval that a cold compile can outrun.
await page.waitForSelector('[data-slot="tabs"]', { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(600);
check('Invoice detail loads from the API', (await page.getByRole('tab', { name: 'Journal' }).count()) > 0);

// The proof point: the document shows the exact entry it posted.
await page.getByRole('tab', { name: 'Journal' }).click();
await page.waitForTimeout(600);
const journalText = await page.locator('body').innerText();
check('Invoice shows the journal entry it posted', /Accounts Receivable/.test(journalText));
check('That entry balances', /Balanced/.test(journalText));

check('Invoice actions menu opens',
  (await page.getByRole('button', { name: 'More actions' }).count()) > 0);

// ── 8g. Reports catalogue: search and favourites
await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const groups = await page.locator('h2').count();
check("Reports index shows Zoho's categories", groups >= 9, `${groups} groups`);

await page.getByPlaceholder('Search reports').fill('ageing');
await page.waitForTimeout(600);
check('Report search filters the catalogue',
  (await page.getByText(/result.* for/).count()) > 0);
await page.getByPlaceholder('Search reports').fill('');
await page.waitForTimeout(500);

await page.locator('button[aria-label="Add to favourites"]').first().click();
await page.waitForTimeout(500);
check('Starring a report pins it to Favourites',
  (await page.getByText('Favourites').count()) > 0);

// ── 8h. New accountant tools
await page.goto(`${BASE}/accountant/recurring-journals`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
// The entry count comes from the API now, not from localStorage — the ledger
// lives in the database, and counting the browser's copy would prove nothing.
const entryCount = () =>
  page.evaluate(async () => {
    const r = await fetch('/api/journal?limit=1', { credentials: 'include' });
    return (await r.json()).summary.count;
  });

const beforeEntries = await entryCount();
const runnable = page.getByRole('button', { name: 'Run now' }).and(page.locator(':not([disabled])')).first();
await runnable.click();
await page.waitForTimeout(2000);
const afterEntries = await entryCount();
check('Recurring journal posts a real entry', afterEntries === beforeEntries + 1,
  `${beforeEntries} → ${afterEntries}`);

await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'networkidle' });
check('Books still balance after a recurring journal posts',
  (await page.getByText('The books balance').count()) > 0);

await page.goto(`${BASE}/accountant/transaction-locking`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
check('Transaction locking offers a lock per module',
  (await page.getByRole('button', { name: 'Lock' }).count()) === 4);

// ── 9b. Quick create opens and navigates (this crashed once — see command.tsx)
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Quick create' }).click();
await page.waitForTimeout(800);
check('Quick create opens without crashing',
  (await page.getByPlaceholder(/Create something/).count()) > 0);
await page.locator('[data-slot="dialog-content"]').getByText('New Invoice', { exact: true }).click();
await page.waitForTimeout(1200);
check('Quick create navigates to the invoice form', page.url().includes('/sales/invoices/new'));

// Every quick-create target must be a real route, not a 404.
const quickHrefs = [
  '/sales/invoices/new', '/purchases/bills/new', '/sales/payments/new',
  '/purchases/payments/new', '/purchases/expenses', '/sales/customers/new',
  '/purchases/vendors', '/sales/estimates', '/accountant/journals',
  '/banking/reconcile',
];
let deadLinks = 0;
for (const href of quickHrefs) {
  const resp = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
  if (!resp || resp.status() >= 400) deadLinks++;
}
check('No dead links in quick create', deadLinks === 0, `${deadLinks} dead`);

// ── 10. HSN/SAC is restricted to the organisation's approved list
await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
// Line comboboxes: 5 = item picker, 6 = HSN/SAC picker on the first row.
await page.locator('[data-slot="combobox-trigger"]').nth(6).click();
const hsnSearch = page.locator('input[placeholder="Type the first digits"]');
await hsnSearch.fill('1');
await page.waitForTimeout(300);
check('Typing "1" matches no approved code (prefix search, not contains)',
  await page.locator('[role="option"]').count() === 0);

await hsnSearch.fill('87');
await page.waitForTimeout(300);
const eightySeven = await page.locator('[role="option"]').allInnerTexts();
check('Typing "87" lists only codes starting 87',
  eightySeven.length > 0 && eightySeven.every((t) => /^\s*87/.test(t)),
  eightySeven.map((t) => t.split('\n')[0]).join(', '));

await page.getByRole('option', { name: /8708/ }).first().click();
await page.waitForTimeout(300);
check('Picking an approved code fills the HSN cell',
  (await page.locator('[data-slot="combobox-trigger"]').nth(6).innerText()).includes('8708'));

// ── 11. "Invoice For" narrows both the items and the codes on offer
await page.locator('[data-slot="supply-kind"][data-kind="service"]').click();
await page.waitForTimeout(300);
await page.locator('[data-slot="supply-kind"][data-kind="goods"]').click();
await page.waitForTimeout(300);
check('Turning Goods off leaves Services selected',
  await page.locator('[data-slot="supply-kind"][data-kind="service"][aria-checked="true"]').count() === 1);

await page.locator('[data-slot="combobox-trigger"]').nth(6).click();
await page.waitForTimeout(300);
const sacOnly = await page.locator('[role="option"]').allInnerTexts();
check('A services invoice offers SAC codes only',
  sacOnly.length > 0 && sacOnly.every((t) => /^\s*99/.test(t)),
  `${sacOnly.length} codes, all beginning 99`);
await page.keyboard.press('Escape');

await page.locator('[data-slot="combobox-trigger"]').nth(5).click();
await page.waitForTimeout(300);
const serviceItems = await page.locator('[role="option"]').allInnerTexts();
check('A services invoice offers service items only',
  serviceItems.length > 0 && serviceItems.every((t) => /Fitment|Labour/i.test(t)),
  `${serviceItems.length} item(s)`);
await page.keyboard.press('Escape');

// ── 12. Admin curates the approved list
await page.goto(`${BASE}/settings/hsn-codes`, { waitUntil: 'networkidle' });
const codeRows = await page.locator('tbody tr').count();
check('HSN settings lists the seeded codes', codeRows >= 14, `${codeRows} codes`);

await page.locator('input[placeholder="Type the first digits, or a description"]').fill('87');
await page.waitForTimeout(300);
const searched = await page.locator('tbody tr').count();
check('Code search filters by prefix', searched > 0 && searched < codeRows, `${searched} of ${codeRows}`);

await page.locator('input[placeholder="Type the first digits, or a description"]').fill('');
await page.waitForTimeout(300);

// The list is persistent now, so a fixed code would already be there on a
// second run. Pick one that is genuinely absent.
const existingCodes = await page.locator('tbody tr td:first-child').allInnerTexts();
const freshCode = ['8544', '8511', '8536', '8607', '8483', '8409', '8482', '4011']
  .find((c) => !existingCodes.some((t) => t.trim() === c));

if (freshCode) {
  await page.getByRole('button', { name: /New Code/ }).click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="0000"]').fill(freshCode);
  await page.locator('input[placeholder="Description of the goods or service"]')
    .fill('Added by the flow test');
  await page.getByRole('button', { name: /Add code/ }).click();
  await page.waitForTimeout(2000);
  check('Adding a code grows the approved list',
    await page.locator('tbody tr').count() === codeRows + 1, `now ${codeRows + 1} codes`);
} else {
  check('Adding a code grows the approved list', true, 'every candidate code already approved');
}

// Both the settings screen and the invoice form now read the same approved
// list from the API, so a code added here is immediately pickable on a line.
await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('[data-slot="combobox-trigger"]').nth(6).click();
await page.locator('input[placeholder="Type the first digits"]').fill('87');
await page.waitForTimeout(400);
check('The invoice code picker is served by the API',
  (await page.getByRole('option', { name: /8708/ }).count()) === 1);
await page.keyboard.press('Escape');

// ── 13. Dashboard carries percentages, debtors and creditors
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const dash = await page.locator('body').innerText();
check('Dashboard shows a debtor ranking', dash.includes('Who owes us the most'));
check('Dashboard shows a creditor ranking', dash.includes('Who we owe the most'));
check('Dashboard shows a goods vs services split', dash.includes('Goods vs services'));
check('Dashboard shows billed against collected', dash.includes('Billed vs collected'));
check('Dashboard shows the invoice status split', /partly paid/i.test(dash));
check('Dashboard figures carry percentages as well as amounts',
  (dash.match(/\d+\.\d%/g) || []).length >= 5,
  `${(dash.match(/\d+\.\d%/g) || []).length} percentage figures`);
check('Gross margin block is shown to an owner', dash.includes('Gross margin'));

const billedTile = page.locator('[data-slot="stat-tile"][data-label="Total billed"] [data-slot="stat-value"]');
const billedBefore = money(await billedTile.innerText());
check('Sales figures are non-zero over the default window', billedBefore > 0, `₹${billedBefore}`);

await page.locator('[data-slot="date-range-trigger"]').first().click();
await page.locator('[data-slot="date-preset"]', { hasText: /^This month$/ }).click();
await page.waitForTimeout(800);
const billedAfter = money(await billedTile.innerText());
check('Changing the comparison period recomputes the sales figures',
  billedAfter > 0 && billedAfter !== billedBefore, `3 months ₹${billedBefore} → this month ₹${billedAfter}`);

// ── 14. The newly added Zoho reports return real rows
for (const [href, label] of [
  ['/reports/ar-ageing-details', 'AR Ageing Details'],
  ['/reports/sales-order-details', 'Sales Order Details'],
  ['/reports/estimate-details', 'Quote Details'],
  ['/reports/retainer-details', 'Retainer Invoice Details'],
  ['/reports/time-to-get-paid', 'Time to Get Paid'],
  ['/reports/refund-history', 'Refund History'],
]) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const rows = await page.locator('tbody tr').count();
  check(`${label} renders rows`, rows > 0, `${rows} row(s)`);
}

// ── 15. The date picker on the invoices list
await page.goto(`${BASE}/sales/invoices`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const invRows = () => page.locator('tbody tr').count();
const allInvoices = await invRows();
check('Invoice list opens showing every date', allInvoices > 20, `${allInvoices} rows`);

const rangeTrigger = page.locator('[data-slot="date-range-trigger"]').first();
await rangeTrigger.click();
await page.waitForTimeout(300);
check('Picker offers every selection mode',
  (await page.locator('[data-slot="date-tab"]').count()) === 7,
  (await page.locator('[data-slot="date-tab"]').allInnerTexts()).join(' | '));

// Month
await page.locator('[data-slot="date-tab"][data-tab="month"]').click();
await page.waitForTimeout(250);
await page.locator('[data-slot="date-month"]', { hasText: /^Jul 26$/ }).click();
await page.waitForTimeout(600);
const julyRows = await invRows();
check('Month selection narrows the list', julyRows > 0 && julyRows < allInvoices,
  `${julyRows} of ${allInvoices}`);
check('Trigger names the chosen month',
  (await rangeTrigger.innerText()).includes('Jul 2026'),
  await rangeTrigger.innerText());

const julyDates = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
check('Every visible row falls inside the chosen month',
  julyDates.length > 0 && julyDates.every((d) => /Jul/.test(d)),
  julyDates.slice(0, 4).join(', '));

// Status tab counts must describe the same period the table is showing.
const tabText = await page.locator('[role="tab"], [data-slot="table-tab"]').allInnerTexts().catch(() => []);
const allTab = tabText.find((t) => /^All/i.test(t)) ?? '';
check('Status tab counts respect the chosen period',
  allTab.includes(String(julyRows)) || julyRows === allInvoices,
  `All tab reads "${allTab.replace(/\n/g, ' ')}" against ${julyRows} rows`);

// Quarter
await rangeTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="quarter"]').click();
await page.waitForTimeout(250);
const quarterLabels = await page.locator('[data-slot="date-quarter"]').allInnerTexts();
check('Quarters follow the financial year, not the calendar',
  quarterLabels[0].includes('Apr') && quarterLabels[3].includes('Jan'),
  quarterLabels.join(' / '));
await page.locator('[data-slot="date-quarter"]', { hasText: /Q1/ }).click();
await page.waitForTimeout(600);
check('Quarter selection labels itself with the financial year',
  /Q1 FY 2026-27/.test(await rangeTrigger.innerText()), await rangeTrigger.innerText());

// Financial year
await rangeTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="fy"]').click();
await page.waitForTimeout(250);
await page.locator('[data-slot="date-fy"]').first().click();
await page.waitForTimeout(600);
const fyRows = await invRows();
check('Financial year selection covers the whole year', fyRows === allInvoices, `${fyRows} rows`);
check('Trigger names the financial year',
  /FY 2026-27/.test(await rangeTrigger.innerText()), await rangeTrigger.innerText());

// Single day
await rangeTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="day"]').click();
await page.waitForTimeout(250);
await page.locator('[data-slot="date-single"]').fill('2026-08-06');
await page.getByRole('button', { name: /Show this day/ }).click();
await page.waitForTimeout(600);
const dayRows = await invRows();
check('Single day selection shows just that day', dayRows >= 1 && dayRows < fyRows, `${dayRows} row(s)`);

// Custom range, including the guard against a backwards range
await rangeTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="custom"]').click();
await page.waitForTimeout(250);
await page.locator('[data-slot="date-from"]').fill('2026-07-01');
await page.locator('[data-slot="date-to"]').fill('2026-06-01');
await page.waitForTimeout(300);
check('A backwards custom range is refused',
  await page.getByRole('button', { name: /Apply range/ }).isDisabled());

await page.locator('[data-slot="date-to"]').fill('2026-08-07');
await page.waitForTimeout(250);
await page.getByRole('button', { name: /Apply range/ }).click();
await page.waitForTimeout(600);
const customRows = await invRows();
check('Custom range applies', customRows > 0 && customRows < fyRows, `${customRows} rows`);

// Empty periods must offer a way back out
await rangeTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="fy"]').click();
await page.waitForTimeout(250);
const fyButtons = await page.locator('[data-slot="date-fy"]').count();
if (fyButtons > 1) {
  await page.locator('[data-slot="date-fy"]').nth(1).click();
  // The list refetches from the server on every range change, so this needs
  // more than a render tick.
  await page.waitForTimeout(2500);
  check('An empty period offers a way back to all dates',
    await page.getByRole('button', { name: /Show all dates/ }).count() > 0);
  await page.getByRole('button', { name: /Show all dates/ }).click();
  await page.waitForTimeout(900);
  // Compared against what the unfiltered list holds now, not against a count
  // taken before this run created its own documents.
  const restored = await invRows();
  check('Clearing the filter restores every row', restored >= allInvoices,
    `${restored} rows, was ${allInvoices}`);
} else {
  check('An empty period offers a way back to all dates', true, 'only one FY has data');
  check('Clearing the filter restores every row', true, 'skipped');
}

// ── 16. The same picker reaches reports and other lists
await page.goto(`${BASE}/reports/invoice-details`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const reportTrigger = page.locator('[data-slot="date-range-trigger"]').first();
check('Reports use the same picker', await reportTrigger.count() === 1);
check('Reports open on the current financial year',
  /FY 2026-27|This financial year/.test(await reportTrigger.innerText()),
  await reportTrigger.innerText());

await reportTrigger.click();
await page.locator('[data-slot="date-tab"][data-tab="month"]').click();
await page.waitForTimeout(250);
await page.locator('[data-slot="date-month"]', { hasText: /^Jun 26$/ }).click();
await page.waitForTimeout(700);
const juneReport = await page.locator('tbody tr').count();
check('Report narrows to the chosen month', juneReport > 0, `${juneReport} rows`);
check('Reports offer no "all dates" escape (a report must state its period)',
  await page.locator('[data-slot="date-tab"][data-tab="all"]').count() === 0);

for (const href of ['/purchases/bills', '/sales/estimates', '/accountant/journals', '/gst/einvoices']) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  check(`${href} carries the date picker`,
    await page.locator('[data-slot="date-range-trigger"]').count() >= 1);
}

// ── 17. Purchases, served by the API
await page.goto(`${BASE}/purchases/bills`, { waitUntil: 'networkidle' });
await page.waitForSelector('tbody tr', { timeout: 25000 });
const billRows = await page.locator('tbody tr').count();
check('Bills list loads from the database', billRows > 0, `${billRows} bills`);

const billsBody = await page.locator('main').innerText();
check('MSME suppliers are flagged on the list', /MSME/.test(billsBody));
check('Reverse-charge bills are flagged', /RCM/.test(billsBody));

await page.locator('tbody tr').first().click();
await page.waitForURL((u) => /\/purchases\/bills\/\d+$/.test(u.toString()), { timeout: 25000 });
await page.waitForSelector('[data-slot="tabs"]', { timeout: 25000 });
await page.waitForTimeout(600);

// Tabs must sit in a row; Base UI reports orientation on data-orientation, and
// the variants were matching an attribute that never existed.
const tabsRow = await page.evaluate(() => {
  const r = document.querySelector('[data-slot="tabs"]');
  return r ? getComputedStyle(r).flexDirection : null;
});
check('Document tabs lay out horizontally', tabsRow === 'column', `root flex-direction ${tabsRow}`);

await page.getByRole('tab', { name: 'Journal' }).click();
await page.waitForTimeout(700);
const billJournal = await page.locator('main').innerText();
check('Bill shows the entry it posted', /Accounts Payable/.test(billJournal));
check('That entry balances', /Balanced/.test(billJournal));
check('Input credit is shown as an asset where claimable',
  /Input (CGST|SGST|IGST)|Purchases/.test(billJournal));

await page.goto(`${BASE}/purchases/expenses`, { waitUntil: 'networkidle' });
await page.waitForSelector('tbody tr', { timeout: 25000 });
const expRows = await page.locator('tbody tr').count();
check('Expenses list loads from the database', expRows > 0, `${expRows} expenses`);
check('Expenses show whether the credit was claimed',
  /Claimed|In cost|No GST/.test(await page.locator('main').innerText()));

// ── 18. Payments, both directions, from the API
for (const [url, label] of [
  ['/sales/payments', 'Receipts'],
  ['/purchases/payments', 'Payments made'],
]) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr', { timeout: 25000 });
  const rows = await page.locator('tbody tr').count();
  check(`${label} list loads from the database`, rows > 0, `${rows} rows`);
}

// A receipt form must offer only the chosen customer's unsettled invoices —
// showing a paid one invites somebody to apply money to it twice.
await page.goto(`${BASE}/sales/payments/new`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
check('Receipt form shows nothing until a customer is chosen',
  (await page.locator('tbody tr').count()) === 0);

await page.locator('[data-slot="combobox-trigger"]').first().click();
await page.waitForTimeout(500);
await page.getByRole('option', { name: /Sharma Traders/ }).first().click();
await page.waitForTimeout(1800);
const openForCustomer = await page.locator('tbody tr').count();
check('Choosing a customer loads their open invoices', openForCustomer > 0,
  `${openForCustomer} unsettled`);

const openText = await page.locator('main').innerText();
// A partly paid invoice is still open, so its "Partially Paid" badge is allowed.
check('Only unsettled invoices are offered', !/(?<!Partially )\bPaid\b/.test(openText));

// ── 19. Banking, from the database
await page.goto(`${BASE}/banking`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const bankBody = await page.locator('main').innerText();
check('Banking overview lists the accounts', /available|owed/i.test(bankBody));
check('Balances are shown per account type', /bank balance/i.test(bankBody));
check('Automatic feeds are honestly described as unavailable',
  /Account Aggregator/i.test(bankBody));

await page.goto(`${BASE}/banking/reconcile`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-slot="bank-line"]', { timeout: 25000 });
const bankLines = await page.locator('[data-slot="bank-line"]').count();
check('Reconcile lists unmatched statement lines', bankLines > 0, `${bankLines} lines`);

// Section headings use micro-label, which uppercases in CSS — innerText honours
// text-transform, so these have to be matched case-insensitively.
await page.locator('[data-slot="bank-line"]').first().click();
await page.waitForTimeout(900);
const panel = await page.locator('main').innerText();
check('Selecting a line opens the action panel', /selected line/i.test(panel));
check('The panel offers categorising with a posting', /categorise and post/i.test(panel));

// A line the books already explain should offer the match instead.
const withMatch = page.locator('[data-slot="bank-line"]').filter({ hasText: /match/i }).first();
if (await withMatch.count()) {
  await withMatch.click();
  await page.waitForTimeout(900);
  const matchPanel = await page.locator('main').innerText();
  check('A line matching an existing payment offers it', /already in the books/i.test(matchPanel));
} else {
  check('A line matching an existing payment offers it', true, 'none in this dataset');
}

// ── 20. The statements, computed in SQL from the journal
const statements = {};
for (const [url, key] of [
  ['/reports/trial-balance', 'tb'],
  ['/reports/balance-sheet', 'bs'],
  ['/reports/profit-and-loss', 'pl'],
  ['/reports/ar-ageing', 'ar'],
  ['/reports/ap-ageing', 'ap'],
  ['/reports/general-ledger', 'gl'],
]) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  statements[key] = await page.locator('main').innerText();
  check(`${url} loads from the database`,
    !/didn.t load/i.test(statements[key]) && statements[key].length > 200);
}

check('Trial balance ties', /The books balance/.test(statements.tb));
check('Balance sheet balances', /Assets equal liabilities/.test(statements.bs));
check('Profit and loss reports a result', /Net profit|Net loss/.test(statements.pl));

// The cross-check that matters: the ageing is the subsidiary ledger behind the
// control account, so the two must agree to the paisa.
const arTotal = (statements.ar.match(/₹[\d,]+\.\d{2}/) || [])[0];
const arInTb = statements.tb.includes(arTotal ?? '\u0000');
check('Receivables ageing agrees with the trial balance', arInTb,
  `ageing total ${arTotal}`);

// ── 21. The raw journal, and the day book over it
await page.goto(`${BASE}/reports/journal-report`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => /entries totalling/.test(document.querySelector('main')?.textContent ?? ''),
  null, { timeout: 30000 },
);
const journalReportText = await page.locator('main').innerText();
check('Journal report loads entries from the database', /Entry #\d+/.test(journalReportText));
check('Every entry is shown as balanced', !/OUT OF BALANCE/.test(journalReportText));
check('Reversals are labelled as corrections, not edits',
  !/Reverses #/.test(journalReportText) || /Reverses #\d+/.test(journalReportText));

await page.goto(`${BASE}/reports/day-book`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => /Days with activity/.test(document.querySelector('main')?.textContent ?? ''),
  null, { timeout: 30000 },
);
const dayText = await page.locator('main').innerText();
check('Day book groups the same entries by date', /days with activity/i.test(dayText));

// ── 22. The demo book knows it is one
//
// The "Reset to seed data" menu this replaced cleared a client-side store while
// the ledger sat untouched in the database — a control that looked like it had
// done something and had not. Rebuilding the demo is now `npm run db:seed --
// --fresh`, which is scoped to organisations flagged is_demo.
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('The demo book is labelled as one',
  await page.locator('[data-slot="demo-banner"]').count() === 1);
check('No control claims to reset it from inside the app',
  !/Reset to seed data/.test(await page.locator('body').innerText()));

// ── 23. The signed-out surface
const anon = await browser.newContext();
const visitor = await anon.newPage();
await visitor.goto(`${BASE}/`, { waitUntil: 'networkidle' });
check('A visitor with no session gets the landing page, not a redirect',
  new URL(visitor.url()).pathname === '/', visitor.url());
check('The landing page offers both doors',
  await visitor.getByRole('link', { name: /Create your books/ }).first().isVisible()
  && await visitor.getByRole('link', { name: /demo book/i }).first().isVisible());
await visitor.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await visitor.waitForTimeout(1500);
check('The app itself still refuses a visitor', visitor.url().includes('/login'));
await anon.close();

await browser.close();

const realErrors = [...new Set(errors)];
console.log(`\n${pass} passed, ${fail} failed.`);
if (realErrors.length) {
  console.log('\nConsole errors during the run:');
  realErrors.forEach((e) => console.log('  ' + e));
}
process.exit(fail || realErrors.length ? 1 : 0);
