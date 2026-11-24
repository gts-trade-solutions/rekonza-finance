import { db } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { profileDetail, updateProfile } from '@/lib/server/services/recurring-profiles';
import { CreateInput, toProfileInput } from '../input';

// One recurring invoice profile: its record (details, the invoices it raised,
// what is left of its cycles) and Zoho's Edit (services/recurring-profiles.ts).
// Run, Stop/Resume and Delete stay on /api/recurring-invoices (PATCH, DELETE).

export const GET = route(
  async ({ orgId, params }) => profileDetail(db, orgId, idParam(params), new Date().toISOString().slice(0, 10)),
  { permission: { module: 'sales', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, CreateInput);
    const current = await db.selectFrom('recurring_invoices').select('branch_id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    await updateProfile(db, orgId, id, toProfileInput(input, current?.branch_id ?? 0));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'recurring_invoice', targetId: id, targetLabel: input.name, detail: 'Profile edited; it applies from the next invoice', ...auditMeta(req) });
    return { id: String(id) };
  },
  { permission: { module: 'sales', action: 'edit' } },
);
