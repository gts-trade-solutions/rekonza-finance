// Shared pieces of the status review 7 end-to-end scripts for items 9, 10 and 14
// (scripts/e2e/sr7-9-*, sr7-10-*, sr7-14-*).
//
//   BASE   the app (default http://localhost:5033)
//   SHOTS  where the evidence screenshots go
//   FRESH  1 signs up a brand-new company, as an auditor starts; without it the
//          seeded demo book is used, for data-rich evidence.
//
// Every script fails (exit 1) on a failed check, a console error, a page error
// or any 5xx response.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const BASE = process.env.BASE || 'http://localhost:5033';
export const SHOTS = process.env.SHOTS || path.resolve('scripts/e2e/shots');
export const FRESH = process.env.FRESH === '1';
mkdirSync(SHOTS, { recursive: true });

export async function start(item) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);
  const errors = [];
  // A step that provokes a refusal on purpose names the endpoint; that 4xx is expected.
  const state = { expect: null, pass: 0, fail: 0, n: 0 };
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|DevTools|Download the React DevTools/i.test(t)) return;
    const url = m.location()?.url ?? '';
    if (/Failed to load resource/.test(t) && state.expect && url.includes(state.expect)) return;
    // 4xx refusals the app shows as a toast are not errors of the page; 5xx are caught below.
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return;
    errors.push(`console: ${t.slice(0, 200)} ${url}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (ok) state.pass++; else state.fail++;
    return ok;
  };
  const shot = async (what) => {
    state.n++;
    const file = path.join(SHOTS, `${item}-${String(state.n).padStart(2, '0')}-${what}${FRESH ? '-fresh' : ''}.png`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`      shot ${path.basename(file)}`);
  };
  /** JSON from the app's own API, as the signed-in user. */
  const api = async (method, url, body) => page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${json?.error ?? text.slice(0, 200)}`);
    return json;
  }, { method, url, body });
  const finish = async () => {
    await browser.close();
    if (errors.length) {
      console.log('\nErrors seen in the browser:');
      for (const e of [...new Set(errors)]) console.log(`  ${e}`);
    }
    const ok = state.fail === 0 && errors.length === 0;
    console.log(`\n${item}: ${state.pass} passed, ${state.fail} failed, ${errors.length} browser error(s) — ${ok ? 'PASS' : 'FAIL'} (${FRESH ? 'fresh company' : 'demo book'})`);
    process.exit(ok ? 0 : 1);
  };
  return { browser, ctx, page, errors, check, shot, api, finish, state };
}

// ── GSTIN with a valid check digit, for a company that charges GST ───────────
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinFor(state, pan) {
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const v = CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body + CHARS[(36 - (sum % 36)) % 36];
}
export function randomPan(kind = 'C') {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const r = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `${r(L, 3)}${kind}${r(L, 1)}${r('0123456789', 4)}${r(L, 1)}`;
}

/** Sign up a new company through the sign-up screen, or sign in to the demo book. */
export async function signIn(t, { business = 'Audit Test', state = '33', stateName = 'Tamil Nadu' } = {}) {
  const { page } = t;
  if (!FRESH) {
    await login(page, 'arun@raceautospares.in', 'Rekonza@2026');
    return { fresh: false };
  }
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const pan = randomPan('C');
  const email = `auditor+${stamp}@example.in`;
  await page.goto(`${BASE}/register`, { waitUntil: 'load' });
  await page.locator('#businessName').fill(`${business} ${stamp}`);
  // The picker answers once the page has hydrated; open it until its search box shows.
  for (let i = 0; i < 20; i++) {
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.waitForTimeout(400);
    if (await page.locator('[role="dialog"][data-open] input').first().isVisible().catch(() => false)) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  await page.locator('[role="dialog"][data-open] input').first().fill(stateName);
  await page.getByRole('option', { name: new RegExp(stateName) }).first().click();
  await page.locator('#gstin').fill(gstinFor(state, pan));
  await page.locator('#name').fill('Audit Partner');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('Audit@2026x');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/dashboard', { timeout: 90_000 });
  return { fresh: true, email, pan };
}

/**
 * Sign in on the login screen. The form is filled once the page has hydrated
 * (a click before that submits the bare HTML form); a first sign-in with a
 * temporary password goes through the change-password screen.
 */
export async function login(page, email, password, newPassword = 'Checker@2026x') {
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForURL(/dashboard|change-password|two-step/, { timeout: 90_000 });
  if (page.url().includes('change-password')) {
    await page.locator('#cp-current').fill(password);
    await page.locator('#cp-next').fill(newPassword);
    await page.locator('#cp-again').fill(newPassword);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard', { timeout: 90_000 });
  }
}

/** Click, and wait for the API call it makes to answer. */
export async function clickAndWait(page, locator, urlPart, method = 'POST') {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(urlPart) && r.request().method() === method, { timeout: 90_000 }),
    locator.click(),
  ]);
  return res;
}

/** Pick an option in a Select (base-ui) by its trigger's data-slot and the option's text. */
export async function pick(page, trigger, option) {
  const t = typeof trigger === 'string' ? page.locator(trigger) : trigger;
  await t.click();
  await page.getByRole('option', { name: option }).first().click();
}

/** Pick in a Combobox: open, type, choose. */
export async function combo(page, trigger, search, option) {
  await trigger.click();
  const input = page.locator('[role="dialog"][data-open] input').last();
  if (search) await input.fill(search);
  await page.getByRole('option', { name: option }).first().click();
}

/** A Field (label above its control) inside a scope, by the start of its label. */
export function field(scope, label) {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  const re = label instanceof RegExp ? label : new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return scope.locator('div.space-y-1\\.5').filter({ has: page.locator('label', { hasText: re }) }).first();
}

/** Money as text: "₹1,23,456.70" → 12345670 paise. */
export const paiseOf = (text) => {
  const m = String(text).replace(/,/g, '').match(/-?\(?₹?\s*-?(\d+(?:\.\d+)?)\)?/);
  if (!m) return NaN;
  const v = Math.round(Number(m[1]) * 100);
  return /^\s*[-−(]/.test(String(text)) || /\(/.test(String(text)) ? -v : v;
};
export const inr = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Wait until a toast with this text shows. */
export async function toast(page, re, timeout = 45_000) {
  await page.locator('[data-sonner-toast]', { hasText: re }).first().waitFor({ timeout });
}
