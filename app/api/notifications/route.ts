import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { listNotifications, markRead } from '@/lib/server/services/notifications';

// One's own notifications, under the bell.

export const GET = route(async ({ user }) => listNotifications(db, user.userId));

const Input = z.object({ ids: z.union([z.literal('all'), z.array(z.union([z.string(), z.number()]).transform(Number))]) });

export const POST = route(async ({ user, req }) => {
  const { ids } = await body(req, Input);
  await markRead(db, user.userId, ids);
  return { ok: true };
});
