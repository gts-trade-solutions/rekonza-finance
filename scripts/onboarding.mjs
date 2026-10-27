// Walks the signed-out surface and the sign-up flow end to end.
//   node scripts/onboarding.mjs
//
// Three things are being checked, in order:
//   1. the landing page renders for a visitor with no session at all;
//   2. a real sign-up produces a working, EMPTY set of books — no seeded
//      customers, no seeded documents, the organisation's own name in the
//      chrome, and no "demo" banner anywhere;
//   3. the demo door still opens onto the seeded book, and that book IS
//      labelled as a demo.
//
// Screenshots land in scripts/shots/ so the result can be eyeballed as well as
// asserted.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';
const OUT = 'scripts/shots';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ── 1. The landing page, signed out ─────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  console.log('\nLanding page');

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  ok('stays on / (no redirect to the app)', new URL(page.url()).pathname === '/', page.url());
  ok('shows the tagline', await page.getByRole('heading', { name: 'Books. Made Smarter.' }).isVisible());
  ok('has a Sign in link', await page.getByRole('link', { name: 'Sign in' }).first().isVisible());
  ok('has a register call to action', await page.getByRole('link', { name: /Create your books/ }).first().isVisible());
  ok('carries JSON-LD', (await page.locator('script[type="application/ld+json"]').count()) > 0);
  ok('title names the brand', (await page.title()).includes('REKONZA AI'), await page.title());
  ok('renders the wordmark', await page.locator('img[alt="REKONZA AI"]').first().isVisible());

  await page.screenshot({ path: `${OUT}/landing-top.png` });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/landing-bottom.png` });
  await ctx.close();
}

// ── 2. Sign up, and land in an empty book ───────────────────────────────────
const stamp = Date.now().toString().slice(-7);
const email = `owner${stamp}@example.in`;
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  console.log('\nSign-up');

  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.fill('#businessName', `Test Trading Co ${stamp}`);
  await page.locator('[data-slot="combobox-trigger"]').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: /Karnataka/ }).click();
  await page.fill('#name', 'Test Owner');
  await page.fill('#email', email);
  await page.fill('#password', 'Testing@2026');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/register-filled.png` });

  await page.getByRole('button', { name: /Create my books/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 20_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/new-org-dashboard.png` });

  const body = (await page.locator('body').innerText()).toLowerCase();
  ok('signed straight in', page.url().includes('/dashboard'));
  ok('chrome shows the new business', body.includes(`test trading co ${stamp}`.toLowerCase()));
  ok('no seeded organisation name anywhere', !body.includes('race auto'));
  ok('no seeded customer leaked in', !body.includes('sharma traders'));
  ok('no demo banner', (await page.locator('[data-slot="demo-banner"]').count()) === 0);

  // The empty book has to render its screens, not crash on them.
  for (const [name, path] of [
    ['new-org-invoices', '/sales/invoices'],
    ['new-org-invoice-new', '/sales/invoices/new'],
    ['new-org-trial-balance', '/reports/trial-balance'],
    ['new-org-banking', '/banking'],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    const text = await page.locator('body').innerText();
    ok(`${path} renders`, !/Application error|Cannot reach the server/i.test(text));
  }

  // Form defaults must come from THIS organisation, not from the demo book.
  // The state on a new customer decides CGST+SGST versus IGST, so a default
  // left on the demo's Tamil Nadu would have a Karnataka business charging
  // integrated tax on its own doorstep sales.
  await page.goto(`${BASE}/sales/customers/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const stateShown = await page.locator('[data-slot="combobox-trigger"]').nth(1).innerText();
  ok('a new customer defaults to the org’s own state', /Karnataka/.test(stateShown), stateShown.trim());

  // No placeholder should name a real person, company, bank or place.
  const placeholders = await page.locator('input[placeholder]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('placeholder') ?? ''),
  );
  const leaked = placeholders.filter((v) =>
    /Race Auto|Sharma|Bosch|Arun|HDFC|ICICI|Mount Road|Guindy|98400|Chennai/i.test(v));
  ok('no placeholder carries real or demo data', leaked.length === 0, leaked.join(' | ') || 'clean');

  // The number a form offers must be the one the database will hand out. It
  // lives in an input, so innerText will not see it.
  await page.goto(`${BASE}/sales/invoices/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const values = await page.locator('input').evaluateAll((els) => els.map((e) => e.value));
  const number = values.find((v) => /^INV\//.test(v ?? ''));
  ok('numbering starts at one', !!number && number.endsWith('/0001'), number ?? 'no number found');

  await ctx.close();
}

// ── 3. The demo door ────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  console.log('\nDemo book');

  await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/login.png` });
  ok('demo panel is open from the landing link', await page.locator('[data-slot="demo-account"]').first().isVisible());

  await page.locator('[data-slot="demo-account"][data-role="admin"]').click();
  await page.waitForURL('**/dashboard', { timeout: 20_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/demo-dashboard.png` });

  const body = await page.locator('body').innerText();
  ok('opens the seeded book', body.includes('Race Auto Spares'));
  ok('is labelled a demo', (await page.locator('[data-slot="demo-banner"]').count()) === 1);
  ok('no demo-reset control remains', !body.includes('Reset to seed data'));

  // Search now comes from the server; the seeded book must be findable.
  await page.keyboard.press('/');
  await page.waitForTimeout(400);
  await page.keyboard.type('INV');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/demo-search.png` });
  const hits = await page.locator('[data-active]').count();
  ok('global search returns documents from the API', hits > 0, `${hits} hits`);

  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
