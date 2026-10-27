// Stand in for the Tally connector: pair with a code, then push a sample
// company through the same endpoints a real connector uses.
//   npm run tally:simulate -- --code K7Q2-9MXP      pair like the real connector
//   npm run tally:simulate -- --org-id 12           make the code directly (local only)
//
// Until the connector runs on a PC with TallyPrime, this is how the Tally
// screens get something real to show: a company worked out the way Tally
// would, sent message by message over HTTP, through pairing, authentication
// and validation exactly as the connector's will be.

import { transaction, db } from '../lib/server/db';
import { createPairingCode } from '../lib/server/tally/connectors';
import type { HelloReply, PairReply, VouchersReply } from '../lib/tally/protocol';
import { sampleCompany } from './tally/sample-company';

const BASE = (process.env.TALLY_PORTAL_URL || 'http://localhost:5000').replace(/\/+$/, '');

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered HTTP ${res.status} with something that is not JSON.`);
  }
  if (!res.ok) {
    const e = json as { error?: string; details?: unknown };
    throw new Error(`${path} refused (HTTP ${res.status}): ${e.error ?? text}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}`);
  }
  return json as T;
}

async function main() {
  let code = arg('code');
  const orgId = arg('org-id');
  if (!code && !orgId) {
    console.error('Pass --code with a pairing code from the portal (Tally → Connect a PC), or --org-id to make one locally.');
    process.exit(2);
  }
  if (!code) {
    const made = await transaction((trx) => createPairingCode(trx, Number(orgId), null));
    code = made.code;
    console.log(`made pairing code ${code} for organisation ${orgId}`);
  }
  await db.destroy();

  const asOf = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const sample = sampleCompany(asOf);

  const pair = await post<PairReply>('/api/tally/pair', {
    code,
    machineName: sample.hello.machineName,
    connectorVersion: sample.hello.connectorVersion,
  });
  console.log(`paired with ${pair.organisation}`);
  const token = pair.token;

  const hello = await post<HelloReply>('/api/tally/sync', sample.hello, token);
  const companyId = hello.companies[0].companyId;
  console.log(`hello · ${sample.hello.companies[0].name} is company ${companyId}`);

  await post('/api/tally/sync', sample.masters, token);
  console.log(`masters · ${sample.masters.groups.length} groups, ${sample.masters.ledgers.length} ledgers, ${sample.masters.stockItems.length} stock items`);

  let stored = 0;
  for (let i = 0; i < sample.vouchers.length; i += 500) {
    const reply = await post<VouchersReply>(
      '/api/tally/sync',
      { kind: 'vouchers', companyGuid: sample.hello.companies[0].guid, vouchers: sample.vouchers.slice(i, i + 500) },
      token,
    );
    stored += reply.stored;
    if (reply.rejected.length) console.log(`  refused: ${JSON.stringify(reply.rejected)}`);
  }
  console.log(`vouchers · ${stored} stored`);

  await post('/api/tally/sync', sample.index, token);
  await post('/api/tally/sync', { kind: 'status', error: null }, token);
  console.log(`\nOpen ${BASE}/tally/${companyId}`);
}

// Exits when done: the server modules it imports keep handles open that a
// one-shot command has no reason to wait for.
main().then(() => process.exit(0)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
