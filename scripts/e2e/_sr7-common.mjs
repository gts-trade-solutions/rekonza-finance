// Shared by the status review 7 end-to-end scripts (scripts/e2e/sr7-*.mjs).
//
//   BASE   the app (default http://localhost:5031)
//   SHOTS  where the evidence screenshots go
//   FRESH  1 = sign up a brand-new company first, as an auditor would;
//          otherwise sign in to the seeded demo book.
//
// A run fails on any failed check, any page error, any console error that is
// not an expected refusal, and any 5xx response.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const BASE = process.env.BASE || 'http://localhost:5031';
export const SHOTS = process.env.SHOTS || path.join(process.cwd(), 'shots');
export const FRESH = process.env.FRESH === '1';
export const PASSWORD = 'Auditor@2026Test';

export async function start(item) {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  // A sign-up is limited per address per hour; each run looks like its own office.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true, extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  const expected = [];
  let pass = 0, fail = 0, n = 0;
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|DevTools|Download the React DevTools/i.test(t)) return;
    const url = m.location()?.url ?? '';
    if (/Failed to load resource/.test(t) && url && expected.some((p) => url.includes(p) || p === url)) return;
    errors.push(`console: ${t.slice(0, 200)}${url ? ` — ${url.replace(BASE, '')}` : ''}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });

  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (ok) pass++; else fail++;
    return ok;
  };
  const shot = async (what) => {
    n += 1;
    const file = path.join(SHOTS, `${item}-${String(n).padStart(2, '0')}-${what}${FRESH ? '-fresh' : '-demo'}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`      shot ${path.basename(file)}`);
  };
  // Dev mode polls (notifications, counts): idle is waited for, but never more than 20s.
  const idle = async (ms = 400) => { await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(ms); };
  const go = async (p) => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 180000 }); await idle(800); };
  /** Call the app's API from the signed-in page, as the screens do. */
  const api = (method, p, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Change-Reason': encodeURIComponent('End-to-end test') }, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  }, [method, p, body]);
  const expect4xx = (urlPart) => expected.push(urlPart);
  // A book that keeps a reason with every change asks for one (components/layout/reason-prompt.tsx), and the
  // browser logs the first 428 that triggers the question: answered here as a person would, and not an error.
  expected.push('__428__');
  page.on('response', (r) => { if (r.status() === 428) expected.push(r.url()); });
  const answerReason = async () => {
    const box = page.getByPlaceholder(/Customer's GSTIN was entered wrongly/);
    if (await box.count()) { await box.fill('Audit test change'); await page.getByRole('button', { name: 'Save with this reason' }).click(); await idle(600); return true; }
    return false;
  };
  setInterval(() => { void answerReason().catch(() => {}); }, 700).unref?.();

  async function loginDemo(email = 'arun@raceautospares.in', password = 'Rekonza@2026') {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 }); await idle();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForURL(/\/(dashboard|change-password|two-step-setup)/, { timeout: 180000 });
    await idle(800);
  }

  async function signUp(business, person = 'Audit Tester') {
    const email = `auditor-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.test`;
    await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded', timeout: 180000 }); await idle();
    await page.locator('#businessName').fill(business);
    await page.locator('[data-slot="combobox-trigger"]').first().click();
    await page.getByPlaceholder('Search states').fill('Tamil');
    await page.getByRole('option', { name: /Tamil Nadu/ }).click();
    await page.locator('#name').fill(person);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: /Create my books/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180000 });
    await idle(800);
    return { email, password: PASSWORD };
  }

  async function finish() {
    for (const e of errors) check('no page, console or server error', false, e);
    console.log(`\n${item}: ${pass} passed, ${fail} failed${errors.length ? ` (including ${errors.length} error(s))` : ''} — ${FRESH ? 'fresh company' : 'demo book'}`);
    await browser.close();
    process.exit(fail ? 1 : 0);
  }

  return { browser, ctx, page, check, shot, idle, go, api, expect4xx, answerReason, loginDemo, signUp, finish, errors };
}

/** "₹1,23,456.00" → 123456 (rupees). */
export const rupees = (t) => Number(String(t ?? '').replace(/[^0-9.-]/g, '')) || 0;
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const fyStart = () => { const d = today(); const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };
export const fyLabel = () => { const y = Number(fyStart().slice(0, 4)); return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };

/**
 * Sign a second person in, on their own page: wait until the form is live (a
 * click before the page hydrates submits it as a plain GET), and try once more
 * if the first attempt did not get past the form.
 */
export async function signInOn(p, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await p.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(1500);
    await p.locator('#email').fill(email);
    await p.locator('#password').fill(password);
    await p.getByRole('button', { name: /^Sign in$/ }).click();
    const ok = await p.waitForURL(/\/(dashboard|change-password|two-step-setup)/, { timeout: 120000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return false;
}
