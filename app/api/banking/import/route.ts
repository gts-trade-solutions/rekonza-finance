import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { importStatement } from '@/lib/server/services/banking';
import { logAudit, auditMeta } from '@/lib/server/audit';

/**
 * What has been imported, and how much of it has since been reconciled.
 *
 * The matched count is read from the transactions rather than stored on the
 * import: reconciliation happens long after the upload, and a number frozen at
 * import time would be wrong within the hour.
 */
export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('bank_statement_imports as i')
      .innerJoin('bank_accounts as b', 'b.id', 'i.bank_account_id')
      .leftJoin('users as u', 'u.id', 'i.imported_by_user_id')
      .select([
        'i.id', 'i.filename', 'i.rows_total', 'i.rows_imported', 'i.rows_duplicate',
        'i.period_from', 'i.period_to', 'i.created_at',
        'b.id as bank_account_id', 'b.name as bank_name', 'u.name as imported_by',
      ])
      .where('i.org_id', '=', orgId)
      .orderBy('i.created_at', 'desc')
      .limit(100)
      .execute();

    const { rows: matched } = await sql<{ id: number; matched: string; total: string }>`
      SELECT i.id,
             SUM(CASE WHEN t.status <> 'unmatched' THEN 1 ELSE 0 END) AS matched,
             COUNT(t.id) AS total
        FROM bank_statement_imports i
        LEFT JOIN bank_transactions t ON t.import_batch_id = i.id
       WHERE i.org_id = ${orgId}
       GROUP BY i.id
    `.execute(db);
    const matchedBy = new Map(matched.map((m) => [m.id, m]));

    return {
      imports: rows.map((r) => ({
        id: asId(r.id),
        filename: r.filename,
        bankAccountId: asId(r.bank_account_id),
        bankName: r.bank_name,
        rowsTotal: r.rows_total,
        rowsImported: r.rows_imported,
        rowsDuplicate: r.rows_duplicate,
        matched: Number(matchedBy.get(r.id)?.matched ?? 0),
        lines: Number(matchedBy.get(r.id)?.total ?? 0),
        periodFrom: r.period_from ? String(r.period_from).slice(0, 10) : null,
        periodTo: r.period_to ? String(r.period_to).slice(0, 10) : null,
        importedBy: r.imported_by,
        at: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString(),
      })),
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const RowInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  narration: z.string().min(1),
  reference: z.string().nullish(),
  depositPaise: z.number().int().nonnegative().optional(),
  withdrawalPaise: z.number().int().nonnegative().optional(),
  runningBalancePaise: z.number().int().nullish(),
});

const ImportInput = z.object({
  bankAccountId: z.string(),
  filename: z.string().min(1),
  rows: z.array(RowInput).min(1, 'The statement had no rows.').max(5000),
});

/**
 * Import parsed statement rows.
 *
 * The file is parsed in the browser — every bank exports a different CSV, and
 * the column mapping is something the user has to see and confirm. What arrives
 * here is already normalised rows, which keeps bank-specific quirks out of the
 * server entirely.
 */
export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ImportInput);

    const result = await transaction(async (trx) =>
      importStatement(
        trx, orgId, user.userId, Number(input.bankAccountId), input.filename, input.rows,
      ),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name,
      action: 'import', targetType: 'bank_statement', targetId: result.importId,
      targetLabel: input.filename,
      detail: `${result.imported} imported, ${result.duplicates} already present, ${result.autoMatched} auto-matched`,
      ...auditMeta(req),
    });

    return { ...result, importId: asId(result.importId) };
  },
  { permission: { module: 'banking', action: 'create' } },
);
