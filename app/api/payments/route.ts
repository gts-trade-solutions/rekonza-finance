import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { receivePayment, makePayment, applyPayment, unapplyAllocation, voidPayment } from '@/lib/server/services/payments';
import { logAudit, auditMeta } from '@/lib/server/audit';

const ListQuery = z.object({
  kind: z.enum(['received', 'made']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  contactId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db
      .selectFrom('payments')
      .innerJoin('contacts', 'contacts.id', 'payments.contact_id')
      .innerJoin('bank_accounts', 'bank_accounts.id', 'payments.bank_account_id')
      .where('payments.org_id', '=', orgId);

    if (q.kind) base = base.where('payments.kind', '=', q.kind);
    if (q.from) base = base.where('payments.payment_date', '>=', q.from);
    if (q.to) base = base.where('payments.payment_date', '<=', q.to);
    if (q.contactId) base = base.where('payments.contact_id', '=', Number(q.contactId));

    const [rows, totals] = await Promise.all([
      base
        .select([
          'payments.id', 'payments.number', 'payments.kind', 'payments.payment_date',
          'payments.mode', 'payments.amount', 'payments.tds_amount', 'payments.bank_charges',
          'payments.unapplied_amount', 'payments.reference', 'payments.status',
          'payments.contact_id', 'contacts.display_name as contact_name',
          'bank_accounts.name as bank_name',
        ])
        .orderBy('payments.payment_date', 'desc')
        .orderBy('payments.id', 'desc')
        .limit(q.limit)
        .offset(q.offset)
        .execute(),
      base
        .select([
          sql<string>`COUNT(*)`.as('count'),
          sql<string>`COALESCE(SUM(payments.amount), 0)`.as('total'),
          sql<string>`COALESCE(SUM(payments.unapplied_amount), 0)`.as('unapplied'),
        ])
        .executeTakeFirst(),
    ]);

    // How many documents each receipt settled. Fetched for the visible page
    // only, and grouped rather than counted per row.
    const ids = rows.map((r) => r.id);
    const allocRows = ids.length
      ? await db
          .selectFrom('payment_allocations')
          .select(['payment_id', sql<string>`COUNT(*)`.as('n')])
          .where('payment_id', 'in', ids)
          .groupBy('payment_id')
          .execute()
      : [];
    const allocBy = new Map(allocRows.map((a) => [a.payment_id, Number(a.n)]));

    return {
      payments: rows.map((r) => ({
        id: asId(r.id),
        number: r.number,
        kind: r.kind,
        date: r.payment_date,
        mode: r.mode,
        status: r.status,
        contactId: asId(r.contact_id),
        contactName: r.contact_name,
        bankName: r.bank_name,
        reference: r.reference,
        amountPaise: toPaiseFromSql(r.amount),
        tdsPaise: toPaiseFromSql(r.tds_amount),
        bankChargesPaise: toPaiseFromSql(r.bank_charges),
        unappliedPaise: toPaiseFromSql(r.unapplied_amount),
        allocationCount: allocBy.get(r.id) ?? 0,
      })),
      summary: {
        count: Number(totals?.count ?? 0),
        totalPaise: toPaiseFromSql(totals?.total ?? '0'),
        unappliedPaise: toPaiseFromSql(totals?.unapplied ?? '0'),
      },
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const CreateInput = z.object({
  kind: z.enum(['received', 'made']),
  branchId: z.string(),
  contactId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other']),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  bankAccountId: z.string(),
  reference: z.string().nullish(),
  tdsPaise: z.number().int().nonnegative().optional(),
  bankChargesPaise: z.number().int().nonnegative().optional(),
  notes: z.string().nullish(),
  allocations: z
    .array(
      z.object({
        targetType: z.enum(['invoice', 'bill', 'credit_note', 'vendor_credit', 'retainer', 'opening']),
        targetId: z.string(),
        // Worked out from the foreign amount when the payment is in another currency.
        amountPaise: z.number().int().nonnegative(),
        foreignAmountPaise: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  /** An advance for services: GST on what is left unapplied is due now. */
  advanceGst: z.object({
    ratePct: z.number().positive().max(40),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
  }).optional(),
  /** Received or paid in another currency; amountPaise is then the rupees in the bank. */
  fx: z.object({
    currency: z.string().trim().toUpperCase().length(3),
    rate: z.number().positive(),
    foreignAmountPaise: z.number().int().positive(),
  }).optional(),
});

/** Receipts belong to sales and payments made to purchases. */
function allowKind(role: Parameters<typeof hasPermission>[0], kind: 'received' | 'made', action: 'create' | 'edit') {
  const area = kind === 'received' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, action)) {
    throw forbidden(`Your role (${role}) cannot ${action === 'create' ? 'record' : 'change'} ${kind === 'received' ? 'receipts' : 'payments to vendors'}.`);
  }
}

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, CreateInput);
    allowKind(role, input.kind, 'create');
    if (input.advanceGst && input.kind !== 'received') {
      throw badRequest('GST on an advance applies to money received for services, not to payments made.');
    }

    // Which documents each kind of payment may settle, and that they belong to
    // the same party, is checked by the service, for every caller.
    const payload = {
      branchId: Number(input.branchId),
      contactId: Number(input.contactId),
      date: input.date,
      mode: input.mode,
      amountPaise: input.amountPaise,
      bankAccountId: Number(input.bankAccountId),
      reference: input.reference,
      tdsPaise: input.tdsPaise,
      bankChargesPaise: input.bankChargesPaise,
      notes: input.notes,
      allocations: (input.allocations ?? []).map((a) => ({
        targetType: a.targetType,
        targetId: Number(a.targetId),
        amountPaise: a.amountPaise,
        foreignAmountPaise: a.foreignAmountPaise,
      })),
      advanceGst: input.advanceGst ?? null,
      fx: input.fx ?? null,
    };

    const created = await transaction(async (trx) =>
      input.kind === 'received'
        ? receivePayment(trx, orgId, user.userId, payload)
        : makePayment(trx, orgId, user.userId, payload),
    );

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: input.kind === 'received' ? 'payment_received' : 'payment_made',
      targetId: created.id,
      targetLabel: created.number,
      detail: `${input.kind === 'received' ? 'Received' : 'Paid'} ${(input.amountPaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });

    return {
      id: asId(created.id),
      number: created.number,
      unappliedPaise: created.unappliedPaise,
      journalEntryId: asId(created.journalEntryId),
      warnings: created.warnings ?? [],
    };
  },
);

// ── Applying an advance later, and undoing an application ───────────────────

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    paymentId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
    allocations: z.array(z.object({
      targetType: z.enum(['invoice', 'bill', 'retainer', 'opening']),
      targetId: z.string(),
      amountPaise: z.number().int().nonnegative(),
      foreignAmountPaise: z.number().int().positive().optional(),
    })).min(1, 'Choose at least one document.'),
  }),
  z.object({ action: z.literal('unapply'), allocationId: z.string() }),
  // A payment entered by mistake. It keeps its number and the reason; its
  // entry is reversed and whatever it settled is owed again.
  z.object({
    action: z.literal('void'),
    paymentId: z.string(),
    reason: z.string().trim().min(3, 'Say why it is being voided.').max(200),
  }),
]);

export const PATCH = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, ActionInput);

  if (input.action === 'void') {
    const paymentId = Number(input.paymentId);
    const p = await db.selectFrom('payments').select(['kind', 'number'])
      .where('id', '=', paymentId).where('org_id', '=', orgId).executeTakeFirst();
    if (!p) throw badRequest('That payment does not exist.');
    const area = p.kind === 'received' ? 'sales' : 'purchases';
    if (!hasPermission(role, area, 'void')) throw forbidden(`Your role (${role}) cannot void ${p.kind === 'received' ? 'receipts' : 'payments'}.`);

    await transaction(async (trx) => {
      const cheque = await trx.selectFrom('cheques').select(['cheque_no', 'status'])
        .where('org_id', '=', orgId).where('payment_id', '=', paymentId).executeTakeFirst();
      if (cheque && cheque.status !== 'bounced') {
        throw badRequest(
          `${p.number} was paid by cheque ${cheque.cheque_no}. If the bank returned it, mark the cheque returned ` +
            'in the cheque register: that reverses this payment and posts the bank charge in one go.',
        );
      }
      await voidPayment(trx, orgId, user.userId, paymentId, input.reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: p.kind === 'received' ? 'payment_received' : 'payment_made', targetId: paymentId, targetLabel: p.number,
        detail: `Voided ${p.number}: ${input.reason}`, ...auditMeta(req),
      });
    });
    return { ok: true };
  }

  if (input.action === 'apply') {
    const paymentId = Number(input.paymentId);
    const p = await db.selectFrom('payments').select(['kind', 'number'])
      .where('id', '=', paymentId).where('org_id', '=', orgId).executeTakeFirst();
    if (!p) throw badRequest('That payment does not exist.');
    allowKind(role, p.kind, 'edit');

    const result = await transaction(async (trx) => {
      const r = await applyPayment(trx, orgId, user.userId, paymentId, {
        date: input.date,
        allocations: input.allocations.map((a) => ({ ...a, targetId: Number(a.targetId) })),
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: p.kind === 'received' ? 'payment_received' : 'payment_made', targetId: paymentId, targetLabel: p.number,
        detail: `Applied ${(input.allocations.reduce((t, a) => t + a.amountPaise, 0) / 100).toFixed(2)} of ${p.number} ` +
          `to ${input.allocations.length} document(s)`,
        payload: input.allocations, ...auditMeta(req),
      });
      return r;
    });
    return { unappliedPaise: result.unappliedPaise, allocationIds: result.allocationIds.map(asId) };
  }

  const allocationId = Number(input.allocationId);
  const a = await db.selectFrom('payment_allocations')
    .innerJoin('payments', 'payments.id', 'payment_allocations.payment_id')
    .select(['payments.kind', 'payments.number', 'payments.id as payment_id', 'payment_allocations.amount',
      'payment_allocations.target_type', 'payment_allocations.target_id'])
    .where('payment_allocations.id', '=', allocationId).where('payment_allocations.org_id', '=', orgId)
    .executeTakeFirst();
  if (!a) throw badRequest('That application was not found.');
  allowKind(role, a.kind, 'edit');

  const result = await transaction(async (trx) => {
    const r = await unapplyAllocation(trx, orgId, user.userId, allocationId);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: a.kind === 'received' ? 'payment_received' : 'payment_made', targetId: a.payment_id, targetLabel: a.number,
      detail: `Undid ${(toPaiseFromSql(a.amount) / 100).toFixed(2)} of ${a.number} applied to ${a.target_type} ${a.target_id}`,
      ...auditMeta(req),
    });
    return r;
  });
  return { unappliedPaise: result.unappliedPaise };
});
