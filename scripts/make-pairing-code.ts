// Make a pairing code for the newest book, for local testing of the connector.
//   npx tsx --conditions=react-server --env-file=.env.local scripts/make-pairing-code.ts
import { db } from '../lib/server/db';
import { createPairingCode } from '../lib/server/tally/connectors';

async function main() {
  const org = await db.selectFrom('organizations').select(['id', 'name'])
    .where('is_demo', '=', 0).orderBy('id', 'desc').executeTakeFirstOrThrow();
  const { code } = await createPairingCode(db, Number(org.id), null);
  console.log(`${org.name}: ${code}`);
  await db.destroy();
}
main().then(() => process.exit(0));
