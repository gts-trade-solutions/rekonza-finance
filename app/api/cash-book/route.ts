import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { cashBook, cashCountById, cashCounts, countCash, recountCash } from '@/lib/server/reports/cash-book';
import { deleteCashCount } from '@/lib/server/services/banking-changes';

// The cash and bank book, and counting the cash. See reports/cash-book.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    // ?count=<id>: one count, for its Edit opened from a ledger row.
    const one = new URL(req.url).searchParams.get('count');
    if (one) return { count: await cashCountById(db, orgId, Number(one)) };
    const q = query(req, z.object({ bankAccountId: z.coerce.number().int().positive(), from: date, to: date }));
    const [book, counts] = await Promise.all([cashBook(db, orgId, q.bankAccountId, q.from, q.to), cashCounts(db, orgId, q.bankAccountId)]);
    return { ...book, counts };
  },
  { permission: { module: 'banking', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      bankAccountId: z.coerce.number().int().positive(), date,
      pieces: z.record(z.string(), z.number().int().min(0)), note: z.string().trim().max(300).nullish(),
    }));
    return transaction(async (trx) => {
      const r = await countCash(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'cash_count', targetId: r.id,
        targetLabel: `Cash count ${input.date}`,
        detail: `Cash counted ₹${(r.countedPaise / 100).toLocaleString('en-IN')} against ₹${(r.bookPaise / 100).toLocaleString('en-IN')} in the books`,
        ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'banking', action: 'create' } },
);

/**
 * Edit a cash count (?id=): the count as it was is undone (its short or excess
 * reversed on its date) and the cash counted again with the figures given.
 */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.coerce.number().int().positive() }));
    const input = await body(req, z.object({
      date, pieces: z.record(z.string(), z.number().int().min(0)), note: z.string().trim().max(300).nullish(),
    }));
    return transaction(async (trx) => {
      const r = await recountCash(trx, orgId, user.userId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'cash_count', targetId: r.id,
        targetLabel: `Cash count ${input.date}`,
        detail: `Cash count edited: ₹${(r.countedPaise / 100).toLocaleString('en-IN')} counted against ₹${(r.bookPaise / 100).toLocaleString('en-IN')} (the count as it was, undone)`,
        ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'banking', action: 'edit' } },
);

/** Delete a cash count (?id=): its short or excess reversed on its date, the count kept on record. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ id: z.coerce.number().int().positive(), reason: z.string().max(300).optional() }));
    return transaction(async (trx) => {
      const gone = await deleteCashCount(trx, orgId, user.userId, q.id, q.reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'cash_count', targetId: q.id,
        targetLabel: `Cash count ${gone.date}`, detail: `Deleted the cash count of ${gone.date}${gone.reversed ? '; its short or excess reversed' : ''}${q.reason ? ` — ${q.reason}` : ''}`,
        ...auditMeta(req),
      });
      return { deleted: true };
    });
  },
  { permission: { module: 'banking', action: 'void' } },
);
