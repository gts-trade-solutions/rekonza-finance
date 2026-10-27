// Records the demo book for the online demo (lib/demo-snapshot.ts).
//
// Opens the demo book through its own door on a running copy, visits every
// screen, clicks every tab, follows links into records, and keeps each /api
// reply under public/demo-snapshot. Every request that would write is blocked
// before it leaves the browser, so recording changes nothing in the books.
//
//   BASE=http://localhost:5001 npx tsx scripts/demo-snapshot.ts

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { snapshotQuery, SNAPSHOT_DIR, type SnapshotManifest } from '../lib/demo-snapshot';

const BASE = (process.env.BASE || 'http://localhost:5001').replace(/\/$/, '');
const OUT = path.join(process.cwd(), 'public', SNAPSHOT_DIR);
/** How many records of one kind to open (invoices, bills, …). */
const PER_KIND = Number(process.env.PER_KIND) || 80;

const EXT: Record<string, string> = {
  'application/json': 'json',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// ── The screens ─────────────────────────────────────────────────────────────

function pages(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // A route group, (app), adds nothing to the address.
      out.push(...pages(full, /^\(.*\)$/.test(name) ? prefix : `${prefix}/${name}`));
    } else if (name === 'page.tsx') {
      out.push(prefix || '/');
    }
  }
  return out;
}

const routes = [...pages(path.join('app', '(app)')), ...pages(path.join('app', 'portal'), '/portal')];
const fixed = routes.filter((r) => !r.includes('['));
// A record's screen; /sales/invoices/new is a form, not invoice "new".
const kinds = routes
  .filter((r) => r.includes('['))
  .map((r) => ({ route: r, re: new RegExp(`^${r.replace(/\[[^\]]+\]/g, '(?!new(?:/|$))[^/]+')}$`) }));

/** Lists whose records open from a row, and the screen each record opens on. */
const ROWS = [
  { api: '/api/contacts?kind=customer&limit=500', screen: '/sales/customers/[id]' },
  { api: '/api/invoices?limit=500', screen: '/sales/invoices/[id]' },
  { api: '/api/bills?limit=500', screen: '/purchases/bills/[id]' },
];

// ── The recording ───────────────────────────────────────────────────────────

const replies = new Map<string, Map<string, string>>(); // path → query → file
const bodies = new Map<string, Buffer>(); // file → body
const blocked = new Set<string>();
const failed = new Set<string>();
const pending: Promise<void>[] = [];
let current = '/login';

async function keep(res: import('playwright').Response) {
  const url = new URL(res.url());
  if (res.status() !== 200) {
    failed.add(`${res.status()} ${url.pathname} (on ${current})`);
    return;
  }
  const type = (res.headers()['content-type'] || '').split(';')[0].trim();
  const ext = EXT[type];
  if (!ext) return;
  let body = await res.body().catch(() => null);
  if (!body) return;
  // The banner that says saving is off reads this flag; the real server never sends it.
  if (url.pathname === '/api/auth/me') body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString('utf8')), demoSnapshot: true }));
  const file = `${createHash('sha256').update(body).digest('hex').slice(0, 20)}.${ext}`;
  bodies.set(file, body);
  const byQuery = replies.get(url.pathname) ?? new Map<string, string>();
  byQuery.set(snapshotQuery(url.searchParams), file);
  replies.set(url.pathname, byQuery);
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function visit(page: Page, route: string) {
  current = route;
  try {
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 120_000 });
  } catch {
    await settle(page);
  }
  await page.waitForTimeout(600);
  // Each tab, in turn; one that leads to another address is followed back.
  const tabs = await page.getByRole('tab').count();
  for (let i = 0; i < tabs; i++) {
    try {
      const tab = page.getByRole('tab').nth(i);
      if (!(await tab.isVisible()) || (await tab.getAttribute('aria-selected')) === 'true') continue;
      await tab.click({ timeout: 3_000 });
      await settle(page);
      if (new URL(page.url()).pathname !== route.split('?')[0]) {
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
      }
    } catch {
      /* a tab that cannot be clicked has nothing to record */
    }
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();

  await page.route(`${BASE}/api/**`, (r) => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    if (req.method() === 'GET' || p === '/api/auth/demo' || p === '/api/auth/logout') return r.continue();
    blocked.add(`${req.method()} ${p} (on ${current})`);
    return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Blocked while recording.', code: 'recording' }) });
  });
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (`${url.protocol}//${url.host}` === BASE && url.pathname.startsWith('/api/') && res.request().method() === 'GET') {
      pending.push(keep(res).catch(() => {}));
    }
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 120_000 });
  const opened = await page.evaluate(async () => {
    const r = await fetch('/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
    return r.status;
  });
  if (opened !== 200) throw new Error(`The demo book did not open (${opened}). Is it seeded? npm run db:seed`);

  const queue = [...fixed];
  const queued = new Set(queue);
  const perKind = new Map<string, number>();
  const enqueue = (p: string) => {
    if (queued.has(p)) return;
    const k = kinds.find((x) => x.re.test(p));
    if (!k) return;
    const n = perKind.get(k.route) ?? 0;
    if (n >= PER_KIND) return;
    perKind.set(k.route, n + 1);
    queued.add(p);
    queue.push(p);
  };
  // Every row of these lists, since a row opened by clicking it leaves no link to follow.
  for (const { api, screen } of ROWS) {
    const res = await page.request.get(BASE + api);
    const body = res.ok() ? await res.json() : null;
    const rows = Array.isArray(body) ? body : (Object.values(body ?? {}).find(Array.isArray) as { id: string }[] | undefined);
    for (const row of rows ?? []) enqueue(screen.replace('[id]', String(row.id)));
  }
  const started = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const route = queue[i];
    await visit(page, route);
    console.log(`${String(i + 1).padStart(4)}/${queue.length}  ${route}`);

    // Records this screen links to, and the screens beneath a record (its print view, say).
    const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href') || '')).catch(() => [] as string[]);
    const kind = kinds.find((k) => k.re.test(route));
    if (kind) {
      for (const sub of kinds) if (sub.route.startsWith(`${kind.route}/`)) hrefs.push(route + sub.route.slice(kind.route.length));
    }
    for (const href of hrefs) enqueue(href.split(/[?#]/)[0]);
  }

  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' })).catch(() => {});
  await Promise.all(pending);
  await browser.close();

  // ── Write it out ────────────────────────────────────────────────────────────

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  let bytes = 0;
  for (const [file, body] of bodies) {
    // Only the files some reply still points at.
    if (![...replies.values()].some((m) => [...m.values()].includes(file))) continue;
    writeFileSync(path.join(OUT, file), body);
    bytes += body.length;
  }
  const manifest: SnapshotManifest = {
    recordedAt: new Date().toISOString(),
    routes: Object.fromEntries([...replies].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, m]) => [p, [...m]])),
  };
  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));

  console.log(`\n${queue.length} screens in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`${replies.size} API paths, ${[...replies.values()].reduce((n, m) => n + m.size, 0)} replies, ${new Set([...replies.values()].flatMap((m) => [...m.values()])).size} files, ${(bytes / 1e6).toFixed(1)} MB`);
  for (const k of kinds) console.log(`  ${k.route}: ${perKind.get(k.route) ?? 0} opened`);
  if (blocked.size) console.log(`\nWrites blocked:\n  ${[...blocked].join('\n  ')}`);
  if (failed.size) console.log(`\nNot recorded (not 200):\n  ${[...failed].join('\n  ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
