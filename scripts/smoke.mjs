// Real-browser smoke test: visits every route, captures console errors and
// uncaught exceptions. Uses the Chrome already installed on the machine, so no
// browser download is needed.
//
//   node scripts/smoke.mjs                       (the app on :5001, or SMOKE_BASE)
//   SMOKE_LOGIN=demo node scripts/smoke.mjs      (in by the demo door: the online demo has no passwords)

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5001';

// Every screen in the app, found from its folders rather than kept as a list
// that falls behind: each page.tsx under app/(app) is a route, route groups
// add nothing to the address, and a [segment] is a record, sampled below.
function screens(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...screens(full, /^(.*)$/.test(name) ? prefix : `${prefix}/${name}`));
    else if (name === 'page.tsx') out.push(prefix || '/');
  }
  return out;
}
const ROUTES = [
  ...screens(path.join('app', '(app)')).filter((r) => !r.includes('[')).sort(),
  '/portal',
  // The signed-out surface. Visited last, and while signed in, which is fine:
  // none of the three redirects on a session, and a console error on the
  // landing page is the one a prospective customer would see first.
  '/', '/login', '/register',
];

/** Browser noise that says nothing about our code. */
const IGNORE = [
  /favicon/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /webpack-hmr/i,
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const problems = [];
let current = '';

page.on('console', (msg) => {
  if (msg.type() !== 'error' && msg.type() !== 'warning') return;
  const text = msg.text();
  if (IGNORE.some((re) => re.test(text))) return;
  problems.push({ route: current, kind: msg.type(), text: text.slice(0, 220) });
});
page.on('pageerror', (err) => {
  problems.push({ route: current, kind: 'exception', text: String(err.message).slice(0, 220) });
});

// ── Sign in once; the session cookie carries across the whole context.
current = '/login';
if (process.env.SMOKE_LOGIN === 'demo') {
  await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
  await page.locator('[data-slot="demo-account"]').first().click();
} else {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#email').fill(process.env.SMOKE_EMAIL || 'arun@raceautospares.in');
  await page.locator('#password').fill(process.env.DEMO_PASSWORD || 'Rekonza@2026');
  await page.getByRole('button', { name: /^Sign in$/ }).click();
}
await page.waitForURL('**/dashboard', { timeout: 60000 });
await page.waitForTimeout(1200);

// A record of each kind, so the screens behind [id] are opened too.
const sample = async (api, key, make) => {
  const body = await page.evaluate(async (u) => (await fetch(u)).json().catch(() => null), api).catch(() => null);
  const first = body?.[key]?.[0];
  return first ? [make(first.id)] : [];
};
ROUTES.splice(ROUTES.length - 3, 0,
  ...await sample('/api/invoices?limit=5', 'invoices', (id) => `/sales/invoices/${id}`),
  ...await sample('/api/invoices?limit=5', 'invoices', (id) => `/sales/invoices/${id}/print`),
  ...await sample('/api/bills?limit=5', 'bills', (id) => `/purchases/bills/${id}`),
  ...await sample('/api/contacts?kind=customer', 'contacts', (id) => `/sales/customers/${id}`),
);

const results = [];
for (const route of ROUTES) {
  current = route;
  const before = problems.length;
  let status = 'ok';
  let detail = '';
  try {
    const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
    if (resp && resp.status() >= 400) { status = 'http'; detail = `HTTP ${resp.status()}`; }
    // Next.js renders its error overlay into this element on a client crash.
    const overlay = await page.locator('nextjs-portal').count();
    const h1 = await page.locator('h1, h2').first().textContent({ timeout: 5000 }).catch(() => null);
    if (overlay > 0) {
      const overlayText = await page.locator('nextjs-portal').first().innerText().catch(() => '');
      if (/Console Error|Unhandled Runtime Error|Failed to compile/i.test(overlayText)) {
        status = 'overlay';
        detail = overlayText.split('\n').slice(0, 3).join(' | ').slice(0, 160);
      }
    }
    if (!h1 && status === 'ok') { status = 'blank'; detail = 'no heading rendered'; }
  } catch (e) {
    status = 'threw';
    detail = String(e.message).slice(0, 140);
  }
  const newProblems = problems.length - before;
  if (newProblems > 0 && status === 'ok') { status = 'console'; detail = `${newProblems} console message(s)`; }
  results.push({ route, status, detail });
  const mark = status === 'ok' ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${route}${detail ? '  — ' + detail : ''}`);
}

await browser.close();

const failed = results.filter((r) => r.status !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} routes clean.`);
if (problems.length) {
  console.log('\nConsole messages captured:');
  const seen = new Set();
  for (const p of problems) {
    const key = `${p.route}|${p.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${p.kind}] ${p.route}\n      ${p.text}`);
  }
}
process.exit(failed.length ? 1 : 0);
