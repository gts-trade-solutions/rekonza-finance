// Status review 7, item 9 — Fixed Assets: the asset disposal workflow, as the
// auditors test it, through the screens.
//
//   FRESH=1 node scripts/e2e/sr7-9-asset-disposal.mjs     a brand-new company
//   node scripts/e2e/sr7-9-asset-disposal.mjs             the seeded demo book (Bengaluru Depot)
//
// 1. Add assets with cost, date put to use, method (SLM / WDV), useful life and
//    residual value.  2. Run depreciation April–August.  3. Dispose of them:
//    (a) sold by tax invoice with GST, (a) sold into a bank, (b) scrapped,
//    (c) part of one (split first).  4. Expect: depreciation to the day before
//    posted first, pro rata; one disposal entry; GST on the invoice; Disposed
//    with date, proceeds and gain; out of the next run; Undo with a reason;
//    the Disposals report and the Schedule III note tied to the ledger; the
//    Income-tax block reduced by the sale.  5. Disposal approval by a second person.

import { BASE, FRESH, clickAndWait, combo, field, gstinFor, inr, login, pick, randomPan, signIn, start, toast } from './sr7c-helpers.mjs';

const t = await start('9');
const { page, check, shot, api } = t;

// Schedule II arithmetic, written out independently of the app: by days, never below the residual.
const DAY = 86_400_000;
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;
const dep = (x, from, to, before = 0) => {
  const n = days(from, to);
  const left = x.cost - x.residual - before;
  const raw = x.method === 'slm'
    ? ((x.cost - x.residual) / x.life) * (n / 365)
    : (x.cost - before) * (1 - Math.pow(Math.max(x.residual, 1) / x.cost, 1 / x.life)) * (n / 365);
  return Math.min(Math.round(raw), left);
};

try {
  await signIn(t, { business: 'Asset Disposal Audit' });
  check('Signed in', page.url().includes('/dashboard'), FRESH ? 'new company signed up' : 'demo book');

  // ── Set-up the auditor would already have: a bank account and a buyer ─────
  let bankName = 'HDFC Bank – Current';
  let buyer = 'Sharma Traders';
  let branch = null;
  if (FRESH) {
    bankName = 'HDFC Current';
    await api('POST', '/api/banking/accounts', {
      kind: 'bank', name: bankName, accountNumber: '50200012345678', ifsc: 'HDFC0000123', bankName: 'HDFC Bank',
      openingBalancePaise: 50_00_000_00, openingDate: '2026-04-01',
    });
    buyer = 'Used Machinery Traders';
    await api('POST', '/api/contacts', { kind: 'customer', displayName: buyer, gstTreatment: 'registered', stateCode: '33', gstin: gstinFor('33', randomPan('F')) });
  } else {
    branch = /Bengaluru/;
    // The demo book asks for approval of disposals of ₹5 lakh and above; this run tests that last, so it starts with none.
    await api('POST', '/api/fixed-assets', { action: 'disposal-approval', isActive: false, thresholdPaise: 0, approverRole: 'admin' });
  }

  // What the report held before this run (the demo book has disposals of its own).
  const base = await api('GET', '/api/fixed-assets?view=disposals&from=2026-04-01&to=2027-03-31');

  // ── 1. Add the assets ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/accountant/fixed-assets`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-slot="add-asset"]').waitFor();
  const ASSETS = [
    { name: 'CNC lathe', cls: /Plant & Machinery/, cost: 6_00_000_00, life: 10, residual: 30_000_00, method: 'slm', hsn: '8458' },
    { name: 'Delivery van', cls: /Vehicles/, cost: 8_00_000_00, life: 8, residual: 40_000_00, method: 'wdv', hsn: '8704' },
    { name: 'Old server', cls: /Computers/, cost: 90_000_00, life: 3, residual: 4_500_00, method: 'slm', hsn: '8471' },
    { name: 'Moulding line', cls: /Plant & Machinery/, cost: 10_00_000_00, life: 15, residual: 50_000_00, method: 'slm', hsn: '8477' },
  ];
  for (const [i, a] of ASSETS.entries()) {
    await page.locator('[data-slot="add-asset"]').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByPlaceholder('CNC lathe, Dell laptop, Tata Ace…').fill(a.name);
    await pick(page, field(dlg, 'Class').locator('[data-slot="select-trigger"]'), a.cls);
    if (branch) await pick(page, field(dlg, 'Branch').locator('[data-slot="select-trigger"]'), branch);
    await field(dlg, 'Cost').locator('input').fill(String(a.cost / 100));
    await field(dlg, 'Acquired on').locator('input').fill('2026-04-01');
    await combo(page, field(dlg, 'Paid from').locator('[data-slot="combobox-trigger"]'), 'HDFC', /HDFC/);
    await field(dlg, 'Put to use on').locator('input').fill('2026-04-01');
    await pick(page, dlg.locator('[data-slot="asset-method"]'), a.method === 'slm' ? /Straight line/ : /Written-down/);
    await dlg.locator('[data-slot="asset-life"]').fill(String(a.life));
    await field(dlg, 'Residual value').locator('input').fill(String(a.residual / 100));
    await field(dlg, 'HSN').locator('input').fill(a.hsn);
    if (i < 2) {
      await dlg.locator('[data-slot="asset-rate"]').waitFor();
      if (i === 0) await shot('add-asset-slm');
      if (i === 1) await shot('add-asset-wdv');
      const rate = await dlg.locator('[data-slot="asset-rate"]').innerText();
      const want = a.method === 'wdv' ? (1 - Math.pow(a.residual / a.cost, 1 / a.life)) * 100 : ((a.cost - a.residual) / a.cost / a.life) * 100;
      check(`${a.name}: ${a.method.toUpperCase()} rate shown`, rate.includes(`${want.toFixed(2)}%`), rate.slice(0, 60));
    }
    await dlg.getByRole('button', { name: /^Add$/ }).click();
    await toast(page, new RegExp(`${a.name} added as`));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  const reg = await api('GET', '/api/fixed-assets?view=register');
  const byName = Object.fromEntries(ASSETS.map((a) => [a.name, reg.assets.find((r) => r.name === a.name && r.status === 'in_use')]));
  check('Four assets in the register, in use', ASSETS.every((a) => byName[a.name]), Object.values(byName).map((r) => r?.tagNo).join(', '));
  await shot('register');

  // ── 2. Depreciation, April to August ──────────────────────────────────────
  await page.getByRole('tab', { name: 'Depreciation' }).click();
  const panel = page.getByRole('tabpanel');
  await pick(page, field(panel, 'Branch').locator('[data-slot="select-trigger"]'), branch ?? /from/);
  await field(panel, 'Up to').locator('input').fill('2026-08-31');
  await panel.getByText('Dr Depreciation · Cr Accumulated Depreciation').waitFor();
  const want = ASSETS.reduce((s, a) => s + dep(a, '2026-04-01', '2026-08-31'), 0);
  const shown = await panel.locator('tr', { hasText: 'Dr Depreciation · Cr Accumulated Depreciation' }).innerText();
  check('Run preview: April–August by days for each asset', shown.includes(inr(want).slice(1)), `${inr(want)} expected; ${shown.replace(/\s+/g, ' ')}`);
  await shot('depreciation-preview');
  await panel.getByRole('button', { name: /^Post$/ }).click();
  await toast(page, /Depreciation of ₹/);
  await shot('depreciation-posted');
  const charged = Object.fromEntries(ASSETS.map((a) => [a.name, dep(a, '2026-04-01', '2026-08-31')]));

  const openAsset = async (name) => {
    await page.getByRole('tab', { name: /^Register/ }).click();
    const all = page.getByRole('button', { name: 'Including disposed' });
    if (await all.count()) await all.click();
    await page.getByRole('row').filter({ hasText: name }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    return dlg;
  };
  const disposePanel = async (dlg) => {
    await dlg.getByRole('tab', { name: 'Verify & dispose' }).click();
    const p = dlg.locator('[data-slot="dispose-panel"]');
    await p.waitFor();
    return p;
  };

  // ── 3(a). The lathe sold by tax invoice, with GST ─────────────────────────
  let dlg = await openAsset('CNC lathe');
  let p = await disposePanel(dlg);
  await p.locator('[data-slot="dispose-how-invoice"]').click();
  await p.locator('[data-slot="dispose-date"]').fill('2026-09-16');
  await combo(page, field(p, 'Buyer').locator('[data-slot="combobox-trigger"]'), buyer.split(' ')[0], new RegExp(buyer));
  await field(p, 'Sale value before GST').locator('input').fill('500000');
  const lathe = ASSETS[0];
  const catchUp = dep(lathe, '2026-09-01', '2026-09-15', charged['CNC lathe']);
  await p.locator('[data-slot="dispose-preview"]').getByText(inr(catchUp).slice(1)).first().waitFor();
  const latheAcc = charged['CNC lathe'] + catchUp;
  const latheGain = 5_00_000_00 + latheAcc - lathe.cost;
  const pv = await p.locator('[data-slot="dispose-preview"]').innerText();
  check('Preview: depreciation 1–15 September, pro rata, before the disposal', pv.includes(inr(catchUp).slice(1)), inr(catchUp));
  check('Preview: the loss on the lathe', pv.includes(inr(Math.abs(latheGain)).slice(1)) && /Loss/.test(pv), inr(latheGain));
  check('Preview: one disposal entry, Dr accumulated depreciation and clearing, Cr cost, loss', /Accumulated Depreciation[\s\S]*Asset Disposal Clearing[\s\S]*its cost[\s\S]*Loss on Sale/.test(pv));
  await shot('lathe-sale-preview');
  await clickAndWait(page, p.locator('[data-slot="dispose-submit"]'), '/api/fixed-assets');
  await toast(page, /Sold by/);
  await dlg.locator('[data-slot="disposed-summary"]').waitFor();
  const sum = await dlg.locator('[data-slot="disposed-summary"]').innerText();
  check('Lathe shows Disposed, with date, proceeds and the loss', /Sold by tax invoice on 16 Sept? 2026/.test(sum) && sum.includes('5,00,000.00') && sum.includes(inr(Math.abs(latheGain)).slice(1)), sum.replace(/\s+/g, ' ').slice(0, 200));
  check('Status badge says Disposed', /Disposed/.test(await dlg.locator('[data-slot="asset-status"]').innerText()));
  await shot('lathe-disposed');
  // The disposal entry as posted.
  await dlg.locator('[data-slot="disposal-journal"]').click();
  const jd = page.locator('[data-slot="journal-dialog"]');
  await jd.getByText('Total').waitFor();
  const jt = await jd.innerText();
  check('Disposal entry: Dr Accumulated Depreciation, Dr Asset Disposal Clearing, Cr Plant & Machinery, Dr Loss on Sale',
    jt.includes('Accumulated Depreciation') && jt.includes('Asset Disposal Clearing') && jt.includes('Plant & Machinery') && jt.includes('Loss on Sale') && jt.includes(inr(lathe.cost).slice(1)));
  await shot('lathe-disposal-entry');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const latheId = byName['CNC lathe'].id;
  const detail = await api('GET', `/api/fixed-assets?view=asset&id=${latheId}`);
  const rec = detail.disposals.find((x) => x.status === 'posted');
  check('GST charged on the invoice: 18% of ₹5,00,000', rec?.gstPaise === 90_000_00, inr(rec?.gstPaise ?? 0));
  check('The disposal record ties: accumulated, catch-up and loss', rec?.accumulatedPaise === latheAcc && rec?.catchUpPaise === catchUp && rec?.gainPaise === latheGain);

  // ── 3(a). The van sold for money into the bank, no invoice (WDV) ──────────
  dlg = await openAsset('Delivery van');
  p = await disposePanel(dlg);
  await p.locator('[data-slot="dispose-how-bank"]').click();
  await p.locator('[data-slot="dispose-date"]').fill('2026-09-01');
  await pick(page, p.locator('[data-slot="dispose-bank"]'), new RegExp(bankName.split(' ')[0]));
  await field(p, 'Amount received').locator('input').fill('650000');
  await p.locator('[data-slot="dispose-preview"]').getByText('Bank').waitFor();
  await shot('van-bank-preview');
  await clickAndWait(page, p.locator('[data-slot="dispose-submit"]'), '/api/fixed-assets');
  await toast(page, /Sold:/);
  const van = ASSETS[1];
  const vanGain = 6_50_000_00 + charged['Delivery van'] - van.cost;
  const vanSum = await dlg.locator('[data-slot="disposed-summary"]').innerText();
  check('Van: sold into the bank on the day after the last run — nothing more to charge; gain or loss right', /money into the bank/.test(vanSum) && vanSum.includes(inr(Math.abs(vanGain)).slice(1)), inr(vanGain));
  await page.keyboard.press('Escape');

  // ── 3(b). The server scrapped, nothing received ───────────────────────────
  dlg = await openAsset('Old server');
  p = await disposePanel(dlg);
  await p.locator('[data-slot="dispose-how-scrap"]').click();
  await p.locator('[data-slot="dispose-date"]').fill('2026-09-11');
  await field(p, 'Reason or note').locator('input').fill('Motherboard failed; not worth repairing');
  const srv = ASSETS[2];
  const srvCatch = dep(srv, '2026-09-01', '2026-09-10', charged['Old server']);
  const srvLoss = srv.cost - charged['Old server'] - srvCatch;
  await p.locator('[data-slot="dispose-preview"]').getByText(inr(srvLoss).slice(1)).first().waitFor();
  await shot('server-scrap-preview');
  await clickAndWait(page, p.locator('[data-slot="dispose-submit"]'), '/api/fixed-assets');
  await toast(page, /Scrapped/);
  check('Server scrapped: the loss is its written-down value', (await dlg.locator('[data-slot="disposed-summary"]').innerText()).includes(inr(srvLoss).slice(1)), inr(srvLoss));
  await page.keyboard.press('Escape');

  // ── 3(c). Part of the moulding line: 30% of it, split off and scrapped ────
  dlg = await openAsset('Moulding line');
  p = await disposePanel(dlg);
  await p.locator('[data-slot="dispose-how-scrap"]').click();
  await p.locator('[data-slot="dispose-date"]').fill('2026-09-21');
  await pick(page, p.locator('[data-slot="dispose-whole-part"]'), /Part of it/);
  await field(p, 'Cost of the part').locator('input').fill('300000');
  const ml = ASSETS[3];
  const part = { ...ml, cost: 3_00_000_00, residual: Math.round(ml.residual * 0.3) };
  const partBefore = Math.round(charged['Moulding line'] * 0.3);
  const partCatch = dep(part, '2026-09-01', '2026-09-20', partBefore);
  await p.locator('[data-slot="dispose-preview"]').getByText('3,00,000.00').first().waitFor();
  await shot('part-disposal-preview');
  await clickAndWait(page, p.locator('[data-slot="dispose-submit"]'), '/api/fixed-assets');
  await toast(page, /Scrapped/);
  await page.keyboard.press('Escape');
  const reg2 = await api('GET', '/api/fixed-assets?view=register');
  const rest = reg2.assets.find((r) => r.name === 'Moulding line' && r.status === 'in_use');
  const partRow = reg2.assets.find((r) => r.name === 'Moulding line (part)');
  check('Part disposal: the rest stays in use at ₹7,00,000 with 70% of the depreciation', rest?.costPaise === 7_00_000_00 && rest?.accumulatedPaise === charged['Moulding line'] - partBefore, `${inr(rest?.costPaise ?? 0)} / ${inr(rest?.accumulatedPaise ?? 0)}`);
  check('Part disposal: the part is its own asset, disposed', partRow?.status === 'disposed' && partRow?.tagNo?.startsWith(rest?.tagNo ?? '?'), partRow?.tagNo);

  // ── 4. Out of later runs: depreciation to 31 October leaves them out ──────
  await page.getByRole('tab', { name: 'Depreciation' }).click();
  await pick(page, field(page.getByRole('tabpanel'), 'Branch').locator('[data-slot="select-trigger"]'), branch ?? /from/);
  await field(page.getByRole('tabpanel'), 'Up to').locator('input').fill('2026-10-31');
  await page.getByRole('tabpanel').getByText('Dr Depreciation · Cr Accumulated Depreciation').waitFor();
  const run2 = await page.getByRole('tabpanel').locator('table').first().innerText();
  check('The next run has only the moulding line that stayed', run2.includes('Moulding line') && !/CNC lathe|Delivery van|Old server/.test(run2), run2.replace(/\s+/g, ' ').slice(0, 200));
  await shot('run-after-disposals');
  await page.getByRole('tabpanel').getByRole('button', { name: /^Post$/ }).click();
  await toast(page, /Depreciation of ₹/);

  // ── 4. The Disposals report, tied to the ledger ───────────────────────────
  await page.getByRole('tab', { name: 'Disposals' }).click();
  const rep = page.locator('[data-slot="asset-disposals"]');
  await rep.locator('[data-slot="disposals-tie"]').waitFor();
  const rows = await rep.locator('[data-slot="disposal-row"]').count();
  const partGain = partBefore + partCatch - part.cost;
  const totalGain = latheGain + vanGain - srvLoss + partGain;
  const tie = await rep.locator('[data-slot="disposals-tie"]').innerText();
  const totals = await rep.locator('[data-slot="disposals-total"]').innerText();
  check('Disposals report: four more disposals', rows === base.rows.length + 4, `${rows} rows, ${base.rows.length} before`);
  check('Disposals report: the total gain (loss) is the sum worked out here', totals.includes(inr(Math.abs(totalGain + base.totals.gainPaise)).slice(1)), inr(totalGain + base.totals.gainPaise));
  check('Disposals report ties to the general ledger', /Ties to the general ledger/.test(tie), tie.split('\n')[0]);
  await shot('disposals-report');
  // The same figure from the ledger itself (Profit on Sale and Loss on Sale for the year).
  const ledger = await api('GET', `/api/fixed-assets?view=disposals&from=2026-04-01&to=2027-03-31`);
  check('Ledger: Profit on Sale less Loss on Sale equals the report', ledger.ledger.fromDisposalsPaise === totalGain + base.totals.gainPaise && ledger.ties, inr(ledger.ledger.netGainPaise));

  // ── 4. Undo the lathe's disposal, with a reason ───────────────────────────
  dlg = await openAsset('CNC lathe');
  await dlg.locator('[data-slot="asset-undo-disposal"]').click();
  const confirm = page.locator('[role="dialog"], [role="alertdialog"]').filter({ has: page.getByPlaceholder(/^Reason/) }).last();
  await confirm.getByPlaceholder(/^Reason/).fill('Buyer backed out; the lathe is still on the shop floor');
  await shot('undo-reason');
  await clickAndWait(page, confirm.getByRole('button', { name: 'Undo disposal' }), '/api/fixed-assets');
  await toast(page, /Disposal undone/);
  await page.waitForTimeout(800);
  const after = await api('GET', `/api/fixed-assets?view=asset&id=${latheId}`);
  check('Undo: the lathe is back in use', after.asset.status === 'in_use');
  const inv = rec?.invoiceId ? await api('GET', `/api/invoices/${rec.invoiceId}`).catch(() => null) : null;
  check('Undo: the sale invoice is void', !rec?.invoiceId || (inv?.invoice?.status ?? inv?.status) === 'void', inv?.invoice?.status ?? inv?.status);
  const missed = after.depreciation.find((l) => l.from === '2026-09-01' && l.to === '2026-10-31');
  check('Undo: the depreciation it missed (Sept–Oct) is charged at once', missed?.amountPaise === dep(lathe, '2026-09-01', '2026-10-31', charged['CNC lathe']), inr(missed?.amountPaise ?? 0));
  check('Undo: the disposal stays on record, marked undone with the reason', after.disposals.some((x) => x.status === 'undone' && /Buyer backed out/.test(x.undoReason ?? '')));
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Disposals' }).click();
  await rep.locator('[data-slot="disposals-undone"]').waitFor();
  check('Disposals report: three left, the undone one listed apart', await rep.locator('[data-slot="disposal-row"]').count() === base.rows.length + 3 && /Ties to the general ledger/.test(await rep.locator('[data-slot="disposals-tie"]').innerText()));
  await shot('report-after-undo');

  // ── 4. The fixed asset schedule (Schedule III), tied ──────────────────────
  await page.getByRole('tab', { name: /Schedule/ }).click();
  const sch = page.locator('[data-slot="asset-schedule"]');
  await sch.locator('[data-slot="schedule-ties"]').waitFor();
  const ties = await sch.locator('[data-slot="schedule-ties"]').innerText();
  const pmRow = await sch.locator('[data-slot="schedule-row"]', { hasText: 'Plant & Machinery' }).innerText();
  check('Schedule: every check against the ledger passes', !/Differs/.test(ties) && (ties.match(/Pass/g) ?? []).length >= 4, ties.replace(/\s+/g, ' ').slice(0, 300));
  check('Schedule: Plant & Machinery shows the part disposed of (₹3,00,000)' + (FRESH ? ' and ₹16,00,000 added' : ''), pmRow.includes('3,00,000.00') && (!FRESH || pmRow.includes('16,00,000.00')), pmRow.replace(/\s+/g, ' '));
  await shot('schedule-iii');

  // ── 4. Income tax: the van's sale out of its block (section 43(6)) ────────
  await page.getByRole('tab', { name: 'Income-tax book' }).click();
  await page.getByText('Motor cars').first().waitFor();
  const it = await page.getByRole('row').filter({ hasText: 'Motor cars' }).first().innerText();
  const itData = await api('GET', '/api/fixed-assets?view=it&fy=2026');
  const motor = itData.blocks.find((b) => /Motor cars/.test(b.block));
  check('Income-tax book: the van\'s ₹6,50,000 comes out of the Motor cars block (section 43(6))',
    FRESH ? it.includes('6,50,000.00') && motor?.salesPaise === 6_50_000_00 : (motor?.salesPaise ?? 0) >= 6_50_000_00, `${it.replace(/\s+/g, ' ')} | sold ${inr(motor?.salesPaise ?? 0)}`);
  await shot('it-block');

  // ── 5. Disposal approval: a second person approves ────────────────────────
  await page.getByRole('tab', { name: 'Classes' }).click();
  const card = page.locator('[data-slot="disposal-approval"]');
  await card.waitFor();
  const on = card.locator('[data-slot="disposal-approval-on"]');
  if (!(await on.isChecked())) await on.check();
  await field(card, 'From').locator('input').fill('100000');
  await pick(page, field(card, 'Approved by').locator('[data-slot="select-trigger"]'), /An accountant/);
  await card.locator('[data-slot="disposal-approval-save"]').click();
  await toast(page, /wait for approval/);
  await shot('approval-rule');
  dlg = await openAsset('CNC lathe');
  p = await disposePanel(dlg);
  await p.locator('[data-slot="dispose-how-scrap"]').click();
  await p.locator('[data-slot="dispose-date"]').fill('2026-11-05');
  await p.getByText(/will wait for an accountant/).waitFor();
  await clickAndWait(page, p.locator('[data-slot="dispose-submit"]'), '/api/fixed-assets');
  await toast(page, /sent for approval/);
  await page.keyboard.press('Escape');
  const pend = await api('GET', `/api/fixed-assets?view=asset&id=${latheId}`);
  check('Approval: waiting, nothing posted, the lathe still in use', pend.asset.status === 'in_use' && pend.disposals.some((x) => x.status === 'pending'));
  await page.getByRole('tab', { name: 'Disposals' }).click();
  await page.locator('[data-slot="disposals-pending"]').waitFor();
  check('Approval: the person who asked cannot approve it', await page.locator('[data-slot="disposal-approve"]').count() === 0);
  await shot('approval-pending');

  // The checker signs in.
  let checkerEmail = 'priya@raceautospares.in';
  let checkerPassword = 'Rekonza@2026';
  if (FRESH) {
    checkerEmail = `checker+${Date.now().toString(36)}@example.in`;
    const made = await api('POST', '/api/settings/users', { action: 'add', name: 'Checker Accountant', email: checkerEmail, role: 'accountant' });
    checkerPassword = made.temporaryPassword;
  }
  const ctx2 = await t.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => t.errors.push(`checker pageerror: ${e.message}`));
  await login(p2, checkerEmail, checkerPassword);
  p2.setDefaultTimeout(60_000);
  await p2.goto(`${BASE}/accountant/fixed-assets?tab=disposals`, { waitUntil: 'load' });
  await p2.locator('[data-slot="disposals-pending"]').waitFor();
  await clickAndWait(p2, p2.locator('[data-slot="disposal-approve"]').first(), '/api/fixed-assets');
  await p2.locator('[data-sonner-toast]', { hasText: /Approved and posted/ }).first().waitFor();
  await p2.screenshot({ path: `${process.env.SHOTS || 'scripts/e2e/shots'}/9-${String(++t.state.n).padStart(2, '0')}-approved-by-checker${FRESH ? '-fresh' : ''}.png` });
  await ctx2.close();
  const done = await api('GET', `/api/fixed-assets?view=asset&id=${latheId}`);
  const posted = done.disposals.find((x) => x.status === 'posted');
  check('Approval: once approved by the checker it posts; the lathe is disposed', done.asset.status === 'disposed' && !!posted?.entryId);

  // ── The books still balance ───────────────────────────────────────────────
  const final = await api('GET', `/api/fixed-assets?view=disposals&from=2026-04-01&to=2027-03-31`);
  const schedule = await api('GET', '/api/fixed-assets?view=schedule&fy=2026');
  check('In the end: report ties, and the schedule ties to every ledger', final.ties && schedule.ties.every((x) => x.differencePaise === 0));
  await page.goto(`${BASE}/reports/trial-balance`, { waitUntil: 'domcontentloaded' });
  await page.getByText('The books balance').first().waitFor({ timeout: 60_000 }).catch(() => {});
  check('Trial balance balances', await page.getByText('The books balance').count() > 0);
  await shot('trial-balance');
} catch (e) {
  check('The run finished without an error', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await t.finish();
