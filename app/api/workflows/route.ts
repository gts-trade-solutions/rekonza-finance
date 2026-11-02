import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listRules, recentRuns, saveRule, WORKFLOW_EVENTS, WORKFLOW_FIELDS } from '@/lib/server/services/workflows';

// Workflow rules (services/workflows.ts): the rules, what they did lately, and
// what a rule can be written against.

export const GET = route(
  async ({ orgId }) => ({
    rules: await listRules(db, orgId),
    runs: await recentRuns(db, orgId),
    events: WORKFLOW_EVENTS,
    fields: WORKFLOW_FIELDS,
  }),
  { permission: { module: 'settings', action: 'view' } },
);

const Condition = z.object({ field: z.string().max(30), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']), value: z.string().trim().max(200) });
const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), to: z.enum(['admins', 'accountants', 'approvers']), message: z.string().trim().max(500).optional() }),
  z.object({ type: z.literal('email'), to: z.string().trim().max(190), subject: z.string().trim().max(200), body: z.string().trim().max(2000) }),
]);
const Input = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  name: z.string().trim().min(1).max(150),
  event: z.enum(WORKFLOW_EVENTS),
  conditions: z.array(Condition).max(10),
  actions: z.array(Action).min(1).max(5),
  isActive: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const id = await transaction(async (trx) => {
      const saved = await saveRule(trx, orgId, { ...input, id: input.id ? Number(input.id) : null });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'workflow_rule', targetId: saved,
        targetLabel: input.name, detail: `On ${input.event}${input.isActive === false ? ' (off)' : ''}`, ...auditMeta(req),
      });
      return saved;
    });
    return { id: asId(id) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
