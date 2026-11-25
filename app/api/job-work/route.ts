import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { deleteJobWorkReceipt, jobWorkReceipts, updateJobWorkReceipt } from '@/lib/server/gst/changes';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { itc04, jobWorkLines, receiveJobWork } from '@/lib/server/services/job-work';

// Job work: goods out to job workers, back again, and ITC-04. See services/job-work.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: date.optional(), to: date.optional() }));
    if (q.from && q.to) return itc04(db, orgId, q.from, q.to);
    const [lines, receipts] = await Promise.all([jobWorkLines(db, orgId), jobWorkReceipts(db, orgId)]);
    return { lines, receipts };
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Receipt = z.object({
  challanId: z.coerce.number().int().positive(), date,
  jobWorkerChallanNo: z.string().trim().max(30).nullish(), jobWorkerChallanDate: date.nullish(),
  natureOfJob: z.string().trim().max(100).nullish(), notes: z.string().max(300).nullish(),
  lines: z.array(z.object({
    challanLineId: z.coerce.number().int().positive(), qtyReceived: z.number().min(0), qtyWaste: z.number().min(0).optional(),
  })).min(1),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Receipt);
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

/** Correct a receipt of goods back (gst/changes.ts). */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Receipt.omit({ challanId: true }).extend({ id: z.coerce.number().int().positive() }));
    return transaction(async (trx) => {
      await updateJobWorkReceipt(trx, orgId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'job_work_receipt', targetId: input.id,
        targetLabel: input.jobWorkerChallanNo ?? String(input.id), detail: `Goods back from job work changed (${input.date})`, ...auditMeta(req),
      });
      return { id: String(input.id) };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

/** Delete a receipt entered in error: the goods count as still with the job worker. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.coerce.number().int().positive() }));
    return transaction(async (trx) => {
      const r = await deleteJobWorkReceipt(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'job_work_receipt', targetId: id,
        targetLabel: r.label, detail: 'Goods back from job work deleted; they count as still with the job worker', ...auditMeta(req),
      });
      return { id: String(id), deleted: true };
    });
  },
  { permission: { module: 'gst', action: 'void' } },
);
