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
import { verifyLedgerBalances } from '../lib/server/ledger/posting';

const fresh = process.argv.includes('--fresh');

/**
 * Tables cleared by --fresh, in an order that respects foreign keys.
 *
 * Every one of them carries org_id, so each delete is scoped to the demo
 * organisation. `user_branches` is the exception — it hangs off users — and is
 * handled separately below.
 */
const DATA_TABLES = [
  'payment_allocations', 'payments', 'bank_transactions', 'bank_statement_imports',
  'bank_transfers', 'bank_rules', 'cheques', 'bank_accounts',
  'einvoices', 'eway_bills', 'gstr2b_entries',
  'invoice_lines', 'credit_note_lines', 'estimate_lines', 'sales_order_lines',
  'challan_lines', 'bill_lines', 'purchase_order_lines',
  'credit_notes', 'invoices', 'delivery_challans', 'sales_orders', 'estimates',
  'retainer_invoices', 'vendor_credits', 'bills', 'expenses', 'purchase_orders',
  'recurring_invoices', 'recurring_journals', 'budgets',
  'stock_adjustments', 'warehouses',
  'journal_lines', 'journal_entries', 'number_series', 'sequences', 'transaction_locks',
  'custom_field_values', 'custom_fields', 'approval_rules', 'workflow_rules',
  // Portal connections and their call history. The sealed credentials and
  // session tokens hang off a connection rather than carrying org_id, so they
  // are cleared separately below — the same exception `user_branches` is.
  'integration_calls', 'integration_connections',
  // Reports reference their dataset, so they go first.
  'analytics_reports', 'analytics_datasets',
  // The assistant's conversations and credit wallet, and any billing records.
  // Invoices before the payments they reference.
  'ai_messages', 'ai_conversations', 'ai_credit_ledger', 'ai_usage', 'ai_credit_buckets',
  'ai_wallets', 'ai_settings',
  'billing_invoices', 'billing_payments', 'billing_subscriptions', 'billing_webhook_events',
  'api_tokens', 'jobs', 'files', 'settings', 'audit_log',
  'items', 'hsn_codes', 'contacts', 'accounts',
  'sessions', 'users', 'branches',
];

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
      const { sql } = await import('kysely');
      const idList = demoOrgIds.join(',');

      // Relaxed only for the duration of these deletes. The order below is
      // foreign-key safe on its own, but a few self-references — a credit note
      // pointing at the invoice it credits — still need the checks off.
      await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);

      await sql
        .raw(`DELETE FROM user_branches WHERE user_id IN (SELECT id FROM users WHERE org_id IN (${idList}))`)
        .execute(db);

      // Sealed portal credentials and their session tokens. Keyed on the
      // connection, not the organisation, so they need the subquery — and they
      // have to go before the connections they hang off. Left behind, they are
      // ciphertext nothing can open, pointing at a registration that no longer
      // exists: harmless, but exactly the kind of debris that later reads as a
      // security question nobody can answer.
      for (const t of ['integration_credentials', 'integration_sessions']) {
        await sql
          .raw(
            `DELETE FROM \`${t}\` WHERE connection_id IN ` +
              `(SELECT id FROM integration_connections WHERE org_id IN (${idList}))`,
          )
          .execute(db);
      }

      for (const t of DATA_TABLES) {
        await sql.raw(`DELETE FROM \`${t}\` WHERE org_id IN (${idList})`).execute(db);
      }
      await sql.raw(`DELETE FROM organizations WHERE id IN (${idList})`).execute(db);

      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
      console.log(`  cleared ${DATA_TABLES.length} tables for the demo book`);
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
    return { ids: created, book: history, docs: around };
  });

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
