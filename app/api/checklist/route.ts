import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { checklist } from '@/lib/server/services/checklist';

// The software checklist with this company's evidence (services/checklist.ts).
export const GET = route(
  async ({ orgId }) => ({ areas: await checklist(db, orgId) }),
  { permission: { module: 'reports', action: 'view' } },
);
