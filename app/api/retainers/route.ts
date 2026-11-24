import { transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createRetainerZoho } from '@/lib/server/services/retainers';
import { RetainerInput, toRetainerInput } from './input';

// Zoho's New Retainer Invoice: several DESCRIPTION | AMOUNT lines, Reference#,
// project, notes and terms (services/retainers.ts). The list stays at
// /api/sales-documents?kind=retainer.

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = toRetainerInput(await body(req, RetainerInput));
    const made = await transaction((trx) => createRetainerZoho(trx, orgId, user.userId, input));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'retainer', targetId: made.id, detail: `Retainer ${made.number} raised`, ...auditMeta(req) });
    return { id: String(made.id), number: made.number, totalPaise: made.totalPaise };
  },
  { permission: { module: 'sales', action: 'create' } },
);
