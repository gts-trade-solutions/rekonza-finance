import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { bulkReclassify, reclassCandidates } from '@/lib/server/services/accountant-tools';

// Bulk update (services/accountant-tools.ts): the lines on an account a
// reclassification may move, the moves made so far, and making one.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      fromAccountId: z.coerce.number().int().positive().optional(), from: DATE.optional(), to: DATE.optional(),
      contactId: z.coerce.number().int().positive().optional(), search: z.string().max(100).optional(),
    }));
    const recent = await db.selectFrom('journal_entries as e')
      .select(['e.id', 'e.entry_no', 'e.entry_date', 'e.memo', 'e.total_debit', 'e.posted_at'])
      .select((eb) => eb.exists(eb.selectFrom('journal_entries as x').select('x.id').whereRef('x.reversal_of_entry_id', '=', 'e.id')).as('reversed'))
      .where('e.org_id', '=', orgId).where('e.source_type', '=', 'reclassification').orderBy('e.id', 'desc').limit(20).execute();
    const lines = q.fromAccountId && q.from && q.to
      ? await reclassCandidates(db, orgId, { fromAccountId: q.fromAccountId, from: q.from, to: q.to, contactId: q.contactId ?? null, search: q.search ?? null })
      : [];
    return {
      lines,
      recent: recent.map((r) => ({
        id: String(r.id), entryNo: r.entry_no, date: String(r.entry_date).slice(0, 10),
        memo: r.memo, amountPaise: toPaiseFromSql(r.total_debit), reversed: !!Number(r.reversed),
      })),
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const ID = z.union([z.string(), z.number()]).transform(Number);
const Input = z.object({
  fromAccountId: ID, toAccountId: ID, lineIds: z.array(ID).min(1).max(2000), date: DATE, memo: z.string().trim().max(500).nullish(),
});

export const POST = route(async ({ orgId, user, role, req }) => {
  if (!hasPermission(role, 'accountant', 'create')) throw forbidden('You cannot post journals.');
  const input = await body(req, Input);
  return transaction(async (trx) => {
    const r = await bulkReclassify(trx, orgId, user.userId, { ...input, memo: input.memo ?? null });
    for (const e of r.entries) {
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'journal_entry', targetId: e.id, targetLabel: `#${e.entryNo}`,
        detail: `Bulk update: ${r.lines} line(s), ₹${(r.movedPaise / 100).toLocaleString('en-IN')}, moved from ${r.fromName} to ${r.toName}`, ...auditMeta(req),
      });
    }
    return { entries: r.entries.map((e) => ({ id: String(e.id), entryNo: e.entryNo })), lines: r.lines, movedPaise: r.movedPaise };
  });
});
