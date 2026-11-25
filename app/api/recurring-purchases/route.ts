import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { runRecurringPurchase, type BillTemplateLine, type ExpenseTemplate } from '@/lib/server/services/recurring';
import { RecurringPurchaseBody, recurringPurchaseValues } from '@/lib/server/recurring-purchase-input';
import { deleteRecurringPurchase } from '@/lib/server/services/recurring-purchases';
import '@/lib/server/jobs/boot';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring bills and recurring expenses (services/recurring.ts).
//
// Like recurring invoices, a profile keeps its lines as written and runs one
// period at a time, by hand or on its date by the scheduler.
// ─────────────────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const id = z.union([z.string(), z.number()]);

export const GET = route(
  async ({ orgId, req }) => {
    const { kind } = query(req, z.object({ kind: z.enum(['bill', 'expense']).optional() }));
    let q = db.selectFrom('recurring_purchases as r')
      .leftJoin('contacts as c', 'c.id', 'r.vendor_id')
      .leftJoin('bank_accounts as b', 'b.id', 'r.paid_through_bank_account_id')
      .selectAll('r')
      .select(['c.display_name as vendor_name', 'b.name as paid_through'])
      .where('r.org_id', '=', orgId);
    if (kind) q = q.where('r.kind', '=', kind);
    const rows = await q.orderBy('r.next_run').execute();
    const today = new Date().toISOString().slice(0, 10);
    return {
      profiles: rows.map((r) => {
        const t = typeof r.template === 'string' ? JSON.parse(r.template) : r.template;
        // What one run comes to: bill lines before tax plus their GST, or the expense as paid.
        const totalPaise = r.kind === 'bill'
          ? (t as BillTemplateLine[]).reduce((s, l) => { const v = Math.round(l.ratePaise * l.qty); return s + v + Math.round((v * l.gstRatePct) / 100); }, 0)
          : (t as ExpenseTemplate).amountPaise;
        return {
          id: asId(r.id),
          kind: r.kind,
          name: r.profile_name,
          vendorId: r.vendor_id ? asId(r.vendor_id) : null,
          vendorName: r.vendor_name,
          paidThrough: r.paid_through,
          frequency: r.frequency,
          startDate: String(r.start_date).slice(0, 10),
          endDate: r.end_date ? String(r.end_date).slice(0, 10) : null,
          nextRun: String(r.next_run).slice(0, 10),
          dueDays: r.due_days,
          autoRun: !!r.auto_run,
          isActive: !!r.is_active,
          lastGeneratedAt: r.last_generated_at ? String(r.last_generated_at).slice(0, 10) : null,
          lastError: r.last_error,
          totalPaise,
          isDue: !!r.is_active && String(r.next_run).slice(0, 10) <= today,
          // For Edit: the profile as written.
          lines: r.kind === 'bill' ? (t as BillTemplateLine[]).map((l) => ({
            itemId: l.itemId ? asId(l.itemId) : null, accountId: l.accountId ? asId(l.accountId) : null, description: l.description,
            qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac,
          })) : null,
          expense: r.kind === 'expense' ? {
            accountId: asId((t as ExpenseTemplate).accountId), amountPaise: (t as ExpenseTemplate).amountPaise, gstRatePct: (t as ExpenseTemplate).gstRatePct,
            itcEligibility: (t as ExpenseTemplate).itcEligibility, notes: (t as ExpenseTemplate).notes,
            paidThroughBankAccountId: r.paid_through_bank_account_id ? asId(r.paid_through_bank_account_id) : null,
          } : null,
        };
      }),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, RecurringPurchaseBody);
    const values = await recurringPurchaseValues(db, orgId, input);
    const inserted = await db.insertInto('recurring_purchases').values({
      org_id: orgId, branch_id: branchId, kind: input.kind, ...values, next_run: input.startDate,
      is_active: 1, created_by_user_id: user.userId,
    }).executeTakeFirstOrThrow();
    const newId = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_purchase', targetId: newId, targetLabel: input.name,
      detail: `${input.frequency} recurring ${input.kind}, first run ${input.startDate}`, ...auditMeta(req),
    });
    return { id: asId(newId), name: input.name };
  },
  { permission: { module: 'purchases', action: 'create' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), id, date: DATE.optional() }),
  z.object({ action: z.literal('toggle'), id, isActive: z.boolean() }),
  z.object({ action: z.literal('auto'), id, autoRun: z.boolean() }),
]);

/** Raise one period's bill or expense, pause a profile, or let the scheduler run it. */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const pid = Number(input.id);
    const profile = await db.selectFrom('recurring_purchases').select(['id', 'profile_name'])
      .where('id', '=', pid).where('org_id', '=', orgId).executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');

    if (input.action !== 'run') {
      await db.updateTable('recurring_purchases')
        .set(input.action === 'toggle' ? { is_active: input.isActive ? 1 : 0 } : { auto_run: input.autoRun ? 1 : 0, last_error: null })
        .where('id', '=', pid).execute();
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'recurring_purchase', targetId: pid, targetLabel: profile.profile_name,
        detail: input.action === 'toggle' ? (input.isActive ? 'Resumed' : 'Paused')
          : input.autoRun ? 'Raised automatically on its dates' : 'Raised only when run by hand',
        ...auditMeta(req),
      });
      return { id: asId(pid) };
    }

    const r = await transaction((trx) => runRecurringPurchase(trx, orgId, user.userId, pid, input.date));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_purchase', targetId: pid, targetLabel: r.name,
      detail: `${r.made.kind === 'bill' ? 'Raised bill' : 'Recorded expense'} ${r.made.number} for ${(r.made.totalPaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });
    return { id: asId(pid), kind: r.made.kind, docId: asId(r.made.id), number: r.made.number, totalPaise: r.made.totalPaise };
  },
  { permission: { module: 'purchases', action: 'create' } },
);

/** The old address of Delete (?id=); the same as DELETE /api/recurring-purchases/[id]. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id: raw } = query(req, z.object({ id: z.string() }));
    const pid = Number(raw);
    return transaction(async (trx) => {
      const r = await deleteRecurringPurchase(trx, orgId, pid);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'recurring_purchase', targetId: pid, targetLabel: r.name,
        detail: `Recurring ${r.kind} profile deleted. The ${r.raised} it raised stay as they are.`, ...auditMeta(req),
      });
      return { id: asId(pid) };
    });
  },
  { permission: { module: 'purchases', action: 'void' } },
);
