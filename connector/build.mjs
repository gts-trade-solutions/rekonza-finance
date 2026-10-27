// Build the connector into one Windows file the customer double-clicks.
//   node connector/build.mjs            → connector/dist/rekonza-tally.exe
//
// Node's own single-executable support does the work: the whole connector is
// bundled into one script, turned into a blob, and injected into a copy of the
// Node runtime. The result needs nothing installed on the customer's PC — no
// Node, no npm, no command line.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'connector', 'dist');
const work = path.join(out, 'build');
const exe = path.join(out, 'rekonza-tally.exe');

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ── 1. One script ────────────────────────────────────────────────────────────
const bundle = path.join(work, 'connector.cjs');
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [path.join(root, 'connector', 'src', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
});

// ── 2. A blob of it ──────────────────────────────────────────────────────────
const seaConfig = path.join(work, 'sea-config.json');
const blob = path.join(work, 'connector.blob');
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: work });

// ── 3. Injected into a copy of Node ──────────────────────────────────────────
copyFileSync(process.execPath, exe);
const postject = require.resolve('postject/dist/cli.js');
execFileSync(
  process.execPath,
  [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { stdio: 'inherit' },
);

rmSync(work, { recursive: true, force: true });
console.log(`\nBuilt ${exe}`);
console.log('Unsigned: Windows will warn until it is signed with a code-signing certificate.');
