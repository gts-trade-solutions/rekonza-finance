import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, forbidden, badRequest } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';

// Web tabs, as Zoho Books has them: websites the business uses every day —
// the GST portal, the bank, a supplier's catalogue — kept as tabs inside the
// app. Everyone sees them; only those who manage settings change them.

const SCOPE = 'web_tabs';
interface Tab { id: string; name: string; url: string }

async function read(orgId: number): Promise<Tab[]> {
  const r = await db.selectFrom('settings').select('value').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'list').executeTakeFirst();
  const v = typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value;
  return Array.isArray(v) ? (v as Tab[]) : [];
}

export const GET = route(async ({ orgId, role }) => ({ tabs: await read(orgId), canEdit: hasPermission(role, 'settings', 'edit') }));

const Input = z.object({
  tabs: z.array(z.object({
    id: z.string().max(40).optional(),
    name: z.string().trim().min(1, 'Give each tab a name.').max(40),
    url: z.string().trim().max(500),
  })).max(20, 'Keep up to 20 web tabs.'),
});

export const PUT = route(async ({ orgId, user, role, req }) => {
  if (!hasPermission(role, 'settings', 'edit')) throw forbidden('Only those who manage settings change the web tabs.');
  const { tabs } = await body(req, Input);
  const clean: Tab[] = tabs.map((t, i) => {
    let u: URL;
    try { u = new URL(t.url); } catch { throw badRequest(`${t.name}: that is not a web address.`); }
    if (u.protocol !== 'https:') throw badRequest(`${t.name}: use an https:// address.`);
    return { id: t.id || `t${Date.now().toString(36)}${i}`, name: t.name, url: u.toString() };
  });
  const value = JSON.stringify(clean);
  const exists = await db.selectFrom('settings').select('setting_key').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'list').executeTakeFirst();
  if (exists) await db.updateTable('settings').set({ value, updated_by_user_id: user.userId }).where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'list').execute();
  else await db.insertInto('settings').values({ org_id: orgId, scope: SCOPE, setting_key: 'list', value, updated_by_user_id: user.userId }).execute();
  await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'settings', targetId: null, targetLabel: 'Web tabs', detail: `Web tabs: ${clean.map((t) => t.name).join(', ') || 'none'}`, ...auditMeta(req) });
  return { tabs: clean };
});
