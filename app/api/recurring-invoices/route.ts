import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { runRecurringInvoice } from '@/lib/server/services/recurring';
import '@/lib/server/jobs/boot';
import { logAudit, auditMeta } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring invoice profiles.
//
// The line template is stored as written, with its own rates, rather than as a
// list of item ids resolved at generation time. That is deliberate: resolving
// later would silently re-price a two-year-old contract the moment somebody
// updates a catalogue price, and the customer would receive an invoice nobody
// agreed to.
//
// Generating goes through createInvoice like any other sale, so the GST, the
// numbering and the posting are identical to a hand-raised invoice.
// ─────────────────────────────────────────────────────────────────────────────

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

interface TemplateLine {
  itemId: number | null;
  description: string | null;
  qty: number;
  ratePaise: number;
  gstRatePct: number;
  hsnSac: string | null;
}

export const GET = route(
  async ({ orgId }) => {
    const rows = await db
      .selectFrom('recurring_invoices as r')
      .innerJoin('contacts as c', 'c.id', 'r.customer_id')
      .select([
        'r.id', 'r.profile_name', 'r.frequency', 'r.start_date', 'r.end_date', 'r.next_run',
        'r.payment_terms', 'r.template', 'r.auto_send', 'r.is_active', 'r.last_generated_at', 'r.auto_run', 'r.last_error',
        'r.customer_id', 'c.display_name as customer_name',
      ])
      .where('r.org_id', '=', orgId)
      .orderBy('r.next_run')
      .execute();

    const today = new Date().toISOString().slice(0, 10);

    return {
      profiles: rows.map((r) => {
        const template = (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as TemplateLine[];
        // The value shown is what the template comes to today, tax included.
        const taxable = template.reduce((t, l) => t + Math.round(l.ratePaise * l.qty), 0);
        const tax = template.reduce(
          (t, l) => t + Math.round((Math.round(l.ratePaise * l.qty) * l.gstRatePct) / 100),
          0,
        );
        return {
          id: asId(r.id),
          name: r.profile_name,
          customerId: asId(r.customer_id),
          customerName: r.customer_name,
          frequency: r.frequency,
          startDate: String(r.start_date).slice(0, 10),
          endDate: r.end_date ? String(r.end_date).slice(0, 10) : null,
          nextRun: String(r.next_run).slice(0, 10),
          paymentTerms: r.payment_terms,
          autoSend: !!r.auto_send,
          /** Raised by the scheduler on its date, without anyone pressing Run. */
          autoRun: !!r.auto_run,
          lastError: r.last_error,
          isActive: !!r.is_active,
          lastGeneratedAt: r.last_generated_at ? String(r.last_generated_at).slice(0, 10) : null,
          lineCount: template.length,
          taxablePaise: taxable,
          totalPaise: taxable + tax,
          isDue: !!r.is_active && String(r.next_run).slice(0, 10) <= today,
        };
      }),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const LineInput = z.object({
  itemId: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  qty: z.number().positive(),
  ratePaise: z.number().int().nonnegative(),
  gstRatePct: z.number().min(0).max(50).default(18),
  hsnSac: z.string().nullish(),
});

const CreateInput = z.object({
  name: z.string().trim().min(1, 'Give the profile a name.').max(200),
  customerId: z.union([z.string(), z.number()]),
  frequency: z.enum(FREQUENCIES),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  paymentTerms: z.string().max(20).nullish(),
  autoSend: z.boolean().optional(),
  autoRun: z.boolean().optional(),
  lines: z.array(LineInput).min(1, 'A profile needs at least one line.'),
});

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const customerId = Number(input.customerId);

    const customer = await db
      .selectFrom('contacts').select(['id', 'display_name'])
      .where('id', '=', customerId).where('org_id', '=', orgId).executeTakeFirst();
    if (!customer) throw badRequest('That customer does not exist.');

    const template: TemplateLine[] = input.lines.map((l) => ({
      itemId: l.itemId == null ? null : Number(l.itemId),
      description: l.description ?? null,
      qty: l.qty,
      ratePaise: l.ratePaise,
      gstRatePct: l.gstRatePct,
      hsnSac: l.hsnSac ?? null,
    }));

    const inserted = await db
      .insertInto('recurring_invoices')
      .values({
        org_id: orgId,
        branch_id: branchId,
        profile_name: input.name,
        customer_id: customerId,
        frequency: input.frequency,
        start_date: input.startDate,
        end_date: input.endDate ?? null,
        next_run: input.startDate,
        payment_terms: input.paymentTerms ?? 'net_30',
        template: JSON.stringify(template),
        auto_send: input.autoSend ? 1 : 0,
        auto_run: input.autoRun ? 1 : 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_invoice', targetId: id, targetLabel: input.name,
      detail: `${input.frequency} profile for ${customer.display_name}, first run ${input.startDate}`,
      ...auditMeta(req),
    });

    return { id: asId(id), name: input.name };
  },
  { permission: { module: 'sales', action: 'create' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run'),
    id: z.union([z.string(), z.number()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    action: z.literal('toggle'),
    id: z.union([z.string(), z.number()]),
    isActive: z.boolean(),
  }),
  z.object({
    action: z.literal('auto'),
    id: z.union([z.string(), z.number()]),
    autoRun: z.boolean(),
  }),
]);

/**
 * Generate one invoice from a profile, pause it, or let the scheduler raise it.
 *
 * Like recurring journals, running does not catch up on missed periods. Six
 * months of back-dated invoices appearing because nobody opened the screen
 * since March would be a surprise nobody wants, least of all the customer.
 */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const id = Number(input.id);

    const profile = await db
      .selectFrom('recurring_invoices')
      .select(['id', 'profile_name'])
      .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');

    if (input.action === 'toggle' || input.action === 'auto') {
      await db
        .updateTable('recurring_invoices')
        .set(input.action === 'toggle' ? { is_active: input.isActive ? 1 : 0 } : { auto_run: input.autoRun ? 1 : 0, last_error: null })
        .where('id', '=', id).execute();
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'recurring_invoice', targetId: id, targetLabel: profile.profile_name,
        detail: input.action === 'toggle' ? (input.isActive ? 'Resumed' : 'Paused')
          : input.autoRun ? 'Raised automatically on its dates' : 'Raised only when run by hand',
        ...auditMeta(req),
      });
      return { id: asId(id) };
    }

    const created = await transaction((trx) => runRecurringInvoice(trx, orgId, user.userId, id, input.date));

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_invoice', targetId: id, targetLabel: created.name,
      detail: `Generated invoice ${created.invoice.number} for ${(created.invoice.totalPaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });

    return {
      id: asId(id),
      invoiceId: asId(created.invoice.id),
      number: created.invoice.number,
      totalPaise: created.invoice.totalPaise,
      autoSent: created.autoSent,
    };
  },
  { permission: { module: 'sales', action: 'create' } },
);

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.string() }));
    const numeric = Number(id);

    const profile = await db
      .selectFrom('recurring_invoices').select(['id', 'profile_name'])
      .where('id', '=', numeric).where('org_id', '=', orgId).executeTakeFirst();
    if (!profile) throw badRequest('That profile does not exist.');

    await db.deleteFrom('recurring_invoices').where('id', '=', numeric).where('org_id', '=', orgId).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'recurring_invoice', targetId: numeric, targetLabel: profile.profile_name,
      detail: 'Profile deleted. Invoices it already raised are unaffected.', ...auditMeta(req),
    });

    return { id: asId(numeric) };
  },
  { permission: { module: 'sales', action: 'edit' } },
);
