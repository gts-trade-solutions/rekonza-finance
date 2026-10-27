import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden } from '@/lib/server/http';
import { markInvoiceSent, setExportDetails, voidInvoice } from '@/lib/server/services/sales';
import { writeOffInvoice } from '@/lib/server/services/journals';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { invoiceDetail } from '@/lib/server/services/invoice-detail';

/** One invoice with its lines, its payments, and the journal entry behind it. */
export const GET = route(
  async ({ orgId, params }) => invoiceDetail(orgId, idParam(params)),
  { permission: { module: 'sales', action: 'view' } },
);

const ActionInput = z.object({
  action: z.enum(['send', 'void', 'export-details', 'write-off']),
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

    await transaction(async (trx) => {
      if (action === 'send') await markInvoiceSent(trx, orgId, user.userId, id);
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
      ...auditMeta(req),
    });

    return { id: asId(id), status: inv.status };
  },
  { permission: { module: 'sales', action: 'edit' } },
);
