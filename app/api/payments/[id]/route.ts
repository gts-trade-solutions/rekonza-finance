import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, idParam, asId, notFound, forbidden } from '@/lib/server/http';
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
      'contacts.display_name as contact_name',
    ])
    .where('payments.id', '=', id).where('payments.org_id', '=', orgId)
    .executeTakeFirst();
  if (!p) throw notFound('Payment not found.');
  if (!hasPermission(role, p.kind === 'received' ? 'sales' : 'purchases', 'view')) throw forbidden('You cannot see this payment.');

  const allocations = await sql<{
    id: number; target_type: string; target_id: number; amount: string; applied_on: string | null; doc_number: string | null;
  }>`
    SELECT a.id, a.target_type, a.target_id, a.amount, a.applied_on,
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
  return {
    id: asId(p.id),
    number: p.number,
    kind: p.kind,
    date: String(p.payment_date).slice(0, 10),
    status: p.status,
    contactId: asId(p.contact_id),
    contactName: p.contact_name,
    amountPaise: toPaiseFromSql(p.amount),
    tdsPaise: toPaiseFromSql(p.tds_amount),
    unappliedPaise: toPaiseFromSql(p.unapplied_amount),
    advanceGst: p.advance_gst
      ? { ratePct: Number(p.advance_rate_pct), advancePaise: toPaiseFromSql(p.advance_amount), taxPaise: tax }
      : null,
    allocations: allocations.rows.map((a) => ({
      id: asId(a.id),
      targetType: a.target_type,
      targetId: asId(a.target_id),
      number: a.doc_number ?? `#${a.target_id}`,
      amountPaise: toPaiseFromSql(a.amount),
      appliedOn: a.applied_on ? String(a.applied_on).slice(0, 10) : null,
    })),
  };
});
