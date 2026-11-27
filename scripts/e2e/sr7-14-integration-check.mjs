// Status review 7, item 14 — Integration: payroll and inventory against the
// general ledger, as the auditors test it, through the screens.
//
//   FRESH=1 node scripts/e2e/sr7-14-integration-check.mjs     a brand-new company
//   node scripts/e2e/sr7-14-integration-check.mjs             the seeded demo book
//
// Payroll: a pay run posts its salary journal (by component, employer PF/ESI,
// every liability, net pay); paying salaries clears net pay from the bank;
// paying a due clears its liability; reopening reverses the journal; a month
// run in another system is imported from its salary register.
// Inventory: a bill raises stock, an invoice lowers it and (perpetual) posts
// COGS; periodic is a stated pass. Accountant → Integration Check shows each
// with Pass or the difference, drills down, prints and exports, and names the
// external feeds (payroll import, Tally) with their last run.

import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE, FRESH, clickAndWait, field, inr, pick, signIn, start, toast } from './sr7c-helpers.mjs';

const t = await start('14');
const { page, check, shot, api } = t;
const R = (r) => Math.round(r * 100);

const openCheck = async (from, to) => {
  await page.goto(`${BASE}/accountant/integration-check`, { waitUntil: 'load' });
  await page.locator('[data-slot="ic-from"]').fill(from);
  await page.locator('[data-slot="ic-to"]').fill(to);
  await page.locator('[data-slot="integration-check"]').waitFor();
  await page.waitForTimeout(1200);
  return page.locator('[data-slot="integration-check"]');
};

try {
  await signIn(t, { business: 'Integration Audit' });
  check('Signed in', page.url().includes('/dashboard'), FRESH ? 'new company signed up' : 'demo book');
  const me = await api('GET', '/api/auth/me');
  const branchId = me.branches?.[0]?.id;
  let from = '2026-04-01';
  const to = '2026-11-27';

  if (FRESH) {
    await api('POST', '/api/banking/accounts', { kind: 'bank', name: 'HDFC Current', accountNumber: '50200011223344', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', openingBalancePaise: R(50_00_000), openingDate: '2026-04-01' });
    for (const [code, name, basic] of [['P1', 'Priyanka Iyer', 20_000], ['P2', 'Ganesh Pillai', 12_000]]) {
      await api('POST', '/api/payroll/employees', {
        action: 'create', employee: { branchId, code, name, dateOfJoining: '2025-01-01', gender: 'female', uan: `10090000${code === 'P1' ? '1111' : '2222'}`, esiIpNumber: '3100000001', bankAccountName: name, bankAccountNo: `9988776655${code === 'P1' ? '01' : '02'}`, bankIfsc: 'HDFC0000123' },
        salary: { basic: R(basic), da: 0, hra: R(basic * 0.4), special: R(3_000), other: 0 },
      });
    }
    const vendor = await api('POST', '/api/contacts', { kind: 'vendor', displayName: 'Bosch Distributor', gstTreatment: 'unregistered', stateCode: '33' });
    const customer = await api('POST', '/api/contacts', { kind: 'customer', displayName: 'City Garage', gstTreatment: 'unregistered', stateCode: '33' });
    const item = await api('POST', '/api/items', { kind: 'goods', name: 'Brake pad set', sku: 'BP-01', hsnSac: '8708', uqc: 'NOS', salePricePaise: R(900), purchasePricePaise: R(600), gstRatePct: 18, taxPref: 'taxable', itemType: 'sales_and_purchases', isDigitalService: false, trackInventory: true, openingStockQty: 0, openingStockRatePaise: 0 });
    const buy = (date, qty, rate) => api('POST', '/api/bills', { branchId: String(branchId), vendorId: String(vendor.id), vendorInvoiceNo: `BD-${date}`, date, dueDate: date, lines: [{ itemId: String(item.id), qty, ratePaise: R(rate) }] });
    const sell = (date, qty) => api('POST', '/api/invoices', { branchId: String(branchId), customerId: String(customer.id), date, dueDate: date, status: 'approved', lines: [{ itemId: String(item.id), qty, ratePaise: R(900) }] });

    // ── Payroll: April and May prepared and posted on screen ──────────────
    const runIds = {};
    for (const m of ['2026-04', '2026-05']) {
      await page.goto(`${BASE}/payroll/runs`, { waitUntil: 'load' });
      await page.locator('input[type="month"]').first().fill(m);
      await page.getByRole('button', { name: /Prepare payroll/ }).click();
      await page.waitForURL(/\/payroll\/runs\/\d+/, { timeout: 150_000 });
      runIds[m] = page.url().split('/').pop();
      await clickAndWait(page, page.getByRole('button', { name: /^Post$/ }), '/api/payroll/runs/');
      await toast(page, /posted/);
    }
    // April's salaries paid on screen, all at once.
    await page.goto(`${BASE}/payroll/runs/${runIds['2026-04']}`, { waitUntil: 'load' });
    await page.locator('[data-slot="run-pay"]').click();
    const pd = page.getByRole('dialog');
    await pick(page, pd.locator('[data-slot="select-trigger"]').first(), /HDFC Current/);
    await field(pd, 'Paid on').locator('input').fill('2026-05-01');
    await clickAndWait(page, pd.getByRole('button', { name: 'Record payment' }), '/api/payroll/runs/');
    await toast(page, /Salaries paid/);
    await shot('run-paid');
    // The journal the run posted.
    const entry = await api('GET', `/api/payroll/runs/${runIds['2026-04']}`);
    const j = await api('GET', `/api/journal?entryId=${entry.journalEntryId}`).catch(() => null);
    const lines = (j?.entries?.[0]?.lines ?? []).map((l) => l.description ?? '').join(' | ');
    check('Salary journal by component, employer PF and ESI apart, every liability, net pay', /Basic/.test(lines) && /House rent allowance/.test(lines) && /Employer PF/.test(lines) && /Net salaries/.test(lines), lines.slice(0, 200));
    // April's PF and ESI paid.
    const dues = await api('GET', '/api/payroll/statutory?from=2026-04&to=2026-04');
    for (const d of dues.dues.filter((x) => x.component === 'pf' || x.component === 'esi')) {
      await api('POST', '/api/payroll/statutory', { component: d.component, period: '2026-04', amountPaise: d.balancePaise, date: '2026-05-12', bankAccountId: dues.dues.length ? (await api('GET', '/api/banking/accounts')).accounts.find((a) => a.name === 'HDFC Current').id : null, reference: `${d.component}-04` });
    }
    // May reopened and posted again: its journal reversed and reposted.
    await page.goto(`${BASE}/payroll/runs/${runIds['2026-05']}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: /Edit \(reopen\)/ }).click();
    const rd = page.locator('[role="dialog"], [role="alertdialog"]').filter({ has: page.getByPlaceholder(/^Reason/) }).last();
    await rd.getByPlaceholder(/^Reason/).fill('Leave days corrected');
    await clickAndWait(page, rd.getByRole('button', { name: /Reopen/ }), '/api/payroll/runs/');
    await page.waitForTimeout(800);
    await clickAndWait(page, page.getByRole('button', { name: /^Post$/ }), '/api/payroll/runs/');
    await toast(page, /posted/);

    // ── Inventory: periodic first, then perpetual ─────────────────────────
    await buy('2026-04-10', 50, 600);
    await sell('2026-04-20', 20);
    let ic = await openCheck('2026-04-01', '2026-04-30');
    const invNote = await ic.locator('[data-slot="ic-inventory-note"]').innerText();
    check('Periodic book: the ledger carries no stock, the statements value it — a stated pass', /periodically/.test(invNote) && /Pass \(periodic\)/.test(await ic.locator('[data-slot="ic-inventory"]').innerText()));
    await shot('inventory-periodic');
    await api('POST', '/api/settings/stock-accounting', { action: 'switch', from: '2026-05-01' });
    await buy('2026-05-05', 30, 650);
    await sell('2026-05-15', 25);
    // Mid-month, before the true-up: the check shows any difference and names the items.
    ic = await openCheck('2026-05-01', '2026-05-20');
    const mid = await api('GET', '/api/integration-check?from=2026-05-01&to=2026-05-20');
    check('Perpetual mid-month: stock valuation and the Inventory account shown side by side; any difference explained by item',
      mid.inventory.method === 'perpetual' && (mid.inventory.differencePaise === 0 || mid.inventory.items.some((i) => i.name === 'Brake pad set')),
      `difference ${inr(mid.inventory.differencePaise)}`);
    // A bill raised stock in the Inventory account, an invoice took its cost out to COGS (since the stock was taken in on 1 May).
    check('Perpetual: the bill and invoice moved the Inventory account (stock in, COGS out)',
      mid.inventory.movements.some((m) => m.sourceType === 'bill' && m.amountPaise > 0) && mid.inventory.movements.some((m) => m.sourceType === 'invoice' && m.amountPaise < 0), JSON.stringify(mid.inventory.movements));
    await shot('inventory-mid-month');
    // Month end: the true-up the scheduler posts on the 1st (here from Settings → Stock accounting).
    await api('POST', '/api/settings/stock-accounting', { action: 'true_up', asOf: '2026-05-31' });
    from = '2026-04-01';

    // ── Payroll run elsewhere: June imported from its salary register ─────
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sr7-14-'));
    const csv = path.join(dir, 'keka-salary-register-2026-06.csv');
    writeFileSync(csv, [
      'Employee Code,Employee Name,Department,Basic,HRA,Other Earnings,Gross,PF Employee,PF Employer,ESI Employee,ESI Employer,Professional Tax,LWF Employee,LWF Employer,TDS,Advance Recovery,Net Pay',
      'K101,Ravi Kumar,Stores,15000.00,6000.00,4000.00,25000.00,1800.00,1950.00,0.00,0.00,208.00,0.00,0.00,500.00,1000.00,21492.00',
      'K102,Anita Shah,Sales,12000.00,4800.00,1200.00,18000.00,1440.00,1560.00,135.00,585.00,0.00,0.00,0.00,0.00,0.00,16425.00',
    ].join('\n'));
    await page.goto(`${BASE}/payroll/import`, { waitUntil: 'load' });
    await page.locator('[data-slot="import-month"]').fill('2026-06');
    await page.locator('[data-slot="import-source"]').fill('Keka');
    await page.locator('[data-slot="import-file"]').setInputFiles(csv);
    await page.locator('[data-slot="import-check"]').waitFor();
    const chk = await page.locator('[data-slot="import-check"]').innerText();
    check('Import: every row foots; totals shown before posting', /Every row foots/.test(chk) && /43,000\.00/.test(chk) && /37,917\.00/.test(chk), chk.split('\n')[0]);
    await shot('import-checked');
    await clickAndWait(page, page.locator('[data-slot="import-post"]'), '/api/payroll/imports');
    await toast(page, /posted/);
    await page.locator('[data-slot="import-row"]').first().waitFor();
    await shot('import-posted');
  } else {
    from = '2026-04-01';
  }

  // ── The integration check ────────────────────────────────────────────────
  const ic = await openCheck(from, to);
  const summary = await ic.locator('[data-slot="ic-payroll-summary"]').innerText();
  check('Payroll vs general ledger: Pass', /Pass/.test(summary) && !/Difference/.test(summary), summary.replace(/\s+/g, ' '));
  const runs = await ic.locator('[data-slot="ic-run"]').allInnerTexts();
  check('Every pay run and imported register: Pass', runs.length >= (FRESH ? 3 : 6) && runs.every((r) => /Pass/.test(r)), runs.map((r) => r.split('\t')[0]).join(' | '));
  check('The imported register is in the check', runs.some((r) => /Imported 2026-0[56]/.test(r)));
  const liab = await ic.locator('[data-slot="ic-liability"]').allInnerTexts();
  check('Each payroll liability ties to its ledger account: PF, ESI, PT, LWF, TDS, Salaries Payable', liab.length === 6 && liab.every((l) => /Pass/.test(l)), liab.map((l) => l.split('\t')[0]).join(' | '));
  const inv = await ic.locator('[data-slot="ic-inventory-summary"]').innerText();
  check('Inventory vs general ledger: Pass, perpetual', /Pass/.test(inv) && /Perpetual/.test(inv), inv.replace(/\s+/g, ' '));
  await shot('integration-check');

  // Figures, from the API the page uses, to the paisa.
  const data = await api('GET', `/api/integration-check?from=${from}&to=${to}`);
  check('Inventory: the stock valuation equals the Inventory account to the paisa', data.inventory.differencePaise === 0 && data.inventory.stockValuePaise === data.inventory.ledgerPaise, `${inr(data.inventory.stockValuePaise)} vs ${inr(data.inventory.ledgerPaise)}`);
  const sp = data.payroll.liabilities.find((l) => l.label === 'Salaries Payable');
  check('Salaries Payable: posted less paid equals the ledger', sp.subledgerPaise + sp.settlementsPaise + sp.otherPaise === sp.ledgerPaise, `${inr(sp.subledgerPaise)} / ${inr(sp.ledgerPaise)}`);
  if (FRESH) {
    const pf = data.payroll.liabilities.find((l) => l.label === 'PF Payable');
    const may = data.payroll.runs.find((r) => r.month === '2026-05' && r.kind === 'run');
    const june = data.payroll.runs.find((r) => r.kind === 'import');
    const left = may.lines.find((l) => l.label === 'PF Payable').registerPaise + june.lines.find((l) => l.label === 'PF Payable').registerPaise;
    check('PF paid for April cleared from PF Payable: what is left is May\'s and the imported June\'s', pf.ok && pf.ledgerPaise === left, `${inr(pf.ledgerPaise)} = ${inr(left)}`);
    check('May, reopened and reposted: its entries net to the register', may.ok && may.entryIds.length === 3, `${may.entryIds.length} entries (posting, reversal, posting)`);
  }

  // Drill-down: a run's lines, its entry, the ledger.
  await ic.locator('[data-slot="ic-run"]').first().click();
  await ic.locator('[data-slot="ic-run-line"]').first().waitFor();
  check('Drill-down: the run\'s lines, account by account, register against ledger', (await ic.locator('[data-slot="ic-run-line"]').count()) >= 9);
  await shot('integration-run-lines');
  await ic.locator('[data-slot="ic-run"]').first().getByRole('button', { name: /Entry 1/ }).click();
  await page.locator('[data-slot="journal-dialog"]').getByText('Total').waitFor();
  check('Drill-down: the run\'s journal entry opens', /Salaries & Wages/.test(await page.locator('[data-slot="journal-dialog"]').innerText()));
  await shot('integration-entry');
  await page.keyboard.press('Escape');
  const ext = await ic.locator('[data-slot="ic-external"]').innerText();
  check('External feeds named with their last run: payroll import and Tally', /Payroll from another system/.test(ext) && /Tally sync/.test(ext) && /(Keka|greytHR)/.test(ext), ext.split('\n').slice(0, 4).join(' | '));
  await shot('integration-external');
  const [xl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-slot="ic-export"]').click()]);
  check('The whole check exports (Excel)', /integration-check-.*\.xlsx/.test(await xl.suggestedFilename()), await xl.suggestedFilename());
  await page.emulateMedia({ media: 'print' });
  await shot('integration-print');
  await page.emulateMedia({ media: 'screen' });
} catch (e) {
  check('The run finished without an error', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await t.finish();
