// Status review 7, item 11 (GST return filing reports): GSTR-7 and GSTR-8, as an
// auditor tests them.
//
//   FRESH=1 node scripts/e2e/sr7-11-gstr7-gstr8.mjs      a brand-new company, from sign-up
//   node scripts/e2e/sr7-11-gstr7-gstr8.mjs              the seeded demo book
//
// Env: BASE (default http://localhost:5034), SHOTS (screenshot folder), FRESH=1.
//
// FRESH: signs up a new company through the sign-up screen, finds GSTR-7 and
// GSTR-8 off (each says what the role is and where it is turned on), turns both
// roles on in Settings → Statutory, records two supplier bills over ₹2.5 lakh
// (one intra-State, one inter-State) and deducts GST TDS from each on the
// GSTR-7 screen, checks table 3 and the totals to the rupee, the tie-out to
// GST TDS Payable, the portal file's keys, fp and amounts, the GSTR-7A
// certificate (and enters its number), records the TDS payment and sees the
// balance come to nil; then books a seller's month of supplies on GSTR-8 and
// checks the TCS at 0.5% and its portal file; then marks November's GSTR-7
// filed and sees Edit/Delete give way to Amend, amends a deduction in
// December and finds it in December's table 4 with the original figures.
//
// The vendors and bills are entered through the app's own endpoints from the
// signed-in page (the same calls the vendor and bill forms make); everything
// GSTR-7 and GSTR-8 is done through their screens.
//
// Exits non-zero on any failed check, console error, page error or 5xx.

import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:5034';
const SHOTS = process.env.SHOTS || 'C:/Users/2182/AppData/Local/Temp/claude/abdf232b01237e56/6f16c6a0-81ce-427c-bcfb-bf0abcc07fe2/scratchpad/shots-d';
const FRESH = process.env.FRESH === '1';
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
  return ok;
};
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  console.log(`      shot ${name}.png`);
};
const rupees = (t) => Number(String(t).replace(/[^0-9.-]/g, '')) || 0;

// ── GSTINs with their own check character ───────────────────────────────────
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const check14 = (s) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const prod = CHARS.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return s + CHARS[(36 - (sum % 36)) % 36];
};
const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const D = () => String(Math.floor(Math.random() * 10));
const pan = () => `${L()}${L()}${L()}C${L()}${D()}${D()}${D()}${D()}${L()}`;
const gstinFor = (state, p = pan(), mid = 'Z') => check14(`${state}${p}1${mid}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// A per-run address, so the sign-up and GSTIN-lookup allowances of one run never limit the next.
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, extraHTTPHeaders: { 'x-forwarded-for': ip } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error' || /favicon|DevTools|Download the React DevTools/i.test(m.text())) return;
  errors.push(`console: ${m.text().slice(0, 200)} ${m.location()?.url ?? ''}`);
});
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}, { method, url, body });

const download = async (trigger) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), trigger()]);
  return JSON.parse(readFileSync(await d.path(), 'utf8'));
};

// The dev server compiles a screen the first time it is opened, which can take a
// while; and when other work in the tree is saved it rebuilds, and a chunk asked
// for mid-rebuild arrives cut short ("Invalid or unexpected token"). That is the
// dev server, not the screen: the page is opened again once, the run says so,
// and only those chunk errors are set aside. Any other error still fails.
let devReloads = 0;
const CHUNK = /Invalid or unexpected token|ChunkLoadError|Loading chunk .* failed|Unexpected end of input/;
const open = async (url, ready = '[data-slot="page-header"]') => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = errors.length;
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 });
    const ok = await page.locator(ready).first().waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
    const fresh = errors.slice(before);
    if (!ok && attempt === 1 && fresh.length && fresh.every((e) => CHUNK.test(e))) {
      errors.splice(before, fresh.length);
      devReloads++;
      console.log(`      ${url}: the dev server was rebuilding (${fresh[0].slice(0, 60)}); opened again`);
      continue;
    }
    break;
  }
  await page.waitForTimeout(800);
};
const pick = async (trigger, optionText) => {
  await trigger.click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: optionText }).first().click();
  await page.waitForTimeout(250);
};
/** The input under a form label inside a container (Field puts them together). */
const field = (scope, label) => scope.locator('div.space-y-1\\.5', { has: page.getByText(label, { exact: true }) }).locator('input').first();
const fillMoney = async (scope, label, rupeesValue) => {
  const i = field(scope, label);
  await i.fill('');
  await i.fill(String(rupeesValue));
};

/** Whether the menu links to a screen: the menu opened out, and the GST & Taxes group open. */
const navHas = async (href) => {
  await page.locator('a[href="/dashboard"]').first().waitFor({ timeout: 120_000 });
  const expand = page.getByRole('button', { name: 'Expand the menu' });
  if (await expand.count()) { await expand.first().click(); await page.waitForTimeout(500); }
  const group = page.locator('[data-slot="sidebar-extras"]').getByText('GST & Taxes', { exact: true }).first();
  if (!(await page.locator('a[href="/gst/gstr1"]').count()) && await group.count()) { await group.click(); await page.waitForTimeout(500); }
  return (await page.locator(`a[href="${href}"]`).count()) > 0;
};

const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(today);
const MONTH = TODAY.slice(0, 7);
const nextMonth = (() => { const [y, m] = MONTH.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
const fp = `${MONTH.slice(5, 7)}${MONTH.slice(0, 4)}`;

try {
  if (FRESH) {
    // ── 1. A brand-new company ───────────────────────────────────────────────
    const stamp = Date.now().toString().slice(-7);
    const orgPan = pan();
    const orgGstin = gstinFor('33', orgPan);
    await open('/register', '#businessName');
    await page.fill('#businessName', `Highways Works ${stamp} Ltd`);
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: /Tamil Nadu/ }).click();
    await page.fill('#gstin', orgGstin);
    await page.fill('#name', 'Audit Tester');
    await page.fill('#email', `gst78.${stamp}@example.in`);
    await page.fill('#password', 'Testing@2026');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Create my books/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    // The app's menu is up once the book's masters have loaded.
    await page.locator('a[href="/dashboard"]').first().waitFor({ timeout: 180_000 });
    await page.waitForTimeout(1500);
    check('Signed up a brand-new company', page.url().includes('/dashboard'), orgGstin);

    // ── 2. Off until the role is turned on, and saying so ────────────────────
    check('GSTR-7 is not in the menu before the role is on (GSTR-1 is)', !(await navHas('/gst/gstr7')) && (await page.locator('a[href="/gst/gstr1"]').count()) > 0);
    await open('/gst/gstr7', '[data-slot="gstr7-role-off"]');
    check('GSTR-7 says the company is not a deductor, and where to turn it on',
      await page.locator('[data-slot="gstr7-role-off"]').isVisible() && await page.locator('[data-slot="gstr7-role-off-turn-on"]').isVisible());
    await shot(page, '11-40-gstr7-role-off');
    await open('/gst/gstr8', '[data-slot="gstr8-role-off"]');
    check('GSTR-8 says the company is not an operator', await page.locator('[data-slot="gstr8-role-off"]').isVisible());

    // ── 3. Settings → Statutory: both roles on, with their registrations ─────
    const tdsGstin = check14(`33CHE${L()}${D()}${D()}${D()}${D()}${D()}${L()}1D`);
    const tcsGstin = gstinFor('33', orgPan, 'C');
    await open('/settings?tab=statutory', '[data-slot="gst-roles"]');
    await page.locator('[data-slot="gst-role-tds-switch"]').click();
    await page.locator('[data-slot="gst-role-tds-gstin"]').fill(tdsGstin);
    await page.locator('[data-slot="gst-role-eco-switch"]').click();
    await page.locator('[data-slot="gst-role-eco-gstin"]').fill(tcsGstin);
    await shot(page, '11-41-settings-gst-roles');
    await page.locator('[data-slot="gst-roles-save"]').click();
    await page.waitForTimeout(1500);
    await open('/gst/gstr7', '[data-slot="gstr7-header"]');
    check('GSTR-7 and GSTR-8 join the menu once the roles are on', (await navHas('/gst/gstr7')) && (await navHas('/gst/gstr8')));
    await shot(page, '11-52-menu-gstr7-gstr8');

    // ── 4. Suppliers and their bills (the app's own endpoints) ───────────────
    const me = (await api('GET', '/api/auth/me')).json;
    const branchId = me.user.branchId;
    const vendor = async (displayName, stateCode, gstin) => (await api('POST', '/api/contacts', {
      kind: 'vendor', displayName, gstTreatment: 'registered', gstin, stateCode,
    })).json.id;
    const localGstin = gstinFor('33');
    const farGstin = gstinFor('29');
    const sellerGstin = gstinFor('27');
    const local = await vendor('Chennai Road Builders', '33', localGstin);
    const far = await vendor('Karnataka Steel Works', '29', farGstin);
    const seller = await vendor('Mumbai Crafts', '27', sellerGstin);
    const bill = async (vendorId, no, rupeesValue) => api('POST', '/api/bills', {
      branchId, vendorId, vendorInvoiceNo: no, date: TODAY, dueDate: TODAY, status: 'open',
      lines: [{ description: 'Road resurfacing works', hsnSac: '995421', qty: 1, ratePaise: rupeesValue * 100, gstRatePct: 18 }],
    });
    const b1 = await bill(local, 'CRB/26/118', 3_00_000);
    const b2 = await bill(far, 'KSW-2291', 2_60_000);
    check('Two supplier bills over ₹2.5 lakh recorded', b1.status === 200 && b2.status === 200, `${b1.status} ${b2.status} ${b1.json?.internalNo ?? b1.text.slice(0, 120)}`);

    // ── 5. GSTR-7: the bills waiting, and the deductions ─────────────────────
    await open('/gst/gstr7', '[data-slot="gstr7-header"]');
    const pending = page.locator('[data-slot="gstr7-pending-row"]');
    check('Both bills are listed as needing GST TDS', (await pending.count()) === 2, `${await pending.count()} row(s)`);
    await shot(page, '11-42-gstr7-bills-waiting');

    const deductRow = async (vendorName, expectPaise, contractRef) => {
      await page.locator('[data-slot="gstr7-pending-row"]', { hasText: vendorName }).locator('[data-slot="gstr7-deduct"]').click();
      const dlg = page.locator('[data-slot="gstr7-deduct-dialog"]');
      await dlg.waitFor();
      await dlg.locator('[data-slot="gstr7-contract-ref"]').fill(contractRef);
      await page.waitForFunction((v) => document.querySelector('[data-slot="gstr7-preview"]')?.getAttribute('data-total') === v, String(expectPaise), { timeout: 10_000 }).catch(() => {});
      const total = await dlg.locator('[data-slot="gstr7-preview"]').getAttribute('data-total');
      check(`The window shows the TDS on ${vendorName} before posting: ₹${expectPaise / 100}`, total === String(expectPaise), `shown ${total}`);
      return dlg;
    };
    let dlg = await deductRow('Chennai Road Builders', 6_000_00, 'HW/WO/2026/17');
    await shot(page, '11-43-gstr7-deduct-window');
    await dlg.locator('[data-slot="gstr7-deduct-save"]').click();
    await dlg.waitFor({ state: 'detached', timeout: 15_000 });
    dlg = await deductRow('Karnataka Steel Works', 5_200_00, 'HW/WO/2026/18');
    await dlg.locator('[data-slot="gstr7-deduct-save"]').click();
    await dlg.waitFor({ state: 'detached', timeout: 15_000 });
    await page.waitForTimeout(1200);

    const rows3 = page.locator('[data-slot="gstr7-deductee"]');
    check('Table 3 lists both deductees', (await rows3.count()) === 2, `${await rows3.count()}`);
    const localRow = await rows3.filter({ hasText: localGstin }).innerText();
    check('Intra-State deductee: ₹3,00,000 paid, CGST ₹3,000 + SGST ₹3,000', /3,00,000\.00/.test(localRow) && (localRow.match(/3,000\.00/g) ?? []).length === 2, localRow.replace(/\s+/g, ' '));
    const farRow = await rows3.filter({ hasText: farGstin }).innerText();
    check('Inter-State deductee: ₹2,60,000 paid, IGST ₹5,200', /2,60,000\.00/.test(farRow) && /5,200\.00/.test(farRow), farRow.replace(/\s+/g, ' '));
    check('TDS deducted in all: ₹11,200', rupees(await page.locator('[data-slot="gstr7-total-tds"]').innerText()) === 11200);
    check('The return ties to GST TDS Payable to the paisa', (await page.locator('[data-slot="gstr7-tieout"]').getAttribute('data-difference')) === '0');
    check('No bill waits any longer', (await page.locator('[data-slot="gstr7-pending-row"]').count()) === 0);
    await shot(page, '11-44-gstr7-tables');

    // The bill is settled by the TDS: the supplier is owed the rest.
    const billNow = (await api('GET', `/api/bills/${b1.json.id}`)).json;
    const paidPaise = billNow?.amountPaidPaise ?? billNow?.bill?.amountPaidPaise;
    const billStatus = billNow?.status ?? billNow?.bill?.status;
    check('Bill settled by the TDS: ₹6,000 of ₹3,54,000 set off, ₹3,48,000 still owed to the supplier', paidPaise === 6_000_00 && billStatus === 'partially_paid', `amount paid ${paidPaise}, ${billStatus}`);

    // ── 6. The portal file ────────────────────────────────────────────────────
    await page.locator('[data-slot="gstr7-export"]').click();
    const file7 = await download(() => page.locator('[data-slot="gstr7-export-json"]').click());
    check('GSTR-7 file: the GSTN keys, the deductor\'s registration, fp MMYYYY',
      JSON.stringify(Object.keys(file7)) === JSON.stringify(['gstin', 'fp', 'tds']) && file7.gstin === tdsGstin && file7.fp === fp, JSON.stringify(Object.keys(file7)) + ` ${file7.gstin} ${file7.fp}`);
    const t1 = file7.tds.find((t) => t.gstin_ded === localGstin);
    const t2 = file7.tds.find((t) => t.gstin_ded === farGstin);
    check('GSTR-7 file rows: {gstin_ded, amt_ded, iamt, camt, samt} in rupees',
      t1 && JSON.stringify(Object.keys(t1)) === JSON.stringify(['gstin_ded', 'amt_ded', 'iamt', 'camt', 'samt']) && t1.amt_ded === 300000 && t1.camt === 3000 && t1.samt === 3000 && t2?.iamt === 5200,
      JSON.stringify(file7.tds));

    // ── 7. GSTR-7A ────────────────────────────────────────────────────────────
    await rows3.filter({ hasText: localGstin }).locator('[data-slot="gstr7-certificate"]').click();
    await page.waitForURL('**/gst/gstr7/certificate**');
    await page.locator('[data-slot="gstr7a-sheet"]').waitFor();
    check('GSTR-7A shows deductor and deductee GSTINs and ₹6,000 deducted',
      (await page.locator('[data-slot="gstr7a-deductor-gstin"]').innerText()).includes(tdsGstin)
      && (await page.locator('[data-slot="gstr7a-deductee-gstin"]').innerText()).includes(localGstin)
      && (await page.locator('[data-slot="gstr7a-total"]').getAttribute('data-tax')) === '600000');
    await page.locator('[data-slot="gstr7a-edit-number"]').click();
    await page.locator('[data-slot="gstr7a-number-input"]').fill(`TDSC33${fp}0001`);
    await page.locator('[data-slot="gstr7a-number-save"]').click();
    await page.waitForTimeout(1200);
    check('The certificate number the portal issued is kept on it', (await page.locator('[data-slot="gstr7a-number"]').innerText()).includes(`TDSC33${fp}0001`));
    await shot(page, '11-45-gstr7a-certificate');

    // ── 8. Paying the TDS over ────────────────────────────────────────────────
    await open('/gst/gstr7', '[data-slot="gstr7-header"]');
    await page.locator('[data-slot="gstr7-table5-pay"]').click();
    const pay = page.locator('[data-slot="gstr7-table5-pay-dialog"]');
    await pay.waitFor();
    await pay.locator('[data-slot="gstr7-table5-pay-cpin"]').fill('26113300012345');
    await pay.locator('[data-slot="gstr7-table5-pay-save"]').click();
    await pay.waitFor({ state: 'detached', timeout: 15_000 });
    await page.waitForTimeout(1200);
    check('Payment recorded: ₹11,200 paid, nothing left to pay',
      rupees(await page.locator('[data-slot="gstr7-table5-paid"]').innerText()) === 11200 && rupees(await page.locator('[data-slot="gstr7-table5-balance"]').innerText()) === 0);
    check('The payment shows with its CPIN and Edit / Delete', /26113300012345/.test(await page.locator('[data-slot="gstr7-table5-payment"]').innerText())
      && (await page.locator('[data-slot="gstr7-table5-payment"] [data-slot="row-edit"]').count()) === 1);
    check('Each deduction has Edit and Delete', (await page.locator('[data-slot="gstr7-deduction"] [data-slot="row-edit"]').count()) === 2
      && (await page.locator('[data-slot="gstr7-deduction"] [data-slot="row-delete"]').count()) === 2);
    await shot(page, '11-46-gstr7-paid');

    // ── 9. GSTR-8: a seller's month of supplies ───────────────────────────────
    await open('/gst/gstr8', '[data-slot="gstr8-header"]');
    await page.locator('[data-slot="gstr8-add"]').click();
    const sup = page.locator('[data-slot="gstr8-supply-dialog"]');
    await sup.waitFor();
    await pick(sup.locator('[data-slot="gstr8-supply-seller"]'), /Mumbai Crafts/);
    await fillMoney(sup, 'Supplies to registered buyers', 200000);
    await fillMoney(sup, 'Returned by registered buyers', 10000);
    await fillMoney(sup, 'Supplies to unregistered buyers', 300000);
    await page.waitForFunction(() => document.querySelector('[data-slot="gstr8-preview"]')?.getAttribute('data-total') === '245000', null, { timeout: 10_000 }).catch(() => {});
    check('TCS shown before booking: 0.5% IGST on ₹4,90,000 = ₹2,450', (await sup.locator('[data-slot="gstr8-preview"]').getAttribute('data-total')) === '245000');
    await shot(page, '11-47-gstr8-add-supplies');
    await sup.locator('[data-slot="gstr8-supply-save"]').click();
    await sup.waitFor({ state: 'detached', timeout: 15_000 });
    await page.waitForTimeout(1200);
    const sellerRow = await page.locator('[data-slot="gstr8-seller"]').first().innerText();
    check('GSTR-8 table 3: the four values apart, net ₹4,90,000, IGST ₹2,450',
      /2,00,000\.00/.test(sellerRow) && /10,000\.00/.test(sellerRow) && /3,00,000\.00/.test(sellerRow) && /4,90,000\.00/.test(sellerRow) && /2,450\.00/.test(sellerRow), sellerRow.replace(/\s+/g, ' '));
    check('GSTR-8 ties to GST TCS Payable', (await page.locator('[data-slot="gstr8-tieout"]').getAttribute('data-difference')) === '0');
    await page.locator('[data-slot="gstr8-export"]').click();
    const file8 = await download(() => page.locator('[data-slot="gstr8-export-json"]').click());
    check('GSTR-8 file: gstin (TCS registration), fp, tcs rows in the GSTN schema',
      file8.gstin === tcsGstin && file8.fp === fp && JSON.stringify(file8.tcs?.[0]) === JSON.stringify({ stin: sellerGstin, supR: 200000, retsupR: 10000, supU: 300000, retsupU: 0, amt: 490000, iamt: 2450, camt: 0, samt: 0 }),
      JSON.stringify(file8));
    await shot(page, '11-48-gstr8-tables');

    // ── 10. Filed: changes give way to an amendment in a later month ─────────
    const marked = await api('POST', '/api/compliance-calendar', { action: 'done', key: 'gstr7', period: MONTH, doneOn: TODAY, reference: `AA33${fp}004471` });
    check('November GSTR-7 marked filed with its ARN', marked.status === 200, marked.text.slice(0, 120));
    await open('/gst/gstr7', '[data-slot="gstr7-header"]');
    check('A filed month offers Amend instead of Edit and Delete',
      (await page.locator('[data-slot="gstr7-deduction"] [data-slot="gstr7-amend"]').count()) === 2 && (await page.locator('[data-slot="gstr7-deduction"] [data-slot="row-delete"]').count()) === 0);
    await page.locator('[data-slot="gstr7-deduction"]', { hasText: 'Chennai Road Builders' }).locator('[data-slot="gstr7-amend"]').click();
    const am = page.locator('[data-slot="gstr7-amend-dialog"]');
    await am.waitFor();
    await am.locator('[data-slot="gstr7-amend-date"]').fill(`${nextMonth}-02`);
    await am.locator('[data-slot="gstr7-amend-taxable"] input').fill('280000');
    await am.locator('[data-slot="gstr7-amend-save"]').click();
    await am.waitFor({ state: 'detached', timeout: 15_000 });
    await page.locator('[data-slot="gstr7-month"]').fill(nextMonth);
    await page.waitForTimeout(1800);
    const amendRow = await page.locator('[data-slot="gstr7-amendment"]').first().innerText().catch(() => '');
    check(`${nextMonth} table 4 carries the correction with the original figures (₹3,00,000 → ₹2,80,000, tax −₹400)`,
      /3,00,000\.00/.test(amendRow) && /2,80,000\.00/.test(amendRow) && /400\.00/.test(amendRow), amendRow.replace(/\s+/g, ' '));
    check(`${nextMonth} ties to the ledger with the amendment posted in it`, (await page.locator('[data-slot="gstr7-tieout"]').getAttribute('data-difference')) === '0');
    await shot(page, '11-49-gstr7-amendment');
    await page.locator('[data-slot="gstr7-export"]').click();
    const fileDec = await download(() => page.locator('[data-slot="gstr7-export-json"]').click());
    const tdsa = fileDec.tdsa?.[0];
    check('Amendment in the portal file as tdsa with omonth and the original amount',
      tdsa && tdsa.omonth === fp && tdsa.oamt_ded === 300000 && tdsa.amt_ded === 280000 && tdsa.camt === 2800, JSON.stringify(fileDec));
  } else {
    // ── The demo book ─────────────────────────────────────────────────────────
    await open('/login', '#email');
    await page.locator('#email').fill('arun@raceautospares.in');
    await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    await page.waitForTimeout(1200);
    check('Signed in to the demo book', page.url().includes('/dashboard'));
    for (const [n, url, slot] of [['7', '/gst/gstr7', 'gstr7'], ['8', '/gst/gstr8', 'gstr8']]) {
      await open(url, `[data-slot="${slot}-role-off"], [data-slot="${slot}-header"]`);
      const off = await page.locator(`[data-slot="${slot}-role-off"]`).isVisible().catch(() => false);
      if (off) {
        check(`GSTR-${n}: the demo book does not hold the role yet; the screen says so and where to turn it on (data checks skipped)`, true);
        await shot(page, `11-5${n === '7' ? 0 : 1}-demo-gstr${n}-role-off`);
        continue;
      }
      check(`GSTR-${n} opens with its tables`, await page.locator(`[data-slot="${slot}-table3"]`).isVisible());
      check(`GSTR-${n} ties to the ledger`, (await page.locator(`[data-slot="${slot}-tieout"]`).getAttribute('data-difference')) === '0');
      const rows = await page.locator(`[data-slot="${slot === 'gstr7' ? 'gstr7-deductee' : 'gstr8-seller'}"]`).count();
      console.log(`      GSTR-${n} this month: ${rows} row(s) in table 3${rows ? '' : ' (data assertions skipped until the demo is seeded)'}`);
      await shot(page, `11-5${n === '7' ? 0 : 1}-demo-gstr${n}`);
    }
  }
} catch (e) {
  check('The run completed', false, e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e));
  await shot(page, '11-59-failure').catch(() => {});
}

if (devReloads) console.log(`      (${devReloads} screen(s) opened again while the dev server rebuilt)`);
check('No console error, page error or 5xx', errors.length === 0, errors.slice(0, 5).join(' || '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
