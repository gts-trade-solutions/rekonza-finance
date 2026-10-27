import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listVoucherTypes, saveVoucherType } from '@/lib/server/services/voucher-types';

// Voucher types: named kinds of a document with their own number series.

export const GET = route(async ({ orgId }) => ({ types: await listVoucherTypes(db, orgId) }));

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      id: z.coerce.number().int().positive().optional(),
      docType: z.enum(['INV', 'CN', 'DC', 'EST', 'SO', 'PO']), code: z.string().max(10), name: z.string().trim().min(1).max(60), prefix: z.string().max(10),
      isActive: z.boolean().optional(),
      printHeading: z.string().max(60).nullish(), printTerms: z.string().max(2000).nullish(),
      printShowUpi: z.boolean().optional(), printShowBank: z.boolean().optional(), restricted: z.boolean().optional(),
    }));
    return transaction(async (trx) => {
      const id = await saveVoucherType(trx, orgId, input, input.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'voucher_type', targetId: id, targetLabel: input.name,
        detail: `Voucher type ${input.name} (${input.prefix.toUpperCase()} series)`, ...auditMeta(req),
      });
      return { id: String(id) };
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
