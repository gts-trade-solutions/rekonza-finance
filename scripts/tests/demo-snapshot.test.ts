// The recorded online demo: which reply a request gets, and when it is played at all.
//
//   npx tsx --test scripts/tests/demo-snapshot.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRecording, snapshotMode, snapshotQuery, type SnapshotManifest } from '../../lib/demo-snapshot';
import manifest from '../../public/demo-snapshot/manifest.json';

test('the same view has the same key, whatever order the query came in', () => {
  assert.equal(snapshotQuery(new URLSearchParams('to=2026-10-27&from=2026-04-01')), 'from=2026-04-01&to=2026-10-27');
  assert.equal(snapshotQuery(new URLSearchParams('q=a b&type=customer')), 'q=a%20b&type=customer');
  assert.equal(snapshotQuery(new URLSearchParams('')), '');
});

test('the closest recording: exact, then most shared, then the plainest', () => {
  const variants: [string, string][] = [
    ['', 'all.json'],
    ['status=paid', 'paid.json'],
    ['from=2026-04-01&to=2026-10-27', 'ytd.json'],
  ];
  assert.equal(pickRecording(variants, 'status=paid'), 'paid.json');
  // A report asked for a day after it was recorded.
  assert.equal(pickRecording(variants, 'from=2026-04-01&to=2026-10-28'), 'ytd.json');
  // A filter never recorded falls back to the unfiltered list.
  assert.equal(pickRecording(variants, 'status=void'), 'all.json');
  assert.equal(pickRecording(undefined, ''), null);
  assert.equal(pickRecording([], ''), null);
});

test('another report never stands in for the one asked for', () => {
  const reports: [string, string][] = [
    ['from=2026-04-01&report=profit-and-loss&to=2026-10-27', 'pl.json'],
    ['report=trial-balance&to=2026-10-27', 'tb.json'],
  ];
  assert.equal(pickRecording(reports, 'from=2026-04-01&report=profit-and-loss&to=2026-11-03'), 'pl.json');
  assert.equal(pickRecording(reports, 'report=trial-balance&to=2026-03-31'), 'tb.json');
  // Sharing the dates is not enough: the cash-flow report was never recorded.
  assert.equal(pickRecording(reports, 'from=2026-04-01&report=cash-flow&to=2026-10-27'), null);
  // A different limit or period is still the same list.
  assert.equal(pickRecording([['limit=500', 'inv.json']], 'limit=100'), 'inv.json');
  assert.equal(pickRecording([['period=2026-10&view=gstr1', 'g1.json']], 'period=2026-09&view=gstr1'), 'g1.json');
});

test('played on a Vercel deployment with no database, or when asked', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['DEMO_SNAPSHOT', 'VERCEL', 'DATABASE_URL', 'DB_HOST']) delete process.env[k];
    assert.equal(snapshotMode(), false, 'never on a machine of your own');
    process.env.VERCEL = '1';
    assert.equal(snapshotMode(), true);
    process.env.DB_HOST = 'db.example.in';
    assert.equal(snapshotMode(), false, 'a database is configured');
    delete process.env.DB_HOST;
    process.env.DATABASE_URL = 'mysql://u:p@db.example.in:3306/rekonza';
    assert.equal(snapshotMode(), false);
    process.env.DEMO_SNAPSHOT = '1';
    assert.equal(snapshotMode(), true, 'asked for outright');
    delete process.env.DATABASE_URL;
    process.env.DEMO_SNAPSHOT = '0';
    assert.equal(snapshotMode(), false, 'turned off outright');
  } finally {
    process.env = saved;
  }
});

test('the recording holds the session, and every file it names', async () => {
  const { existsSync } = await import('node:fs');
  const routes = (manifest as unknown as SnapshotManifest).routes;
  assert.ok(routes['/api/auth/me'], 'without the session, the app shell never opens');
  for (const variants of Object.values(routes)) {
    for (const [, file] of variants) assert.ok(existsSync(`public/demo-snapshot/${file}`), file);
  }
});
