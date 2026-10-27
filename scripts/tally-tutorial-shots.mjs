// Capture the exact REKONZA screens used by the Tally connector tutorial.
//
// The browser uses the real app and a signed-in demo session. Tally API calls
// are intercepted with deterministic tutorial data so no database rows are
// created or changed while the pairing, connected, and first-sync states are
// recorded.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000';
const OUT = 'docs/tally-tutorial/images';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto(`${BASE}/login?demo=1`, { waitUntil: 'networkidle' });
await page.locator('[data-slot="demo-account"][data-role="admin"]').click();
await page.waitForURL('**/dashboard');

let state = 'empty';
const now = new Date();
const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
const syncedAt = now.toISOString();

const emptyOverview = { pendingCodeExpiresAt: null, connectors: [], companies: [] };
const connector = {
  id: '71',
  status: 'active',
  machineName: 'ACCOUNTS-PC',
  connectorVersion: '0.1.0',
  tallyVersion: 'TallyPrime Release 6.1',
  tokenPrefix: 'tly_example',
  pairedAt: syncedAt,
  lastSeenAt: syncedAt,
  lastError: null,
  companies: state === 'synced' ? 1 : 0,
};
const company = {
  id: '101',
  name: 'Sharma Auto Parts Pvt Ltd',
  gstin: '33AAAAA0000A1Z5',
  stateName: 'Tamil Nadu',
  booksFrom: '2024-04-01',
  fyFrom: '2026-04-01',
  asOf: '2026-10-03',
  lastSyncedAt: syncedAt,
  lastError: null,
  maintainsInventory: true,
  connectorName: 'ACCOUNTS-PC',
  connectorStatus: 'active',
  ledgers: 148,
  vouchers: 1264,
  stockItems: 386,
  firstVoucherDate: '2026-04-01',
  lastVoucherDate: '2026-10-03',
};

await page.route('**/api/tally', async (route, request) => {
  if (request.method() === 'POST') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'K7Q2-9MXP', expiresAt, minutes: 15 }),
    });
    return;
  }
  const overview = state === 'empty'
    ? emptyOverview
    : {
        pendingCodeExpiresAt: null,
        connectors: [{ ...connector, companies: state === 'synced' ? 1 : 0 }],
        companies: state === 'synced' ? [company] : [],
      };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overview) });
});

await page.route('**/api/tally/companies/101**', async (route) => {
  const url = new URL(route.request().url());
  const view = url.searchParams.get('view');
  if (view === 'day-book') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        from: '2026-10-01',
        to: '2026-10-03',
        totalDebitPaise: 18876500,
        totalCreditPaise: 18876500,
        truncated: false,
        rows: [
          {
            id: '1', date: '2026-10-03', voucherType: 'Sales', baseType: 'Sales', number: 'INV/1028',
            particulars: 'Apex Motors', debitPaise: 11800000, creditPaise: null,
            narration: 'Automotive spares', isCancelled: false, isOptional: false,
            entries: [
              { ledger: 'Apex Motors', debitPaise: 11800000, creditPaise: 0 },
              { ledger: 'Sales', debitPaise: 0, creditPaise: 10000000 },
              { ledger: 'Output GST', debitPaise: 0, creditPaise: 1800000 },
            ],
          },
          {
            id: '2', date: '2026-10-02', voucherType: 'Receipt', baseType: 'Receipt', number: 'RCT/0441',
            particulars: 'HDFC Bank', debitPaise: 7076500, creditPaise: null,
            narration: 'Customer receipt', isCancelled: false, isOptional: false,
            entries: [
              { ledger: 'HDFC Bank', debitPaise: 7076500, creditPaise: 0 },
              { ledger: 'Sharma Traders', debitPaise: 0, creditPaise: 7076500 },
            ],
          },
        ],
      }),
    });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot ${name}`);
};

await page.goto(`${BASE}/tally`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-slot="tally-setup"]');
await shot('01-tally-empty-state');

await page.locator('[data-slot="tally-connect"]').first().click();
await page.waitForSelector('[data-slot="tally-code"]');
await shot('02-pairing-code-dialog');

state = 'paired';
await page.waitForTimeout(4500);
await page.waitForSelector('[data-slot="tally-paired"]');
await shot('03-pairing-success');

await page.getByRole('button', { name: 'Done' }).click();
state = 'synced';
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-slot="tally-company"]');
await shot('04-company-synced');

await page.locator('[data-slot="tally-company"]').click();
await page.waitForURL('**/tally/101');
await page.waitForSelector('[data-slot="tally-freshness"]');
await page.waitForSelector('text=INV/1028');
await shot('05-company-day-book');

const setGuide = async (body) => {
  await page.setContent(`
    <!doctype html>
    <html><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; width: 1600px; height: 900px; overflow: hidden; background: linear-gradient(145deg, #f8fbfd, #eaf1f5); color: #101828; font-family: Arial, sans-serif; }
      .frame { width: 100%; height: 100%; padding: 72px 92px; display: flex; flex-direction: column; }
      .eyebrow { color: #0573c8; font-size: 22px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 14px 0 16px; font-size: 58px; letter-spacing: -.035em; }
      .sub { color: #536273; font-size: 25px; line-height: 1.45; max-width: 1050px; }
      .card { margin-top: 46px; background: white; border: 1px solid #cfd9e2; border-radius: 20px; box-shadow: 0 18px 50px rgba(32, 55, 76, .09); padding: 40px 44px; }
      .path { display: flex; align-items: center; gap: 18px; font-size: 29px; font-weight: 700; }
      .path span { padding: 15px 22px; border-radius: 12px; background: #edf6fd; border: 1px solid #c7e5fb; }
      .arrow { color: #0573c8; font-size: 34px; }
      .settings { margin-top: 32px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      .setting { border: 1px solid #d7e0e7; border-radius: 14px; padding: 24px; background: #fbfdfe; }
      .setting b { display: block; color: #0573c8; font-size: 17px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
      .setting strong { font-size: 28px; }
      .confirm { margin-top: 26px; color: #087f5b; font-size: 24px; font-weight: 700; }
      .terminal { margin-top: 42px; background: #111a26; color: #d6e3ee; border-radius: 18px; padding: 34px 40px; box-shadow: 0 18px 50px rgba(15, 24, 36, .2); font-family: Consolas, monospace; font-size: 25px; line-height: 1.75; }
      .prompt { color: #52c7ff; } .ok { color: #74dbb5; } .muted { color: #93a6b7; }
      .note { margin-top: 24px; display: flex; gap: 18px; align-items: center; font-size: 22px; color: #475569; }
      .shield { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: #e4f7f0; color: #087f5b; font-weight: 800; }
    </style></head><body>${body}</body></html>
  `);
};

await setGuide(`
  <div class="frame">
    <div class="eyebrow">TallyPrime setup</div>
    <h1>Turn on Tally's data port</h1>
    <div class="sub">Do this once on the PC or server where TallyPrime runs, with the company open.</div>
    <div class="card">
      <div class="path"><span>F1 Help</span><div class="arrow">→</div><span>Settings</span><div class="arrow">→</div><span>Connectivity</span></div>
      <div class="settings">
        <div class="setting"><b>Act as server</b><strong>Yes</strong></div>
        <div class="setting"><b>Port</b><strong>9000</strong></div>
        <div class="setting"><b>Save</b><strong>Ctrl + A</strong></div>
      </div>
      <div class="confirm">✓ Confirm the top of the Tally window reads “TallyPrime:9000”.</div>
    </div>
  </div>
`);
await shot('06-tally-port-setup-guide');

await setGuide(`
  <div class="frame">
    <div class="eyebrow">REKONZA connector</div>
    <h1>Pair this PC, then keep sync running</h1>
    <div class="sub">Current repository implementation: run these commands on the same PC as TallyPrime.</div>
    <div class="terminal">
      <div><span class="prompt">PS&gt;</span> rekonza-tally pair K7Q2-9MXP --portal https://YOUR-REKONZA-DOMAIN</div>
      <div class="ok">Paired with your organisation.</div>
      <div><span class="prompt">PS&gt;</span> rekonza-tally run</div>
      <div class="muted">Syncing the portal every 5 minute(s). Press Ctrl+C to stop.</div>
    </div>
    <div class="note"><div class="shield">✓</div><div>Use only the one-time code. The connector never needs your REKONZA password.</div></div>
  </div>
`);
await shot('07-connector-command-guide');

await browser.close();

if (errors.length) {
  throw new Error(`Browser errors: ${[...new Set(errors)].join(' | ')}`);
}

