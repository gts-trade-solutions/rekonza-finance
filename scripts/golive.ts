// The go-live check from a terminal, against whichever settings it is given:
//
//   npm run golive                                   this machine's .env.local
//   npx tsx --conditions=react-server --env-file=.env.production.local scripts/golive.ts
//
// Exits non-zero while anything required is missing, so a deployment can be
// held back on it. Only says whether a secret is set, never what it is.

import { db } from '../lib/server/db';
import { goLiveChecks, type CheckStatus } from '../lib/server/golive';

const MARK: Record<CheckStatus, string> = { ok: 'OK    ', warn: 'WARN  ', fail: 'FAIL  ', manual: 'DO    ' };
const GROUPS = { required: 'Required', connections: 'Connections', data: 'The books' } as const;

async function main() {
  const checks = await goLiveChecks();
  for (const group of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) {
    const mine = checks.filter((c) => c.group === group);
    if (!mine.length) continue;
    console.log(`\n${GROUPS[group]}`);
    for (const c of mine) {
      console.log(`  ${MARK[c.status]}${c.label}: ${c.detail}`);
      if (c.status !== 'ok' && c.fix) console.log(`        → ${c.fix}`);
    }
  }
  const failing = checks.filter((c) => c.status === 'fail');
  console.log(failing.length ? `\nNot ready: ${failing.length} required item${failing.length === 1 ? '' : 's'} to fix.` : '\nReady to keep real books. Work through the warnings before the client relies on them.');
  await db.destroy();
  process.exitCode = failing.length ? 1 : 0;
}

void main();
