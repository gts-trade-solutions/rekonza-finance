import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { PaymentInput, toPaymentInput } from '@/lib/server/payment-input';
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
      .innerJoin('branches', 'branches.id', 'payments.branch_id')
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
          'bank_accounts.name as bank_name', 'branches.name as branch_name', 'payments.advance_gst',
          'payments.created_at', 'payments.updated_at',
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
    // Zoho's INVOICE# and TYPE columns: the documents each receipt settled, by number.
    const settled = ids.length
      ? await db.selectFrom('payment_allocations as pa')
          .leftJoin('invoices as i', (j) => j.onRef('i.id', '=', 'pa.target_id').on('pa.target_type', '=', 'invoice'))
          .leftJoin('bills as b', (j) => j.onRef('b.id', '=', 'pa.target_id').on('pa.target_type', '=', 'bill'))
          .leftJoin('retainer_invoices as r', (j) => j.onRef('r.id', '=', 'pa.target_id').on('pa.target_type', '=', 'retainer'))
          .select(['pa.payment_id', 'pa.target_type', 'i.number as inv', 'b.vendor_invoice_no as bill', 'b.internal_no as bill_no', 'r.number as ret'])
          .where('pa.payment_id', 'in', ids).orderBy('pa.id').execute()
      : [];
    const docsBy = new Map<number, { numbers: string[]; retainer: boolean }>();
    for (const d of settled) {
      const e = docsBy.get(d.payment_id) ?? { numbers: [], retainer: false };
      const n = d.inv ?? d.bill ?? d.bill_no ?? d.ret;
      if (n) e.numbers.push(n);
      if (d.target_type === 'retainer') e.retainer = true;
      docsBy.set(d.payment_id, e);
    }
    const typeOf = (r: { id: number; advance_gst: number }) => {
      const d = docsBy.get(r.id);
      if (d?.retainer) return 'Retainer Payment';
      if (!d?.numbers.length || r.advance_gst) return 'Customer Advance';
      return 'Invoice Payment';
    };

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
        branchName: r.branch_name,
        type: typeOf(r),
        documentNumbers: docsBy.get(r.id)?.numbers ?? [],
        reference: r.reference,
        amountPaise: toPaiseFromSql(r.amount),
        tdsPaise: toPaiseFromSql(r.tds_amount),
        bankChargesPaise: toPaiseFromSql(r.bank_charges),
        unappliedPaise: toPaiseFromSql(r.unapplied_amount),
        allocationCount: allocBy.get(r.id) ?? 0,
        // Zoho's Sort by → Created Time / Last Modified Time.
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
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

/** Receipts belong to sales and payments made to purchases. */
function allowKind(role: Parameters<typeof hasPermission>[0], kind: 'received' | 'made', action: 'create' | 'edit') {
  const area = kind === 'received' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, action)) {
    throw forbidden(`Your role (${role}) cannot ${action === 'create' ? 'record' : 'change'} ${kind === 'received' ? 'receipts' : 'payments to vendors'}.`);
  }
}

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, PaymentInput);
    allowKind(role, input.kind, 'create');
    if (input.advanceGst && input.kind !== 'received') {
      throw badRequest('GST on an advance applies to money received for services, not to payments made.');
    }

    // Which documents each kind of payment may settle, and that they belong to
    // the same party, is checked by the service, for every caller.
    const payload = toPaymentInput(input);

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
