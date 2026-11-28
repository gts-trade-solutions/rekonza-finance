// Status review 7, item 11 (GST return filing reports): GSTR-1, GSTR-3B, the
// reconciliations, GSTR-2B, the return status grid, the filing mark and the
// lock after filing, as an auditor tests them.
//
//   FRESH=1 node scripts/e2e/sr7-11-gst-returns.mjs    a brand-new company, from sign-up
//   node scripts/e2e/sr7-11-gst-returns.mjs            the seeded demo book
//
// Env: BASE (default http://localhost:5034), SHOTS (screenshot folder), FRESH=1.
// GSTR-7 / GSTR-8 and GSTR-9 have scripts of their own (sr7-11-gstr7-gstr8.mjs,
// sr7-11-gstr9.mjs).
//
// FRESH: signs up a new company; with no documents GSTR-1 says what to do and
// the filing bar says plainly that no GSP is connected and how to upload by
// hand. Last month: a B2B invoice through the invoice screen; GSTR-1 for last
// month marked filed with its ARN through the filing dialog (and the mark
// edited); the invoice then corrected. This month, through the app's own
// endpoints: a consumer sale, a B2C large inter-state sale, an export with
// IGST, a deemed export to an EOU, a nil-rated sale, a sale through an
// e-commerce operator under s.9(5), a credit note, a bill and an advance for
// services. GSTR-1 for this month: every table's count and totals to the
// rupee, the amendment in 9A, the tie-out with the books, the portal JSON
// (keys, fp, dd-mm-yyyy, two decimals) and the Excel. GSTR-3B: 3.1, 3.1.1,
// 4, the values from GSTR-1 and GSTR-2B, the ledger tie-out, and table 6.1
// posted as a payment (recorded, edited, deleted). GSTR-2B imported as the
// portal's JSON: matched and missing-in-books lines; a bill deferred and
// claimed later, the decision deleted. GST Reconciliation agrees month by
// month. Return Status: last month's GSTR-3B is overdue with its late fee,
// marked filed with the lock, and a document dated in the locked month is
// then refused.
//
// Demo: signs in to the seeded book; every GSTR-1 table of this month has
// rows, the amendment and the tie-out are there; GSTR-3B's every section,
// checks and tie-out; August's GSTR-3B filed late with its late fee and
// interest; GSTR-2B with a mismatch and both missing sides and the held-back
// credit; the reconciliation for the year; the return status grid.
//
// Exits non-zero on any failed check, console error, page error or 5xx.

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const rupees = (t) => {
  const s = String(t ?? '').trim();
  if (!s || s === '—') return 0;
  const n = Number(s.replace(/[^0-9.]/g, '')) || 0;
  return /^[-−(]/.test(s) ? -n : n;
};

// GSTINs with their own check character.
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
const pan = (fourth = 'C') => `${L()}${L()}${L()}${fourth}${L()}${D()}${D()}${D()}${D()}${L()}`;
const gstinFor = (state, p = pan()) => check14(`${state}${p}1Z`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, extraHTTPHeaders: { 'x-forwarded-for': ip } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error' || /favicon|DevTools|Download the React DevTools/i.test(m.text())) return;
  // A refusal the script provokes on purpose (the locked period) is logged by the browser as a failed request.
  if (/status of 4\d\d/.test(m.text())) return;
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

let devReloads = 0;
const CHUNK = /Invalid or unexpected token|ChunkLoadError|Loading chunk .* failed|Unexpected end of input/;
const open = async (url, ready = '[data-slot="page-header"]') => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = errors.length;
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    const ok = await page.locator(ready).first().waitFor({ timeout: 240_000 }).then(() => true).catch(() => false);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    const fresh = errors.slice(before);
    if (!ok && attempt === 1 && fresh.length && fresh.every((e) => CHUNK.test(e))) {
      errors.splice(before, fresh.length);
      devReloads++;
      console.log(`      ${url}: the dev server was rebuilding; opened again`);
      continue;
    }
    break;
  }
  await page.waitForTimeout(800);
};
const download = async (trigger) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  return { name: d.suggestedFilename(), path: await d.path() };
};
const twoDecimals = (v) => {
  if (typeof v === 'number') return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  if (Array.isArray(v)) return v.every(twoDecimals);
  if (v && typeof v === 'object') return Object.values(v).every(twoDecimals);
  return true;
};
const dates = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => dates(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/dt$/.test(k) && typeof x === 'string') out.push(x); else dates(x, out); }
  return out;
};
const totalCells = async (slot) => {
  const cells = page.locator(`[data-slot="gstr1-total-${slot}"] td`);
  const n = await cells.count();
  const texts = [];
  for (let i = 0; i < n; i++) texts.push(await cells.nth(i).innerText());
  // The last five: taxable, IGST, CGST, SGST, cess.
  return texts.slice(-5).map(rupees);
};
const tab = async (key) => {
  await page.locator(`[data-slot="gstr1-tab-${key}"]`).click();
  await page.waitForTimeout(500);
};

const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(today);
const CUR = TODAY.slice(0, 7);
const prevDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
const PREV = ymd(prevDate).slice(0, 7);
const mmyyyy = (m) => `${m.slice(5, 7)}${m.slice(0, 4)}`;
const dmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const FY = today.getMonth() < 3 ? today.getFullYear() - 1 : today.getFullYear();

try {
  if (FRESH) {
    // ── 1. A brand-new company ─────────────────────────────────────────────
    const stamp = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
    const orgGstin = gstinFor('33');
    await open('/register', '#businessName');
    await page.fill('#businessName', `Return Filing Test ${stamp} Pvt Ltd`);
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: /Tamil Nadu/ }).click();
    await page.fill('#gstin', orgGstin);
    await page.fill('#name', 'Audit Tester');
    await page.fill('#email', `returns.${stamp}@example.in`);
    await page.fill('#password', 'Testing@2026');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Create my books/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    check('Signed up a brand-new company', page.url().includes('/dashboard'), orgGstin);

    // ── 2. Nothing yet: GSTR-1 says what to do; no GSP: upload by hand ──────
    await open(`/gst/gstr1?period=${CUR}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="gstr1-empty"]').waitFor({ timeout: 60_000 }).catch(() => {});
    check('An empty GSTR-1 says what to record', await page.locator('[data-slot="gstr1-empty"]').isVisible());
    const gspText = await page.locator('[data-slot="filing-gsp-status"]').innerText();
    check('The filing bar says no GSP is connected and to upload the JSON on gst.gov.in', /No GSP is connected/.test(gspText) && /Offline upload/.test(gspText), gspText.slice(0, 120));
    check('The offline steps are listed', (await page.locator('[data-slot="filing-steps"] li').count()) >= 5);
    await shot(page, '11-01-gstr1-new-company-empty');

    // ── 3. Masters ────────────────────────────────────────────────────────
    const me = (await api('GET', '/api/auth/me')).json;
    const branchId = me.user.branchId;
    const contact = async (kind, displayName, gstTreatment, stateCode, gstin) => {
      const r = await api('POST', '/api/contacts', { kind, displayName, gstTreatment, stateCode, ...(gstin ? { gstin } : {}) });
      return r.json?.id ?? (console.log('contact', r.status, r.text.slice(0, 200)), null);
    };
    const buyerGstin = gstinFor('33');
    const vendorGstin = gstinFor('33');
    const buyer = await contact('customer', 'Kaveri Motors Pvt Ltd', 'registered', '33', buyerGstin);
    const walkIn = await contact('customer', 'Walk-in customer', 'consumer', '33');
    const farBuyer = await contact('customer', 'Bengaluru walk-in buyer', 'unregistered', '29');
    const overseas = await contact('customer', 'Gulf Auto Trading LLC', 'overseas', '96');
    const eou = await contact('customer', 'Coastal EOU Components', 'deemed_export', '33', gstinFor('33'));
    const vendor = await contact('vendor', 'Sundaram Brake Linings', 'registered', '33', vendorGstin);
    check('Buyers and a supplier added', !!(buyer && walkIn && farBuyer && overseas && eou && vendor));
    const item = async (b) => {
      const r = await api('POST', '/api/items', { itemType: 'sales_and_purchases', isDigitalService: false, uqc: 'NOS', purchasePricePaise: 0, ...b });
      return r.json?.id ?? (console.log('item', r.status, r.text.slice(0, 200)), null);
    };
    const pads = await item({ kind: 'goods', name: 'Brake pad set', hsnSac: '870830', salePricePaise: 10_000_00, gstRatePct: 18, taxPref: 'taxable' });
    const pulses = await item({ kind: 'goods', name: 'Tur dal (unbranded)', hsnSac: '071360', uqc: 'KGS', salePricePaise: 100_00, gstRatePct: 0, taxPref: 'nil' });
    const labour = await item({ kind: 'service', name: 'Doorstep car wash', hsnSac: '998533', salePricePaise: 500_00, gstRatePct: 18, taxPref: 'taxable' });
    check('Items added', !!(pads && pulses && labour));

    // ── 4. Last month: a B2B invoice through the invoice screen ─────────────
    await open('/sales/invoices/new', '[data-slot="combobox-trigger"]');
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: /Kaveri Motors/ }).first().click();
    await page.waitForTimeout(800);
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill(`${PREV}-20`);
    await page.waitForTimeout(300);
    await page.locator('table [data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: /Brake pad set/ }).first().click();
    await page.waitForTimeout(800);
    await shot(page, '11-02-invoice-through-the-screen');
    await page.getByRole('button', { name: 'Save and Send' }).click();
    await page.waitForURL((u) => /\/sales\/invoices\/\d+$/.test(u.toString()), { timeout: 60_000 }).catch(() => {});
    const prevInvoiceId = (/\/sales\/invoices\/(\d+)$/.exec(page.url()) ?? [])[1];
    check('Last month\'s B2B invoice saved from the invoice screen', !!prevInvoiceId, page.url());
    const prevInv = (await api('GET', `/api/invoices/${prevInvoiceId}`)).json;
    check('It is dated last month', String(prevInv?.date ?? prevInv?.invoiceDate ?? '').startsWith(PREV), String(prevInv?.date ?? prevInv?.invoiceDate));

    // ── 5. Last month's GSTR-1 marked filed, through the filing dialog ───────
    await open(`/gst/gstr1?period=${PREV}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="gstr1-table-b2b"]').waitFor({ timeout: 60_000 });
    await page.locator('[data-slot="filing-mark"]').click();
    await page.locator('[data-slot="filing-dialog"]').waitFor();
    await page.fill('[data-slot="filing-date"]', `${CUR}-11`);
    await page.fill('[data-slot="filing-arn"]', `AA33${mmyyyy(PREV).slice(0, 2)}${PREV.slice(2, 4)}0001234`);
    // Not locked: the invoice is corrected below, as a late correction would be.
    // The lock is off unless ticked (auditor check, 2026-11-28), and says what it does.
    const lockBox = page.locator('[data-slot="filing-lock-sales"]');
    if (await lockBox.count()) {
      check('The lock after filing is offered, unticked', (await lockBox.getAttribute('data-checked')) === null && (await lockBox.getAttribute('aria-checked')) !== 'true');
      check('Under it, what locking does and that corrections go to a later return (s.37(3))', /can be added, edited, voided or deleted[\s\S]*section 37\(3\)/.test(await page.locator('[data-slot="filing-lock-help"]').innerText()));
    }
    await shot(page, '11-03-gstr1-mark-filed-dialog');
    await page.locator('[data-slot="filing-save"]').click();
    await page.locator('[data-slot="filing-filed"]').waitFor({ timeout: 60_000 });
    check('Last month\'s GSTR-1 shows as filed with its ARN', /AA33/.test(await page.locator('[data-slot="filing-filed-arn"]').innerText()));
    // Edit the mark: the ARN was mistyped.
    await page.locator('[data-slot="filing-edit"]').click();
    await page.locator('[data-slot="filing-dialog"]').waitFor();
    const newArn = `AA33${mmyyyy(PREV).slice(0, 2)}${PREV.slice(2, 4)}0001299`;
    await page.fill('[data-slot="filing-arn"]', newArn);
    await page.locator('[data-slot="filing-save"]').click();
    await page.waitForTimeout(1500);
    check('The filed mark edited (Edit): the ARN corrected', (await page.locator('[data-slot="filing-filed-arn"]').innerText()).trim() === newArn);
    await shot(page, '11-04-gstr1-last-month-filed');

    // The invoice corrected after filing: two sets, not one (₹20,000).
    const edit = await api('PUT', `/api/invoices/${prevInvoiceId}`, {
      branchId, customerId: buyer, date: `${PREV}-20`, dueDate: `${PREV}-20`, status: 'approved',
      lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 2, ratePaise: 10_000_00, gstRatePct: 18 }],
    });
    check('The filed invoice corrected afterwards', edit.status === 200, edit.text.slice(0, 160));

    // ── 6. This month's documents ─────────────────────────────────────────
    const post = (url, body) => api('POST', url, body);
    const day = (n) => `${CUR}-${String(Math.min(n, today.getDate())).padStart(2, '0')}`;
    const r1 = await post('/api/invoices', { branchId, customerId: walkIn, date: day(2), dueDate: day(2), status: 'approved', lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 1, ratePaise: 4_000_00, gstRatePct: 18 }] });
    const r2 = await post('/api/invoices', { branchId, customerId: farBuyer, date: day(3), dueDate: day(3), status: 'approved', lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 12, ratePaise: 10_000_00, gstRatePct: 18 }] });
    const r3 = await post('/api/invoices', { branchId, customerId: overseas, date: day(4), dueDate: day(4), status: 'approved', exportWithTax: true, lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 5, ratePaise: 10_000_00, gstRatePct: 18 }] });
    const r4 = await post('/api/invoices', { branchId, customerId: eou, date: day(5), dueDate: day(5), status: 'approved', lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 1, ratePaise: 8_000_00, gstRatePct: 18 }] });
    const r5 = await post('/api/invoices', { branchId, customerId: walkIn, date: day(6), dueDate: day(6), status: 'approved', lines: [{ itemId: pulses, description: 'Tur dal (unbranded)', hsnSac: '071360', qty: 10, uqc: 'KGS', ratePaise: 100_00, gstRatePct: 0 }] });
    const ecoGstin = check14(`29${pan('C')}1C`);
    const r6 = await post('/api/invoices', { branchId, customerId: walkIn, date: day(7), dueDate: day(7), status: 'approved', eco: { gstin: ecoGstin, section: '9_5' }, lines: [{ itemId: labour, description: 'Doorstep car wash', hsnSac: '998533', qty: 4, ratePaise: 500_00, gstRatePct: 18 }] });
    const b2bNow = await post('/api/invoices', { branchId, customerId: buyer, date: day(8), dueDate: day(8), status: 'approved', lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 3, ratePaise: 10_000_00, gstRatePct: 18 }] });
    const cn = await post('/api/sales-documents', { kind: 'credit-note', branchId, customerId: buyer, date: day(9), reason: 'Price revised after delivery', againstInvoiceId: b2bNow.json?.id, status: 'open',
      lines: [{ itemId: pads, description: 'Brake pad set — rate difference', hsnSac: '870830', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }] });
    const billNo = `SBL/${stamp.slice(-4)}`;
    const bill = await post('/api/bills', { branchId, vendorId: vendor, vendorInvoiceNo: billNo, date: day(3), dueDate: day(3), status: 'open',
      lines: [{ itemId: pads, description: 'Brake pad sets', hsnSac: '870830', qty: 1, ratePaise: 6_000_00, gstRatePct: 18 }] });
    // A new company has its cash account to start with.
    const accounts = (await api('GET', '/api/banking/accounts')).json?.accounts ?? [];
    const bankId = String((accounts.find((b) => b.kind === 'bank') ?? accounts.find((b) => b.kind === 'cash') ?? {}).id ?? '');
    const adv = await post('/api/payments', { kind: 'received', branchId: String(branchId), contactId: String(buyer), date: day(10), mode: 'cash', amountPaise: 11_800_00, bankAccountId: bankId, advanceGst: { ratePct: 18 } });
    const all = [r1, r2, r3, r4, r5, r6, b2bNow, cn, bill];
    check('This month\'s sales, credit note and bill recorded', all.every((r) => r.status === 200), all.map((r) => `${r.status}${r.status === 200 ? '' : ` ${r.text.slice(0, 120)}`}`).join(' | '));
    check('An advance for services received with GST', adv.status === 200, `${adv.status} ${adv.text.slice(0, 160)}`);

    // ── 7. GSTR-1 for this month, table by table ─────────────────────────
    await open(`/gst/gstr1?period=${CUR}`, '[data-slot="gstr1-tiles"]');
    await page.locator('[data-slot="gstr1-table-b2b"]').waitFor({ timeout: 60_000 });
    let t = await totalCells('b2b');
    check('4: B2B — the buyer\'s ₹30,000 and the EOU\'s ₹8,000, CGST ₹3,420', t[0] === 38_000 && t[2] === 3_420, JSON.stringify(t));
    const deTag = await page.locator('[data-slot="gstr1-table-b2b"] tbody tr', { hasText: 'Coastal EOU' }).innerText();
    check('6C: the supply to the EOU is a deemed export (DE)', /\bDE\b/.test(deTag), deTag.replace(/\s+/g, ' ').slice(0, 120));
    await shot(page, '11-05-gstr1-b2b');
    await tab('b2cl'); t = await totalCells('b2cl');
    check('5: B2C large — the inter-state consumer sale, ₹1,20,000 with IGST ₹21,600', t[0] === 1_20_000 && t[1] === 21_600, JSON.stringify(t));
    await tab('exp'); t = await totalCells('exp');
    check('6A: the export with IGST, ₹50,000 and IGST ₹9,000', t[0] === 50_000 && t[1] === 9_000, JSON.stringify(t));
    await tab('b2cs'); t = await totalCells('b2cs');
    check('7: B2C others — ₹4,000, CGST ₹360', t[0] === 4_000 && t[2] === 360, JSON.stringify(t));
    await tab('nil');
    const nilText = await page.locator('[data-slot="gstr1-table-nil"]').innerText();
    check('8: the nil-rated pulses, ₹1,000', /1,000/.test(nilText), nilText.replace(/\s+/g, ' ').slice(0, 160));
    await tab('cdnr'); t = await totalCells('cdnr');
    check('9B: the credit note to the registered buyer, −₹1,000', t[0] === -1_000 && t[2] === -90, JSON.stringify(t));
    const against = await page.locator('[data-slot="gstr1-table-cdnr"] [data-slot="gstr1-against"]').first().innerText();
    check('9B: the note names the invoice it corrects, with its date', /vs .+ of \d{4}-\d{2}-\d{2}/.test(against), against);
    await tab('adv'); t = await totalCells('at');
    check('11A: the advance for services, ₹10,000 and CGST ₹900', t[0] === 10_000 && t[2] === 900, JSON.stringify(t));
    await tab('hsn');
    check('12: the HSN summary in its B2B and B2C parts', (await page.locator('[data-slot="gstr1-table-hsn-b2b"] tbody tr').count()) >= 1 && (await page.locator('[data-slot="gstr1-table-hsn-b2c"] tbody tr').count()) >= 1);
    await tab('docs');
    check('13: the documents issued', (await page.locator('[data-slot="gstr1-table-docs"] tbody tr').count()) >= 2);
    await tab('eco'); t = await totalCells('eco14');
    check('14(b): the car wash through the operator who pays tax under 9(5), ₹2,000', t[0] === 2_000, JSON.stringify(t));
    await shot(page, '11-06-gstr1-ecommerce');
    const am = page.locator('[data-slot="gstr1-amendment-row"]');
    check('9A: last month\'s corrected invoice is an amendment this month', (await am.count()) === 1 && /B2BA/.test(await am.first().innerText()), (await am.count()) ? (await am.first().innerText()).replace(/\s+/g, ' ').slice(0, 160) : 'none');
    check('GSTR-1 ties to the sales register and the ledger to the paisa', (await page.locator('[data-slot="gstr1-tied"]').getAttribute('data-tied')) === 'true');
    await page.locator('[data-slot="gstr1-tieout"]').scrollIntoViewIfNeeded();
    await shot(page, '11-07-gstr1-amendment-and-tieout');

    await page.locator('[data-slot="gstr1-export"]').click();
    await page.waitForTimeout(300);
    const jf = await download(() => page.locator('[data-slot="gstr1-export-json"]').click());
    const file = JSON.parse(readFileSync(jf.path, 'utf8'));
    check('The portal JSON: GSTIN, fp MMYYYY and every table', file.gstin === orgGstin && file.fp === mmyyyy(CUR)
      && ['b2b', 'b2cl', 'b2cs', 'exp', 'nil', 'cdnr', 'at', 'hsn', 'doc_issue', 'supeco', 'b2ba'].every((k) => k in file), Object.keys(file).join(','));
    check('… dates day-first and amounts to two decimals', dates(file).every((d) => /^\d{2}-\d{2}-\d{4}$/.test(d)) && twoDecimals(file));
    check('… the amendment carries its original number and date', file.b2ba?.[0]?.inv?.[0]?.oinum === prevInv.number && file.b2ba[0].inv[0].oidt === dmy(`${PREV}-20`), JSON.stringify(file.b2ba?.[0]?.inv?.[0] ?? {}).slice(0, 160));
    check('… a deemed export is inv_typ DE', file.b2b.some((g) => g.inv.some((i) => i.inv_typ === 'DE')));
    await page.locator('[data-slot="gstr1-export"]').click();
    await page.waitForTimeout(300);
    const xf = await download(() => page.locator('[data-slot="gstr1-export-excel"]').click());
    check('The Excel workbook downloads', /\.xlsx$/.test(xf.name), xf.name);

    // ── 8. GSTR-3B ────────────────────────────────────────────────────────
    await open(`/gst/gstr3b?period=${CUR}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="gstr3b-compare"]').waitFor({ timeout: 120_000 });
    const form = (await api('GET', `/api/gst?view=gstr3b-form&ret=${CUR}`)).json;
    const r = form.rows;
    // 3.1(a) by hand: walk-in ₹4,000 (CGST 360) + inter-state consumer ₹1,20,000 (IGST) + EOU deemed
    // export ₹8,000 (720) + B2B ₹30,000 (2,700) − credit note ₹1,000 (−90) + advance ₹10,000 (900) =
    // ₹1,71,000 and CGST ₹4,590; plus last month's invoice amended from ₹10,000 (900, as filed) to
    // ₹20,000 (1,800): +₹10,000 and +₹900. The export (3.1(b)), the nil-rated dal (3.1(c)) and the
    // s.9(5) car wash (3.1.1) are elsewhere.
    check('3.1(a): taxable ₹1,81,000 with the amendment and the advance, CGST ₹5,490', r['3.1a'].taxablePaise === 1_81_000_00 && r['3.1a'].cgstPaise === 5_490_00, `${r['3.1a'].taxablePaise} ${r['3.1a'].cgstPaise}`);
    check('3.1(b): the export, IGST ₹9,000', r['3.1b'].igstPaise === 9_000_00);
    check('3.1(c): the nil-rated sale, ₹1,000', r['3.1c'].taxablePaise === 1_000_00);
    check('3.1.1(ii): through the operator under 9(5), ₹2,000', r['3.1.1ii'].taxablePaise === 2_000_00);
    check('4(A)(5): the bill\'s credit, CGST ₹540', r['4A5'].cgstPaise === 540_00);
    check('3.2: the inter-state consumer sale to Karnataka', form.interState.unregistered.some((x) => x.pos === '29' && x.taxablePaise === 1_20_000_00));
    const cmp = await page.locator('[data-slot="gstr3b-compare-3.1a"]').innerText();
    const checks = (await api('GET', `/api/gst/returns?view=gstr3b-checks&ret=${CUR}`)).json;
    check('Values from GSTR-1: 3.1(a) agrees with GSTR-1', checks.compare.find((c) => c.key === '3.1a').difference.cgstPaise === 0, cmp.replace(/\s+/g, ' ').slice(0, 160));
    check('Tie-out with the ledger: every difference explained', (await page.locator('[data-slot="gstr3b-tieout"]').getAttribute('data-tied')) === 'true');
    await page.locator('[data-slot="gstr3b-compare"]').scrollIntoViewIfNeeded();
    await shot(page, '11-08-gstr3b-checks-and-tieout');
    // 6.1 recorded as a payment: Record, Edit, Delete.
    await page.locator('[data-slot="gstr3b-pay"]').click();
    await page.locator('[data-slot="gstr3b-pay-dialog"]').waitFor();
    await page.fill('[data-slot="gstr3b-pay-cpin"]', '33112600099999');
    await shot(page, '11-09-gstr3b-payment-dialog');
    await page.locator('[data-slot="gstr3b-pay-save"]').click();
    await page.locator('[data-slot="gstr3b-payment-recorded"]').waitFor({ timeout: 60_000 });
    const pay = (await api('GET', `/api/gst/returns?view=gstr3b-payment&ret=${CUR}`)).json;
    check('6.1 recorded: credit set off and cash paid, as the return works them out', !!pay.recorded && pay.recorded.creditUsedPaise === pay.settlement.creditUsedPaise && pay.recorded.cashTotalPaise === pay.settlement.cashTotalPaise,
      JSON.stringify({ used: pay.recorded?.creditUsedPaise, cash: pay.recorded?.cashTotalPaise }));
    const glAfter = (await api('GET', `/api/gst/returns?view=gstr3b-checks&ret=${CUR}`)).json;
    check('… and the tie-out still has nothing unexplained', glAfter.tied === true);
    await page.locator('[data-slot="gstr3b-pay-edit"]').click();
    await page.locator('[data-slot="gstr3b-pay-dialog"]').waitFor();
    await page.fill('[data-slot="gstr3b-pay-cpin"]', '33112600088888');
    await page.locator('[data-slot="gstr3b-pay-save"]').click();
    await page.waitForTimeout(2000);
    check('The payment edited (Edit): the CPIN corrected', /88888/.test(await page.locator('[data-slot="gstr3b-payment-recorded"]').innerText()));
    await page.locator('[data-slot="gstr3b-pay-delete"]').click();
    await page.locator('[data-slot="confirm-delete-go"]').click();
    await page.locator('[data-slot="gstr3b-pay"]').waitFor({ timeout: 60_000 });
    check('The payment deleted (Delete): its entry reversed', (await api('GET', `/api/gst/returns?view=gstr3b-payment&ret=${CUR}`)).json.recorded === null);
    await shot(page, '11-10-gstr3b-payment-card');

    // ── 9. GSTR-2B: import, match, decide ───────────────────────────────────
    const statement = {
      data: {
        gstin: orgGstin, rtnprd: mmyyyy(CUR), gendt: dmy(TODAY),
        docdata: {
          b2b: [
            { ctin: vendorGstin, trdnm: 'Sundaram Brake Linings', inv: [{ inum: billNo, dt: dmy(day(3)), val: 7080, txval: 6000, igst: 0, cgst: 540, sgst: 540, cess: 0, itcavl: 'Y', rev: 'N' }] },
            { ctin: gstinFor('27'), trdnm: 'Pune Parts House', inv: [{ inum: 'PPH/551', dt: dmy(day(2)), val: 1180, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' }] },
          ],
        },
      },
    };
    const tmp = path.join(SHOTS, `gstr2b-${stamp}.json`);
    writeFileSync(tmp, JSON.stringify(statement));
    await open(`/gst/itc-reconciliation`, '[data-slot="page-header"]');
    await page.locator('input[type="file"][accept*="json"]').setInputFiles(tmp);
    await page.waitForTimeout(3000);
    const itc = (await api('GET', `/api/gst?view=itc&period=${CUR}`)).json;
    check('GSTR-2B imported: the bill matched, the Pune invoice missing in the books', itc.summary.matched === 1 && itc.summary.missing_in_books === 1, JSON.stringify(itc.summary));
    await page.getByRole('tab', { name: /Matched/ }).click();
    await page.waitForTimeout(500);
    await shot(page, '11-11-itc-reconciliation-matched');
    // Hold the matched bill back, then claim it next month, then delete the decision.
    await page.locator('[data-slot="itc-claim-defer"]').first().click();
    await page.waitForTimeout(1500);
    const held = (await api('GET', `/api/gst/returns?view=itc-claims&period=${CUR}`)).json;
    check('Defer: the bill\'s credit held back', held.decisions.length === 1 && held.decisions[0].decision === 'defer');
    const g3 = (await api('GET', `/api/gst?view=gstr3b-form&ret=${CUR}`)).json;
    check('… and GSTR-3B 4(A)(5) no longer claims it', g3.rows['4A5'].cgstPaise === 0, String(g3.rows['4A5'].cgstPaise));
    await page.getByRole('tab', { name: /Matched/ }).click();
    await page.locator('[data-slot="itc-claim-later"]').first().click();
    await page.locator('[data-slot="itc-claim-later-dialog"]').waitFor();
    await page.locator('[data-slot="itc-claim-later-save"]').click();
    await page.waitForTimeout(1500);
    const later = (await api('GET', `/api/gst/returns?view=itc-claims&period=${CUR}`)).json;
    check('Claim later: next month', later.decisions[0]?.decision === 'claim_later', JSON.stringify(later.decisions[0] ?? {}));
    await page.locator('[data-slot="itc-held-back"]').scrollIntoViewIfNeeded();
    await shot(page, '11-12-itc-held-back');
    await page.locator('[data-slot="itc-held-delete"]').first().click();
    await page.locator('[data-slot="confirm-delete-go"]').click();
    await page.waitForTimeout(1500);
    check('The decision deleted (Delete): claimed in its own month again', (await api('GET', `/api/gst/returns?view=itc-claims&period=${CUR}`)).json.decisions.length === 0);

    // ── 10. GST Reconciliation ───────────────────────────────────────────
    await open('/gst/reconciliation', '[data-slot="recon-table"]');
    const row = page.locator(`[data-slot="recon-row-${CUR}"]`);
    check('GSTR-1, GSTR-3B and the books agree this month, once the amendment and the advance are counted', (await row.getAttribute('data-agrees')) === 'true', (await row.innerText()).replace(/\s+/g, ' ').slice(0, 200));
    await shot(page, '11-13-gst-reconciliation');

    // ── 11. Return Status: overdue, marked filed with the lock, the lock holds ─
    await open('/gst/return-status', '[data-slot="return-status-grid"]');
    const cell3b = page.locator(`[data-slot="return-cell"][data-key="gstr3b"][data-period="${PREV}"]`);
    const st = await cell3b.getAttribute('data-status');
    check(`Last month's GSTR-3B shows as ${st}`, ['overdue', 'due_soon', 'upcoming'].includes(st ?? ''), st);
    const cell1 = page.locator(`[data-slot="return-cell"][data-key="gstr1"][data-period="${PREV}"]`);
    check('Last month\'s GSTR-1 shows as filed (late, after the 11th) with its ARN', ['done', 'late'].includes(await cell1.getAttribute('data-status') ?? '') && /AA33/.test(await cell1.innerText()));
    await shot(page, '11-14-return-status-grid');
    await cell3b.click();
    await page.locator('[data-slot="return-cell-dialog"] [data-slot="return-filing-bar"]').waitFor({ timeout: 60_000 });
    if (st === 'overdue') check('Overdue: the late fee and interest are estimated', await page.locator('[data-slot="return-cell-dialog"] [data-slot="filing-estimate"]').isVisible());
    await shot(page, '11-15-return-status-cell');
    await page.locator('[data-slot="return-cell-dialog"] [data-slot="filing-mark"]').click();
    await page.locator('[data-slot="filing-dialog"]').waitFor();
    await page.fill('[data-slot="filing-date"]', TODAY);
    await page.fill('[data-slot="filing-arn"]', `AB33${mmyyyy(PREV).slice(0, 2)}${PREV.slice(2, 4)}0004321`);
    check('The lock after filing is offered for sales and purchases', await page.locator('[data-slot="filing-lock-sales"]').count() === 1 && await page.locator('[data-slot="filing-lock-purchases"]').count() === 1);
    // Ticked on purpose here: the lock is optional and off by default.
    await page.locator('[data-slot="filing-lock-sales"]').click();
    await page.locator('[data-slot="filing-lock-purchases"]').click();
    await page.locator('[data-slot="filing-save"]').click();
    await page.waitForTimeout(2500);
    const status = (await api('GET', `/api/gst/filing?returnType=gstr3b&period=${PREV}`)).json;
    check('Marked filed from the grid, sales and purchases locked to the month end', !!status.filed && status.locks.sales >= `${PREV}-28` && status.locks.purchases >= `${PREV}-28`, JSON.stringify(status.locks));
    const refused = await api('POST', '/api/invoices', { branchId, customerId: walkIn, date: `${PREV}-25`, dueDate: `${PREV}-25`, status: 'approved', lines: [{ itemId: pads, description: 'Brake pad set', hsnSac: '870830', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }] });
    check('A sale dated in the filed, locked month is refused', refused.status >= 400 && refused.status < 500 && /locked/i.test(refused.text), `${refused.status} ${refused.text.slice(0, 140)}`);
    await page.keyboard.press('Escape');
    await open('/gst/return-status', '[data-slot="return-status-grid"]');
    await shot(page, '11-16-return-status-after-filing');
  } else {
    // ── Demo book ─────────────────────────────────────────────────────────
    await open('/login', '#email');
    await page.waitForTimeout(2000);
    await page.locator('#email').fill('arun@raceautospares.in');
    await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    check('Signed in to the demo book', page.url().includes('/dashboard'));

    await open(`/gst/gstr1?period=${CUR}`, '[data-slot="gstr1-tiles"]');
    await page.locator('[data-slot="gstr1-table-b2b"]').waitFor({ timeout: 120_000 });
    const rep = (await api('GET', `/api/gst/returns?view=gstr1-report&period=${CUR}`)).json;
    const empty = Object.entries(rep.tables).filter(([, x]) => x.rows.length === 0).map(([k]) => k);
    check('Every GSTR-1 table of this month has rows', empty.length === 0, empty.join(','));
    check('An amendment of a filed return in 9A', rep.amendments.count >= 1 && (await page.locator('[data-slot="gstr1-amendment-row"]').count()) >= 1);
    check('GSTR-1 ties to the books', rep.tieOut.tied === true);
    await shot(page, '11-20-demo-gstr1');
    for (const k of ['b2cl', 'nil', 'cdnur', 'adv', 'eco']) await tab(k);
    await shot(page, '11-21-demo-gstr1-ecommerce');
    await page.locator('[data-slot="gstr1-export"]').click();
    await page.waitForTimeout(300);
    const jf = await download(() => page.locator('[data-slot="gstr1-export-json"]').click());
    const file = JSON.parse(readFileSync(jf.path, 'utf8'));
    check('Its JSON has every table, fp, day-first dates and two decimals',
      ['b2b', 'b2cl', 'b2cs', 'exp', 'nil', 'cdnr', 'cdnur', 'at', 'txpd', 'hsn', 'doc_issue', 'supeco', 'ecob2c', 'b2ba'].every((k) => k in file) && file.fp === mmyyyy(CUR) && dates(file).every((d) => /^\d{2}-\d{2}-\d{4}$/.test(d)) && twoDecimals(file),
      Object.keys(file).join(','));

    await open(`/gst/gstr3b?period=${CUR}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="gstr3b-tieout"]').waitFor({ timeout: 120_000 });
    const form = (await api('GET', `/api/gst?view=gstr3b-form&ret=${CUR}`)).json;
    const blank = Object.entries(form.rows).filter(([k, v]) => !['4A4', '4D2'].includes(k) && v.count === 0).map(([k]) => k);
    check('Every GSTR-3B row this month has documents (4(A)(4) ISD and 4(D)(2) aside)', blank.length === 0, blank.join(','));
    check('3.2: unregistered, composition and UIN holders', form.interState.unregistered.length > 0 && form.interState.composition.length > 0 && form.interState.uin.length > 0);
    check('The GSTR-3B tie-out has nothing unexplained', (await page.locator('[data-slot="gstr3b-tieout"]').getAttribute('data-tied')) === 'true');
    await shot(page, '11-22-demo-gstr3b');
    const aug = `${FY}-08`;
    await open(`/gst/gstr3b?period=${aug}`, '[data-slot="return-filing-bar"]');
    await page.locator('[data-slot="return-filing-bar"][data-status="filed_late"]').waitFor({ timeout: 60_000 }).catch(() => {});
    check('August\'s GSTR-3B: filed late, with its late fee and interest', (await page.locator('[data-slot="return-filing-bar"]').getAttribute('data-status')) === 'filed_late' && await page.locator('[data-slot="filing-estimate"]').isVisible());
    await shot(page, '11-23-demo-gstr3b-filed-late');

    await open('/gst/itc-reconciliation', '[data-slot="page-header"]');
    const itc = (await api('GET', `/api/gst?view=itc&period=${CUR}`)).json;
    check('GSTR-2B: matched, a mismatch, missing in the books and missing in 2B', itc.summary.matched > 0 && itc.summary.mismatch > 0 && itc.summary.missing_in_books > 0 && itc.summary.missing_in_portal > 0, JSON.stringify(itc.summary));
    check('The credit held back and claimed later is listed', (await page.locator('[data-slot="itc-held-row"]').count()) >= 2);
    await shot(page, '11-24-demo-itc-reconciliation');

    await open('/gst/reconciliation', '[data-slot="recon-table"]');
    check('The reconciliation lists the year month by month', (await page.locator('[data-slot^="recon-row-"]').count()) >= 1);
    await shot(page, '11-25-demo-reconciliation');

    await open('/gst/return-status', '[data-slot="return-status-grid"]');
    const rowsThere = [];
    for (const k of ['gstr1', 'gstr3b', 'gstr7', 'gstr8']) rowsThere.push((await page.locator(`[data-slot="return-row-${k}"]`).count()) === 1);
    check('Return Status shows GSTR-1, GSTR-3B, GSTR-7 and GSTR-8 rows', rowsThere.every(Boolean), JSON.stringify(rowsThere));
    check('August\'s GSTR-3B is marked filed late', (await page.locator(`[data-slot="return-cell"][data-key="gstr3b"][data-period="${aug}"]`).getAttribute('data-status')) === 'late');
    await shot(page, '11-26-demo-return-status');
  }
} catch (e) {
  check('The run finished without an exception', false, e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e));
  await shot(page, '11-39-gst-returns-failure').catch(() => {});
}

check('No console errors, page errors or server errors', errors.length === 0, errors.slice(0, 5).join(' | '));
if (devReloads) console.log(`      (${devReloads} page(s) opened twice while the dev server rebuilt)`);
console.log(`\n${pass} passed, ${fail} failed (${FRESH ? 'a brand-new company' : 'the demo book'})`);
await browser.close();
process.exit(fail ? 1 : 0);
