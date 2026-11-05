// Seed the demo book.
//   npm run db:seed              create the demo organisation and master data
//   npm run db:seed -- --fresh   rebuild the demo book from scratch
//
// Runs inside one transaction: either the whole book appears or none of it
// does. A half-seeded database is worse than an empty one, because it looks
// usable right up until the first missing account.
//
// --fresh deletes ONLY organisations flagged is_demo. Real books created
// through the sign-up form share this database, and a seed script that
// truncated every table would take a customer's ledger with it. The wipe is
// therefore scoped by org_id, and that flag is set by this script alone.

import { db, transaction } from '../lib/server/db';
import { bootstrap } from '../lib/server/seed/bootstrap';
import { seedDemoBook } from '../lib/server/seed/demo-book';
import { seedDemoDocuments } from '../lib/server/seed/demo-documents';
import { seedDemoCoverage, seedDemoHistory, seedDemoIrns } from '../lib/server/seed/demo-coverage';
import { turnOnDemoControls } from '../lib/server/seed/demo-controls';
import { wipeOrganizations } from '../lib/server/seed/wipe';
import { verifyLedgerBalances } from '../lib/server/ledger/posting';

const fresh = process.argv.includes('--fresh');

async function main() {
  const demoOrgs = await db
    .selectFrom('organizations')
    .select('id')
    .where('is_demo', '=', 1)
    .execute();
  const demoOrgIds = demoOrgs.map((o) => o.id);

  if (fresh) {
    if (process.env.APP_ENV === 'production') {
      console.error('Refusing to wipe data in production.');
      process.exit(1);
    }

    if (demoOrgIds.length === 0) {
      console.log('  No demo organisation to clear.');
    } else {
      console.log(`Clearing demo organisation(s) ${demoOrgIds.join(', ')}...`);
      // Every table carrying org_id, read from the database (lib/server/seed/wipe.ts).
      const cleared = await wipeOrganizations(db, demoOrgIds);
      console.log(`  cleared ${cleared} tables for the demo book`);
    }
  } else if (demoOrgIds.length > 0) {
    console.log('\n  The demo organisation already exists. Use --fresh to rebuild it.\n');
    await db.destroy();
    return;
  }

  const started = Date.now();
  const masters = process.argv.includes('--masters-only');

  // One transaction for the whole book: a half-seeded database is worse than an
  // empty one, because it looks usable until the first missing account.
  const { ids, book, docs } = await transaction(async (trx) => {
    const created = await bootstrap(trx, { isDemo: true });
    const history = masters ? null : await seedDemoBook(trx, created);
    // The surrounding documents come second: the credit notes attach to real
    // invoices and the retainer is applied against one.
    const around = masters ? null : await seedDemoDocuments(trx, created);
    // Then every other area of the software checklist, so none of them is empty.
    if (!masters) await seedDemoCoverage(trx, created);
    // Last: perpetual inventory takes the stock the documents above left on hand.
    if (!masters) await turnOnDemoControls(trx, created.orgId);
    // And the reminders and audit trail the book would carry by its date.
    if (!masters) await seedDemoHistory(trx, created);
    return { ids: created, book: history, docs: around };
  });

  // IRNs once the book is committed, as a user registers them.
  if (!masters) await seedDemoIrns(ids);

  const check = await transaction(async (trx) => verifyLedgerBalances(trx, ids.orgId));

  console.log(`
  Seeded in ${Date.now() - started}ms

    organisation   ${ids.orgId}
    branches       ${Object.keys(ids.branches).length}
    users          ${Object.keys(ids.users).length}
    accounts       ${Object.keys(ids.accounts).length}
    contacts       ${Object.keys(ids.contacts).length}
    items          ${Object.keys(ids.items).length}
    bank accounts  ${Object.keys(ids.bankAccounts).length}
${book ? `
    invoices       ${book.invoices}
    bills          ${book.bills}
    expenses       ${book.expenses}
    payments       ${book.payments}
    bank lines     ${book.statementLines}${docs ? `

    estimates      ${docs.estimates}
    sales orders   ${docs.salesOrders}
    challans       ${docs.challans}
    credit notes   ${docs.creditNotes}
    retainers      ${docs.retainers}
    purchase ord.  ${docs.purchaseOrders}
    vendor credits ${docs.vendorCredits}` : ''}` : `
    (masters only)`}

    ledger         ${check.balanced ? 'balanced' : 'OUT OF BALANCE'}

  Sign in with any seeded user, password Rekonza@2026:
    arun@raceautospares.in     admin
    priya@raceautospares.in    accountant
    vikram@raceautospares.in   sales
    deepa@raceautospares.in    viewer
`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error('\n  Seed failed — nothing was committed.\n', err);
  await db.destroy();
  process.exit(1);
});
