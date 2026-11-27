import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { hasPermission } from '@/lib/rbac';
import { actualsForPlan, budgetYears, clonePlan, listPlans, savePlan } from '@/lib/server/reports/budget-plans';

// ─────────────────────────────────────────────────────────────────────────────
// Budgets by period, as Zoho Books keeps them (lib/server/reports/budget-plans.ts):
// GET lists a year's budgets; POST saves one (every amount at once), clones
// one, or fills a grid from last year's actuals (which saves nothing).
// ─────────────────────────────────────────────────────────────────────────────

const FY = z.string().regex(/^\d{4}-\d{2}$/);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ fy: FY.optional() }));
    const [plans, years] = await Promise.all([listPlans(db, orgId, q.fy), budgetYears(db, orgId, today())]);
    return { plans, years };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const OptId = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)));
const PERIOD = z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: OptId, name: z.string().trim().min(1).max(120), fyLabel: FY, period: PERIOD,
    branchId: OptId, costCentreId: OptId, projectId: OptId,
    includeBalanceSheet: z.boolean().optional(), isPrimary: z.boolean().optional(), notes: z.string().max(500).nullish(),
    lines: z.array(z.object({ accountId: Id, amountsPaise: z.array(z.number().int().min(0)).min(1).max(12) })).max(1000),
  }),
  z.object({ action: z.literal('clone'), id: Id, name: z.string().trim().min(1).max(120), fyLabel: FY.optional(), adjustPct: z.number().min(-100).max(1000).optional() }),
  z.object({
    action: z.literal('fill'), fyLabel: FY, period: PERIOD, accountIds: z.array(Id).max(1000), adjustPct: z.number().min(-100).max(1000).optional(),
    branchId: OptId, costCentreId: OptId, projectId: OptId, sourceFy: FY.optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    if (input.action === 'fill') return actualsForPlan(db, orgId, input);
    if (!hasPermission(role, 'accountant', input.action === 'save' && input.id ? 'edit' : 'create')) throw forbidden('Your role cannot change budgets.');
    return transaction(async (trx) => {
      if (input.action === 'clone') {
        const id = await clonePlan(trx, orgId, user.userId, input.id, input);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'budget_plan', targetId: id, targetLabel: input.name,
          detail: `Cloned budget #${input.id} as "${input.name}"${input.fyLabel ? ` for FY ${input.fyLabel}` : ''}${input.adjustPct ? `, each amount ${input.adjustPct > 0 ? '+' : ''}${input.adjustPct}%` : ''}`,
          ...auditMeta(req),
        });
        return { id: asId(id) };
      }
      const id = await savePlan(trx, orgId, user.userId, input);
      const total = input.lines.reduce((t, l) => t + l.amountsPaise.reduce((s, a) => s + a, 0), 0);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'budget_plan', targetId: id,
        targetLabel: `${input.name} (FY ${input.fyLabel})`,
        detail: `${input.id ? 'Changed' : 'Created'} the ${input.period.replace('_', '-')} budget "${input.name}" for FY ${input.fyLabel}: ${input.lines.length} account(s), ₹${(total / 100).toLocaleString('en-IN')} in all`,
        payload: { lines: input.lines.length, totalPaise: total }, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'accountant', action: 'view' } },
);
