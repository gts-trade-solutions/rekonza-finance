import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { cashBook, cashCounts, countCash } from '@/lib/server/reports/cash-book';

// The cash and bank book, and counting the cash. See reports/cash-book.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
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
