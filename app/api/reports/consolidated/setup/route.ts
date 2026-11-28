import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { saveGroup, setupOptions } from '@/lib/server/reports/consolidated';

// ─────────────────────────────────────────────────────────────────────────────
// Group set-up for consolidation (lib/server/reports/consolidated.ts): which
// company is the parent, each subsidiary's ownership, acquisition date and the
// parent's investment account, and which customers and vendors are group
// companies when their PANs do not say so. Saved by an admin or accountant of
// the parent; the change is recorded in the trail of the company the person
// is in and of the parent.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ user, req }) => {
    const q = query(req, z.object({ orgIds: z.string().max(500).optional() }));
    return setupOptions(db, user.email, q.orgIds ? q.orgIds.split(',').filter(Boolean) : undefined);
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(String);
const Input = z.object({
  parentOrgId: Id,
  name: z.string().trim().max(200).default(''),
  members: z.array(z.object({
    orgId: Id, ownershipPct: z.coerce.number().gt(0).max(100),
    acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
    investmentAccountId: Id.nullish().or(z.literal('').transform(() => null)),
  })).max(50),
  links: z.array(z.object({ orgId: Id, contactId: Id, counterpartOrgId: Id.nullish().or(z.literal('').transform(() => null)) })).max(500).default([]),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const id = await saveGroup(trx, user.email, user.userId, { ...input, members: input.members.map((m) => ({ ...m, acquiredOn: m.acquiredOn ?? null, investmentAccountId: m.investmentAccountId ?? null })), links: input.links.map((l) => ({ ...l, counterpartOrgId: l.counterpartOrgId ?? null })) });
      const detail = `Consolidation group set up: parent company ${input.parentOrgId}; ${input.members.map((m) => `company ${m.orgId} at ${m.ownershipPct}%`).join(', ') || 'no subsidiaries'}; ${input.links.filter((l) => l.counterpartOrgId).length} customer/vendor link(s)`;
      for (const o of new Set([orgId, Number(input.parentOrgId)])) {
        await logAudit({ trx, orgId: o, actorUserId: o === orgId ? user.userId : null, actorName: user.name, action: 'update', targetType: 'consolidation_group', targetId: id, targetLabel: input.name || 'Consolidation group', detail, payload: input, ...auditMeta(req) });
      }
      return { id: asId(id) };
    });
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);
