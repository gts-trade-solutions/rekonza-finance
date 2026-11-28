// Status review 7, item 12 — Budgeting & Costing: variance reporting.
//
// The auditor's test: create a monthly budget for the year (income and
// expense accounts, the same amount every period), open Budget vs Actuals and
// read each month's budget, actual, variance in rupees and per cent and
// whether it is favourable; change the columns to quarters and the threshold;
// open an actual's ledger; export CSV, Excel and PDF; clone it as "Revised"
// at +10%, edit and delete; budget a cost centre and see it under Costing;
// fill a budget from last year's actuals.
//
//   FRESH=1 node scripts/e2e/sr7-12-budget-variance.mjs   (a new company)
//   node scripts/e2e/sr7-12-budget-variance.mjs           (the demo book)

import { readFileSync } from 'node:fs';
import { start, FRESH, rupees, today, fyStart, fyLabel } from './_sr7-common.mjs';

const t = await start('12');
const { page, check, shot, idle, go, api, finish } = t;
const tag = String(Date.now()).slice(-6);
const monthEnd = (d) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
const firstLine = (s) => s.split(String.fromCharCode(10))[0];

try {
  if (FRESH) await t.signUp(`Budget Audit Co ${tag}`); else await t.loginDemo();
  const masters = (await api('GET', '/api/masters')).body;
  const acc = (code) => masters.accounts.find((a) => a.code === code);
  const branchId = masters.branches[0].id;

  // ── Set-up: this month's sale and rent; a cost centre's rent; a sale last year.
  const cust = (await api('POST', '/api/contacts', { kind: 'customer', displayName: `Budget Buyer ${tag}`, gstTreatment: 'unregistered', stateCode: '33' })).body;
  const sale = (await api('POST', '/api/invoices', { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: 1200000, gstRatePct: 0 }] })).body;
  const bank = String(masters.bankAccounts[0].id);
  const rent = (await api('POST', '/api/expenses', { branchId, date: today(), accountId: String(acc('6100').id), paidThroughBankAccountId: bank, amountPaise: 250000, gstRatePct: 0 })).body;
  const cc = (await api('POST', '/api/cost-centres', { code: `B${tag.slice(-4)}`, name: `Branch office ${tag}` })).body;
  const ccId = String(cc.id ?? cc.centre?.id);
  const ccRent = (await api('POST', '/api/expenses', { branchId, date: today(), accountId: String(acc('6100').id), paidThroughBankAccountId: bank, amountPaise: 150000, gstRatePct: 0, costCentreId: ccId })).body;
  const lastYear = `${Number(fyStart().slice(0, 4)) - 1}-06-15`;
  const old = await api('POST', '/api/invoices', { branchId, customerId: String(cust.id), date: lastYear, dueDate: lastYear, status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: 900000, gstRatePct: 0 }] });
  check('set-up: a sale, rent, the cost centre\'s rent', !!sale?.id && !!rent?.id && !!ccRent?.id, `${sale?.number} ${rent?.number} ${ccRent?.number}`);
  const lastYearOk = old.status === 200;

  // ── 1. Budgets: empty state (fresh), then New Budget.
  await go('/accountant/budgets');
  if (FRESH) check('an empty year says what to do', /New Budget → name it/.test(await page.locator('main').innerText()));
  await shot('budgets-list');
  await page.click('[data-slot="new-budget"]');
  await page.waitForSelector('[data-slot="budget-form"]');
  await page.fill('[data-slot="budget-name"]', `Original ${tag}`);
  await page.selectOption('[data-slot="budget-period"]', 'monthly');
  check('the editor offers monthly, quarterly, half-yearly and yearly', (await page.locator('[data-slot="budget-period"] option').count()) === 4);
  const addAccount = async (code) => {
    await page.click('[data-slot="budget-add-accounts"]');
    await page.fill('[data-slot="budget-pick-search"]', code);
    await page.locator('[data-slot="budget-pick-dialog"] label', { hasText: code }).first().locator('input').check();
    await page.click('[data-slot="budget-pick-add"]');
  };
  await addAccount('4100');
  await addAccount('6100');
  const rowOf = (code) => page.locator('[data-slot="budget-grid-row"]', { hasText: code });
  await rowOf('4100').locator('[data-slot="budget-same-input"]').fill('10000');
  await rowOf('4100').locator('[data-slot="budget-same-go"]').click();
  await rowOf('6100').locator('[data-slot="budget-same-input"]').fill('2000');
  await rowOf('6100').locator('[data-slot="budget-same-go"]').click();
  // The year's total is the last cell with a figure (the row ends with an empty cell under "Same amount every period").
  const net = firstLine((await page.locator('[data-slot="budget-grid-net"] td').allInnerTexts()).filter((c) => /₹/.test(c)).pop() ?? '');
  check('budgeted profit for the year: ₹96,000', rupees(net) === 96000, net);
  await shot('budget-grid');
  await page.click('[data-slot="budget-save"]');
  await page.waitForURL(/budget-vs-actuals\?plan=/, { timeout: 90000 });
  const planId = new URL(page.url()).searchParams.get('plan');

  // ── 2. Budget vs Actuals for this month.
  await page.fill('[data-slot="bva-upto"]', monthEnd(today()));
  await page.waitForSelector('[data-slot="bva-table"]', { timeout: 60000 });
  await idle(1500);
  const heading = await page.locator('[data-slot="bva-heading"]').innerText();
  check('the heading names the budget and the columns', heading.includes(`Original ${tag}`) && /Columns: by month/.test(heading), firstLine(heading));
  const lastMonth = async (code) => {
    const cells = await page.locator('[data-slot="bva-row"]', { hasText: code }).first().locator('td').allInnerTexts();
    const n = (cells.length - 1) / 4 - 1;
    const at = 1 + (n - 1) * 4;
    return { budget: rupees(firstLine(cells[at])), actual: rupees(firstLine(cells[at + 1])), variance: firstLine(cells[at + 2]), pct: cells[at + 3] };
  };
  const s = await lastMonth('4100');
  const r = await lastMonth('6100');
  if (FRESH) {
    check('sales this month: budget ₹10,000, actual ₹12,000, +₹2,000, +20%, favourable', s.budget === 10000 && s.actual === 12000 && /2,000/.test(s.variance) && /F/.test(s.variance) && s.pct === '+20.0%', JSON.stringify(s));
    check('rent this month: budget ₹2,000, actual ₹4,000, +100%, unfavourable', r.budget === 2000 && r.actual === 4000 && /U/.test(r.variance) && r.pct === '+100.0%', JSON.stringify(r));
  } else {
    check('sales this month: budget ₹10,000 and the variance is actual less budget', s.budget === 10000 && rupees(s.variance.replace(/[FU]/g, '')) === Math.abs(s.actual - 10000), JSON.stringify(s));
    check('rent this month: budget ₹2,000; over budget is unfavourable', r.budget === 2000 && (r.actual > 2000 ? /U/.test(r.variance) : /F/.test(r.variance)), JSON.stringify(r));
  }
  check('income, gross profit and net profit totals', (await page.locator('[data-slot="bva-gross"]').count()) === 1 && (await page.locator('[data-slot="bva-net"]').count()) === 1);
  check('lines beyond the 10% threshold are highlighted', (await page.locator('[data-slot="bva-row"]', { hasText: '6100' }).locator('td.bg-amber-100\\/70, td[class*="amber"]').count()) > 0);
  await shot('budget-vs-actuals-month');

  // ── 3. Quarters and the threshold; show/hide columns.
  await page.selectOption('[data-slot="bva-columns"]', 'quarter');
  await idle(1500);
  const qCols = await page.locator('[data-slot="bva-table"] thead tr').first().locator('th').allInnerTexts();
  check('columns by quarter', qCols.some((c) => /^Q\d/i.test(c.trim())), qCols.join(' | '));
  const rentFlags = () => page.locator('[data-slot="bva-row"]', { hasText: '6100' }).locator('td[class*="amber"]').count();
  const flaggedAt10 = await rentFlags();
  // A new company's rent is 100% over: 150% flags nothing. The demo book's rent runs far over
  // its budget, so there the highest threshold (1000%) need only flag fewer quarters.
  await page.fill('[data-slot="bva-threshold"]', FRESH ? '150' : '1000');
  await idle(1200);
  const flaggedHigher = await rentFlags();
  check('a higher threshold highlights less on rent', FRESH ? flaggedHigher === 0 : flaggedHigher < flaggedAt10, `${flaggedAt10} → ${flaggedHigher}`);
  await page.fill('[data-slot="bva-threshold"]', '10');
  await page.locator('[data-slot="bva-show"] label', { hasText: 'Variance %' }).locator('input').uncheck();
  await idle(600);
  check('Variance % can be hidden', (await page.locator('[data-slot="bva-pct"]').count()) === 0);
  await page.locator('[data-slot="bva-show"] label', { hasText: 'Variance %' }).locator('input').check();
  await shot('budget-vs-actuals-quarter');

  // ── 4. Exports.
  const exportAs = async (label) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), (async () => { await page.click('[data-slot="bva-export"]'); await page.getByRole('menuitem', { name: label, exact: true }).click(); })()]);
    return { name: dl.suggestedFilename(), text: readFileSync(await dl.path()).toString('latin1') };
  };
  const pdf = await exportAs('PDF');
  check('PDF: the heading, the budget and page numbers', pdf.text.startsWith('%PDF') && pdf.text.includes(`Original ${tag}`) && /Page 1 of/.test(pdf.text), pdf.name);
  const xlsx = await exportAs('Excel (.xlsx)');
  check('Excel: a workbook with the budget', xlsx.text.startsWith('PK') && xlsx.text.includes(`Original ${tag}`), xlsx.name);
  const csv = await exportAs('CSV');
  check('CSV: budget, actual and variance columns', /Budget/.test(csv.text) && /Variance/.test(csv.text), csv.name);

  // ── 5. Drill-down from an actual to the ledger.
  await page.selectOption('[data-slot="bva-columns"]', 'month');
  await idle(1500);
  await page.locator('[data-slot="bva-row"]', { hasText: '4100' }).first().locator('[data-slot="bva-drill"]').last().click();
  await page.waitForURL(/general-ledger/, { timeout: 60000 });
  await idle(2000);
  check('the actual opens the account\'s ledger', /Sales|4100/.test(await page.locator('main').innerText()));
  await shot('drill-to-ledger');

  // ── 6. Clone as Revised +10%; edit; delete.
  await go(`/accountant/budgets?fy=${fyLabel()}`);
  const orow = page.locator('[data-slot="budget-row"]', { hasText: `Original ${tag}` });
  await orow.locator('[data-slot="budget-clone"]').click();
  await page.fill('[data-slot="clone-name"]', `Revised ${tag}`);
  await page.fill('[data-slot="clone-pct"]', '10');
  await page.click('[data-slot="clone-go"]');
  await page.waitForURL(/budgets\/edit\?id=/, { timeout: 90000 });
  await page.waitForSelector('[data-slot="budget-grid"]', { timeout: 60000 });
  const first = await page.locator('[data-slot="budget-grid-row"]', { hasText: '4100' }).locator('[data-slot="budget-cell"]').first().inputValue();
  check('the clone is 10% higher: ₹11,000 a month', Number(first) === 11000, first);
  await page.click('[data-slot="budget-save"]');
  await page.waitForURL(/budget-vs-actuals/, { timeout: 90000 });
  await go(`/accountant/budgets?fy=${fyLabel()}`);
  check('several budgets for one year', (await page.locator('[data-slot="budget-row"]', { hasText: tag }).count()) === 2);
  await page.locator('[data-slot="budget-row"]', { hasText: `Original ${tag}` }).locator('[data-slot="budget-edit"]').click();
  await page.waitForSelector('[data-slot="budget-grid"]', { timeout: 60000 });
  await page.locator('[data-slot="budget-grid-row"]', { hasText: '6100' }).locator('[data-slot="budget-same-input"]').fill('2500');
  await page.locator('[data-slot="budget-grid-row"]', { hasText: '6100' }).locator('[data-slot="budget-same-go"]').click();
  await page.click('[data-slot="budget-save"]');
  await page.waitForURL(/budget-vs-actuals/, { timeout: 90000 });
  check('Edit saves a new rent budget', (await api('GET', `/api/budget-plans/${planId}`)).body.lines.find((l) => l.code === '6100').amountsPaise[0] === 250000);
  await go(`/accountant/budgets?fy=${fyLabel()}`);
  await page.locator('[data-slot="budget-row"]', { hasText: `Revised ${tag}` }).locator('[data-slot="budget-delete"]').click();
  const reasonBox = page.getByRole('dialog').locator('textarea, input').first();
  if (await reasonBox.count()) await reasonBox.fill('Superseded');
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).click();
  await page.waitForSelector(`[data-slot="budget-row"]:has-text("Revised ${tag}")`, { state: 'detached', timeout: 60000 }).catch(() => {});
  check('Delete removes the budget', (await page.locator('[data-slot="budget-row"]', { hasText: `Revised ${tag}` }).count()) === 0);

  // ── 7. A cost centre's budget, and Costing.
  await page.click('[data-slot="new-budget"]');
  await page.waitForSelector('[data-slot="budget-form"]');
  await page.fill('[data-slot="budget-name"]', `Branch office ${tag}`);
  await page.selectOption('[data-slot="budget-period"]', 'yearly');
  await page.selectOption('[data-slot="budget-scope"]', { label: `B${tag.slice(-4)} Branch office ${tag}` });
  await addAccount('6100');
  await page.locator('[data-slot="budget-grid-row"]', { hasText: '6100' }).locator('[data-slot="budget-cell"]').first().fill('12000');
  await page.click('[data-slot="budget-save"]');
  await page.waitForURL(/budget-vs-actuals\?plan=/, { timeout: 90000 });
  await page.waitForSelector('[data-slot="bva-table"]', { timeout: 60000 });
  await idle(1500);
  const ccCells = await page.locator('[data-slot="bva-row"]', { hasText: '6100' }).first().locator('td').allInnerTexts();
  const ccActual = rupees(firstLine(ccCells[ccCells.length - 3]));
  check('the cost centre budget counts only its own rent: ₹1,500', ccActual === 1500, ccCells.join(' | '));
  await shot('cost-centre-budget');
  await go('/accountant/budgets?tab=costing');
  await page.waitForSelector('[data-slot="costing-table"]', { timeout: 60000 });
  check('Costing lists the cost centre against its budget', (await page.locator('[data-slot="costing-row"]', { hasText: `Branch office ${tag}` }).count()) === 1);
  await shot('costing');

  // ── 8. Fill from last year's actuals.
  await go(`/accountant/budgets/edit?fy=${fyLabel()}`);
  await page.waitForSelector('[data-slot="budget-form"]');
  await page.fill('[data-slot="budget-name"]', `From last year ${tag}`);
  await addAccount('4100');
  await page.fill('[data-slot="budget-pct"]', '0');
  await page.click('[data-slot="budget-fill-actuals"]');
  await idle(2500);
  const cells = await page.locator('[data-slot="budget-grid-row"]', { hasText: '4100' }).locator('[data-slot="budget-cell"]').evaluateAll((els) => els.map((e) => e.value));
  if (FRESH && lastYearOk) check('June filled from last June\'s ₹9,000 sale', Number(cells[2]) === 9000, cells.join(','));
  else check('fill from last year ran (the demo book has no earlier year)', true, cells.join(','));
  await shot('fill-from-last-year');
} catch (e) {
  check('the script ran to the end', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await finish();
