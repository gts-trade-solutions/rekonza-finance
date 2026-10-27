import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createApiKey, listApiKeys, revokeApiKey } from '@/lib/server/auth/api-keys';

// API keys for other software. Only an admin makes or revokes them, signed in
// to the app — a key can never manage keys.

export const GET = route(async ({ orgId }) => ({ keys: await listApiKeys(db, orgId) }), { permission: { module: 'settings', action: 'edit' } });

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'), name: z.string().trim().min(1).max(80),
    role: z.enum(['admin', 'accountant', 'sales', 'staff', 'viewer']),
    customRoleId: z.union([z.string(), z.number()]).transform(Number).nullish(),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }),
  z.object({ action: z.literal('revoke'), id: z.union([z.string(), z.number()]).transform(Number) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'revoke') {
        await revokeApiKey(trx, orgId, input.id);
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'api_key', targetId: input.id, detail: 'API key revoked', ...auditMeta(req) });
        return { id: asId(input.id) };
      }
      const made = await createApiKey(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'api_key', targetId: made.id,
        targetLabel: input.name, detail: `API key ${input.name} made, acting as ${input.customRoleId ? 'a custom role' : input.role}`, ...auditMeta(req),
      });
      // The only time the key is ever shown.
      return { id: asId(made.id), key: made.key };
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
