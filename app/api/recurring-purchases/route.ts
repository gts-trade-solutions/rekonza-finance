import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { runRecurringPurchase, type BillTemplateLine, type ExpenseTemplate } from '@/lib/server/services/recurring';
import '@/lib/server/jobs/boot';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring bills and recurring expenses (services/recurring.ts).
//
// Like recurring invoices, a profile keeps its lines as written and runs one
// period at a time, by hand or on its date by the scheduler.
// ─────────────────────────────────────────────────────────────────────────────

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
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
        };
      }),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const BillLine = z.object({
  itemId: id.nullish(),
  accountId: id.nullish(),
  description: z.string().trim().max(500).nullish(),
  qty: z.number().positive(),
  ratePaise: z.number().int().nonnegative(),
  gstRatePct: z.number().min(0).max(50).default(18),
  hsnSac: z.string().trim().max(10).nullish(),
});

const CreateInput = z.object({
  kind: z.enum(['bill', 'expense']),
  name: z.string().trim().min(1, 'Give the profile a name.').max(200),
  vendorId: id.nullish(),
  frequency: z.enum(FREQUENCIES),
  startDate: DATE,
  endDate: DATE.nullish(),
  dueDays: z.number().int().min(0).max(365).default(30),
  autoRun: z.boolean().optional(),
  lines: z.array(BillLine).max(100).optional(),
  expense: z.object({
    accountId: id,
    paidThroughBankAccountId: id,
    amountPaise: z.number().int().positive('Enter an amount above zero.'),
    gstRatePct: z.number().min(0).max(50).default(0),
    itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).default('eligible'),
    notes: z.string().trim().max(500).nullish(),
  }).optional(),
});

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const vendorId = input.vendorId ? Number(input.vendorId) : null;
    if (vendorId) {
      const v = await db.selectFrom('contacts').select('id').where('id', '=', vendorId).where('org_id', '=', orgId).executeTakeFirst();
      if (!v) throw badRequest('That vendor does not exist.');
    }
    if (input.endDate && input.endDate < input.startDate) throw badRequest('The profile cannot end before it starts.');

    let template: BillTemplateLine[] | ExpenseTemplate;
    let paidThrough: number | null = null;
    if (input.kind === 'bill') {
      if (!vendorId) throw badRequest('A recurring bill needs the vendor it comes from.');
      if (!input.lines?.length) throw badRequest('A recurring bill needs at least one line.');
      if (input.lines.some((l) => !l.itemId && !l.accountId)) throw badRequest('Each line needs an item, or the account it is booked to.');
      template = input.lines.map((l) => ({
        itemId: l.itemId ? Number(l.itemId) : null, accountId: l.accountId ? Number(l.accountId) : null,
        description: l.description ?? null, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac ?? null,
      }));
    } else {
      if (!input.expense) throw badRequest('Say what the expense is booked to, what it is paid from and how much.');
      const e = input.expense;
      const [acc, bank] = await Promise.all([
        db.selectFrom('accounts').select(['id', 'type']).where('id', '=', Number(e.accountId)).where('org_id', '=', orgId).executeTakeFirst(),
        db.selectFrom('bank_accounts').select('id').where('id', '=', Number(e.paidThroughBankAccountId)).where('org_id', '=', orgId).executeTakeFirst(),
      ]);
      if (!acc || acc.type !== 'expense') throw badRequest('Book a recurring expense to an expense account.');
      if (!bank) throw badRequest('That account to pay from does not exist.');
      paidThrough = bank.id;
      template = { accountId: acc.id, amountPaise: e.amountPaise, gstRatePct: e.gstRatePct, itcEligibility: e.itcEligibility, notes: e.notes ?? null };
    }

    const inserted = await db.insertInto('recurring_purchases').values({
      org_id: orgId, branch_id: branchId, kind: input.kind, profile_name: input.name, vendor_id: vendorId,
      frequency: input.frequency, start_date: input.startDate, end_date: input.endDate ?? null, next_run: input.startDate,
      due_days: input.dueDays, paid_through_bank_account_id: paidThrough, template: JSON.stringify(template),
      auto_run: input.autoRun ? 1 : 0, is_active: 1, created_by_user_id: user.userId,
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

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id: raw } = query(req, z.object({ id: z.string() }));
    const pid = Number(raw);
    const profile = await db.selectFrom('recurring_purchases').select(['id', 'profile_name'])
      .where('id', '=', pid).where('org_id', '=', orgId).executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');
    await db.deleteFrom('recurring_purchases').where('id', '=', pid).where('org_id', '=', orgId).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'recurring_purchase', targetId: pid, targetLabel: profile.profile_name,
      detail: 'Profile deleted. Bills and expenses it already raised are unaffected.', ...auditMeta(req),
    });
    return { id: asId(pid) };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);
