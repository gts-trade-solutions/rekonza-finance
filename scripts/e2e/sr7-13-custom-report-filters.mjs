// Status review 7, item 13 — Reporting: custom report filters.
//
// The auditor's test: open the financial reports, use Customize Report to
// filter by customer, cost centre and accounts, add month columns and a
// comparison, save it as a custom report, find it under Reports → Custom
// Reports, edit and delete it; a filtered balance sheet says it cannot
// balance; the ledger and account transactions narrow too; exports carry the
// filters in their heading.
//
//   FRESH=1 node scripts/e2e/sr7-13-custom-report-filters.mjs   (a new company)
//   node scripts/e2e/sr7-13-custom-report-filters.mjs           (the demo book)
//
// The set-up records (two customers, a cost centre, two invoices) are made
// through the app's own API from the signed-in page; every report step is
// done on the screens.

import { readFileSync } from 'node:fs';
import { start, FRESH, rupees, today, fyStart } from './_sr7-common.mjs';

const t = start('13');
const { page, check, shot, idle, go, api, finish } = await t;
const tag = String(Date.now()).slice(-6);

try {
  if (FRESH) await (await t).signUp(`Filter Audit Co ${tag}`);
  else await (await t).loginDemo();

  // ── Set-up: two customers, a cost centre, two invoices this year.
  const masters = (await api('GET', '/api/masters')).body;
  const branchId = masters.branches[0].id;
  const apexName = `Apex Motors ${tag}`, bharatName = `Bharat Garage ${tag}`;
  const mk = async (displayName) => (await api('POST', '/api/contacts', { kind: 'customer', displayName, gstTreatment: 'unregistered', stateCode: '33' })).body;
  const apex = await mk(apexName); const bharat = await mk(bharatName);
  const cc = (await api('POST', '/api/cost-centres', { code: `S${tag.slice(-4)}`, name: `Showroom ${tag}` })).body;
  check('set-up: customers and a cost centre made', !!apex?.id && !!bharat?.id && !!(cc?.id ?? cc?.centre?.id), JSON.stringify(cc).slice(0, 80));
  const ccId = String(cc.id ?? cc.centre?.id);
  const d1 = today() > `${fyStart().slice(0, 4)}-04-15` ? `${fyStart().slice(0, 4)}-04-15` : today();
  const inv = async (customerId, rupeesAmt, extra = {}) => (await api('POST', '/api/invoices', {
    branchId, customerId: String(customerId), date: d1, dueDate: d1, status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: rupeesAmt * 100, gstRatePct: 0 }], ...extra,
  })).body;
  const i1 = await inv(apex.id, 10000, { costCentreId: ccId });
  const i2 = await inv(bharat.id, 5000);
  check('set-up: two invoices posted', !!i1?.id && !!i2?.id, `${i1?.number ?? i1?.error} / ${i2?.number ?? i2?.error}`);
  // A project, on an expense of ₹3,000; a reporting tag, on Bharat's invoice.
  const proj = (await api('POST', '/api/projects', { customerId: String(apex.id), name: `Fleet contract ${tag}`, billingMethod: 'fixed', fixedAmountPaise: 5000000 })).body;
  const expenseAcc = masters.accounts.find((a) => a.code === '6300') ?? masters.accounts.find((a) => a.type === 'expense');
  const exp = (await api('POST', '/api/expenses', { branchId, date: d1, accountId: String(expenseAcc.id), paidThroughBankAccountId: String(masters.bankAccounts[0].id), amountPaise: 300000, gstRatePct: 0, projectId: String(proj.id) })).body;
  await api('POST', '/api/reporting-tags', { action: 'save', name: `Region ${tag}`, values: ['South', 'North'] });
  const tagRow = (await api('GET', '/api/reporting-tags')).body.tags.find((x) => x.name === `Region ${tag}`);
  const north = tagRow.options.find((o) => o.value === 'North');
  const assigned = await api('POST', '/api/reporting-tags', { action: 'assign', entity: 'invoice', id: String(i2.id), values: { [tagRow.id]: north.id } });
  check('set-up: a project expense and a tagged invoice', !!proj?.id && !!exp?.id && assigned.status === 200, `${JSON.stringify(exp).slice(0, 80)} ${assigned.status}`);

  const waitText = (sel, text) => page.waitForFunction(([s, t]) => (document.querySelector(s)?.textContent ?? '').includes(t), [sel, text], { timeout: 90000 }).catch(() => {});
  // ── 1. The plain profit and loss, then Customize Report.
  await go('/reports/profit-and-loss');
  await page.waitForSelector('[data-slot="customize-report"]');
  await shot('pl-plain');
  await page.click('[data-slot="customize-report"]');
  await page.waitForSelector('[data-slot="customize-panel"]');
  await page.selectOption('[data-slot="customize-report-by"]', 'month');
  await page.click('[data-slot="customize-tab-filters"]');
  await page.locator('[data-slot="customize-contacts"] input').first().fill(apexName);
  await page.locator('[data-slot="customize-contacts"] label', { hasText: apexName }).locator('input').check();
  await shot('panel-filters');
  await page.click('[data-slot="customize-apply"]');
  await page.waitForSelector('[data-slot="custom-report-applied"]', { timeout: 30000 });
  await idle(800);
  let applied = await page.locator('[data-slot="custom-report-applied"]').innerText();
  check('heading states the customer filter', applied.includes(`Customer / vendor: ${apexName}`), applied.replace(/\n/g, ' | '));
  check('heading states report by month', /Report by: month/.test(applied));
  const cols = await page.locator('[data-slot="custom-column"]').allInnerTexts();
  check('month columns from April', cols.length >= 1 && /^apr/i.test(cols[0].trim()), cols.join(', '));
  const salesRow = page.locator('[data-slot="rpt-account"]', { hasText: '4100' }).first();
  const salesCells = await salesRow.locator('td').allInnerTexts();
  const salesTotal = salesCells.slice(2).reduce((s, c) => s + rupees(c.split('\n')[0]), 0);
  check('sales filtered to the customer: ₹10,000', salesTotal === 10000, salesCells.join(' | '));
  await shot('pl-customer-by-month');

  // ── 2. Cost centre, total with last year beside it.
  await page.click('text=Edit filters');
  await page.waitForSelector('[data-slot="customize-panel"]');
  await page.selectOption('[data-slot="customize-report-by"]', 'total');
  await page.selectOption('[data-slot="customize-compare"]', 'previous_year');
  await page.click('[data-slot="customize-tab-filters"]');
  await page.locator('[data-slot="customize-contacts"] label', { hasText: apexName }).locator('input').uncheck();
  await page.locator('[data-slot="customize-cost-centres"] input').first().fill(`Showroom ${tag}`);
  await page.locator('[data-slot="customize-cost-centres"] label', { hasText: `Showroom ${tag}` }).locator('input').check();
  await page.click('[data-slot="customize-tab-columns"]');
  await page.check('[data-slot="customize-col-pct"]');
  await page.click('[data-slot="customize-apply"]');
  await waitText('[data-slot="custom-report-applied"]', `Cost centre: Showroom ${tag}`);
  await idle(800);
  applied = await page.locator('[data-slot="custom-report-applied"]').innerText();
  check('heading states the cost centre and the comparison', applied.includes(`Cost centre: Showroom ${tag}`) && /Compared with: 1 previous year/.test(applied), applied.replace(/\n/g, ' | '));
  const cols2 = await page.locator('[data-slot="custom-column"]').count();
  check('two columns: this year and last year', cols2 === 2, String(cols2));
  const ccSales = rupees((await page.locator('[data-slot="rpt-account"]', { hasText: '4100' }).first().locator('td').nth(2).innerText()).split('\n')[0]);
  check('sales of the cost centre: ₹10,000 (Bharat\'s invoice has none)', ccSales === 10000, String(ccSales));
  await shot('pl-cost-centre-compare');

  // ── 2b. Project and reporting tag filters.
  // Clear this run's project, tag and cost centre, then tick the one asked for (matched by both its text and its group).
  const runWith = async (slot, text, group = '', expect = '') => {
    await page.click('text=Edit filters');
    await page.waitForSelector('[data-slot="customize-panel"]');
    await page.selectOption('[data-slot="customize-compare"]', 'none');
    await page.click('[data-slot="customize-tab-filters"]');
    const pick = (s2, t2, g2 = '') => { let l = page.locator(`[data-slot="${s2}"] label`).filter({ hasText: t2 }); if (g2) l = l.filter({ hasText: g2 }); return l.first().locator('input'); };
    await pick('customize-cost-centres', `Showroom ${tag}`).uncheck();
    await pick('customize-projects', `Fleet contract ${tag}`).uncheck();
    await pick('customize-tags', 'North', `Region ${tag}`).uncheck();
    await pick(slot, text, group).check();
    await page.click('[data-slot="customize-apply"]');
    if (expect) await waitText('[data-slot="custom-report-applied"]', expect);
    await idle(1200);
  };
  await runWith('customize-projects', `Fleet contract ${tag}`, '', `Project: Fleet contract ${tag}`);
  applied = await page.locator('[data-slot="custom-report-applied"]').innerText();
  const firstLine = (t) => t.split(String.fromCharCode(10))[0];
  const oneLine = (t) => t.split(String.fromCharCode(10)).join(' | ');
  const projExp = rupees(firstLine(await page.locator('[data-slot="rpt-account"]', { hasText: expenseAcc.code }).first().locator('td').nth(2).innerText()));
  check('project filter: the project expense of ₹3,000', applied.includes(`Project: Fleet contract ${tag}`) && projExp === 3000, `${projExp} | ${oneLine(applied)}`);
  await shot('pl-project');
  await runWith('customize-tags', 'North', `Region ${tag}`, `Reporting tag: Region ${tag} = North`);
  applied = await page.locator('[data-slot="custom-report-applied"]').innerText();
  const tagSales = rupees(firstLine(await page.locator('[data-slot="rpt-account"]', { hasText: '4100' }).first().locator('td').nth(2).innerText()));
  check('reporting tag filter: Bharat invoice of ₹5,000 tagged North', applied.includes(`Reporting tag: Region ${tag} = North`) && tagSales === 5000, `${tagSales} | ${oneLine(applied)}`);
  await shot('pl-tag');
  // Back to the cost centre for the exports.
  await runWith('customize-cost-centres', `Showroom ${tag}`, '', `Cost centre: Showroom ${tag}`);

  // ── 3. Exports carry the filters: Excel and PDF.
  const exportAs = async (label) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), (async () => {
      await page.click('[data-slot="report-export"]');
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    })()]);
    const file = await dl.path();
    return { name: dl.suggestedFilename(), bytes: readFileSync(file) };
  };
  const pdf = await exportAs('PDF');
  const pdfText = pdf.bytes.toString('latin1');
  check('PDF export: a real PDF with the filters in its heading', pdfText.startsWith('%PDF') && pdfText.includes(`Cost centre: Showroom ${tag}`) && /Page 1 of/.test(pdfText), pdf.name);
  const xlsx = await exportAs('Excel (.xlsx)');
  const xText = xlsx.bytes.toString('latin1');
  check('Excel export: an XLSX workbook with the filters', xText.startsWith('PK') && xText.includes(`Showroom ${tag}`), xlsx.name);

  // ── 4. Save as custom report, shared; find it, edit it, open it.
  await page.click('text=Edit filters');
  await page.waitForSelector('[data-slot="customize-panel"]');
  const reportName = `Showroom P&L ${tag}`;
  await page.fill('[data-slot="customize-save-name"]', reportName);
  await page.check('[data-slot="customize-save-shared"]');
  await page.click('[data-slot="customize-save-go"]');
  await page.waitForSelector('text=Saved as custom report', { timeout: 90000 });
  await idle(600);
  await go('/reports');
  check('Reports Center links to Custom Reports', (await page.locator('[data-slot="open-custom-reports"]').count()) === 1);
  await page.click('[data-slot="open-custom-reports"]');
  await page.waitForSelector('[data-slot="custom-reports-list"]');
  const row = page.locator('[data-slot="custom-report-row"]', { hasText: reportName });
  check('the saved report is listed, shared', (await row.count()) === 1 && /Shared/.test(await row.innerText()));
  await shot('custom-reports-list');
  await row.locator('[data-slot="custom-report-edit"]').click();
  await page.fill('[data-slot="custom-report-name"]', `${reportName} (audit)`);
  await page.click('[data-slot="custom-report-save"]');
  // A book that keeps a reason with every change asks for one first (answered by the helper).
  await page.waitForSelector(`[data-slot="custom-report-row"]:has-text("${reportName} (audit)")`, { timeout: 30000 }).catch(() => {});
  const renamed = page.locator('[data-slot="custom-report-row"]', { hasText: `${reportName} (audit)` });
  check('Edit renames it', (await renamed.count()) === 1);
  await renamed.locator('[data-slot="custom-report-open"]').click();
  await page.waitForSelector('[data-slot="custom-report-applied"]', { timeout: 30000 });
  await idle(800);
  check('Open runs it with its filters', (await page.locator('[data-slot="custom-report-applied"]').innerText()).includes(`Cost centre: Showroom ${tag}`));
  check('the heading names the saved report', (await page.locator('[data-slot="custom-report-heading"]').innerText()).includes(`${reportName} (audit)`));
  await shot('custom-report-opened');

  // ── 5. Balance sheet filtered by a customer: says it cannot balance.
  await go('/reports/balance-sheet');
  await page.click('[data-slot="customize-report"]');
  await page.click('[data-slot="customize-tab-filters"]');
  await page.locator('[data-slot="customize-contacts"] input').first().fill(apexName);
  await page.locator('[data-slot="customize-contacts"] label', { hasText: apexName }).locator('input').check();
  await page.click('[data-slot="customize-apply"]');
  await page.waitForSelector('[data-slot="custom-cannot-balance"]', { timeout: 30000 });
  check('a filtered balance sheet says plainly it does not balance', /does not balance and is not meant to/.test(await page.locator('[data-slot="custom-cannot-balance"]').innerText()));
  const ar = rupees((await page.locator('[data-slot="rpt-account"]', { hasText: '1100' }).first().locator('td').nth(2).innerText()));
  check('Apex owes ₹10,000 on the filtered balance sheet', ar === 10000, String(ar));
  await shot('bs-customer-cannot-balance');

  // ── 6. Trial balance: all accounts, the net column shown.
  await go('/reports/trial-balance');
  await page.click('[data-slot="customize-report"]');
  await page.click('[data-slot="customize-tab-filters"]');
  await page.check('[data-slot="customize-accounts-all"]');
  await page.click('[data-slot="customize-tab-columns"]');
  await page.check('[data-slot="customize-col-net"]');
  await page.click('[data-slot="customize-apply"]');
  await page.waitForSelector('[data-slot="custom-balanced"]', { timeout: 30000 });
  check('unfiltered, the customised trial balance balances', /Debits equal credits/.test(await page.locator('[data-slot="custom-balanced"]').innerText()));
  check('all accounts listed, zero balances too', (await page.locator('[data-slot="rpt-account"]').count()) > 20);
  await shot('tb-all-accounts');

  // ── 7. General ledger of Receivables for one customer; account transactions for income only.
  const arAcc = masters.accounts.find((a) => a.code === '1100');
  await go(`/reports/general-ledger?account=${arAcc.id}&from=${fyStart()}&to=${today()}&contactIds=${bharat.id}`);
  await page.waitForSelector('[data-slot="custom-lines"]', { timeout: 30000 });
  const glLines = await page.locator('[data-slot="custom-line"]').allInnerTexts();
  check('the ledger keeps only Bharat\'s line', glLines.length === 1 && /5,000/.test(glLines[0]), glLines.join(' | '));
  await shot('gl-customer');
  await go('/reports/account-transactions');
  await page.click('[data-slot="customize-report"]');
  await page.click('[data-slot="customize-tab-filters"]');
  await page.check('[data-slot="customize-type-income"]');
  await page.locator('[data-slot="customize-contacts"] input').first().fill(apexName);
  await page.locator('[data-slot="customize-contacts"] label', { hasText: apexName }).locator('input').check();
  await page.click('[data-slot="customize-apply"]');
  await page.waitForSelector('[data-slot="custom-lines"]', { timeout: 30000 });
  const atLines = await page.locator('[data-slot="custom-line"]').allInnerTexts();
  check('account transactions: Apex\'s income lines only', atLines.length === 1 && /4100/.test(atLines[0]) && /10,000/.test(atLines[0]), atLines.join(' | '));
  await shot('account-transactions-filtered');

  // ── 8. Cash flow by quarter.
  await go('/reports/cash-flow');
  await page.click('[data-slot="customize-report"]');
  await page.selectOption('[data-slot="customize-report-by"]', 'quarter');
  await page.click('[data-slot="customize-apply"]');
  await page.waitForSelector('[data-slot="custom-table"]', { timeout: 30000 });
  check('cash flow by quarter', (await page.locator('[data-slot="custom-column"]').count()) >= 1);
  await shot('cash-flow-quarters');

  // ── 9. Delete the custom report.
  await go('/reports/custom-reports');
  await page.locator('[data-slot="custom-report-row"]', { hasText: `${reportName} (audit)` }).locator('[data-slot="custom-report-delete"]').click();
  await page.getByRole('button', { name: /^Delete$/ }).last().click();
  await page.waitForSelector(`[data-slot="custom-report-row"]:has-text("${reportName} (audit)")`, { state: 'detached', timeout: 30000 }).catch(() => {});
  check('Delete removes it', (await page.locator('[data-slot="custom-report-row"]', { hasText: `${reportName} (audit)` }).count()) === 0);
} catch (e) {
  check('the script ran to the end', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await finish();
