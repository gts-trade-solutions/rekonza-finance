// Push an export file into a running TallyPrime, and print what Tally made of it.
//   npm run tally:import -- <file.xml> [--host localhost] [--port 9000]
//
// Tally's data port takes imports as well as exports: the same envelope the
// Gateway of Tally → Import menu reads, posted over HTTP. That makes it the
// quickest way to check an export against real Tally — it answers with its own
// counts of what it created, altered and refused, and names the first error.
//
// A development tool, not part of the product: the connector itself only ever
// reads from Tally.

import { readFileSync } from 'node:fs';
import { postTally, TallyUnavailable } from '../connector/src/tally-client';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? (args[i + 1] ?? fallback) : fallback;
};

if (!file) {
  console.error('Usage: npm run tally:import -- <file.xml> [--host localhost] [--port 9000]');
  process.exit(2);
}

const address = { host: option('host', 'localhost'), port: Number(option('port', '9000')), timeoutMs: 300_000 };

/** Tally answers an import with a tally of what it did. */
function summarise(xml: string) {
  const n = (tag: string) => Number(xml.match(new RegExp(`<${tag}>(-?\\d+)</${tag}>`))?.[1] ?? 0);
  const errors = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => m[1].trim());
  return {
    created: n('CREATED'), altered: n('ALTERED'), deleted: n('DELETED'),
    ignored: n('IGNORED'), combined: n('COMBINED'), cancelled: n('CANCELLED'),
    errors: Math.max(n('ERRORS'), errors.length),
    messages: errors.slice(0, 10),
  };
}

async function main() {
  // Sent without the byte-order mark a browser download carries: Tally reads
  // the envelope itself, and a mark before "<?xml" is not part of it.
  const xml = readFileSync(file!, 'utf8').replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '');
  const vouchers = (xml.match(/<VOUCHER /g) ?? []).length;
  const ledgers = (xml.match(/<LEDGER /g) ?? []).length;
  console.log(`Sending ${file} to ${address.host}:${address.port} — ${ledgers} ledger(s), ${vouchers} voucher(s).`);

  const reply = await postTally(xml, address);
  const s = summarise(reply);
  console.log(`Tally created ${s.created}, altered ${s.altered}, ignored ${s.ignored}, cancelled ${s.cancelled}, errors ${s.errors}.`);
  for (const m of s.messages) console.log(`  refused: ${m}`);
  if (!s.created && !s.altered && !s.errors) console.log(reply.slice(0, 600));
  process.exit(s.errors ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof TallyUnavailable ? err.message : (err as Error).message);
  process.exit(1);
});
