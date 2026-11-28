import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { statusReview } from '@/lib/server/services/status-review';

// The auditors' status review, item by item, with this company's evidence
// (services/status-review.ts). Read by Home's "Auditor Review" tab.
export const GET = route(
  async ({ orgId }) => ({ items: await statusReview(db, orgId) }),
  { permission: { module: 'reports', action: 'view' } },
);
