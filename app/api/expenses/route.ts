import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { createExpense } from '@/lib/server/services/purchases';
import { logAudit, auditMeta } from '@/lib/server/audit';

const ListQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  accountId: z.string().optional(),
  /** A customer's billable expenses not yet re-charged on an invoice, outside any project. */
  unbilledFor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db
      .selectFrom('expenses')
      .innerJoin('accounts', 'accounts.id', 'expenses.account_id')
      .innerJoin('bank_accounts', 'bank_accounts.id', 'expenses.paid_through_bank_account_id')
      .leftJoin('contacts', 'contacts.id', 'expenses.vendor_id')
      .where('expenses.org_id', '=', orgId);

    if (q.from) base = base.where('expenses.expense_date', '>=', q.from);
    if (q.to) base = base.where('expenses.expense_date', '<=', q.to);
    if (q.accountId) base = base.where('expenses.account_id', '=', Number(q.accountId));
    if (q.unbilledFor) {
      base = base.where('expenses.is_billable', '=', 1).where('expenses.billable_customer_id', '=', Number(q.unbilledFor))
        .where('expenses.billed_invoice_id', 'is', null).where('expenses.project_id', 'is', null).where('expenses.status', '<>', 'void');
    }

    const [rows, totals] = await Promise.all([
      base
        .select([
          'expenses.id', 'expenses.number', 'expenses.expense_date', 'expenses.amount',
          'expenses.cgst', 'expenses.sgst', 'expenses.igst', 'expenses.total',
          'expenses.itc_eligibility', 'expenses.is_billable', 'expenses.reference',
          'expenses.notes', 'expenses.status', 'expenses.account_id', 'expenses.mileage_km', 'expenses.recurring_id', 'expenses.project_id', 'expenses.billed_invoice_id',
          'accounts.name as account_name', 'accounts.code as account_code',
          'bank_accounts.name as paid_through', 'contacts.display_name as vendor_name',
        ])
        .orderBy('expenses.expense_date', 'desc')
        .orderBy('expenses.id', 'desc')
        .limit(q.limit).offset(q.offset).execute(),
      base
        .select([
          sql<string>`COUNT(*)`.as('count'),
          sql<string>`COALESCE(SUM(expenses.total), 0)`.as('total'),
        ])
        .executeTakeFirst(),
    ]);

    return {
      expenses: rows.map((r) => ({
        id: asId(r.id),
        number: r.number,
        date: r.expense_date,
        accountId: asId(r.account_id),
        accountName: r.account_name,
        accountCode: r.account_code,
        paidThrough: r.paid_through,
        vendorName: r.vendor_name,
        reference: r.reference,
        notes: r.notes,
        status: r.status,
        itcEligibility: r.itc_eligibility,
        isBillable: !!r.is_billable,
        mileageKm: r.mileage_km == null ? null : Number(r.mileage_km),
        recurring: !!r.recurring_id,
        projectId: r.project_id ? asId(r.project_id) : null,
        billed: !!r.billed_invoice_id,
        amountPaise: toPaiseFromSql(r.amount),
        taxPaise: toPaiseFromSql(r.cgst) + toPaiseFromSql(r.sgst) + toPaiseFromSql(r.igst),
        totalPaise: toPaiseFromSql(r.total),
      })),
      summary: {
        count: Number(totals?.count ?? 0),
        totalPaise: toPaiseFromSql(totals?.total ?? '0'),
      },
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const CreateInput = z.object({
  branchId: z.string(),
  /** The cost centre the document's income or expense belongs to. */
  costCentreId: z.union([z.string(), z.number()]).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  accountId: z.string(),
  paidThroughBankAccountId: z.string(),
  // Left out for mileage, where it is the distance times the rate.
  amountPaise: z.number().int().nonnegative().default(0),
  gstRatePct: z.number().min(0).max(50).optional(),
  vendorId: z.string().nullish(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  isBillable: z.boolean().optional(),
  billableCustomerId: z.string().nullish(),
  projectId: z.union([z.string(), z.number()]).nullish(),
  reference: z.string().nullish(),
  notes: z.string().nullish(),
  /** A journey claimed by the kilometre; the amount is worked out from it. */
  mileage: z.object({ km: z.number().positive().max(100000), ratePaise: z.number().int().positive().max(100000) }).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);

    const created = await transaction(async (trx) =>
      createExpense(trx, orgId, user.userId, {
        branchId: Number(input.branchId),
        costCentreId: input.costCentreId ? Number(input.costCentreId) : null,
        date: input.date,
        accountId: Number(input.accountId),
        paidThroughBankAccountId: Number(input.paidThroughBankAccountId),
        amountPaise: input.amountPaise,
        gstRatePct: input.gstRatePct,
        vendorId: input.vendorId ? Number(input.vendorId) : null,
        itcEligibility: input.itcEligibility,
        isBillable: input.isBillable,
        billableCustomerId: input.billableCustomerId ? Number(input.billableCustomerId) : null,
        projectId: input.projectId ? Number(input.projectId) : null,
        reference: input.reference,
        notes: input.notes,
        mileage: input.mileage ?? null,
      }),
    );

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'expense',
      targetId: created.id,
      targetLabel: created.number,
      detail: `Recorded expense ${created.number}`,
      ...auditMeta(req),
    });

    return {
      id: asId(created.id),
      number: created.number,
      totalPaise: created.totalPaise,
      journalEntryId: asId(created.journalEntryId),
      warnings: created.warnings ?? [],
    };
  },
  { permission: { module: 'purchases', action: 'create' } },
);
