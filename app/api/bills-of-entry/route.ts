import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { recordBillOfEntry, voidBillOfEntry } from '@/lib/server/services/bill-of-entry';

// Bills of entry: what customs charged on goods imported (services/bill-of-entry.ts).

export const GET = route(
  async ({ orgId }) => {
    const rows = await db.selectFrom('bills_of_entry as e')
      .leftJoin('contacts as c', 'c.id', 'e.vendor_id').leftJoin('bills as b', 'b.id', 'e.bill_id')
      .innerJoin('bank_accounts as k', 'k.id', 'e.paid_through_bank_account_id')
      .select(['e.id', 'e.boe_no', 'e.boe_date', 'e.port_code', 'e.assessable_value', 'e.customs_duty', 'e.igst', 'e.cess', 'e.itc_eligibility',
        'e.status', 'e.void_reason', 'e.bill_id', 'b.internal_no as bill_no', 'c.display_name as vendor_name', 'k.name as paid_through'])
      .where('e.org_id', '=', orgId).orderBy('e.boe_date', 'desc').orderBy('e.id', 'desc').limit(500).execute();
    return {
      entries: rows.map((r) => ({
        id: asId(r.id), boeNo: r.boe_no, boeDate: String(r.boe_date).slice(0, 10), portCode: r.port_code,
        assessablePaise: toPaiseFromSql(r.assessable_value), customsDutyPaise: toPaiseFromSql(r.customs_duty),
        igstPaise: toPaiseFromSql(r.igst), cessPaise: toPaiseFromSql(r.cess), itcEligibility: r.itc_eligibility,
        status: r.status, voidReason: r.void_reason, billId: r.bill_id ? asId(r.bill_id) : null, billNo: r.bill_no,
        vendorName: r.vendor_name, paidThrough: r.paid_through,
      })),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const id = z.union([z.string(), z.number()]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const CreateInput = z.object({
  branchId: id, vendorId: id.nullish(), billId: id.nullish(),
  boeNo: z.string().trim().min(1).max(20), boeDate: DATE, portCode: z.string().trim().min(1).max(6),
  assessablePaise: z.number().int().nonnegative(), customsDutyPaise: z.number().int().nonnegative(),
  igstPaise: z.number().int().nonnegative(), cessPaise: z.number().int().nonnegative().optional(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  dutyAccountId: id, paidThroughBankAccountId: id, notes: z.string().trim().max(500).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);
    const r = await transaction(async (trx) => {
      const made = await recordBillOfEntry(trx, orgId, user.userId, {
        ...input, branchId: Number(input.branchId), vendorId: input.vendorId ? Number(input.vendorId) : null,
        billId: input.billId ? Number(input.billId) : null, dutyAccountId: Number(input.dutyAccountId),
        paidThroughBankAccountId: Number(input.paidThroughBankAccountId),
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'bill_of_entry', targetId: made.id,
        targetLabel: input.boeNo, detail: `Bill of entry ${input.boeNo}, ${input.portCode}: ₹${(made.totalPaise / 100).toFixed(2)} paid at customs`, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(r.id), totalPaise: r.totalPaise };
  },
  { permission: { module: 'purchases', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ action: z.literal('void'), id, reason: z.string().trim().max(300) }));
    await transaction(async (trx) => {
      await voidBillOfEntry(trx, orgId, user.userId, Number(input.id), input.reason);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'bill_of_entry', targetId: Number(input.id), detail: input.reason, reason: input.reason, ...auditMeta(req) });
    });
    return { id: asId(Number(input.id)) };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
