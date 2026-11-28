// The independent auditor check of item 11 (GST return filing), 2026-11-28:
// its five defects, done again through the screens.
//
//   FRESH=1 node scripts/e2e/fx-a-gst-fixes.mjs    a brand-new company, from sign-up
//   node scripts/e2e/fx-a-gst-fixes.mjs            the seeded demo book
//
// Env: BASE (default http://localhost:5041), SHOTS (screenshot folder), FRESH=1.
//
// 1. GSTR-2B in the GSTN portal's own JSON layout (docdata.b2b[].inv[].items[])
//    imported on ITC Reconciliation: the supplier's invoice shows its tax in the
//    Portal column and matches the bill; a credit note in 2B layout is listed;
//    a bill of entry (IMPG) is read. The same statement in the 2A layout
//    (itms[].itm_det) matches too, and a GSTR-1 file is refused saying why.
// 2. A customer advance of ₹11,800 on Payments Received → Customer Advance: the
//    form asks what it is for and will not save unanswered; for services, its
//    ₹1,800 GST is in GSTR-1 11 Advances (11A) and its JSON (at), in GSTR-3B
//    3.1(a), and the return ties to the ledger. Applied to an invoice the next
//    month it moves to 11B (txpd) and comes off 3.1(a).
// 3. An item saved with HSN 8708: the bill line, GSTR-1's B2B and B2C HSN
//    tables and the JSON all show 8708, never 870899.
// 4. A credit note with a line without HSN/SAC: the form says so as it is typed,
//    and the save warns.
// 5. Mark GSTR-1 filed: the lock is offered unticked, explained (no edits to the
//    period's documents; corrections in a later return under s.37(3)), and
//    marking filed without it leaves the period open.
//
// FRESH does all of it in a new company. The demo book shows the same screens
// on its own data (the advance and 2B steps are run there too, in their own
// month, without touching what the reviewers read).
//
// Exits non-zero on any failed check, console error, page error or 5xx.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:5041';
const SHOTS = process.env.SHOTS || 'C:/Users/2182/AppData/Local/Temp/claude/abdf232b01237e56/6f16c6a0-81ce-427c-bcfb-bf0abcc07fe2/scratchpad/shots-fx-a';
const FRESH = process.env.FRESH === '1';
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0, shots = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
  return ok;
};
const rupees = (t) => {
  const s = String(t ?? '').trim();
  if (!s || s === '—') return 0;
  const n = Number(s.replace(/[^0-9.]/g, '')) || 0;
  return /^[-−(]/.test(s) ? -n : n;
};

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
const gstinFor = (state) => check14(`${state}${pan()}1Z`);

let browser;
try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = await chromium.launch({ headless: true }); }
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, extraHTTPHeaders: { 'x-forwarded-for': ip } });
const page = await ctx.newPage();
page.setDefaultTimeout(120_000);

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error' || /favicon|DevTools|Download the React DevTools/i.test(m.text())) return;
  // A refusal the script provokes on purpose (the GSTR-1 file offered as a 2B) is a 4xx.
  if (/status of 4\d\d/.test(m.text())) return;
  errors.push(`console: ${m.text().slice(0, 200)} ${m.location()?.url ?? ''}`);
});
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

const shot = async (what) => {
  shots++;
  const name = `fx-a-${String(shots).padStart(2, '0')}-${what}${FRESH ? '' : '-demo'}.png`;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  console.log(`      shot ${name}`);
};
const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}, { method, url, body });
const open = async (url, ready = '[data-slot="page-header"]') => {
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
  await page.locator(ready).first().waitFor({ timeout: 240_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(800);
};
/** Open a combobox and pick the option matching `name`, typing `search` first when given. */
const pick = async (trigger, name, search) => {
  await trigger.click();
  await page.waitForTimeout(400);
  if (search) { await page.keyboard.type(search, { delay: 20 }); await page.waitForTimeout(700); }
  await page.getByRole('option', { name }).first().click();
  await page.waitForTimeout(500);
};
const toastText = async () => (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
const waitToast = async (re, timeout = 60_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await toastText();
    if (re.test(t)) return t;
    await page.waitForTimeout(500);
  }
  return toastText();
};
const cells = async (row) => (await row.locator('td').allInnerTexts()).map((x) => x.trim());

const now = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) + 'T00:00:00');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(now);
const CUR = TODAY.slice(0, 7);
const PREV = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);
const day = (n) => `${CUR}-${String(Math.min(n, now.getDate())).padStart(2, '0')}`;
const mmyyyy = (m) => `${m.slice(5, 7)}${m.slice(0, 4)}`;
const dmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const stamp = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

try {
  let orgGstin;
  if (FRESH) {
    // ── A brand-new company ──────────────────────────────────────────────────
    orgGstin = gstinFor('33');
    await open('/register', '#businessName');
    await page.fill('#businessName', `Auditor Alpha Traders ${stamp}`);
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: /Tamil Nadu/ }).click();
    await page.fill('#gstin', orgGstin);
    await page.fill('#name', 'Audit Tester');
    await page.fill('#email', `fxa.${stamp}@example.in`);
    await page.fill('#password', 'Testing@2026');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Create my books/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    check('Signed up a brand-new company', page.url().includes('/dashboard'), orgGstin);
  } else {
    await open('/login', '#email');
    await page.fill('#email', 'arun@raceautospares.in');
    await page.fill('#password', 'Rekonza@2026');
    await page.waitForTimeout(800);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    check('Signed in to the demo book', page.url().includes('/dashboard'));
  }

  const me = (await api('GET', '/api/auth/me')).json;
  const branchId = me.user.branchId ?? me.branches?.[0]?.id;
  const branch = (me.branches ?? []).find((b) => String(b.id) === String(branchId)) ?? me.branches?.[0];
  orgGstin ??= branch?.gstin;
  const contact = async (kind, displayName, gstTreatment, stateCode, gstin) => {
    const r = await api('POST', '/api/contacts', { kind, displayName, gstTreatment, stateCode, ...(gstin ? { gstin } : {}) });
    return r.json?.id ?? (console.log('contact', r.status, r.text.slice(0, 200)), null);
  };
  const tag = FRESH ? '' : ` ${stamp}`;
  const buyer = await contact('customer', `Kaveri Retail Pvt Ltd${tag}`, 'registered', '33', gstinFor('33'));
  const walkIn = await contact('customer', `Walk-in Consumer TN${tag}`, 'consumer', '33');
  const vendorGstin = gstinFor('33');
  const vendor = await contact('vendor', `Nila Suppliers Pvt Ltd${tag}`, 'registered', '33', vendorGstin);
  const itemR = await api('POST', '/api/items', { itemType: 'sales_and_purchases', isDigitalService: false, uqc: 'NOS', kind: 'goods', name: `CN Gadget${tag}`, hsnSac: FRESH ? '8708' : '870830', salePricePaise: 500_00, purchasePricePaise: 300_00, gstRatePct: 18, taxPref: 'taxable' });
  const gadget = itemR.json?.id;
  const CODE = FRESH ? '8708' : '870830';
  check('A customer, a consumer, a supplier and an item on HSN ' + CODE, !!(buyer && walkIn && vendor && gadget), itemR.status !== 200 ? itemR.text.slice(0, 160) : '');

  // ── 3. One item, one HSN code ───────────────────────────────────────────────
  const billNo = `NS-B-${stamp.slice(-4)}`;
  const bill = await api('POST', '/api/bills', { branchId, vendorId: vendor, vendorInvoiceNo: billNo, date: day(3), dueDate: day(3), status: 'open', lines: [{ itemId: gadget, qty: 20, ratePaise: 300_00 }] });
  const b2b = await api('POST', '/api/invoices', { branchId, customerId: buyer, date: day(11), dueDate: day(11), status: 'approved', lines: [{ itemId: gadget, qty: 10, ratePaise: 500_00 }] });
  const b2c = await api('POST', '/api/invoices', { branchId, customerId: walkIn, date: day(12), dueDate: day(12), status: 'approved', lines: [{ itemId: gadget, qty: 4, ratePaise: 500_00 }] });
  check('A bill and B2B and B2C invoices of the item, with no code typed on the lines', [bill, b2b, b2c].every((r) => r.status === 200), [bill, b2b, b2c].map((r) => r.status === 200 ? 200 : `${r.status} ${r.text.slice(0, 120)}`).join(' | '));
  const billId = bill.json?.id;
  await open(`/purchases/bills/${billId}`, 'table');
  const billText = await page.locator('main').innerText();
  check(`The bill line shows the item's HSN ${CODE}, not 870899`, billText.includes(CODE) && !/870899/.test(billText));
  await shot('bill-line-hsn');

  await open(`/gst/gstr1?period=${CUR}`, '[data-slot="return-filing-bar"]');
  await page.locator('[data-slot="gstr1-tab-hsn"]').waitFor({ timeout: 120_000 });
  await page.locator('[data-slot="gstr1-tab-hsn"]').click();
  await page.waitForTimeout(600);
  const hsnRow = (slot) => page.locator(`[data-slot="gstr1-table-${slot}"] tbody tr`, { hasText: CODE }).first();
  const b2bHsn = await cells(hsnRow('hsn-b2b'));
  const b2cHsn = await cells(hsnRow('hsn-b2c'));
  check(`GSTR-1 12 B2B HSN: ${CODE} for the item`, b2bHsn[0]?.startsWith(CODE), b2bHsn.join(' · '));
  check(`GSTR-1 12 B2C HSN: ${CODE} for the item`, b2cHsn[0]?.startsWith(CODE), b2cHsn.join(' · '));
  if (FRESH) check('No 870899 anywhere in table 12', !/870899/.test(await page.locator('[data-slot="gstr1-table-hsn-b2b"]').innerText() + await page.locator('[data-slot="gstr1-table-hsn-b2c"]').innerText()));
  await shot('gstr1-hsn-same-code');
  const fileCur = (await api('GET', `/api/gst?view=gstr1-file&period=${CUR}`)).json;
  const codes = (k) => (fileCur?.hsn?.[k] ?? []).map((r) => r.hsn_sc);
  check(`GSTR-1 JSON: hsn_b2b and hsn_b2c both carry ${CODE}`, codes('hsn_b2b').includes(CODE) && codes('hsn_b2c').includes(CODE) && (!FRESH || ![...codes('hsn_b2b'), ...codes('hsn_b2c')].includes('870899')), JSON.stringify({ b2b: codes('hsn_b2b'), b2c: codes('hsn_b2c') }));

  // ── 2. A customer advance for services ──────────────────────────────────────
  // FRESH: last month, so it is applied to this month's invoice below (11A then 11B).
  // Demo: this month, on a customer of its own, so last month's figures stay as recorded.
  const ADV_MONTH = FRESH ? PREV : CUR;
  const advDate = FRESH ? `${PREV}-24` : day(14);
  await open('/sales/payments/new', '[data-slot="payment-form"]');
  await page.locator('[data-slot="payment-tab-advance"]').click();
  await page.waitForTimeout(400);
  await pick(page.locator('[data-slot="payment-form"] [data-slot="combobox-trigger"]').first(), /Walk-in Consumer TN/, `Walk-in Consumer TN${tag}`);
  // Amount Received is the first figure on the Customer Advance tab.
  const amount = page.locator('main input[type="number"]').first();
  await amount.fill('11800');
  await amount.blur();
  await page.locator('input[type="date"]').first().fill(advDate);
  await page.waitForTimeout(500);
  const asked = page.locator('[data-slot="advance-for"]');
  check('The receipt asks what the advance is for: services or goods', await asked.isVisible() && /Services: GST is due on it now/.test(await asked.innerText()) && /Goods: no GST until the invoice/.test(await asked.innerText()));
  const preset = await page.locator('[data-slot="advance-for-services"]').isChecked() || await page.locator('[data-slot="advance-for-goods"]').isChecked();
  if (!preset) {
    await page.locator('[data-slot="save-payment"]').click();
    await page.waitForTimeout(800);
    check('Not saved until it says (a GST-registered book selling goods and services)', /Say what the advance is for/.test(await page.locator('main').innerText()) && page.url().includes('/new'));
    await shot('advance-asked');
  }
  await page.locator('[data-slot="advance-for-services"]').check();
  await page.selectOption('[data-slot="advance-rate"]', '18');
  await page.waitForTimeout(300);
  const gstLine = await page.locator('[data-slot="advance-gst"]').innerText();
  check('For services at 18%: ₹1,800.00 of it is GST, reported in 11A and 3.1(a)', /1,800\.00/.test(gstLine) && /11A/.test(gstLine) && /3\.1\(a\)/.test(gstLine), gstLine.slice(0, 160));
  await shot('advance-for-services');
  await page.locator('[data-slot="save-payment"]').click();
  await page.waitForURL((u) => /\/sales\/payments\/\d+$/.test(u.toString()), { timeout: 90_000 }).catch(() => {});
  const paymentId = (/\/sales\/payments\/(\d+)$/.exec(page.url()) ?? [])[1];
  check('The advance is saved', !!paymentId, page.url());
  await shot('advance-saved');

  await open(`/gst/gstr1?period=${ADV_MONTH}`, '[data-slot="return-filing-bar"]');
  await page.locator('[data-slot="gstr1-tab-adv"]').waitFor({ timeout: 120_000 });
  await page.locator('[data-slot="gstr1-tab-adv"]').click();
  await page.waitForTimeout(600);
  const atRow = page.locator('[data-slot="gstr1-table-at"] tbody tr', { hasText: /Tamil Nadu|33/ }).first();
  const at = await cells(atRow);
  // Place of supply, supply, rate, then taxable, IGST, CGST, SGST, cess.
  const atNums = at.slice(3).map(rupees);
  check('GSTR-1 11A: the advance, intra-state at 18%, at least ₹10,000 taxable and ₹900 CGST + ₹900 SGST', /Intra/.test(at[1] ?? '') && /18%/.test(at[2] ?? '') && atNums[0] >= 10_000 && atNums[2] >= 900 && atNums[3] >= 900 && (!FRESH || (atNums[0] === 10_000 && atNums[2] === 900 && atNums[3] === 900)), at.join(' · '));
  await shot('gstr1-11a-advance');
  const fileAdv = (await api('GET', `/api/gst?view=gstr1-file&period=${ADV_MONTH}`)).json;
  const at33 = (fileAdv?.at ?? []).find((g) => g.pos === '33' && g.sply_ty === 'INTRA');
  const atItem = at33?.itms?.find((i) => i.rt === 18);
  check('GSTR-1 JSON at: pos 33, INTRA, rt 18, ad_amt and CGST/SGST', !!atItem && atItem.ad_amt >= 10_000 && atItem.camt >= 900 && (!FRESH || (atItem.ad_amt === 10_000 && atItem.camt === 900 && atItem.samt === 900)), JSON.stringify(at33));
  const rep = (await api('GET', `/api/gst/returns?view=gstr1-report&period=${ADV_MONTH}`)).json;
  const ledger = rep?.tieOut?.ledger ?? [];
  check('GSTR-1 ties to the ledger head by head with the advance in it', ledger.length > 0 && ledger.every((l) => l.differencePaise === 0), JSON.stringify(ledger.map((l) => [l.head, l.differencePaise])));

  await open(`/gst/gstr3b?period=${ADV_MONTH}`, '[data-slot="gstr3b-row-3.1a"]');
  const r31a = (await cells(page.locator('[data-slot="gstr3b-row-3.1a"]'))).slice(1).map(rupees);
  const form = (await api('GET', `/api/gst?view=gstr3b-form&ret=${ADV_MONTH}`)).json;
  const f31a = form?.rows?.['3.1a'];
  if (FRESH) check('GSTR-3B 3.1(a) last month: ₹10,000 taxable, CGST ₹900, SGST ₹900 (the advance)', r31a[0] === 10_000 && r31a[2] === 900 && r31a[3] === 900 && f31a?.cgstPaise === 900_00, r31a.join(' · '));
  else check('GSTR-3B 3.1(a) carries the advance tax (screen and API agree)', r31a[0] * 100 === f31a?.taxablePaise && f31a?.cgstPaise >= 900_00, `${r31a.join(' · ')} / ${f31a?.taxablePaise}`);
  await shot('gstr3b-31a-advance');

  if (FRESH) {
    // Applied to this month's invoice for the service: 11B, and off 3.1(a).
    const svc = await api('POST', '/api/invoices', { branchId, customerId: walkIn, date: day(5), dueDate: day(5), status: 'approved', lines: [{ description: 'Installation service', hsnSac: '998729', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }] });
    const applied = await api('PATCH', '/api/payments', { action: 'apply', paymentId, date: day(5), allocations: [{ targetType: 'invoice', targetId: String(svc.json?.id), amountPaise: 11_800_00 }] });
    check('This month the advance is applied to the service invoice', svc.status === 200 && applied.status === 200, `${svc.status} ${applied.status} ${applied.text.slice(0, 160)}`);
    await open(`/gst/gstr1?period=${CUR}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="gstr1-tab-adv"]').waitFor({ timeout: 120_000 });
    await page.locator('[data-slot="gstr1-tab-adv"]').click();
    await page.waitForTimeout(600);
    const adj = (await cells(page.locator('[data-slot="gstr1-table-atadj"] tbody tr').first())).slice(3).map(rupees);
    check('GSTR-1 11B this month: the advance adjusted, ₹10,000 and ₹900 + ₹900', adj[0] === 10_000 && adj[2] === 900 && adj[3] === 900, adj.join(' · '));
    check('…and nothing new in 11A', /Nothing in this table/i.test(await page.locator('[data-slot="gstr1-table-at"]').innerText()));
    await shot('gstr1-11b-adjusted');
    const fCur = (await api('GET', `/api/gst?view=gstr1-file&period=${CUR}`)).json;
    check('GSTR-1 JSON txpd this month', fCur?.txpd?.[0]?.itms?.[0]?.ad_amt === 10_000 && !fCur?.at, JSON.stringify(fCur?.txpd));
    // This month: B2B ₹5,000 (450 + 450) + B2C ₹2,000 (180 + 180) + service ₹10,000 (900 + 900) − 11B ₹10,000 (900 + 900).
    await open(`/gst/gstr3b?period=${CUR}`, '[data-slot="gstr3b-row-3.1a"]');
    const cur31a = (await cells(page.locator('[data-slot="gstr3b-row-3.1a"]'))).slice(1).map(rupees);
    check('GSTR-3B 3.1(a) this month: ₹7,000 taxable, CGST ₹630, SGST ₹630: the advance tax is not paid twice', cur31a[0] === 7_000 && cur31a[2] === 630 && cur31a[3] === 630, cur31a.join(' · '));
    const repCur = (await api('GET', `/api/gst/returns?view=gstr1-report&period=${CUR}`)).json;
    check('This month GSTR-1 still ties to the ledger', (repCur?.tieOut?.ledger ?? []).length > 0 && repCur.tieOut.ledger.every((l) => l.differencePaise === 0), JSON.stringify((repCur?.tieOut?.ledger ?? []).map((l) => [l.head, l.differencePaise])));
    await shot('gstr3b-31a-after-adjustment');
  }

  // ── 1. GSTR-2B in the portal's layout ───────────────────────────────────────
  // Demo: the import goes to an earlier month of its own, so this month's 2B (the reviewers' data) stays.
  const TWO_B = FRESH ? CUR : `${Number(CUR.slice(0, 4)) - 1}${CUR.slice(4)}`;
  const billDate = FRESH ? day(3) : `${TWO_B}-03`;
  let billNo2 = billNo;
  if (!FRESH) {
    billNo2 = `NS-B-${stamp.slice(-4)}X`;
    const old = await api('POST', '/api/bills', { branchId, vendorId: vendor, vendorInvoiceNo: billNo2, date: billDate, dueDate: billDate, status: 'open', lines: [{ itemId: gadget, qty: 20, ratePaise: 300_00 }] });
    check('Demo: a bill for the month the 2B is imported to', old.status === 200, old.text.slice(0, 160));
  }
  const portal2b = {
    chksum: 'fx-a',
    data: {
      gstin: orgGstin, rtnprd: mmyyyy(TWO_B), gendt: dmy(`${TWO_B}-14`), version: '1.0',
      itcsumm: {},
      docdata: {
        b2b: [{ ctin: vendorGstin, trdnm: 'Nila Suppliers Pvt Ltd', supfildt: dmy(`${TWO_B}-11`), supprd: mmyyyy(TWO_B),
          inv: [{ inum: billNo2, typ: 'R', dt: dmy(billDate), val: 7080, pos: '33', rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 1,
            items: [{ num: 1, rt: 18, txval: 4000, igst: 0, cgst: 360, sgst: 360, cess: 0 }, { num: 2, rt: 18, txval: 2000, igst: 0, cgst: 180, sgst: 180, cess: 0 }] }] }],
        cdnr: [{ ctin: vendorGstin, trdnm: 'Nila Suppliers Pvt Ltd',
          nt: [{ ntnum: `NS-CN-${stamp.slice(-3)}`, typ: 'C', suptyp: 'R', dt: dmy(billDate), val: 354, pos: '33', rev: 'N', itcavl: 'Y', items: [{ num: 1, rt: 18, txval: 300, igst: 0, cgst: 27, sgst: 27, cess: 0 }] }] }],
        impg: [{ refdt: dmy(`${TWO_B}-12`), portcode: 'INMAA1', boenum: `76${stamp.slice(-5)}`, boedt: dmy(`${TWO_B}-10`), isamd: 'N', txval: 50000, igst: 9000, cess: 0 }],
      },
    },
  };
  const twoA = {
    gstin: orgGstin, fp: mmyyyy(TWO_B),
    b2b: [{ ctin: vendorGstin, trdnm: 'Nila Suppliers Pvt Ltd', cfs: 'Y', inv: [{ inum: billNo2, idt: dmy(billDate), val: 7080, rchrg: 'N',
      itms: [{ num: 1, itm_det: { rt: 18, txval: 4000, camt: 360, samt: 360, csamt: 0 } }, { num: 2, itm_det: { rt: 18, txval: 2000, camt: 180, samt: 180, csamt: 0 } }] }] }],
  };
  const files = path.join(SHOTS, 'files');
  mkdirSync(files, { recursive: true });
  writeFileSync(path.join(files, 'gstr2b-portal.json'), JSON.stringify(portal2b, null, 2));
  writeFileSync(path.join(files, 'gstr2a.json'), JSON.stringify(twoA, null, 2));
  writeFileSync(path.join(files, 'gstr1-not-2b.json'), JSON.stringify(fileCur ?? { gstin: orgGstin, fp: mmyyyy(CUR), b2cs: [], hsn: {} }));

  await open('/gst/itc-reconciliation', '[data-slot="page-header"]');
  const importFile = async (name) => {
    await page.locator('input[type="file"]').first().setInputFiles(path.join(files, name));
  };
  await importFile('gstr2b-portal.json');
  const t2b = await waitToast(/GSTR-2B for .* imported|could not|not a GSTR/i);
  check('The portal-layout GSTR-2B imports: 1 invoice, 1 credit note, 1 bill of entry', /GSTR-2B for .* imported/.test(t2b) && /1 invoice/.test(t2b) && /1 credit note/.test(t2b) && /1 bill of entry/.test(t2b), t2b.slice(0, 200));
  await page.waitForTimeout(2500);
  await page.locator('[role="tab"]', { hasText: /^Matched/ }).first().click();
  await page.waitForTimeout(600);
  const mRow = page.locator('tr', { hasText: billNo2 }).first();
  const m = await cells(mRow);
  // (select), supplier, GSTIN, their invoice, date, our bill, portal, books, difference, …
  const portalCol = m.find((x, i) => i > 4 && /₹/.test(x));
  check(`The invoice ${billNo2} is matched, its Portal column ₹1,080.00 (not "—")`, (await mRow.count()) === 1 && /1,080\.00/.test(portalCol ?? '') && m.filter((x) => /1,080\.00/.test(x)).length >= 2, m.join(' · '));
  await shot('gstr2b-portal-layout-matched');
  await page.locator('[role="tab"]', { hasText: /^Not in your books/ }).first().click();
  await page.waitForTimeout(600);
  const cnRow = page.locator('tr', { hasText: `NS-CN-${stamp.slice(-3)}` }).first();
  const cnText = (await cells(cnRow)).join(' · ');
  check('The credit note in 2B layout is listed with its ₹54.00 and marked Credit note', /Credit note/.test(cnText) && /54\.00/.test(cnText), cnText);
  const boeText = (await cells(page.locator('tr', { hasText: `76${stamp.slice(-5)}` }).first())).join(' · ');
  check('The import (IMPG) is read as a bill of entry with its ₹9,000.00 IGST', /Bill of entry/.test(boeText) && /9,000\.00/.test(boeText), boeText);
  await shot('gstr2b-credit-note-and-boe');

  await importFile('gstr2a.json');
  const t2a = await waitToast(/GSTR-2A for .* imported/i);
  check('The same invoice in the GSTR-2A layout imports and still matches', /GSTR-2A for .* imported/.test(t2a), t2a.slice(0, 200));
  await page.waitForTimeout(2000);
  await page.locator('[role="tab"]', { hasText: /^Matched/ }).first().click();
  await page.waitForTimeout(500);
  check('…still matched at ₹1,080.00', /1,080\.00/.test((await cells(page.locator('tr', { hasText: billNo2 }).first())).join(' ')));
  await importFile('gstr1-not-2b.json');
  const tBad = await waitToast(/GSTR-1 file|not a GSTR-2B/i);
  check('A GSTR-1 file is refused, saying which file to download', /GSTR-1 file/.test(tBad) && /GSTR-2B/.test(tBad), tBad.slice(0, 200));
  await shot('gstr2b-wrong-file-refused');

  // ── 4. A credit note line with no HSN/SAC ────────────────────────────────────
  await open('/sales/credit-notes/new', '[data-slot="combobox-trigger"]');
  await pick(page.locator('[data-slot="combobox-trigger"]').first(), /Kaveri Retail/, `Kaveri Retail Pvt Ltd${tag}`);
  await page.waitForTimeout(800);
  const reasonTrigger = page.locator('[data-slot="combobox-trigger"]', { hasText: 'Select a reason' }).first();
  await pick(reasonTrigger, /Post Sale Discount/);
  const row = page.locator('table tbody tr').first();
  await row.locator('textarea').first().fill('Rate difference on CN Gadget');
  const nums = row.locator('input[type="number"]');
  await nums.nth(0).fill('1');
  await nums.nth(1).fill('400');
  await nums.nth(1).blur();
  await page.waitForTimeout(600);
  const warn = page.locator('[data-slot="cn-hsn-warning"]');
  const warnText = await warn.innerText().catch(() => '');
  check('The form says at once: line 1 has no HSN or SAC code, GSTR-1 table 12 needs one', /Line 1 has no HSN or SAC code/.test(warnText) && /table 12/.test(warnText), warnText.slice(0, 160));
  await shot('credit-note-no-hsn-warning');
  if (FRESH) {
    await page.locator('[data-slot="doc-save-open"]').click();
    const tCn = await waitToast(/no HSN or SAC/i, 60_000);
    check('Saved as open (a book on 4 digits), with the warning that GSTR-1 will list it', /no HSN or SAC/.test(tCn), tCn.slice(0, 200));
    await page.waitForURL((u) => /\/sales\/credit-notes\/\d+$/.test(u.toString()), { timeout: 60_000 }).catch(() => {});
    await shot('credit-note-saved-warned');
  } else {
    // The demo book is above ₹5 crore: an open note without the code is refused on the form.
    check('Above ₹5 crore the warning says it cannot be saved as open', /cannot be saved as open/.test(warnText), warnText.slice(0, 200));
    await page.locator('[data-slot="doc-save-open"]').click();
    await page.waitForTimeout(800);
    check('…and Save as Open is refused until the line has its code', /an HSN or SAC code/.test(await page.locator('main').innerText()) && page.url().includes('/new'));
    await shot('credit-note-required-demo');
  }

  // ── 5. Marking GSTR-1 filed: no lock unless asked ───────────────────────────
  const FILE_MONTH = FRESH ? PREV : CUR;
  await open(`/gst/gstr1?period=${FILE_MONTH}`, '[data-slot="return-filing-bar"]');
  const mark = page.locator('[data-slot="filing-mark"]');
  await mark.waitFor({ timeout: 120_000 }).catch(() => {});
  if (await mark.count()) {
    await mark.click();
    await page.locator('[data-slot="filing-dialog"]').waitFor();
    const lockSales = page.locator('[data-slot="filing-lock-sales"]');
    const unticked = (await lockSales.count()) === 1 && (await lockSales.getAttribute('aria-checked')) !== 'true' && (await lockSales.getAttribute('data-checked')) === null;
    check('Mark as filed: "Lock Sales" is offered and unticked', unticked);
    const help = await page.locator('[data-slot="filing-lock-help"]').innerText();
    check('Under it: no edits to the period\'s documents, corrections in a later return (s.37(3)), how to lift it', /can be added, edited, voided or deleted/.test(help) && /section 37\(3\)/.test(help) && /Transaction locking/.test(help), help.slice(0, 200));
    await shot('filing-dialog-lock-off');
    if (FRESH) {
      await page.fill('[data-slot="filing-date"]', TODAY);
      await page.fill('[data-slot="filing-arn"]', `AA33${mmyyyy(PREV).slice(0, 2)}${PREV.slice(2, 4)}0009876`);
      await page.locator('[data-slot="filing-save"]').click();
      await page.locator('[data-slot="filing-filed"]').waitFor({ timeout: 60_000 }).catch(() => {});
      const st = (await api('GET', `/api/gst/filing?returnType=gstr1&period=${PREV}`)).json;
      check('Marked filed without the lock: the period stays open', !!st?.filed && !(st?.locks?.sales >= `${PREV}-01`), JSON.stringify(st?.locks));
      // A correction dated in that month is still accepted.
      const late = await api('POST', '/api/invoices', { branchId, customerId: walkIn, date: `${PREV}-26`, dueDate: `${PREV}-26`, status: 'draft', lines: [{ itemId: gadget, qty: 1, ratePaise: 500_00 }] });
      check('A document dated in the filed month can still be saved', late.status === 200, `${late.status} ${late.text.slice(0, 120)}`);
      await shot('gstr1-filed-not-locked');
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    check('The filing bar offers Mark as filed', false, 'no filing-mark button');
  }
} catch (e) {
  check('The script ran to the end', false, String(e?.stack ?? e).slice(0, 400));
  await shot('crash').catch(() => {});
} finally {
  await browser.close();
  if (errors.length) {
    console.log('\nErrors seen in the browser:');
    for (const e of [...new Set(errors)]) console.log(`  ${e}`);
  }
  const ok = fail === 0 && errors.length === 0;
  console.log(`\nfx-a: ${pass} passed, ${fail} failed, ${errors.length} browser error(s) — ${ok ? 'PASS' : 'FAIL'} (${FRESH ? 'fresh company' : 'demo book'})`);
  process.exit(ok ? 0 : 1);
}
