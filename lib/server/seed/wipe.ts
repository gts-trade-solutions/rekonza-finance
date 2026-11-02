// Deleting whole organisations: what `npm run db:seed -- --fresh` does to the
// demo book before building it again.
//
// The tables to clear are read from the database, not kept in a list. A hand
// list fell 103 tables behind the migrations, and every table it missed kept
// the old demo book's rows, pointing at an organisation that no longer exists.
// Anything carrying org_id is cleared; the few tables that hang off an
// org-scoped row instead are named below, and a test fails when a new table
// is neither.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../db-types';
import { fileStore } from '../files/store';

/** Tables without org_id that belong to a row of one that has it: [table, column, parent]. */
export const CHILD_TABLES: ReadonlyArray<readonly [string, string, string]> = [
  ['user_branches', 'user_id', 'users'],
  ['password_history', 'user_id', 'users'],
  // Sealed portal credentials and session tokens: left behind, they are
  // ciphertext pointing at a registration that no longer exists.
  ['integration_credentials', 'connection_id', 'integration_connections'],
  ['integration_sessions', 'connection_id', 'integration_connections'],
  ['bom_lines', 'bom_id', 'boms'],
  ['production_lines', 'production_id', 'productions'],
  ['stock_transfer_lines', 'transfer_id', 'stock_transfers'],
  ['job_work_receipt_lines', 'receipt_id', 'job_work_receipts'],
  ['price_list_items', 'price_list_id', 'price_lists'],
  ['price_list_discounts', 'price_list_id', 'price_lists'],
  ['employee_salaries', 'employee_id', 'employees'],
  ['payroll_lines', 'run_id', 'payroll_runs'],
  ['payroll_arrears', 'run_id', 'payroll_runs'],
  ['payroll_recoveries', 'run_id', 'payroll_runs'],
  ['tally_groups', 'company_id', 'tally_companies'],
  ['tally_ledgers', 'company_id', 'tally_companies'],
  ['tally_stock_items', 'company_id', 'tally_companies'],
  ['tally_vouchers', 'company_id', 'tally_companies'],
  ['tally_voucher_entries', 'company_id', 'tally_companies'],
];

/**
 * Tables that belong to no organisation: the platform's own. Sign-in codes are
 * keyed by email, last ten minutes and are never tied to one book.
 */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  'organizations', 'schema_migrations', 'backup_runs', 'billing_counters', 'billing_plan_links',
  'portal_login_codes',
  // Sign-in attempts per address and email (auth/throttle.ts): about people, not books.
  'auth_throttle',
]);

async function tablesWhere(ex: Kysely<DB>, hasOrgId: boolean): Promise<string[]> {
  const { rows } = await sql<{ t: string }>`
    SELECT t.TABLE_NAME AS t
    FROM information_schema.TABLES t
    LEFT JOIN information_schema.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.COLUMN_NAME = 'org_id'
    WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
      AND (c.COLUMN_NAME IS NOT NULL) = ${hasOrgId ? 1 : 0}
    ORDER BY t.TABLE_NAME`.execute(ex);
  return rows.map((r) => r.t);
}

/** Every table carrying org_id. */
export const orgTables = (ex: Kysely<DB>) => tablesWhere(ex, true);
/** Every table without it: each must be a child table or a global one. */
export const tablesWithoutOrgId = (ex: Kysely<DB>) => tablesWhere(ex, false);

/**
 * Delete the organisations and everything in them, stored file bytes included.
 * Returns how many tables were cleared.
 *
 * Foreign-key checks are relaxed for the deletes (self-references such as a
 * credit note pointing at the invoice it credits rule out a safe order), on
 * one held connection: SET applies to its own session only, and a pool could
 * hand each statement a different one.
 */
export async function wipeOrganizations(db: Kysely<DB>, orgIds: number[]): Promise<number> {
  const ids = orgIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  const idList = ids.join(',');
  const tables = await orgTables(db);

  const keys = (await db.selectFrom('files').select('storage_key').where('org_id', 'in', ids).execute())
    .map((f) => f.storage_key);

  await db.connection().execute(async (conn) => {
    await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(conn);
    try {
      for (const [table, column, parent] of CHILD_TABLES) {
        await sql.raw(
          `DELETE FROM \`${table}\` WHERE \`${column}\` IN (SELECT id FROM \`${parent}\` WHERE org_id IN (${idList}))`,
        ).execute(conn);
      }
      for (const t of tables) {
        await sql.raw(`DELETE FROM \`${t}\` WHERE org_id IN (${idList})`).execute(conn);
      }
      await sql.raw(`DELETE FROM organizations WHERE id IN (${idList})`).execute(conn);
    } finally {
      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(conn);
    }
  });

  // After the rows: a file whose bytes are gone but whose row survived would be worse.
  const store = fileStore();
  for (const k of keys) await store.remove(k).catch(() => undefined);
  return tables.length + CHILD_TABLES.length;
}
