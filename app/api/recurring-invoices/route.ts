import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { runRecurringInvoice, type Frequency } from '@/lib/server/services/recurring';
import { createProfile, repeatLabel } from '@/lib/server/services/recurring-profiles';
import { CreateInput, toProfileInput } from './input';
import '@/lib/server/jobs/boot';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { mailStatus, siteUrl } from '@/lib/server/mail/mailer';
import { emailInvoice } from '@/lib/server/mail/documents';

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
        'r.id', 'r.profile_name', 'r.frequency', 'r.repeat_every', 'r.start_date', 'r.end_date', 'r.next_run',
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
          /** Zoho's FREQUENCY column: "Week", "2 Weeks", "Every 10 Days" (migration 123). */
          every: Number(r.repeat_every) || 1,
          repeatLabel: repeatLabel(r.frequency as Frequency, Number(r.repeat_every) || 1),
          /** Zoho's STATUS: Active, Stopped, or Expired once past its end date. */
          status: r.end_date && String(r.next_run).slice(0, 10) > String(r.end_date).slice(0, 10) ? 'expired' : r.is_active ? 'active' : 'stopped',
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

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    const id = await createProfile(db, orgId, toProfileInput(input, branchId));
    const customer = await db.selectFrom('contacts').select('display_name').where('id', '=', Number(input.customerId)).executeTakeFirst();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'recurring_invoice', targetId: id, targetLabel: input.name,
      detail: `${repeatLabel(input.frequency as Frequency, input.every ?? 1)} profile for ${customer?.display_name ?? 'a customer'}, first run ${input.startDate}`,
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
    // Set to send itself: with a mail server, it goes to the customer now it is committed.
    let emailed: string[] | null = null;
    if (created.autoSent && mailStatus().configured) {
      emailed = await emailInvoice(orgId, user.userId, created.invoice.id, { baseUrl: siteUrl(req) }).then((r) => r.to).catch(() => null);
    }

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
      emailedTo: emailed,
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
