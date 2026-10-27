import { db } from '@/lib/server/db';
import { route, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { hasPermission } from '@/lib/rbac';

// ─────────────────────────────────────────────────────────────────────────────
// Global search.
//
// Contacts and items are already in the client's store, so this endpoint only
// returns what is not: documents. They live in the database, there can be tens
// of thousands of them, and the browser has never held more than the page it
// was looking at.
//
// Each document type is capped at eight hits. Search is for jumping to a known
// document, not for listing — anyone who wants the full set wants a filtered
// list page, which is a different screen with a different shape.
//
// The role check matters here. A salesperson who cannot open the purchases
// module must not be able to read a supplier's invoice totals by typing a
// vendor's name into the search box.
// ─────────────────────────────────────────────────────────────────────────────

const PER_TYPE = 8;

export const GET = route(async ({ orgId, role, req }) => {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();

  // Two characters is the shortest query worth a round trip; one character
  // matches most of the book and none of it usefully.
  if (q.length < 2) {
    return { invoices: [], bills: [], payments: [], expenses: [] };
  }

  const like = `%${q}%`;
  const canSales = hasPermission(role, 'sales', 'view');
  const canPurchases = hasPermission(role, 'purchases', 'view');

  const [invoices, bills, payments, expenses] = await Promise.all([
    canSales
      ? db
          .selectFrom('invoices')
          .innerJoin('contacts', 'contacts.id', 'invoices.customer_id')
          .select([
            'invoices.id', 'invoices.number', 'invoices.invoice_date',
            'invoices.total', 'invoices.status', 'contacts.display_name',
          ])
          .where('invoices.org_id', '=', orgId)
          .where((eb) =>
            eb.or([eb('invoices.number', 'like', like), eb('contacts.display_name', 'like', like)]),
          )
          .orderBy('invoices.invoice_date', 'desc')
          .limit(PER_TYPE)
          .execute()
      : [],

    canPurchases
      ? db
          .selectFrom('bills')
          .innerJoin('contacts', 'contacts.id', 'bills.vendor_id')
          .select([
            'bills.id', 'bills.internal_no', 'bills.vendor_invoice_no', 'bills.bill_date',
            'bills.total', 'bills.status', 'contacts.display_name',
          ])
          .where('bills.org_id', '=', orgId)
          .where((eb) =>
            eb.or([
              eb('bills.internal_no', 'like', like),
              eb('bills.vendor_invoice_no', 'like', like),
              eb('contacts.display_name', 'like', like),
            ]),
          )
          .orderBy('bills.bill_date', 'desc')
          .limit(PER_TYPE)
          .execute()
      : [],

    canSales || canPurchases
      ? db
          .selectFrom('payments')
          .leftJoin('contacts', 'contacts.id', 'payments.contact_id')
          .select([
            'payments.id', 'payments.number', 'payments.kind', 'payments.payment_date',
            'payments.amount', 'payments.reference', 'contacts.display_name',
          ])
          .where('payments.org_id', '=', orgId)
          .where((eb) =>
            eb.or([
              eb('payments.number', 'like', like),
              eb('payments.reference', 'like', like),
              eb('contacts.display_name', 'like', like),
            ]),
          )
          // A payment run and a receipt are different modules; the ones the
          // caller may not see are filtered out rather than hidden in the UI.
          .where('payments.kind', 'in', [
            ...(canSales ? (['received'] as const) : []),
            ...(canPurchases ? (['made'] as const) : []),
          ])
          .orderBy('payments.payment_date', 'desc')
          .limit(PER_TYPE)
          .execute()
      : [],

    canPurchases
      ? db
          .selectFrom('expenses')
          .leftJoin('contacts', 'contacts.id', 'expenses.vendor_id')
          .select([
            'expenses.id', 'expenses.number', 'expenses.expense_date',
            'expenses.total', 'expenses.notes', 'contacts.display_name',
          ])
          .where('expenses.org_id', '=', orgId)
          .where((eb) =>
            eb.or([
              eb('expenses.number', 'like', like),
              eb('expenses.notes', 'like', like),
              eb('contacts.display_name', 'like', like),
            ]),
          )
          .orderBy('expenses.expense_date', 'desc')
          .limit(PER_TYPE)
          .execute()
      : [],
  ]);

  return {
    invoices: invoices.map((r) => ({
      id: asId(r.id),
      number: r.number,
      party: r.display_name,
      date: String(r.invoice_date).slice(0, 10),
      totalPaise: toPaiseFromSql(r.total),
      status: r.status,
    })),
    bills: bills.map((r) => ({
      id: asId(r.id),
      number: r.internal_no,
      vendorNumber: r.vendor_invoice_no,
      party: r.display_name,
      date: String(r.bill_date).slice(0, 10),
      totalPaise: toPaiseFromSql(r.total),
      status: r.status,
    })),
    payments: payments.map((r) => ({
      id: asId(r.id),
      number: r.number,
      kind: r.kind,
      party: r.display_name ?? 'On account',
      date: String(r.payment_date).slice(0, 10),
      totalPaise: toPaiseFromSql(r.amount),
      reference: r.reference,
    })),
    expenses: expenses.map((r) => ({
      id: asId(r.id),
      number: r.number,
      party: r.display_name ?? 'Direct expense',
      date: String(r.expense_date).slice(0, 10),
      totalPaise: toPaiseFromSql(r.total),
      notes: r.notes,
    })),
  };
});
