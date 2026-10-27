import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { auditMeta, logAudit } from '@/lib/server/audit';
import { badRequest, body, query, route } from '@/lib/server/http';
import { buildExport, exportSummary, mastersXml, vouchersXml } from '@/lib/server/tally/export';
import { TALLY_NAME_MAX, tallyExportFileName } from '@/lib/tally/export';

// ─────────────────────────────────────────────────────────────────────────────
// Handing our books to TallyPrime: what a period holds, the two files Tally
// imports, and the map of what each of our accounts is called over there.
//
// The files are built from the journal on each request rather than stored, so
// a download is always the books as they stand. What is kept is a note of what
// was handed over, which is what the next export starts from.
// ─────────────────────────────────────────────────────────────────────────────

const Period = z.object({
  view: z.enum(['summary', 'masters', 'vouchers']).default('summary'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a start date.'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give an end date.'),
  branchId: z.coerce.number().int().positive().optional(),
});

export const GET = route(
  async ({ orgId, user, req }) => {
    const q = query(req, Period);
    if (q.from > q.to) throw badRequest('The start date is after the end date.');
    const opts = { from: q.from, to: q.to, branchId: q.branchId ?? null };

    if (q.view === 'summary') return exportSummary(db, orgId, opts);

    const data = await buildExport(db, orgId, opts);
    if (!data.vouchers.length) throw badRequest('There is nothing posted in those dates to send to Tally.');
    const xml = q.view === 'masters' ? mastersXml(data) : vouchersXml(data);

    await db.insertInto('tally_exports').values({
      org_id: orgId,
      branch_id: opts.branchId,
      kind: q.view,
      from_date: q.from,
      to_date: q.to,
      voucher_count: q.view === 'vouchers' ? data.vouchers.length : 0,
      ledger_count: data.ledgers.length,
      exported_by_user_id: user.userId,
    }).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'export',
      targetType: 'tally_export', targetId: null, targetLabel: `Tally ${q.view}`,
      detail: q.view === 'vouchers'
        ? `Downloaded ${data.vouchers.length} voucher(s) for Tally, ${q.from} to ${q.to}`
        : `Downloaded ${data.ledgers.length} ledger(s) for Tally, ${q.from} to ${q.to}`,
      ...auditMeta(req),
    });

    // UTF-8 with a byte-order mark: what Tally expects of an import file, and
    // what keeps a name like "Shri Rām & Co" intact on the way in.
    return new NextResponse(`${String.fromCharCode(0xfeff)}${xml}`, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${tallyExportFileName(q.view, q.from, q.to)}"`,
        'Cache-Control': 'no-store',
      },
    });
  },
  { permission: { module: 'tally', action: 'view' } },
);

const MapRow = z.object({
  accountId: z.union([z.string(), z.number()]),
  ledgerName: z.string().trim().min(1, 'A ledger needs a name.').max(TALLY_NAME_MAX),
  parentGroup: z.string().trim().min(1, 'Choose a group.').max(TALLY_NAME_MAX),
});

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('map'), rows: z.array(MapRow).min(1).max(500) }),
  z.object({ action: z.literal('reset'), accountId: z.union([z.string(), z.number()]) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Action);

    if (input.action === 'reset') {
      // Back to following the account: the row is removed, not blanked.
      await db.deleteFrom('tally_ledger_map')
        .where('org_id', '=', orgId).where('account_id', '=', Number(input.accountId)).execute();
      return { ok: true };
    }

    await transaction(async (trx) => {
      for (const row of input.rows) {
        const accountId = Number(row.accountId);
        const account = await trx.selectFrom('accounts').select('id')
          .where('id', '=', accountId).where('org_id', '=', orgId).executeTakeFirst();
        if (!account) throw badRequest('That account does not exist in this book.');
        await trx.insertInto('tally_ledger_map')
          .values({
            org_id: orgId, account_id: accountId, ledger_name: row.ledgerName,
            parent_group: row.parentGroup, updated_by_user_id: user.userId,
          })
          .onDuplicateKeyUpdate({
            ledger_name: row.ledgerName, parent_group: row.parentGroup, updated_by_user_id: user.userId,
          })
          .execute();
      }
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'tally_export', targetId: null, targetLabel: 'Tally ledger names',
      detail: `Changed what ${input.rows.length} account(s) are called in Tally`,
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'tally', action: 'edit' } },
);
