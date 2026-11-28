import { transaction } from '@/lib/server/db';
import { route, body, idParam, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteSalesDocument, updateSalesDocument, type EditableSalesDoc } from '@/lib/server/services/sales-documents';
import { CreateInput, toSalesDocInput } from '@/lib/server/sales-doc-input';
import { salesDocRecord } from '@/lib/server/services/sales-doc-record';

// Zoho Books' Edit and Delete on a quote, sales order, delivery challan or
// credit note (services/sales-documents.ts updateSalesDocument, deleteSalesDocument).

const KINDS: EditableSalesDoc[] = ['estimate', 'sales-order', 'challan', 'credit-note'];

function kindOf(params: Record<string, string | string[]> | undefined): EditableSalesDoc {
  const k = String(params?.kind ?? '');
  if (!KINDS.includes(k as EditableSalesDoc)) throw badRequest('That document cannot be edited here.');
  return k as EditableSalesDoc;
}

/**
 * The document as saved, for its Edit form, and around it what its record
 * shows (services/sales-doc-record.ts).
 */
export const GET = route(
  async ({ orgId, params }) => salesDocRecord(orgId, kindOf(params), idParam(params)),
  { permission: { module: 'sales', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, branchId, req, params }) => {
    const kind = kindOf(params);
    const id = idParam(params);
    const input = await body(req, CreateInput);
    if (input.kind !== kind) throw badRequest('A document keeps its kind when edited.');
    const done = await transaction(async (trx) => {
      const made = await updateSalesDocument(trx, orgId, user.userId, id, toSalesDocInput(input, Number(input.branchId ?? branchId) || branchId));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: kind, targetId: id, targetLabel: made.number, detail: `Edited ${made.number}`,
        payload: { before: made.before, after: made.after }, ...auditMeta(req),
      });
      return made;
    });
    return { id: String(done.id), number: done.number, totalPaise: done.totalPaise };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const kind = kindOf(params);
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteSalesDocument(trx, orgId, user.userId, kind, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: kind, targetId: id, targetLabel: gone.number, detail: `Deleted ${gone.number}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'sales', action: 'void' } },
);
