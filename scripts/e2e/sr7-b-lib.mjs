// Shared steps for builder B's status-review-7 end-to-end scripts
// (scripts/e2e/sr7-3-*.mjs … sr7-8-*.mjs).
//
//   BASE   the app (default http://localhost:5032)
//   SHOTS  where the evidence screenshots go
//   FRESH  1: sign up a brand-new company, as an auditor would; else sign in
//          to the seeded demo book (arun@raceautospares.in)
//
// Every script fails (exit 1) on a failed check, a page error, a console
// error or a 5xx from the server.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BASE = process.env.BASE || 'http://localhost:5032';
export const SHOTS = process.env.SHOTS || path.resolve('shots');
export const FRESH = process.env.FRESH === '1';
mkdirSync(SHOTS, { recursive: true });

export async function start(item) {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = await chromium.launch({ headless: true }); }
  // A sign-up is throttled per address; each run comes from its own (test only).
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const page = await ctx.newPage();
  // A dev server on a busy machine compiles and hydrates slowly; every wait is generous.
  page.setDefaultTimeout(120_000);
  const t = { item, page, ctx, browser, pass: 0, fail: 0, errors: [], expect: [] };
  page.on('pageerror', (e) => t.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /favicon|DevTools|Download the React DevTools/i.test(m.text())) return;
    const url = m.location()?.url ?? '';
    // A refusal provoked on purpose (a 4xx the step expects) is not an error of the page.
    if (/Failed to load resource/.test(m.text()) && /status of 4\d\d/.test(m.text())) return;
    t.errors.push(`console: ${m.text().slice(0, 200)}${url ? ` — ${url.replace(BASE, '')}` : ''}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) t.errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  return t;
}

export function check(t, label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) t.pass++; else t.fail++;
  return ok;
}

let shotNo = 0;
export async function shot(t, what) {
  shotNo++;
  const name = `${t.item}-${String(shotNo).padStart(2, '0')}-${what}${FRESH ? '' : '-demo'}.png`;
  await t.page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  console.log(`SHOT  ${name}`);
  return name;
}

/** The app's own API as the signed-in person (cookies shared with the page). */
export async function api(t, method, url, body) {
  // The document forms send the branch they are raised in; so do these steps.
  if (method === 'POST' && body && !body.branchId && /^\/api\/(invoices|bills|sales-documents|expenses)(\?|$)/.test(url)) {
    if (!t.branchId) t.branchId = String(((await api(t, 'GET', '/api/settings')).json?.branches ?? [])[0]?.id ?? '');
    body = { ...body, branchId: t.branchId };
  }
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await t.page.request.fetch(`${BASE}${url}`, { method, data: body, headers: { 'content-type': 'application/json' }, failOnStatusCode: false, timeout: 240_000 });
      break;
    } catch (e) {
      // Only a request the server never received is sent again, so nothing is posted twice.
      if (attempt >= 2 || !/ECONNREFUSED/.test(String(e))) throw e;
      await serverUp();
    }
  }
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  if (r.status() >= 500) t.errors.push(`HTTP ${r.status()} ${method} ${url}: ${JSON.stringify(json)?.slice(0, 200)}`);
  return { status: r.status(), json };
}

export const stamp = Date.now().toString(36).slice(-5);

/** Sign up a brand-new company through the sign-up screen, or sign in to the demo book. */
/** A GSTIN that passes the check digit (lib/tax/gst.ts isValidGstin), new each time: state, a company PAN, 1Z, check. */
export function newGstin(state) {
  const cp = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const pan = `${L()}${L()}${L()}C${L()}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}${L()}`;
  const g = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = cp.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return g + cp[(36 - (sum % 36)) % 36];
}

export async function enter(t) {
  const { page } = t;
  t.branchId = null;
  if (FRESH) {
    await goto(t, '/register');
    await page.locator('#businessName').fill(`Auditor Test ${t.item} ${stamp}`);
    await page.locator('[data-slot="combobox-trigger"]', { hasText: 'Select a state' }).click();
    await page.locator('input[placeholder="Search states"]').fill('Tamil');
    await page.getByRole('option', { name: /Tamil Nadu/ }).first().click();
    // A GST-registered business, as the auditors' own company is: without a GSTIN the company is
    // unregistered, cannot claim input tax, and every bill's GST becomes part of the stock's cost.
    await page.locator('#gstin').fill(newGstin('33'));
    await page.locator('#name').fill('Audit Tester');
    await page.locator('#email').fill(`audit-${t.item}-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`);
    await page.locator('#password').fill('Audit@Test2026');
    await page.getByRole('button', { name: /Create my books/ }).click();
    await landOnDashboard(t);
  } else {
    await goto(t, '/login');
    await page.locator('#email').fill('arun@raceautospares.in');
    await page.locator('#password').fill('Rekonza@2026');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await landOnDashboard(t);
  }
  check(t, FRESH ? 'a new company is signed up and opens its dashboard' : 'signed in to the demo book', page.url().includes('/dashboard'));
}

/** The dashboard after signing up or in; if the server restarted meanwhile, open it again (the session is kept). */
async function landOnDashboard(t) {
  try {
    await t.page.waitForURL('**/dashboard', { timeout: 240_000 });
  } catch (e) {
    if (!/ERR_CONNECTION|Timeout/.test(String(e))) throw e;
    console.log('(the server restarted while the dashboard opened; opening it again)');
    await serverUp();
    await goto(t, '/dashboard');
  }
}

/** Open a combobox (by the text its trigger shows) inside `scope`, search, and pick the option. */
export async function pick(t, scope, triggerText, search, option, searchPlaceholder) {
  const trigger = scope.locator('[data-slot="combobox-trigger"]', { hasText: triggerText }).first();
  await trigger.click();
  const input = searchPlaceholder ? t.page.locator(`input[placeholder="${searchPlaceholder}"]`).last() : t.page.locator('[role="dialog"] input, [data-radix-popper-content-wrapper] input, input[placeholder^="Search"]').last();
  if (search) await input.fill(search);
  await t.page.getByRole('option', { name: option }).first().click();
}

/** Wait for the server to answer again (a dev server on a busy machine restarts now and then). */
export async function serverUp(limitMs = 300_000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    try { const r = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(20_000) }); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function goto(t, url) {
  // A dev server compiles a page on its first visit, which can take a while.
  for (let attempt = 0; ; attempt++) {
    try {
      await t.page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      break;
    } catch (e) {
      if (attempt >= 2 || !/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(String(e))) throw e;
      console.log(`(the server is restarting; waiting to open ${url})`);
      await serverUp();
    }
  }
  await t.page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
}

/** A file on disk for an upload, in this run's shots folder's sibling. */
export function file(name, content) {
  const dir = path.join(SHOTS, '..', 'e2e-files');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${stamp}-${name}`);
  writeFileSync(p, content);
  return p;
}

/** Money as the screens print it, to paise: "₹1,23,456.78" → 12345678. */
export const paise = (s) => Math.round(Number(String(s).replace(/[^0-9.-]/g, '')) * 100);
export const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function finish(t) {
  if (t.errors.length) for (const e of t.errors) check(t, 'no page error, console error or 5xx', false, e);
  console.log(`\n${t.item}: ${t.pass} passed, ${t.fail} failed`);
  await t.browser.close();
  process.exit(t.fail ? 1 : 0);
}

/** Make a contact through the app's API (setup the item's test does not examine). */
export async function contact(t, kind, name, extra = {}) {
  const r = await api(t, 'POST', '/api/contacts', { kind, displayName: name, gstTreatment: 'unregistered', stateCode: '33', ...extra });
  if (r.status !== 200) throw new Error(`contact ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id;
}
