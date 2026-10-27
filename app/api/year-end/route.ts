import { z } from 'zod';
import { NextResponse } from 'next/server';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { closeYear, listYears, reopenYear, yearChecks, yearPack } from '@/lib/server/services/year-end';
import { workbook } from '@/lib/xlsx';

// Closing and reopening financial years, and the year's statements as one
// workbook. See lib/server/services/year-end.ts.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['years', 'checks', 'pack']).default('years'),
      fy: z.coerce.number().int().min(2000).max(2100).optional(),
    }));
    if (q.view === 'checks') return yearChecks(db, orgId, q.fy!);
    if (q.view === 'pack') {
      const { filename, sheets } = await yearPack(db, orgId, q.fy!);
      return new NextResponse(Buffer.from(workbook(sheets)), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }
    return { years: await listYears(db, orgId) };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close'), fy: z.number().int(), overrideReason: z.string().trim().max(300).nullish() }),
  z.object({ action: z.literal('reopen'), fy: z.number().int(), reason: z.string().trim().min(5, 'Say why it is being reopened.').max(300) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const fyLabel = `${input.fy}-${String((input.fy + 1) % 100).padStart(2, '0')}`;
    return transaction(async (trx) => {
      if (input.action === 'close') {
        const r = await closeYear(trx, orgId, user.userId, input.fy, { overrideReason: input.overrideReason });
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'approve',
          targetType: 'financial_year', targetId: input.fy, targetLabel: `FY ${fyLabel}`,
          detail: `Closed FY ${fyLabel}; profit ₹${(r.netProfitPaise / 100).toLocaleString('en-IN')}` +
            (r.overridden.length ? `; closed over ${r.overridden.join(', ')}: ${input.overrideReason}` : ''),
          ...auditMeta(req),
        });
        return { ok: true, netProfitPaise: r.netProfitPaise };
      }
      await reopenYear(trx, orgId, user.userId, input.fy, input.reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'financial_year', targetId: input.fy, targetLabel: `FY ${fyLabel}`,
        detail: `Reopened FY ${fyLabel}: ${input.reason}`, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  // Closing a year locks every module: the same right as setting a lock.
  { permission: { module: 'accountant', action: 'approve' } },
);
