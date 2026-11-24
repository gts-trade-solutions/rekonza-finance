import { db, transaction } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteRetainer, retainerDetail, updateRetainer } from '@/lib/server/services/retainers';
import { RetainerInput, toRetainerInput } from '../input';

// One retainer invoice: as saved (its record and its Edit form), Zoho's Edit
// and Delete — both refused once money rests on it (services/retainers.ts).

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
