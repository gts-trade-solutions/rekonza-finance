import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { itc04, jobWorkLines, receiveJobWork } from '@/lib/server/services/job-work';

// Job work: goods out to job workers, back again, and ITC-04. See services/job-work.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: date.optional(), to: date.optional() }));
    if (q.from && q.to) return itc04(db, orgId, q.from, q.to);
    return { lines: await jobWorkLines(db, orgId) };
  },
  { permission: { module: 'gst', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      challanId: z.coerce.number().int().positive(), date,
      jobWorkerChallanNo: z.string().trim().max(30).nullish(), jobWorkerChallanDate: date.nullish(),
      natureOfJob: z.string().trim().max(100).nullish(), notes: z.string().max(300).nullish(),
      lines: z.array(z.object({
        challanLineId: z.coerce.number().int().positive(), qtyReceived: z.number().min(0), qtyWaste: z.number().min(0).optional(),
      })).min(1),
    }));
    return transaction(async (trx) => {
      const r = await receiveJobWork(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'job_work_receipt', targetId: r.id,
        targetLabel: input.jobWorkerChallanNo ?? String(r.id), detail: `Goods back from job work on ${input.date}`, ...auditMeta(req),
      });
      return { id: String(r.id) };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
