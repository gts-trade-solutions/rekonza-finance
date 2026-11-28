import { sql } from 'kysely';
import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, idParam, asId, notFound, forbidden, body, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deletePayment, deletePaymentRefund, paymentRefunds, refundPayment, updatePayment } from '@/lib/server/services/payments';
import { PaymentInput, toPaymentInput } from '@/lib/server/payment-input';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';

// One payment: what it was, and every document it has been applied to, with
// the date each was applied — which is what the Apply dialog shows and undoes.

export const GET = route(async ({ orgId, role, params }) => {
  const id = idParam(params);
  const p = await db
    .selectFrom('payments')
    .innerJoin('contacts', 'contacts.id', 'payments.contact_id')
    .select([
      'payments.id', 'payments.number', 'payments.kind', 'payments.payment_date', 'payments.amount',
      'payments.tds_amount', 'payments.unapplied_amount', 'payments.status', 'payments.contact_id',
      'payments.advance_gst', 'payments.advance_rate_pct', 'payments.advance_amount',
      'payments.advance_cgst', 'payments.advance_sgst', 'payments.advance_igst',
      'contacts.display_name as contact_name', 'contacts.legal_name as contact_legal_name',
      'payments.mode', 'payments.reference', 'payments.bank_account_id',
      'payments.bank_charges', 'payments.notes', 'payments.currency', 'payments.fc_amount', 'payments.branch_id',
      'payments.journal_entry_id',
    ])
    .where('payments.id', '=', id).where('payments.org_id', '=', orgId)
    .executeTakeFirst();
  if (!p) throw notFound('Payment not found.');
  if (!hasPermission(role, p.kind === 'received' ? 'sales' : 'purchases', 'view')) throw forbidden('You cannot see this payment.');

  const allocations = await sql<{
    id: number; target_type: string; target_id: number; amount: string; fc_amount: string | null; applied_on: string | null; doc_number: string | null; due_date: string | null;
  }>`
    SELECT a.id, a.target_type, a.target_id, a.amount, a.fc_amount, a.applied_on,
           CASE a.target_type
             WHEN 'invoice'  THEN (SELECT due_date FROM invoices WHERE id = a.target_id)
             WHEN 'bill'     THEN (SELECT due_date FROM bills WHERE id = a.target_id)
             WHEN 'opening'  THEN (SELECT due_date FROM opening_documents WHERE id = a.target_id)
           END AS due_date,
           CASE a.target_type
             WHEN 'invoice'  THEN (SELECT number FROM invoices WHERE id = a.target_id)
             WHEN 'bill'     THEN (SELECT COALESCE(vendor_invoice_no, internal_no) FROM bills WHERE id = a.target_id)
             WHEN 'retainer' THEN (SELECT number FROM retainer_invoices WHERE id = a.target_id)
             WHEN 'opening'  THEN (SELECT CONCAT('Opening ', ref_no) FROM opening_documents WHERE id = a.target_id)
           END AS doc_number
      FROM payment_allocations a
     WHERE a.payment_id = ${id}
     ORDER BY a.applied_on, a.id
  `.execute(db);

  const tax = toPaiseFromSql(p.advance_cgst) + toPaiseFromSql(p.advance_sgst) + toPaiseFromSql(p.advance_igst);
  // The record's View Journal and its refunds (Zoho's payment record).
  const journalLines = p.journal_entry_id
    ? await db.selectFrom('journal_lines as jl').innerJoin('accounts as a', 'a.id', 'jl.account_id')
        .select(['jl.line_no', 'a.code', 'a.name', 'jl.debit', 'jl.credit']).where('jl.entry_id', '=', p.journal_entry_id).orderBy('jl.line_no').execute()
    : [];
  const refunds = await paymentRefunds(db, orgId, id);
  return {
    id: asId(p.id),
    number: p.number,
    kind: p.kind,
    date: String(p.payment_date).slice(0, 10),
    status: p.status,
    contactId: asId(p.contact_id),
    contactName: p.contact_name,
    /** The name a cheque is written to. */
    payeeName: p.contact_legal_name || p.contact_name,
    mode: p.mode,
    reference: p.reference,
    /** What the Edit form needs to show it as saved. */
    bankAccountId: p.bank_account_id ? asId(p.bank_account_id) : null,
    branchId: asId(p.branch_id),
    bankChargesPaise: toPaiseFromSql(p.bank_charges),
    notes: p.notes,
    currency: p.currency,
    fcAmountPaise: p.fc_amount == null ? null : toPaiseFromSql(p.fc_amount),
    bankName: p.bank_account_id ? (await db.selectFrom('bank_accounts').select('name').where('id', '=', p.bank_account_id).executeTakeFirst())?.name ?? null : null,
    amountPaise: toPaiseFromSql(p.amount),
    tdsPaise: toPaiseFromSql(p.tds_amount),
    unappliedPaise: toPaiseFromSql(p.unapplied_amount),
    advanceGst: p.advance_gst
      ? { ratePct: Number(p.advance_rate_pct), advancePaise: toPaiseFromSql(p.advance_amount), taxPaise: tax }
      : null,
    journalEntryId: p.journal_entry_id ? asId(p.journal_entry_id) : null,
    journalLines: journalLines.map((l) => ({ lineNo: l.line_no, accountCode: l.code, accountName: l.name, debitPaise: toPaiseFromSql(l.debit), creditPaise: toPaiseFromSql(l.credit) })),
    refunds: refunds.map((r) => ({ id: asId(r.entryId), date: r.date, amountPaise: r.amountPaise, memo: r.memo })),
    allocations: allocations.rows.map((a) => ({
      id: asId(a.id),
      targetType: a.target_type,
      targetId: asId(a.target_id),
      number: a.doc_number ?? `#${a.target_id}`,
      amountPaise: toPaiseFromSql(a.amount),
      foreignAmountPaise: a.fc_amount == null ? null : toPaiseFromSql(a.fc_amount),
      dueDate: a.due_date ? String(a.due_date).slice(0, 10) : null,
      appliedOn: a.applied_on ? String(a.applied_on).slice(0, 10) : null,
    })),
  };
});

/** Receipts belong to sales and payments made to purchases; the right to act is that area's. */
async function kindOf(orgId: number, id: number, role: Parameters<typeof hasPermission>[0], action: 'edit' | 'void') {
  const p = await db.selectFrom('payments').select(['kind']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('Payment not found.');
  if (!hasPermission(role, p.kind === 'received' ? 'sales' : 'purchases', action)) {
    throw forbidden(action === 'edit' ? 'Your role cannot change this payment.' : 'Your role cannot delete this payment.');
  }
  return p.kind;
}

/** Zoho's Edit on a payment: taken off what it paid, reversed, and recorded again in place. */
export const PUT = route(async ({ orgId, user, role, req, params }) => {
  const id = idParam(params);
  const input = await body(req, PaymentInput);
  const kind = await kindOf(orgId, id, role, 'edit');
  if (input.kind !== kind) throw badRequest('A receipt stays a receipt, and a payment made stays one.');
  const done = await transaction(async (trx) => {
    const made = await updatePayment(trx, orgId, user.userId, id, toPaymentInput(input));
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: kind === 'received' ? 'payment_received' : 'payment_made', targetId: id, targetLabel: made.number,
      detail: `Edited ${made.number}`, payload: { before: made.before, after: made.after }, ...auditMeta(req),
    });
    return made;
  });
  return { id: asId(done.id), number: done.number, unappliedPaise: done.unappliedPaise, journalEntryId: asId(done.journalEntryId), warnings: done.warnings ?? [] };
});

/** Zoho's Delete on a payment: what it paid is owed again; its entry is reversed. */
export const DELETE = route(async ({ orgId, user, role, req, params }) => {
  const id = idParam(params);
  const kind = await kindOf(orgId, id, role, 'void');
  const reason = new URL(req.url).searchParams.get('reason');
  const done = await transaction(async (trx) => {
    const gone = await deletePayment(trx, orgId, user.userId, id, reason);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
      targetType: kind === 'received' ? 'payment_received' : 'payment_made', targetId: id, targetLabel: gone.number,
      detail: `Deleted ${gone.number}`, ...auditMeta(req),
    });
    return gone;
  });
  return { deleted: true, number: done.number };
});

/**
 * Zoho's Refund on a payment: money given back from what it left unused
 * (services/payments.ts refundPayment), and deleting such a refund.
 */
const RefundInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('refund'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amountPaise: z.number().int().positive().optional(),
    bankAccountId: z.coerce.number().int().positive().nullish(), mode: z.string().max(30).nullish(), reference: z.string().max(100).nullish(),
  }),
  z.object({ action: z.literal('delete-refund'), refundId: z.coerce.number().int().positive() }),
]);

export const POST = route(async ({ orgId, user, role, req, params }) => {
  const id = idParam(params);
  const input = await body(req, RefundInput);
  const kind = await kindOf(orgId, id, role, input.action === 'refund' ? 'edit' : 'void');
  const area = kind === 'received' ? 'sales' : 'purchases';
  if (input.action === 'refund') {
    const r = await transaction((trx) => refundPayment(trx, orgId, user.userId, id, {
      date: input.date, amountPaise: input.amountPaise, bankAccountId: input.bankAccountId ?? null, mode: input.mode ?? null, reference: input.reference ?? null,
    }));
    await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'payment', targetId: id, detail: `Refunded ${(r.refundedPaise / 100).toFixed(2)} (${area})`, ...auditMeta(req) });
    return r;
  }
  const r = await transaction((trx) => deletePaymentRefund(trx, orgId, user.userId, id, input.refundId));
  await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'payment', targetId: id, detail: 'Refund deleted', ...auditMeta(req) });
  return r;
});
