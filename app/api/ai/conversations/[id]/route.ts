import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { deleteConversation, getConversation, renameConversation } from '@/lib/server/ai/assistant';
import { currentSessionKey } from '@/lib/server/ai/session-key';

// One conversation: read it, rename it, or delete it. Only ever the caller's
// own — a conversation id belonging to anyone else is simply not found.

async function scope(orgId: number) {
  const org = await db.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirst();
  return { isDemo: !!org?.is_demo, sessionKey: await currentSessionKey() };
}

export const GET = route(
  async ({ user, orgId, params }) => {
    const s = await scope(orgId);
    return getConversation(orgId, user.userId, s.isDemo, s.sessionKey, idParam(params));
  },
  { permission: { module: 'ai', action: 'view' } },
);

const Rename = z.object({ title: z.string().trim().min(1, 'Give it a name.').max(150) });

export const PATCH = route(
  async ({ user, orgId, params, req }) => {
    const input = await body(req, Rename);
    const s = await scope(orgId);
    await renameConversation(orgId, user.userId, s.isDemo, s.sessionKey, idParam(params), input.title);
    return { ok: true };
  },
  { permission: { module: 'ai', action: 'view' } },
);

export const DELETE = route(
  async ({ user, orgId, params }) => {
    const s = await scope(orgId);
    await deleteConversation(orgId, user.userId, s.isDemo, s.sessionKey, idParam(params));
    return { ok: true };
  },
  { permission: { module: 'ai', action: 'view' } },
);
