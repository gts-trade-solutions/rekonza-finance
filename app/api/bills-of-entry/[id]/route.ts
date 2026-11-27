import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteBillOfEntry, updateBillOfEntry } from '@/lib/server/services/purchase-changes';
import { BillOfEntryBody, toBillOfEntryInput } from '@/lib/server/bill-of-entry-input';

// Edit and Delete on a bill of entry (services/purchase-changes.ts): its entry
// for the duty and import IGST is reversed, and posted again for an edit.
// Refused once its IGST is in a filed GSTR-3B or its payment is matched in Banking.

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, BillOfEntryBody);
    const done = await transaction(async (trx) => {
      const made = await updateBillOfEntry(trx, orgId, user.userId, id, toBillOfEntryInput(input));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bill_of_entry', targetId: id,
        targetLabel: input.boeNo, detail: `Edited bill of entry ${input.boeNo}: ₹${(made.totalPaise / 100).toFixed(2)} paid at customs`,
        payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(done.id), totalPaise: done.totalPaise };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteBillOfEntry(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'bill_of_entry', targetId: id,
        targetLabel: gone.number, detail: `Deleted bill of entry ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
