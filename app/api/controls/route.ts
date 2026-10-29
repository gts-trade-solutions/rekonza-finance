import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { controlsOverview } from '@/lib/server/services/controls';
import { getPolicies } from '@/lib/server/services/org-settings';

// The book's internal controls, area by area, with the evidence (services/controls.ts).
export const GET = route(async ({ orgId }) => {
  const [controls, policies] = await Promise.all([controlsOverview(db, orgId), getPolicies(db, orgId)]);
  return { controls, policies: { controls: policies.controls, password: policies.password, stockAccounting: policies.stockAccounting } };
}, { permission: { module: 'settings', action: 'view' } });
