import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { listConversations } from '@/lib/server/ai/assistant';
import { currentSessionKey } from '@/lib/server/ai/session-key';

/** The person's own conversations, most recent first. Nobody else's, admins included. */
export const GET = route(
  async ({ user, orgId }) => {
    const org = await db.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirst();
    return {
      conversations: await listConversations(orgId, user.userId, !!org?.is_demo, await currentSessionKey()),
    };
  },
  { permission: { module: 'ai', action: 'view' } },
);
