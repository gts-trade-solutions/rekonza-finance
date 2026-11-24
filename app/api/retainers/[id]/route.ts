import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteRetainer, deleteRetainerRefund, refundRetainer, retainerDetail, updateRetainer } from '@/lib/server/services/retainers';
import { RetainerInput, toRetainerInput } from '../input';

// One retainer invoice: as saved (its record and its Edit form), Zoho's Edit
// and Delete — both refused once money rests on it — and its ⋯ → Refund of
// what is paid but not applied, and deleting such a refund (services/retainers.ts).

export const GET = route(
  async ({ orgId, params }) => retainerDetail(db, orgId, idParam(params)),
  { permission: { module: 'sales', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = toRetainerInput(await body(req, RetainerInput));
    const r = await transaction((trx) => updateRetainer(trx, orgId, user.userId, id, input));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'retainer', targetId: id, detail: `Retainer ${r.number} edited`, ...auditMeta(req) });
    return { id: String(r.id), number: r.number, totalPaise: r.totalPaise };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const r = await transaction((trx) => deleteRetainer(trx, orgId, user.userId, id, reason));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'retainer', targetId: id, detail: `Retainer ${r.number} deleted${reason ? `: ${reason}` : ''}`, ...auditMeta(req) });
    return r;
  },
  { permission: { module: 'sales', action: 'void' } },
);

const Action = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('refund'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the refund date.'),
    amountPaise: z.number().int().positive().optional(),
    bankAccountId: z.union([z.string(), z.number()]),
    mode: z.string().max(30).nullish(),
    reference: z.string().max(100).nullish(),
  }),
  z.object({ action: z.literal('delete_refund'), entryId: z.union([z.string(), z.number()]) }),
]);

export const POST = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Action);
    if (input.action === 'refund') {
      const r = await transaction((trx) => refundRetainer(trx, orgId, user.userId, id, {
        date: input.date, amountPaise: input.amountPaise, bankAccountId: Number(input.bankAccountId), mode: input.mode, reference: input.reference,
      }));
      await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'retainer', targetId: id, detail: `Refunded ₹${(r.refundedPaise / 100).toFixed(2)} to the customer`, ...auditMeta(req) });
      return { ...r, journalEntryId: String(r.journalEntryId) };
    }
    const r = await transaction((trx) => deleteRetainerRefund(trx, orgId, user.userId, id, Number(input.entryId)));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'retainer', targetId: id, detail: 'Refund deleted (reversed)', ...auditMeta(req) });
    return r;
  },
  { permission: { module: 'sales', action: 'create' } },
);
