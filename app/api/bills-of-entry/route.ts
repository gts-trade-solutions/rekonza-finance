import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { recordBillOfEntry, voidBillOfEntry } from '@/lib/server/services/bill-of-entry';
import { BillOfEntryBody, toBillOfEntryInput } from '@/lib/server/bill-of-entry-input';

// Bills of entry: what customs charged on goods imported (services/bill-of-entry.ts).

export const GET = route(
  async ({ orgId }) => {
    const rows = await db.selectFrom('bills_of_entry as e')
      .leftJoin('contacts as c', 'c.id', 'e.vendor_id').leftJoin('bills as b', 'b.id', 'e.bill_id')
      .innerJoin('bank_accounts as k', 'k.id', 'e.paid_through_bank_account_id')
      .select(['e.id', 'e.boe_no', 'e.boe_date', 'e.port_code', 'e.assessable_value', 'e.customs_duty', 'e.igst', 'e.cess', 'e.itc_eligibility',
        'e.status', 'e.void_reason', 'e.bill_id', 'b.internal_no as bill_no', 'c.display_name as vendor_name', 'k.name as paid_through',
        'e.vendor_id', 'e.branch_id', 'e.duty_account_id', 'e.paid_through_bank_account_id', 'e.notes'])
      .where('e.org_id', '=', orgId).orderBy('e.boe_date', 'desc').orderBy('e.id', 'desc').limit(500).execute();
    return {
      entries: rows.map((r) => ({
        id: asId(r.id), boeNo: r.boe_no, boeDate: String(r.boe_date).slice(0, 10), portCode: r.port_code,
        assessablePaise: toPaiseFromSql(r.assessable_value), customsDutyPaise: toPaiseFromSql(r.customs_duty),
        igstPaise: toPaiseFromSql(r.igst), cessPaise: toPaiseFromSql(r.cess), itcEligibility: r.itc_eligibility,
        status: r.status, voidReason: r.void_reason, billId: r.bill_id ? asId(r.bill_id) : null, billNo: r.bill_no,
        vendorName: r.vendor_name, paidThrough: r.paid_through,
        // For Edit: the form as it was filled in.
        vendorId: r.vendor_id ? asId(r.vendor_id) : null, branchId: asId(r.branch_id), dutyAccountId: asId(r.duty_account_id),
        paidThroughBankAccountId: asId(r.paid_through_bank_account_id), notes: r.notes,
      })),
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const id = z.union([z.string(), z.number()]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, BillOfEntryBody);
    const r = await transaction(async (trx) => {
      const made = await recordBillOfEntry(trx, orgId, user.userId, toBillOfEntryInput(input));
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
