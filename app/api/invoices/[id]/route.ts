import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound } from '@/lib/server/http';
import { deleteInvoice, markInvoiceSent, setExportDetails, updateInvoice, voidInvoice } from '@/lib/server/services/sales';
import { CreateInput, toInvoiceInput } from '@/lib/server/invoice-input';
import { deleteSalesReceipt, updateSalesReceipt } from '@/lib/server/services/sales-receipts';
import { queueIrns } from '@/lib/server/gst/auto-irn';
import { writeOffInvoice } from '@/lib/server/services/journals';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { invoiceDetail } from '@/lib/server/services/invoice-detail';
import { TEMPLATE_KEYS, templateInfo } from '@/lib/print-template';

/** One invoice with its lines, its payments, and the journal entry behind it. */
export const GET = route(
  async ({ orgId, params }) => invoiceDetail(orgId, idParam(params)),
  { permission: { module: 'sales', action: 'view' } },
);

const ActionInput = z.object({
  action: z.enum(['send', 'void', 'export-details', 'write-off', 'template']),
  // template: the PDF template this invoice prints in; null follows Settings → PDF Templates.
  template: z.enum(TEMPLATE_KEYS).nullish(),
  reason: z.string().max(300).optional(),
  // write-off: the date, and how much (all that is left, when omitted).
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amountPaise: z.number().int().positive().optional(),
  // export-details: the shipping bill, usually known days after the invoice.
  shippingBillNo: z.string().trim().max(20).nullish(),
  shippingBillDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  portCode: z.string().trim().toUpperCase().max(6).nullish(),
  countryCode: z.string().trim().toUpperCase().length(2).nullish(),
  currency: z.string().trim().toUpperCase().length(3).nullish(),
});

/**
 * State changes on an existing invoice.
 *
 * There is no PUT that rewrites a posted invoice. Editing one that is already
 * in the ledger and reported to the customer would change history silently;
 * the routes here are the transitions that leave a trail.
 */
export const POST = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const input = await body(req, ActionInput);
    const { action, reason } = input;

    if (action === 'write-off') {
      if (!hasPermission(role, 'sales', 'void')) throw forbidden('Writing off a debt needs the right to void sales documents.');
      const entry = await transaction(async (trx) => {
        const e = await writeOffInvoice(trx, orgId, user.userId, id, {
          date: input.date ?? new Date().toISOString().slice(0, 10), reason: reason ?? '', amountPaise: input.amountPaise,
        });
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
          targetType: 'invoice', targetId: id, targetLabel: String(id),
          detail: `Bad debt written off: ${reason ?? ''}`, ...auditMeta(req),
        });
        return e;
      });
      return { id: asId(id), journalEntryId: asId(entry.id) };
    }

    if (action === 'template') {
      // The look of one invoice, as Zoho's "PDF Template : … Change": nothing it says changes.
      if (!hasPermission(role, 'sales', 'edit')) throw forbidden('Your role cannot change how invoices print.');
      await transaction(async (trx) => {
        const inv = await trx.selectFrom('invoices').select(['number']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
        if (!inv) throw notFound('Invoice not found.');
        await trx.updateTable('invoices').set({ print_template: input.template ?? null }).where('id', '=', id).where('org_id', '=', orgId).execute();
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'invoice', targetId: id, targetLabel: inv.number,
          detail: input.template ? `PDF template set to ${templateInfo(input.template).name}` : 'PDF template set back to the one for invoices',
          ...auditMeta(req),
        });
      });
      return { id: asId(id), template: input.template ?? null };
    }

    if (action === 'export-details') {
      await transaction(async (trx) => {
        await setExportDetails(trx, orgId, id, input);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'invoice', targetId: id, targetLabel: String(id),
          detail: `Shipping bill ${input.shippingBillNo ?? '—'} of ${input.shippingBillDate ?? '—'}, port ${input.portCode ?? '—'}`,
          ...auditMeta(req),
        });
      });
      return { id: asId(id) };
    }

    const warnings: string[] = [];
    await transaction(async (trx) => {
      if (action === 'send') warnings.push(...(await markInvoiceSent(trx, orgId, user.userId, id)).warnings);
      else await voidInvoice(trx, orgId, user.userId, id, reason);
    });

    const inv = await db
      .selectFrom('invoices').select(['number', 'status'])
      .where('id', '=', id).executeTakeFirstOrThrow();

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: action === 'void' ? 'void' : 'send',
      targetType: 'invoice',
      targetId: id,
      targetLabel: inv.number,
      detail: action === 'void'
        ? `Voided invoice ${inv.number}${reason ? ` — ${reason}` : ''}`
        : `Sent invoice ${inv.number}`,
      // The reason typed for the void is the audit row's reason (the Reversed Vouchers register reads it).
      reason: action === 'void' ? reason || undefined : undefined,
      ...auditMeta(req),
    });

    return { id: asId(id), status: inv.status, warnings };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

/**
 * Edit, as Zoho Books' Edit: a draft or an issued invoice, rewritten in place
 * (services/sales.ts updateInvoice). An issued one's entry is reversed and
 * posted again; the audit trail keeps both versions.
 */
export const PUT = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const input = await body(req, CreateInput);
    const done = await transaction(async (trx) => {
      // A sales receipt sends its payment with it: the invoice and the counter payment change together.
      const receipt = input.paidAtSale
        ? !!(await trx.selectFrom('invoices').select('paid_at_sale').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst())?.paid_at_sale
        : false;
      const made = receipt && input.paidAtSale
        ? await updateSalesReceipt(trx, orgId, user.userId, id, toInvoiceInput(input, role), {
          mode: input.paidAtSale.mode, bankAccountId: Number(input.paidAtSale.bankAccountId), reference: input.paidAtSale.reference ?? null,
        })
        : await updateInvoice(trx, orgId, user.userId, id, toInvoiceInput(input, role));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'invoice', targetId: id, targetLabel: made.number,
        detail: `Edited ${receipt ? 'sales receipt ' : ''}${made.number}`, payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    await queueIrns(db, orgId, { invoiceId: id, userId: user.userId }).catch((err) => console.error('[auto-irn]', err));
    return {
      id: asId(done.id), number: done.number, totalPaise: done.totalPaise,
      journalEntryId: done.journalEntryId ? asId(done.journalEntryId) : null, warnings: done.warnings ?? [],
    };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

/**
 * Delete, as Zoho Books' Delete: while nothing is received against it. The
 * entry is reversed and the number kept as cancelled (migration 118).
 */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      // A sales receipt goes with its counter payment (services/sales-receipts.ts).
      const receipt = !!(await trx.selectFrom('invoices').select('paid_at_sale').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst())?.paid_at_sale;
      const gone = receipt ? await deleteSalesReceipt(trx, orgId, user.userId, id, reason) : { ...(await deleteInvoice(trx, orgId, user.userId, id, reason)), payments: [] as string[] };
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'invoice', targetId: id, targetLabel: gone.number,
        detail: receipt ? `Deleted sales receipt ${gone.number} with its payment ${gone.payments.join(', ') || '(none left)'}` : `Deleted ${gone.number}`,
        reason: reason || undefined,
        ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'sales', action: 'void' } },
);
