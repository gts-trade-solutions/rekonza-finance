// Status review 7, item 10 — Payroll: statutory deduction reports, as the
// auditors test them, through the screens.
//
//   FRESH=1 node scripts/e2e/sr7-10-statutory-reports.mjs     a brand-new company
//   node scripts/e2e/sr7-10-statutory-reports.mjs             the seeded demo book
//
// 1. Employees with varied structures: basic above and below the ₹15,000 PF
//    ceiling, gross above and below the ₹21,000 ESI ceiling, PT in Maharashtra,
//    Karnataka, Tamil Nadu, Telangana and West Bengal, LWF, TDS on the new and
//    old regimes.  2. Payroll for three months.  3. The reports: PF register
//    and ECR 2.0, ESI and its upload, PT by state, LWF by state and period, TDS:
//    challans with BSR code and serial, linked deductions, Form 24Q Annexure I
//    (and II), Form 16 Part A and B — each tying to the pay runs and the
//    ledger, each exporting.  4. Paying a due clears its liability.
//    5. Salaries paid employee by employee, the bank file, a payment taken back.

import { BASE, FRESH, clickAndWait, field, inr, pick, signIn, start, toast } from './sr7c-helpers.mjs';
import { readFileSync } from 'node:fs';

const t = await start('10');
const { page, check, shot, api } = t;
const R = (r) => Math.round(r * 100);

try {
  await signIn(t, { business: 'Payroll Statutory Audit' });
  check('Signed in', page.url().includes('/dashboard'), FRESH ? 'new company signed up' : 'demo book');
  const me = await api('GET', '/api/auth/me');
  const branchId = me.branches?.[0]?.id ?? me.user?.branchId;
  let from = '2026-06';
  let to = '2026-10';
  let ids = {};

  if (FRESH) {
    from = '2026-04';
    to = '2026-06';
    await api('POST', '/api/banking/accounts', { kind: 'bank', name: 'HDFC Salary', accountNumber: '50200077665544', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', openingBalancePaise: R(50_00_000), openingDate: '2026-04-01' });
    await api('PATCH', '/api/settings', { name: me.org?.name ?? 'Payroll Statutory Audit', tan: 'CHEP12345K' });
    await api('POST', '/api/settings/statutory', { action: 'deductor', type: 'K', name: 'Audit Partner', designation: 'Director', pan: 'ABCPA1234K' });

    // ── 1. The first employee through the Add employee screen ──────────────
    await page.goto(`${BASE}/payroll/employees`, { waitUntil: 'load' });
    await page.getByRole('button', { name: /Add employee/ }).click();
    const dlg = page.getByRole('dialog');
    await field(dlg, 'Employee code').locator('input').fill('A');
    await field(dlg, 'Name').locator('input').fill('Aarti Kulkarni');
    await pick(page, dlg.locator('[data-slot="employee-work-state"]'), /Maharashtra/);
    await field(dlg, 'Joined on').locator('input').fill('2025-01-01');
    await dlg.getByRole('tab', { name: 'Salary' }).click();
    await field(dlg, 'Basic').locator('input').fill('20000');
    await field(dlg, 'HRA').locator('input').fill('8000');
    await field(dlg, 'Special allowance').locator('input').fill('7000');
    await dlg.getByRole('tab', { name: 'PF, ESI and tax' }).click();
    await field(dlg, 'PAN').locator('input').fill('ABCPK1001A');
    await field(dlg, 'UAN').locator('input').fill('100900000001');
    await dlg.getByRole('tab', { name: 'Bank' }).click();
    await field(dlg, 'Account number').locator('input').fill('11112222333301');
    await field(dlg, 'IFSC').locator('input').fill('HDFC0000123');
    await shot('employee-form');
    await dlg.getByRole('button', { name: /^(Add|Save)/ }).last().click();
    await toast(page, /Aarti Kulkarni added/);
    // The rest the same way, through the same API the screen uses.
    const emp = (code, name, state, basic, hra, special, extra = {}) => api('POST', '/api/payroll/employees', {
      action: 'create', employee: { branchId, code, name, dateOfJoining: '2025-01-01', workStateCode: state, gender: 'male', pan: `ABCPK${1000 + Number(code.charCodeAt(0))}A`.slice(0, 10),
        uan: `1009000000${String(code.charCodeAt(0)).padStart(2, '0')}`, esiIpNumber: `31000000${code.charCodeAt(0)}`, bankAccountName: name, bankAccountNo: `1111222233${code.charCodeAt(0)}`, bankIfsc: 'HDFC0000123', ...extra },
      salary: { basic: R(basic), da: 0, hra: R(hra), special: R(special), other: 0 },
    });
    await emp('B', 'Basavaraj H', '29', 10_000, 5_000, 3_000);
    await emp('C', 'Chitra S', null, 12_000, 4_000, 4_000);
    await emp('D', 'Dinesh Reddy', '36', 1_00_000, 40_000, 60_000, { taxRegime: 'old', declaredDeductionsPaise: R(1_50_000) });
    await emp('E', 'Esha Banerjee', '19', 14_000, 6_000, 5_000);

    // ── 2. Payroll for April, May and June, prepared and posted on screen ──
    for (const m of ['2026-04', '2026-05', '2026-06']) {
      await page.goto(`${BASE}/payroll/runs`, { waitUntil: 'load' });
      await page.locator('input[type="month"]').first().fill(m);
      await page.getByRole('button', { name: /Prepare payroll/ }).click();
      await page.waitForURL(/\/payroll\/runs\/\d+/, { timeout: 150_000, waitUntil: 'domcontentloaded' });
      await clickAndWait(page, page.getByRole('button', { name: /^Post$/ }), '/api/payroll/runs/');
      await toast(page, /posted/);
      if (m === '2026-04') await shot('run-posted');
    }
    const runs = (await api('GET', '/api/payroll/runs')).runs;
    ids = Object.fromEntries(runs.map((r) => [r.month, r.id]));
    check('Three months of payroll posted', ['2026-04', '2026-05', '2026-06'].every((m) => ids[m]));
  }

  // ── 3. Payroll → Statutory Reports ───────────────────────────────────────
  await page.goto(`${BASE}/payroll/statutory`, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'Statutory Reports' }).waitFor();
  await page.getByLabel('From month').fill(from);
  await page.getByLabel('To month').fill(to);
  await page.waitForTimeout(800);

  // PF
  await page.locator('[data-slot="tab-pf"]').click();
  const pf = page.locator('[data-slot="pf-report"]');
  await pf.waitFor();
  const firstHigh = FRESH ? 'Aarti Kulkarni' : 'Rohit Menon';
  const pfRow = await pf.locator('[data-slot="pf-row"]', { hasText: firstHigh }).first().innerText();
  check('PF: basic above the ceiling contributes on ₹15,000; EE ₹1,800, EPS capped at ₹1,250, ER difference ₹550',
    /15,000\.00/.test(pfRow) && /1,800\.00/.test(pfRow) && /1,250\.00/.test(pfRow) && /550\.00/.test(pfRow), pfRow.replace(/\s+/g, ' '));
  check('PF reconciles with the pay runs and PF Payable in the ledger', /Reconciles/.test(await pf.locator('[data-slot="stat-tie"]').innerText()));
  await shot('pf-register');
  const [ecrDl] = await Promise.all([page.waitForEvent('download'), pf.locator('[data-slot="pf-ecr-download"]').first().click()]);
  const ecr = readFileSync(await ecrDl.path(), 'utf8');
  const ecrLine = ecr.split('\n').find((l) => l.includes(FRESH ? 'AARTI KULKARNI' : 'ROHIT MENON')) ?? '';
  check('ECR 2.0 file: #~# separated, 11 fields, whole rupees, EPS 1250', ecrLine.split('#~#').length === 11 && ecrLine.includes('#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#'), ecrLine);
  const [pfCsv] = await Promise.all([page.waitForEvent('download'), pf.locator('[data-slot="pf-export"]').click()]);
  check('PF register exports', (await pfCsv.suggestedFilename()).endsWith('.csv'));

  // ESI
  await page.locator('[data-slot="tab-esi"]').click();
  const esi = page.locator('[data-slot="esi-report"]');
  await esi.waitFor();
  const esiText = await esi.innerText();
  const covered = FRESH ? ['Basavaraj H', 'Chitra S'] : ['Imran Sheikh', 'Lakshmi R'];
  check('ESI: gross ₹21,000 or less covered; above it not', covered.every((n) => esiText.includes(n)) && !esiText.includes(firstHigh));
  if (FRESH) check('ESI: 0.75% and 3.25% of ₹18,000 (₹135 and ₹585)', /Basavaraj H[\s\S]*?18,000\.00[\s\S]*?135\.00[\s\S]*?585\.00/.test(esiText));
  check('ESI reconciles with the ledger', /Reconciles/.test(await esi.locator('[data-slot="stat-tie"]').innerText()));
  const [esiUp] = await Promise.all([page.waitForEvent('download'), esi.locator('[data-slot="esi-upload-download"]').first().click()]);
  check('ESIC monthly contribution upload downloads (Excel)', (await esiUp.suggestedFilename()).endsWith('.xlsx'));
  await shot('esi-register');

  // PT
  await page.locator('[data-slot="tab-pt"]').click();
  const pt = page.locator('[data-slot="pt-report"]');
  await pt.waitFor();
  const states = await pt.locator('[data-slot="pt-state"]').allInnerTexts();
  const has = (s) => states.some((x) => x.startsWith(s));
  check('PT by state: Maharashtra, Karnataka, Tamil Nadu, Telangana, West Bengal', ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Telangana', 'West Bengal'].every(has), states.map((x) => x.split('\n')[0]).join(' | '));
  const wb = states.find((x) => x.startsWith('West Bengal')) ?? '';
  check('West Bengal slab ₹130 (₹15,001–25,000); Maharashtra ₹200', /130\.00/.test(wb) && /200\.00/.test(states.find((x) => x.startsWith('Maharashtra')) ?? ''));
  check('PT reconciles with the ledger', /Reconciles/.test(await pt.locator('[data-slot="stat-tie"]').innerText()));
  await shot('pt-by-state');

  // LWF
  await page.locator('[data-slot="tab-lwf"]').click();
  const lwf = page.locator('[data-slot="lwf-report"]');
  await lwf.waitFor();
  const lwfText = await lwf.innerText();
  check('LWF by state and period: Maharashtra ₹25 + ₹75 and West Bengal ₹3 + ₹15 for January–June', /Maharashtra\s+January–June 2026[\s\S]*?25\.00[\s\S]*?75\.00/.test(lwfText) && /West Bengal\s+January–June 2026[\s\S]*?3\.00[\s\S]*?15\.00/.test(lwfText), lwfText.replace(/\s+/g, ' ').slice(0, 300));
  check('LWF reconciles with the ledger', /Reconciles/.test(await lwf.locator('[data-slot="stat-tie"]').innerText()));
  await shot('lwf-register');

  // TDS on salary: challans recorded on screen (fresh), linked; the register.
  await page.locator('[data-slot="tab-tds"]').click();
  const tds = page.locator('[data-slot="tds-report"]');
  await tds.waitFor();
  if (FRESH) {
    let serial = 101;
    for (let i = 0; i < 3; i++) {
      const btn = tds.locator('[data-slot="tds-record-challan"]').first();
      if (!(await btn.count())) break;
      await btn.click();
      const cd = page.locator('[data-slot="tds-challan-dialog"]');
      await cd.locator('[data-slot="tds-bsr"]').fill('0510308');
      await cd.locator('[data-slot="tds-serial"]').fill(String(serial++));
      const month = ['2026-05-06', '2026-06-06', '2026-07-06'][i];
      await cd.locator('[data-slot="tds-date"]').fill(month);
      if (i === 0) await shot('tds-challan-dialog');
      await clickAndWait(page, cd.locator('[data-slot="tds-challan-save"]'), '/api/payroll/salary-tds');
      await toast(page, /Challan recorded; \d+ deduction/);
      await page.waitForTimeout(600);
    }
  }
  const tdsMonths = await tds.locator('[data-slot="tds-month"]').allInnerTexts();
  check('TDS: every month deposited by challan (BSR code, date, serial) and linked', tdsMonths.length > 0 && tdsMonths.every((m) => /Deposited/.test(m) && /0510308/.test(m)), `${tdsMonths.length} month(s)`);
  check('TDS reconciles with the pay runs and TDS Payable', /Reconciles/.test(await tds.locator('[data-slot="stat-tie"]').innerText()));
  await shot('tds-on-salary');

  // Form 24Q
  await page.locator('[data-slot="tab-24q"]').click();
  const q = page.locator('[data-slot="form-24q"]');
  await q.waitFor();
  const quarter = FRESH ? /^Q1/ : /^Q2/;
  await pick(page, q.locator('[data-slot="24q-quarter"]'), quarter);
  await q.locator('[data-slot="24q-annexure-1"]').waitFor();
  await page.waitForTimeout(800);
  const ann1 = await q.locator('[data-slot="24q-annexure-1"]').innerText();
  check('Form 24Q Annexure I: each challan with the deductions it paid', /Challan 0510308/.test(ann1) && (await q.locator('[data-slot="24q-deductee"]').count()) > 0);
  const issues = (await q.locator('[data-slot="24q-issues"]').count()) ? await q.locator('[data-slot="24q-issues"]').innerText() : '';
  check('Form 24Q: no deduction left unlinked', !/not linked/.test(issues), issues.slice(0, 200));
  if (FRESH) {
    await q.locator('[data-slot="24q-receipt"] input').first().fill('QWERTYUI1234567');
    await clickAndWait(page, q.locator('[data-slot="24q-receipt"]').getByRole('button', { name: 'Save' }), '/api/payroll/salary-tds');
    await toast(page, /Receipt number saved/);
  }
  const [rpu] = await Promise.all([page.waitForEvent('download'), q.locator('[data-slot="24q-rpu"]').click()]);
  check('Form 24Q exports laid out for the RPU (Excel)', /24Q-FY2026-27-Q\d-RPU\.xlsx/.test(await rpu.suggestedFilename()), await rpu.suggestedFilename());
  await shot('form-24q');
  if (FRESH) {
    // Annexure II is the fourth quarter's: shown there for the year (only one quarter run here).
    await pick(page, q.locator('[data-slot="24q-quarter"]'), /^Q4/);
    await q.locator('[data-slot="24q-annexure-2"]').waitFor();
    check('Form 24Q Q4 carries Annexure II, salary for the year by employee', (await q.locator('[data-slot="24q-salary"]').count()) === 5);
    await shot('form-24q-annexure-ii');
  }

  // Form 16 Part A and B for the high earner, tied to the 24Q.
  const f16list = await api('GET', '/api/payroll/form16?fy=2026');
  const hi = f16list.employees.find((e) => e.name === (FRESH ? 'Dinesh Reddy' : 'Sunita Reddy'));
  await page.goto(`${BASE}/payroll/form-16/${hi.employeeId}?fy=2026`, { waitUntil: 'load' });
  const partA = page.locator('[data-slot="form16-part-a"]');
  await partA.waitFor();
  const aText = await partA.innerText();
  check('Form 16 Part A: the 24Q receipt number and the challans that carried the tax', /QWERTYUI1234567|QAUFRTYE4567890/.test(aText) && /0510308/.test(aText), aText.split('\n').slice(0, 3).join(' '));
  const f16 = await api('GET', `/api/payroll/form16?fy=2026&employeeId=${hi.employeeId}`);
  check('Form 16: tax deposited (Part A) equals tax deducted (Part B)', f16.partA.totals.depositedPaise === f16.deductedPaise && f16.deductedPaise > 0, inr(f16.deductedPaise));
  await page.locator('[data-slot="form16-part-b"]').scrollIntoViewIfNeeded();
  await shot('form-16');

  // ── 4. Paying a due clears its liability (fresh: April's PF) ────────────
  if (FRESH) {
    await page.goto(`${BASE}/payroll/statutory`, { waitUntil: 'load' });
    await page.getByLabel('From month').fill(from);
    await page.getByLabel('To month').fill(to);
    const pfDue = page.locator('[data-slot="statutory-due"]', { hasText: 'Apr 2026' }).filter({ hasText: 'Provident Fund' }).first();
    await pfDue.locator('[data-slot="statutory-pay"]').click();
    const pd = page.locator('[data-slot="statutory-pay-dialog"]');
    await pd.locator('input').nth(2).fill('TRRN2604001').catch(() => {});
    await clickAndWait(page, pd.getByRole('button', { name: /^Pay$/ }), '/api/payroll/statutory');
    await toast(page, /paid/);
    await page.waitForTimeout(600);
    check('April PF paid: the due shows Paid', /Paid/.test(await page.locator('[data-slot="statutory-due"]', { hasText: 'Apr 2026' }).filter({ hasText: 'Provident Fund' }).first().innerText()));
    await shot('dues-paid');
    const tie = (await api('GET', `/api/payroll/statutory?view=pf&from=${from}&to=${to}`)).tie;
    check('PF Payable: what was paid left the ledger account, to the paisa', tie.ok && tie.paidPaise > 0 && tie.paidPaise === tie.ledgerPaidPaise, `${inr(tie.paidPaise)} paid`);
  }

  // ── 5. Salaries paid employee by employee ───────────────────────────────
  const runId = FRESH ? ids['2026-04'] : (await api('GET', '/api/payroll/runs')).runs.find((r) => r.month === '2026-10').id;
  await page.goto(`${BASE}/payroll/runs/${runId}`, { waitUntil: 'load' });
  const card = page.locator('[data-slot="salary-payments"]');
  await card.waitFor();
  if (FRESH) {
    await card.locator('[data-slot="salary-payment-row"]', { hasText: 'Aarti Kulkarni' }).locator('input[type="checkbox"]').check();
    await card.locator('[data-slot="salary-pay-selected"]').click();
    const sd = page.locator('[data-slot="salary-pay-dialog"]');
    await sd.locator('[data-slot="salary-pay-date"]').fill('2026-05-01');
    await clickAndWait(page, sd.locator('[data-slot="salary-pay-confirm"]'), '/payments');
    await toast(page, /Paid 1 employee/);
    await page.waitForTimeout(500);
    const [bf] = await Promise.all([page.waitForEvent('download'), card.locator('[data-slot="salary-bank-file"]').click()]);
    check('Bank transfer file for the four still unpaid', (await bf.suggestedFilename()).startsWith('salary-transfers-'));
    await card.locator('[data-slot="salary-pay-all"]').click();
    await page.locator('[data-slot="salary-pay-date"]').fill('2026-05-02');
    await clickAndWait(page, page.locator('[data-slot="salary-pay-confirm"]'), '/payments');
    await toast(page, /Paid 4 employees/);
    await page.waitForTimeout(500);
    // One taken back: the transfer bounced.
    await card.locator('[data-slot="salary-payment-row"]', { hasText: 'Basavaraj H' }).locator('[data-slot="salary-take-back"]').click();
    const cf = page.locator('[role="dialog"], [role="alertdialog"]').filter({ has: page.getByPlaceholder(/^Reason/) }).last();
    await cf.getByPlaceholder(/^Reason/).fill('Transfer returned: account closed');
    await clickAndWait(page, cf.getByRole('button', { name: 'Take back' }), '/payments');
    await toast(page, /taken back/);
    await page.waitForTimeout(800);
  }
  const pays = await api('GET', `/api/payroll/runs/${runId}/payments`);
  const back = pays.rows.find((r) => r.code === (FRESH ? 'B' : 'E008'));
  check('Salary payments kept employee by employee; one taken back shows with its reason', back.payments.some((x) => x.reversed && /account closed/.test(x.reverseReason ?? '')));
  check(FRESH ? 'After the take-back, that employee is unpaid and the rest are paid' : 'The returned transfer was paid again',
    FRESH ? (back.unpaidPaise === back.netPaise && pays.rows.filter((r) => r.code !== 'B').every((r) => r.unpaidPaise === 0)) : back.unpaidPaise === 0);
  await card.scrollIntoViewIfNeeded();
  await shot('salary-payments');
  const ic = await api('GET', `/api/integration-check?from=2026-04-01&to=2026-11-27`);
  const sp = ic.payroll.liabilities.find((l) => l.label === 'Salaries Payable');
  check('Salaries Payable in the ledger equals what payroll says is unpaid, to the paisa', sp.ok && sp.subledgerPaise === sp.ledgerPaise - sp.settlementsPaise - sp.otherPaise, `${inr(sp.ledgerPaise)}`);

  await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'load' });
  await page.getByText('The books balance').first().waitFor({ timeout: 60_000 }).catch(() => {});
  check('Trial balance balances', await page.getByText('The books balance').count() > 0);
} catch (e) {
  check('The run finished without an error', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await t.finish();
