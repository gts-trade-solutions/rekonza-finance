import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { deleteExpense, updateExpense } from '@/lib/server/services/purchases';
import { ExpenseInput, toExpenseInput } from '@/lib/server/expense-input';

// One expense: as saved (for its Edit form), Zoho's Edit, and Zoho's Delete.

export const GET = route(
  async ({ orgId, params }) => {
    const id = idParam(params);
    const e = await db.selectFrom('expenses').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!e) throw notFound('Expense not found.');
    return {
      id: asId(e.id), number: e.number, date: String(e.expense_date).slice(0, 10), status: e.status,
      branchId: asId(e.branch_id), costCentreId: e.cost_centre_id ? asId(e.cost_centre_id) : null,
      accountId: asId(e.account_id), paidThroughBankAccountId: asId(e.paid_through_bank_account_id),
      vendorId: e.vendor_id ? asId(e.vendor_id) : null,
      amountPaise: toPaiseFromSql(e.total), gstRatePct: Number(e.gst_rate_pct), itcEligibility: e.itc_eligibility,
      isBillable: !!e.is_billable, billableCustomerId: e.billable_customer_id ? asId(e.billable_customer_id) : null,
      projectId: e.project_id ? asId(e.project_id) : null, reference: e.reference, notes: e.notes,
      mileage: e.mileage_km ? { km: Number(e.mileage_km), ratePaise: toPaiseFromSql(e.mileage_rate ?? '0') } : null,
      billedInvoiceId: e.billed_invoice_id ? asId(e.billed_invoice_id) : null,
      journalEntryId: e.journal_entry_id ? asId(e.journal_entry_id) : null,
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, ExpenseInput);
    const done = await transaction(async (trx) => {
      const made = await updateExpense(trx, orgId, user.userId, id, toExpenseInput(input));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'expense', targetId: id, targetLabel: made.number, detail: `Edited expense ${made.number}`,
        payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(done.id), number: done.number, totalPaise: done.totalPaise, journalEntryId: asId(done.journalEntryId), warnings: done.warnings ?? [] };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteExpense(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'expense', targetId: id, targetLabel: gone.number, detail: `Deleted expense ${gone.number}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
