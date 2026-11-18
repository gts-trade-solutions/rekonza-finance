import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { hsnHistory } from '@/lib/server/services/item-activity';

/** Zoho's "HSN/SAC Update History" (services/item-activity.ts). */
export const GET = route(
  async ({ orgId }) => ({ entries: await hsnHistory(db, orgId) }),
  { permission: { module: 'sales', action: 'view' } },
);
