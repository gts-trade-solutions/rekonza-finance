import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteAddress, listAddresses, saveAddress } from '@/lib/server/services/contact-addresses';

// A customer's or vendor's other addresses (services/contact-addresses.ts).

export const GET = route(async ({ orgId, role, params }) => {
  if (!hasPermission(role, 'sales', 'view') && !hasPermission(role, 'purchases', 'view')) throw forbidden('You cannot see contacts.');
  return { addresses: await listAddresses(db, orgId, idParam(params)) };
});

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), id: z.union([z.string(), z.number()]).transform(Number).nullish(),
    label: z.string().max(80), name: z.string().max(150).nullish(), address: z.string().max(500), city: z.string().max(60).nullish(),
    pincode: z.string().max(6).nullish(), stateCode: z.string().max(2), gstin: z.string().max(15).nullish(), phone: z.string().max(30).nullish(),
    isDefault: z.boolean().optional(),
  }),
  z.object({ action: z.literal('delete'), id: z.union([z.string(), z.number()]).transform(Number) }),
]);

export const POST = route(async ({ orgId, user, role, params, req }) => {
  if (!hasPermission(role, 'sales', 'edit') && !hasPermission(role, 'purchases', 'edit')) throw forbidden('You cannot change contacts.');
  const contactId = idParam(params);
  const input = await body(req, Input);
  await transaction(async (trx) => {
    if (input.action === 'delete') {
      const label = await deleteAddress(trx, orgId, contactId, input.id);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId, detail: `Address removed: ${label}`, ...auditMeta(req) });
      return;
    }
    const { action: _a, ...fields } = input;
    void _a;
    await saveAddress(trx, orgId, contactId, fields);
    await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId, detail: `Address ${input.id ? 'changed' : 'added'}: ${input.label}`, ...auditMeta(req) });
  });
  return { addresses: await listAddresses(db, orgId, contactId) };
});
