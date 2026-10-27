// The signed-in journey, in a real browser, against the real database.
//   node scripts/auth-flow.mjs
//
// The API tests prove the endpoints behave; this proves the app actually uses
// them — that the shell is gated on a server session rather than on localStorage,
// and that signing out ends access rather than merely hiding it.

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5001';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
// The 401 and 403 below are provoked on purpose — the browser logs every
// failed fetch as a console error, and those two are the assertions passing.
page.on('console', (m) => {
  const t = m.text();
  if (m.type() !== 'error') return;
  if (/favicon|DevTools|404|status of 401|status of 403/i.test(t)) return;
  errors.push(t.slice(0, 160));
});

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ── 1. The shell is closed to anonymous visitors
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('Visiting the app without a session lands on the login page',
  page.url().includes('/login'), page.url());

// ── 2. A wrong password is refused, and says so
await page.locator('#email').fill('arun@raceautospares.in');
await page.locator('#password').fill('definitely-not-the-password');
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.waitForTimeout(1500);
check('A wrong password is refused',
  await page.locator('[data-slot="login-error"]').count() > 0);
check('The refusal does not reveal whether the email exists',
  /Email or password is incorrect/.test(await page.locator('[data-slot="login-error"]').innerText()));
check('A failed sign-in does not enter the app', page.url().includes('/login'));

// ── 3. Real credentials get in
await page.locator('#password').fill('Rekonza@2026');
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.waitForURL('**/dashboard', { timeout: 20000 });
// The shell loads master data before it renders, so wait for content rather
// than a fixed delay — otherwise this races the gate on a slow machine.
await page.waitForSelector('main', { timeout: 30000 });
await page.waitForFunction(() => (document.querySelector('main')?.textContent ?? '').length > 50,
  null, { timeout: 30000 });
check('Correct credentials reach the dashboard', page.url().includes('/dashboard'));

const shell = await page.locator('body').innerText();
check('The signed-in user is shown in the shell', /Arun/.test(shell));

// ── 4. The session is a server cookie, not readable by script
const cookies = await ctx.cookies();
const session = cookies.find((c) => c.name === 'rekonza_session');
check('A session cookie was issued', !!session);
check('The session cookie is httpOnly', !!session?.httpOnly);
const readable = await page.evaluate(() => document.cookie.includes('rekonza_session'));
check('Page scripts cannot read the session cookie', readable === false);

// ── 5. Invoices come from the database, not from local storage
const list = await page.evaluate(async () => {
  const r = await fetch('/api/invoices?limit=5', { credentials: 'include' });
  return { status: r.status, body: await r.json() };
});
check('The API serves invoices to the signed-in browser', list.status === 200,
  `${list.body.summary?.count ?? 0} invoices in the database`);

// ── 6. A sales user cannot do what a viewer cannot
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
const viewerAttempt = await page.evaluate(async () => {
  await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'deepa@raceautospares.in', password: 'Rekonza@2026' }),
  });
  const r = await fetch('/api/invoices', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branchId: '1', customerId: '1', date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId: '1', qty: 1, ratePaise: 1000 }],
    }),
  });
  return { status: r.status, body: await r.json() };
});
check('A viewer is refused by the server, not just by a hidden button',
  viewerAttempt.status === 403, viewerAttempt.body.error);

// ── 7. Signing out ends access immediately
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
const afterLogout = await page.evaluate(async () => {
  const r = await fetch('/api/auth/me', { credentials: 'include' });
  return r.status;
});
check('The session is dead the moment it is revoked', afterLogout === 401);

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('The shell sends a signed-out user back to login', page.url().includes('/login'));

await browser.close();

const unique = [...new Set(errors)];
console.log(`\n${pass} passed, ${fail} failed.`);
if (unique.length) {
  console.log('\nConsole errors during the run:');
  unique.forEach((e) => console.log('  ' + e));
}
process.exit(fail || unique.length ? 1 : 0);
