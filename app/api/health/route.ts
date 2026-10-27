import { ping } from '@/lib/server/db';
import { route } from '@/lib/server/http';

/** Liveness probe. Public so a load balancer can call it without a session. */
export const GET = route(
  async () => {
    const database = await ping();
    return {
      ok: database.ok,
      database,
      env: process.env.APP_ENV ?? 'unknown',
      time: new Date().toISOString(),
    };
  },
  { public: true },
);
