import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, idParam, asId, notFound } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { unseal } from '@/lib/server/crypto/fields';
import { vendorFyTaxable } from '@/lib/server/services/purchases';

/**
 * One party, with the running story of its account.
 *
 * Invoices, bills and receipts come back together because a contact page is
 * useless without them, and three requests to build one screen is three chances
 * for the figures to disagree by the time they all land.
 */
export const GET = route(
  async ({ orgId, params, req }) => {
    const id = idParam(params);
    // A form that only needs a figure should not pull six hundred documents to
    // get it. `summary=1` returns the totals and nothing else.
    const summaryOnly = new URL(req.url).searchParams.get('summary') === '1';

    const c = await db
      .selectFrom('contacts')
      .selectAll()
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!c) throw notFound('That contact does not exist.');

    if (summaryOnly) {
      // Year-to-date taxable billing drives TDS, and the threshold is annual —
      // so the figure a form needs is the running total, not this bill alone.
      const today = new Date().toISOString().slice(0, 10);
      const [ar, ap, fyTaxable] = await Promise.all([
        db.selectFrom('invoices')
          .select(sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('v'))
          .where('org_id', '=', orgId).where('customer_id', '=', id)
          .where('status', 'not in', ['draft', 'void']).executeTakeFirst(),
        db.selectFrom('bills')
          .select(sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('v'))
          .where('org_id', '=', orgId).where('vendor_id', '=', id)
          .where('status', 'not in', ['draft', 'void']).executeTakeFirst(),
        db.transaction().execute((trx) => vendorFyTaxable(trx, orgId, id, today)),
      ]);

      return {
        contact: {
          id: asId(c.id),
          displayName: c.display_name,
          gstin: c.gstin,
          pan: c.pan,
          gstTreatment: c.gst_treatment,
          stateCode: c.state_code,
          isMsme: !!c.is_msme,
          tdsSection: c.tds_section,
          paymentTerms: c.payment_terms,
        },
        summary: {
          receivablePaise: toPaiseFromSql(ar?.v ?? '0'),
          payablePaise: toPaiseFromSql(ap?.v ?? '0'),
          fyTaxablePaise: fyTaxable,
        },
      };
    }

    const [invoices, bills, payments] = await Promise.all([
      db
        .selectFrom('invoices')
        .select([
          'id', 'number', 'invoice_date', 'due_date', 'status',
          'subtotal', 'total', 'amount_paid',
        ])
        .where('org_id', '=', orgId)
        .where('customer_id', '=', id)
        .orderBy('invoice_date', 'desc')
        .orderBy('id', 'desc')
        .limit(200)
        .execute(),
      db
        .selectFrom('bills')
        .select([
          'id', 'internal_no', 'vendor_invoice_no', 'bill_date', 'due_date', 'status',
          'subtotal', 'total', 'amount_paid',
        ])
        .where('org_id', '=', orgId)
        .where('vendor_id', '=', id)
        .orderBy('bill_date', 'desc')
        .orderBy('id', 'desc')
        .limit(200)
        .execute(),
      db
        .selectFrom('payments')
        .leftJoin('bank_accounts', 'bank_accounts.id', 'payments.bank_account_id')
        .select([
          'payments.id', 'payments.number', 'payments.kind', 'payments.payment_date',
          'payments.mode', 'payments.status', 'payments.amount', 'payments.tds_amount',
          'payments.unapplied_amount', 'payments.reference', 'bank_accounts.name as bank_name',
        ])
        .where('payments.org_id', '=', orgId)
        .where('payments.contact_id', '=', id)
        .orderBy('payments.payment_date', 'desc')
        .orderBy('payments.id', 'desc')
        .limit(200)
        .execute(),
    ]);

    const open = (status: string) => status !== 'draft' && status !== 'void';
    const sumBalance = (rows: { status: string; total: string; amount_paid: string }[]) =>
      rows.filter((r) => open(r.status))
        .reduce((t, r) => t + toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid), 0);

    return {
      contact: {
        id: asId(c.id),
        kind: c.kind,
        displayName: c.display_name,
        legalName: c.legal_name,
        gstin: c.gstin,
        pan: c.pan,
        gstTreatment: c.gst_treatment,
        stateCode: c.state_code,
        email: c.email,
        phone: c.phone,
        paymentTerms: c.payment_terms,
        creditLimitPaise: toPaiseFromSql(c.credit_limit),
        isMsme: !!c.is_msme,
        msmeUdyamNo: c.msme_udyam_no,
        msmeCategory: c.msme_category,
        msmeActivity: c.msme_activity,
        msmeAgreementDays: c.msme_agreement_days,
        bankAccountName: c.bank_account_name,
        bankAccountNo: unseal(c.bank_account_no),
        updatedAt: new Date(c.updated_at).toISOString(),
        bankIfsc: c.bank_ifsc,
        currency: c.currency,
        priceListId: c.price_list_id ? String(c.price_list_id) : null,
        bankName: c.bank_name,
        tdsApplicable: !!c.tds_applicable,
        tdsSection: c.tds_section,
        billingAddress: c.billing_address,
        shippingAddress: c.shipping_address,
        notes: c.notes,
        isArchived: !!c.is_archived,
      },
      invoices: invoices.map((i) => ({
        id: asId(i.id),
        number: i.number,
        date: i.invoice_date,
        dueDate: i.due_date,
        status: i.status,
        subtotalPaise: toPaiseFromSql(i.subtotal),
        totalPaise: toPaiseFromSql(i.total),
        amountPaidPaise: toPaiseFromSql(i.amount_paid),
        // A void invoice owes nothing whatever its total says.
        balancePaise: i.status === 'void' ? 0 : toPaiseFromSql(i.total) - toPaiseFromSql(i.amount_paid),
      })),
      bills: bills.map((b) => ({
        id: asId(b.id),
        number: b.internal_no,
        vendorInvoiceNo: b.vendor_invoice_no,
        date: b.bill_date,
        dueDate: b.due_date,
        status: b.status,
        subtotalPaise: toPaiseFromSql(b.subtotal),
        totalPaise: toPaiseFromSql(b.total),
        amountPaidPaise: toPaiseFromSql(b.amount_paid),
        balancePaise: b.status === 'void' ? 0 : toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid),
      })),
      payments: payments.map((p) => ({
        id: asId(p.id),
        number: p.number,
        kind: p.kind,
        date: p.payment_date,
        mode: p.mode,
        status: p.status,
        reference: p.reference,
        bankName: p.bank_name ?? '—',
        amountPaise: toPaiseFromSql(p.amount),
        tdsPaise: toPaiseFromSql(p.tds_amount),
        unappliedPaise: toPaiseFromSql(p.unapplied_amount),
      })),
      summary: {
        // Voids excluded: a cancelled document was never billed.
        invoicedPaise: invoices.filter((i) => i.status !== 'void')
          .reduce((t, i) => t + toPaiseFromSql(i.total), 0),
        billedPaise: bills.filter((b) => b.status !== 'void')
          .reduce((t, b) => t + toPaiseFromSql(b.total), 0),
        receivablePaise: sumBalance(invoices),
        payablePaise: sumBalance(bills),
        // Cash actually collected includes the tax the customer withheld: they
        // paid it, just to the government rather than to us.
        receivedPaise: payments
          .filter((p) => p.kind === 'received' && p.status !== 'void')
          .reduce((t, p) => t + toPaiseFromSql(p.amount) + toPaiseFromSql(p.tds_amount), 0),
        paidPaise: payments
          .filter((p) => p.kind === 'made' && p.status !== 'void')
          .reduce((t, p) => t + toPaiseFromSql(p.amount), 0),
      },
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);
