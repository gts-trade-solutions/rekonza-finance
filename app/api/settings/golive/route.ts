import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { goLiveChecks } from '@/lib/server/golive';

// The go-live check (lib/server/golive.ts): whether this server is set up to
// keep real books, for the admins who look after it. Says whether each secret
// is set, never what it is. Not from the demo book: anyone may open that, and
// how the server is set up is none of their business.
export const GET = route(async ({ orgId }) => {
  const book = await db.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirst();
  if (book?.is_demo) return { checks: [], blocking: 0, ready: false, demo: true };
  const checks = await goLiveChecks();
  const blocking = checks.filter((c) => c.status === 'fail').length;
  return { checks, blocking, ready: blocking === 0, demo: false };
}, { permission: { module: 'settings', action: 'edit' } });
