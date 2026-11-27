// Status review 7, item 11 (GST return filing reports): GSTR-9, the annual
// return, as an auditor tests it.
//
//   FRESH=1 node scripts/e2e/sr7-11-gstr9.mjs      a brand-new company, from sign-up
//   node scripts/e2e/sr7-11-gstr9.mjs              the seeded demo book
//
// Env: BASE (default http://localhost:5034), SHOTS (screenshot folder), FRESH=1.
//
// FRESH: signs up a new company through the sign-up screen; adds a registered
// buyer, a walk-in consumer, a registered supplier and a composition dealer,
// and two items (brake pads at 18%, pulses nil-rated); raises the first
// invoice through the invoice screen, and the rest of the month's documents —
// a consumer invoice, a credit note against the first invoice, a bill with
// credit and a bill from the composition dealer — through the app's own
// endpoints, the calls their forms make. Then, on GSTR-9 for the year now
// running, it checks tables 4, 5, 6, 7, 16 and 17 to the rupee against what
// was entered, that 6J is nil and the GL tie-out agrees to the paisa, the
// JSON file's keys, fp and two-decimal amounts, the Excel download, and enters
// a table 15 refund, edits it and deletes it. GSTR-9C is opened and its 5Q is
// GSTR-9's 5N.
//
// Demo: signs in to the seeded book and opens GSTR-9 for the last full year
// and for the year running: every table renders, the tie-out has no
// unexplained difference, and the JSON downloads.
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
/** ₹1,234.50 or −₹1,000.00 or — to a number of rupees. */
const rupees = (t) => {
  const s = String(t ?? '').trim();
  if (!s || s === '—') return 0;
  const n = Number(s.replace(/[^0-9.]/g, '')) || 0;
  return /^[-−(]/.test(s) ? -n : n;
};

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
const gstinFor = (state, p = pan()) => check14(`${state}${p}1Z`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// A per-run address, so the sign-up allowance of one run never limits the next.
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

// The dev server compiles a screen the first time it is opened; when other
// work in the tree is saved it rebuilds, and a chunk asked for mid-rebuild can
// arrive cut short. That is the dev server, not the screen: the page is
// opened again once and the run says so. Any other error still fails.
let devReloads = 0;
const CHUNK = /Invalid or unexpected token|ChunkLoadError|Loading chunk .* failed|Unexpected end of input/;
const open = async (url, ready = '[data-slot="page-header"]') => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = errors.length;
    // A cold dev server compiles each route on its first request, side
    // requests included, so the page is waited for by what it draws, not by
    // the network going quiet.
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
const cell = async (row, col) => rupees(await page.locator(`[data-slot="g9-${row}"] [data-col="${col}"]`).first().innerText());
const pickFy = async (label) => {
  await page.locator('[data-slot="gstr9-fy"]').click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: label }).first().click();
  await page.locator('[data-slot="gstr9-table4"]').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
};
const download = async (trigger) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  return { name: d.suggestedFilename(), path: await d.path() };
};
const exportItem = async (slot) => {
  await page.locator('[data-slot="gstr9-export"]').click();
  await page.waitForTimeout(300);
  return download(() => page.locator(`[data-slot="${slot}"]`).click());
};
/** Every number in a JSON tree has at most two decimals, as the portal requires. */
const twoDecimals = (v) => {
  if (typeof v === 'number') return Math.round(v * 100) === Number((v * 100).toFixed(6)) || Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  if (Array.isArray(v)) return v.every(twoDecimals);
  if (v && typeof v === 'object') return Object.values(v).every(twoDecimals);
  return true;
};
const TABLE_KEYS = ['table4', 'table5', 'table6', 'table7', 'table8', 'table9', 'table10', 'table14', 'table15', 'table16', 'table17', 'table18'];

const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(today);
const FY = today.getMonth() < 3 ? today.getFullYear() - 1 : today.getFullYear();
const fyLabel = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;

try {
  if (FRESH) {
    // ── 1. A brand-new company ───────────────────────────────────────────────
    const stamp = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
    const orgGstin = gstinFor('33');
    await open('/register', '#businessName');
    await page.fill('#businessName', `Annual Return Test ${stamp} Pvt Ltd`);
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: /Tamil Nadu/ }).click();
    await page.fill('#gstin', orgGstin);
    await page.fill('#name', 'Audit Tester');
    await page.fill('#email', `gstr9.${stamp}@example.in`);
    await page.fill('#password', 'Testing@2026');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Create my books/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180_000, waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    check('Signed up a brand-new company', page.url().includes('/dashboard'), orgGstin);

    // ── 2. The year starts empty, and says what to do ────────────────────────
    await open('/gst/gstr9', '[data-slot="gstr9-fy"]');
    await pickFy(new RegExp(`FY ${fyLabel(FY)}`));
    check('GSTR-9 of a new company is a nil return that says what to record',
      await page.locator('[data-slot="gstr9-nil"]').isVisible() && await page.locator('[data-slot="gstr9-empty"]').isVisible());
    await shot(page, '11-60-gstr9-new-company-nil');

    // ── 3. Masters: buyers, suppliers, items (the app's own endpoints) ───────
    const me = (await api('GET', '/api/auth/me')).json;
    const branchId = me.user.branchId;
    const contact = async (kind, displayName, gstTreatment, stateCode, gstin) => {
      const r = await api('POST', '/api/contacts', { kind, displayName, gstTreatment, stateCode, ...(gstin ? { gstin } : {}) });
      return r.json?.id ?? (console.log('contact', r.status, r.text.slice(0, 200)), null);
    };
    const buyer = await contact('customer', 'Kaveri Motors Pvt Ltd', 'registered', '33', gstinFor('33'));
    const walkIn = await contact('customer', 'Walk-in customer', 'consumer', '33');
    const supplier = await contact('vendor', 'Sundaram Brake Linings', 'registered', '33', gstinFor('33'));
    const compo = await contact('vendor', 'Lakshmi Packaging (composition)', 'registered_composition', '33', gstinFor('33'));
    check('Buyers and suppliers added', !!(buyer && walkIn && supplier && compo));
    const item = async (b) => {
      const r = await api('POST', '/api/items', { itemType: 'sales_and_purchases', isDigitalService: false, uqc: 'NOS', purchasePricePaise: 0, ...b });
      return r.json?.id ?? (console.log('item', r.status, r.text.slice(0, 200)), null);
    };
    const pads = await item({ kind: 'goods', name: 'Brake pad set', hsnSac: '8708', salePricePaise: 10_000_00, gstRatePct: 18, taxPref: 'taxable' });
    const pulses = await item({ kind: 'goods', name: 'Tur dal (unbranded)', hsnSac: '0713', uqc: 'KGS', salePricePaise: 100_00, gstRatePct: 0, taxPref: 'nil' });
    check('Items added: brake pads at 18%, pulses nil-rated', !!(pads && pulses));

    // ── 4. The first invoice, through the invoice screen ─────────────────────
    await open('/sales/invoices/new', '[data-slot="combobox-trigger"]');
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: /Kaveri Motors/ }).first().click();
    await page.waitForTimeout(800);
    await page.locator('table [data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: /Brake pad set/ }).first().click();
    await page.waitForTimeout(800);
    await shot(page, '11-61-invoice-through-the-screen');
    await page.getByRole('button', { name: 'Save and Send' }).click();
    await page.waitForURL((u) => /\/sales\/invoices\/\d+$/.test(u.toString()), { timeout: 60_000 }).catch(() => {});
    const firstInvoiceId = (/\/sales\/invoices\/(\d+)$/.exec(page.url()) ?? [])[1];
    check('The B2B invoice saved from the invoice screen', !!firstInvoiceId, page.url());

    // ── 5. The rest of the month (the calls the forms make) ──────────────────
    const inv2 = await api('POST', '/api/invoices', {
      branchId, customerId: walkIn, date: TODAY, dueDate: TODAY, status: 'approved',
      lines: [
        { itemId: pads, description: 'Brake pad set', hsnSac: '8708', qty: 1, ratePaise: 4_000_00, gstRatePct: 18 },
        { itemId: pulses, description: 'Tur dal (unbranded)', hsnSac: '0713', qty: 5, uqc: 'KGS', ratePaise: 100_00, gstRatePct: 0 },
      ],
    });
    const cn = await api('POST', '/api/sales-documents', {
      kind: 'credit-note', branchId, customerId: buyer, date: TODAY, reason: 'Price revised after delivery',
      againstInvoiceId: firstInvoiceId, status: 'open',
      lines: [{ itemId: pads, description: 'Brake pad set — rate difference', hsnSac: '8708', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
    });
    const bill = await api('POST', '/api/bills', {
      branchId, vendorId: supplier, vendorInvoiceNo: `SBL/${stamp.slice(-4)}`, date: TODAY, dueDate: TODAY, status: 'open',
      lines: [{ itemId: pads, description: 'Brake pad sets', hsnSac: '8708', qty: 1, ratePaise: 6_000_00, gstRatePct: 18 }],
    });
    const compoBill = await api('POST', '/api/bills', {
      branchId, vendorId: compo, vendorInvoiceNo: `LP-${stamp.slice(-3)}`, date: TODAY, dueDate: TODAY, status: 'open',
      lines: [{ description: 'Corrugated cartons', hsnSac: '4819', qty: 1, ratePaise: 2_000_00, gstRatePct: 0 }],
    });
    check('Consumer invoice, credit note and two bills recorded',
      [inv2, cn, bill, compoBill].every((r) => r.status === 200),
      [inv2, cn, bill, compoBill].map((r) => `${r.status}${r.status === 200 ? '' : ` ${r.text.slice(0, 140)}`}`).join(' | '));

    // ── 6. GSTR-9 for the year running, table by table ───────────────────────
    await open('/gst/gstr9', '[data-slot="gstr9-fy"]');
    await pickFy(new RegExp(`FY ${fyLabel(FY)}`));
    check('The year running is marked a draft', await page.locator('[data-slot="gstr9-draft"]').isVisible());
    const t = {
      '4A': await cell('4A', 'taxable'), '4Acgst': await cell('4A', 'cgst'),
      '4B': await cell('4B', 'taxable'), '4Bcgst': await cell('4B', 'cgst'), '4Bsgst': await cell('4B', 'sgst'),
      '4I': await cell('4I', 'taxable'), '4Icgst': await cell('4I', 'cgst'),
      '4N': await cell('4N', 'taxable'), '4Ncgst': await cell('4N', 'cgst'),
      '5E': await cell('5E', 'taxable'), '5N': await cell('5N', 'taxable'),
    };
    check('4A: the consumer sale, ₹4,000 with CGST ₹360', t['4A'] === 4000 && t['4Acgst'] === 360, JSON.stringify([t['4A'], t['4Acgst']]));
    check('4B: the B2B sale, ₹10,000 with CGST and SGST ₹900 each', t['4B'] === 10000 && t['4Bcgst'] === 900 && t['4Bsgst'] === 900, JSON.stringify([t['4B'], t['4Bcgst'], t['4Bsgst']]));
    check('4I: the credit note, −₹1,000 and −₹90', t['4I'] === -1000 && t['4Icgst'] === -90, JSON.stringify([t['4I'], t['4Icgst']]));
    check('4N: ₹13,000, CGST ₹1,170', t['4N'] === 13000 && t['4Ncgst'] === 1170, JSON.stringify([t['4N'], t['4Ncgst']]));
    check('5E: the nil-rated pulses, ₹500; 5N total turnover ₹13,500', t['5E'] === 500 && t['5N'] === 13500, JSON.stringify([t['5E'], t['5N']]));
    await page.locator('[data-slot="gstr9-table4"]').scrollIntoViewIfNeeded();
    await shot(page, '11-62-gstr9-tables-4-5');

    const six = {
      a: await cell('6A', 'cgst'), b: await cell('6B', 'cgst'), j: await cell('6J', 'cgst'),
      jI: await cell('6J', 'igst'), o: await cell('6O', 'sgst'), j7: await cell('7J', 'cgst'),
    };
    check('6A (GSTR-3B 4A) and 6B (the bill) are both CGST ₹540', six.a === 540 && six.b === 540, JSON.stringify(six));
    check('6J difference is nil', six.j === 0 && six.jI === 0);
    check('6O and 7J: ₹540 of SGST and CGST available', six.o === 540 && six.j7 === 540);
    check('16A: the composition dealer\'s bill, ₹2,000', (await cell('16A', 'taxable')) === 2000);
    const hsnPads = rupees(await page.locator('[data-slot="g9-hsn-8708"] [data-col="taxable"]').first().innerText());
    check('17: HSN 8708 net of the credit note, ₹13,000', hsnPads === 13000, String(hsnPads));
    const ties = await page.locator('[data-slot="g9-tie-ok"]').count();
    check('GL tie-out: output, reverse-charge and input ledgers agree to the paisa', ties === 3, `${ties} of 3`);
    await page.locator('[data-slot="gstr9-table6"]').scrollIntoViewIfNeeded();
    await shot(page, '11-63-gstr9-tables-6-8');
    await page.locator('[data-slot="gstr9-table16"]').scrollIntoViewIfNeeded();
    await shot(page, '11-64-gstr9-tables-16-19-tieout');

    // ── 7. The JSON for the offline tool, and Excel ──────────────────────────
    const json = await exportItem('gstr9-export-json');
    const file = JSON.parse(readFileSync(json.path, 'utf8'));
    check('JSON: gstin, isnil N and fp 03 + the year\'s end', file.gstin === orgGstin && file.isnil === 'N' && file.fp === `03${FY + 1}`, `${file.gstin} ${file.isnil} ${file.fp}`);
    check('JSON: every table key the GSTN schema has', TABLE_KEYS.every((k) => k in file), TABLE_KEYS.filter((k) => !(k in file)).join(','));
    check('JSON: 4B, the credit note, nil and total turnover in rupees',
      file.table4.b2b.txval === 10000 && file.table4.b2b.camt === 900 && file.table4.cr_nt.txval === -1000
        && file.table5.nil.txval === 500 && file.table5.total_tover.txval === 13500,
      JSON.stringify([file.table4.b2b, file.table4.cr_nt.txval, file.table5.nil, file.table5.total_tover]));
    check('JSON: 6B split by type, ip carrying the bill\'s credit',
      Array.isArray(file.table6.supp_non_rchrg) && file.table6.supp_non_rchrg.find((x) => x.itc_typ === 'ip')?.camt === 540);
    check('JSON: table 17 by HSN with UQC', file.table17.items.some((i) => i.hsn_sc === '8708' && i.uqc === 'NOS' && i.txval === 13000 && i.isconcesstional === 'N'));
    check('JSON: amounts rounded to two decimals', twoDecimals(file));
    const xl = await exportItem('gstr9-export-excel');
    check('Excel workbook downloads', /\.xlsx$/.test(xl.name), xl.name);

    // ── 8. Table 15: enter a refund, edit it, delete it ─────────────────────
    await page.locator('[data-slot="gstr9-inputs-edit"]').click();
    await page.locator('[data-slot="g9-in-15A-cgstPaise"]').fill('1000');
    await page.locator('[data-slot="g9-in-15A-sgstPaise"]').fill('1000');
    await page.locator('[data-slot="gstr9-inputs-save"]').click();
    await page.waitForTimeout(2000);
    check('15A: a refund claim entered, ₹1,000 CGST', (await cell('15A', 'cgstPaise')) === 1000);
    await page.locator('[data-slot="gstr9-table15"]').scrollIntoViewIfNeeded();
    await shot(page, '11-65-gstr9-table15-entered');
    await page.locator('[data-slot="gstr9-inputs-edit"]').click();
    await page.locator('[data-slot="g9-in-15A-cgstPaise"]').fill('1500');
    await page.locator('[data-slot="gstr9-inputs-save"]').click();
    await page.waitForTimeout(2000);
    check('15A edited to ₹1,500', (await cell('15A', 'cgstPaise')) === 1500);
    await page.locator('[data-slot="gstr9-inputs-delete"]').click();
    await page.locator('[data-slot="confirm-delete-go"]').click();
    await page.waitForTimeout(2000);
    check('Deleted: 15A back to nil', (await cell('15A', 'cgstPaise')) === 0);
    await page.locator('[data-slot="gstr9-table15"]').scrollIntoViewIfNeeded();
    await shot(page, '11-66-gstr9-table15-deleted');

    // ── 9. GSTR-9C reconciles to it ───────────────────────────────────────────
    await page.locator('[data-slot="gstr9-to-9c"]').click();
    await page.waitForURL('**/gst/gstr9c');
    const nineC = (await api('GET', `/api/gst?view=gstr9c&fy=${FY}`)).json;
    const q5 = nineC?.table5?.find((l) => l.ref === '5Q')?.paise;
    check('GSTR-9C 5Q is GSTR-9\'s 5N, ₹13,500', q5 === 13_500_00, String(q5));
    await page.waitForTimeout(1500);
    await shot(page, '11-67-gstr9c-new-company');
  } else {
    // ── Demo book ─────────────────────────────────────────────────────────────
    await open('/login', '#email');
    await page.locator('#email').fill('arun@raceautospares.in');
    await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.waitForURL('**/dashboard', { timeout: 120_000, waitUntil: 'commit' });
    check('Signed in to the demo book', page.url().includes('/dashboard'));

    for (const [y, nameShot] of [[FY - 1, '11-70-demo-gstr9-last-year'], [FY, '11-72-demo-gstr9-year-running']]) {
      await open('/gst/gstr9', '[data-slot="gstr9-fy"]');
      await pickFy(new RegExp(`FY ${fyLabel(y)}`));
      const parts = ['table4', 'table5', 'table6', 'table7', 'table8', 'table9', 'table10', 'table14', 'table15', 'table16', 'table17', 'table18', 'table19', 'tieout'];
      const missing = [];
      for (const p of parts) if (!(await page.locator(`[data-slot="gstr9-${p}"]`).count())) missing.push(p);
      check(`FY ${fyLabel(y)}: every table of the form is on the screen`, missing.length === 0, missing.join(','));
      const g = (await api('GET', `/api/gst/annual?view=gstr9&fy=${y}`)).json;
      const unexplained = (g?.tieOut ?? []).filter((x) => x.unexplainedPaise !== 0);
      check(`FY ${fyLabel(y)}: GL tie-out has no unexplained difference`, !!g && unexplained.length === 0, unexplained.map((x) => `${x.key} ${x.unexplainedPaise}`).join(','));
      const has = g && !g.isNil;
      console.log(`      FY ${fyLabel(y)}: ${has ? `4N taxable ₹${(g.table4.total.taxablePaise / 100).toLocaleString('en-IN')}, 6A ₹${((g.table6.itc3b.cgstPaise + g.table6.itc3b.sgstPaise + g.table6.itc3b.igstPaise) / 100).toLocaleString('en-IN')}` : 'nil (no documents in the year in this book)'}`);
      if (has) {
        const shown = await cell('4N', 'taxable');
        check(`FY ${fyLabel(y)}: 4N on the screen is the return's own figure`, Math.round(shown * 100) === g.table4.total.taxablePaise, `${shown}`);
        check(`FY ${fyLabel(y)}: 6J difference is nil`, g.table6.difference.cgstPaise === 0 && g.table6.difference.igstPaise === 0 && g.table6.difference.sgstPaise === 0);
      }
      await shot(page, nameShot);
      const json = await exportItem('gstr9-export-json');
      const file = JSON.parse(readFileSync(json.path, 'utf8'));
      check(`FY ${fyLabel(y)}: JSON downloads with fp 03${y + 1} and every table key`, file.fp === `03${y + 1}` && TABLE_KEYS.every((k) => k in file) && twoDecimals(file));
    }
    await page.locator('[data-slot="gstr9-table17"]').scrollIntoViewIfNeeded();
    await shot(page, '11-73-demo-gstr9-hsn');
  }
} catch (e) {
  check('The run finished without an exception', false, e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : String(e));
  await shot(page, '11-79-gstr9-failure').catch(() => {});
}

check('No console errors, page errors or server errors', errors.length === 0, errors.slice(0, 5).join(' | '));
if (devReloads) console.log(`      (${devReloads} page(s) opened twice while the dev server rebuilt)`);
console.log(`\n${pass} passed, ${fail} failed (${FRESH ? 'a brand-new company' : 'the demo book'})`);
await browser.close();
process.exit(fail ? 1 : 0);
