// Adds a few replies to the online demo's recording without recording every
// screen again (scripts/demo-snapshot.ts takes half an hour): for when a
// window gains a request the recording lacks. Run against the same book the
// recording was made from, on a running copy:
//
//   BASE=http://localhost:5023 npx tsx scripts/demo-snapshot-add.ts
//
// Each URL may hold [id], filled from a list reply, as in demo-snapshot.ts's DIALOGS.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { snapshotQuery, SNAPSHOT_DIR, type SnapshotManifest } from '../lib/demo-snapshot';

const BASE = (process.env.BASE || 'http://localhost:5001').replace(/\/$/, '');
const OUT = path.join(process.cwd(), 'public', SNAPSHOT_DIR);
const today = new Date().toISOString().slice(0, 10);

const ADD: { list: string; detail: string }[] = [
  { list: '/api/fixed-assets?view=register', detail: `/api/fixed-assets?view=sale-advice&id=[id]&date=${today}` },
  ...['invoice', 'bank', 'none'].map((via) => ({ list: '/api/fixed-assets?view=register', detail: `/api/fixed-assets?view=disposal-preview&id=[id]&date=${today}&salePaise=0&via=${via}` })),
];

async function main() {
  const door = await fetch(`${BASE}/api/auth/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
  if (!door.ok) throw new Error(`the demo book did not open: ${door.status}`);
  const cookie = door.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const get = (u: string) => fetch(BASE + u, { headers: { cookie } });

  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  let added = 0;
  for (const { list, detail } of ADD) {
    const r = await get(list);
    if (!r.ok) throw new Error(`${list}: ${r.status}`);
    const body = (await r.json()) as Record<string, unknown>;
    const rows = (Array.isArray(body) ? body : Object.values(body).find(Array.isArray) ?? []) as { id: string }[];
    for (const row of rows) {
      const u = new URL(BASE + detail.replace('[id]', String(row.id)));
      const res = await get(u.pathname + u.search);
      if (res.status !== 200) { console.log(`  not 200 (${res.status}): ${u.pathname}${u.search}`); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = `${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}.json`;
      writeFileSync(path.join(OUT, file), bytes);
      const variants = (manifest.routes[u.pathname] ??= []);
      const q = snapshotQuery(u.searchParams);
      const at = variants.findIndex(([k]) => k === q);
      if (at >= 0) variants[at] = [q, file]; else variants.push([q, file]);
      added++;
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await get('/api/auth/logout').catch(() => {});
  console.log(`${added} replies added to the recording`);
}

main().catch((err) => { console.error(err); process.exit(1); });
