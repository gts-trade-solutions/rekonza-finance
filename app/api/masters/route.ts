import { db } from '@/lib/server/db';
import { route, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { peekNumber, peekOrgNumber } from '@/lib/server/ledger/posting';
import { fyLabelFor } from '@/lib/server/services/sales';
import { hsnRateHistory } from '@/lib/server/tax/rates';

/**
 * Everything a document form needs to render, in one request.
 *
 * The invoice form needs customers, items, HSN codes, branches, salespeople and
 * the next invoice number. Six round trips before the user can type anything is
 * a form that feels slow on a phone; these are all small, rarely-changing lists,
 * so they travel together.
 */
export const GET = route(
  async ({ orgId, user, req }) => {
    const url = new URL(req.url);
    const forDate = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
    const branchId = Number(url.searchParams.get('branchId') || user.activeBranchId || 0);

    const rateHistory = await hsnRateHistory(db, orgId);
    const [org, contacts, items, hsnCodes, branches, users, accounts, bankAccounts, grants] = await Promise.all([
      db.selectFrom('organizations').selectAll().where('id', '=', orgId).executeTakeFirst(),
      db
        .selectFrom('contacts')
        .select([
          'id', 'kind', 'display_name', 'gstin', 'pan', 'gst_treatment', 'state_code',
          'email', 'phone', 'payment_terms', 'is_msme', 'tds_section', 'billing_address', 'currency', 'bill_wise',
        ])
        .where('org_id', '=', orgId)
        .where('is_archived', '=', 0)
        .orderBy('display_name')
        .execute(),
      db
        .selectFrom('items')
        .select([
          'id', 'kind', 'name', 'sku', 'hsn_sac', 'uqc', 'sale_price',
          'purchase_price', 'gst_rate_pct', 'tax_pref', 'track_inventory', 'track_batches', 'track_serials', 'alt_uqc', 'alt_factor', 'mrp',
        ])
        .where('org_id', '=', orgId)
        .where('is_archived', '=', 0)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('hsn_codes')
        .select(['id', 'code', 'kind', 'description', 'gst_rate_pct', 'cess_rate_pct', 'uqc', 'is_active'])
        .where('org_id', '=', orgId)
        .orderBy('code')
        .execute(),
      db
        .selectFrom('branches')
        .select(['id', 'name', 'gstin', 'state_code', 'address', 'city', 'pincode', 'is_primary'])
        .where('org_id', '=', orgId)
        .where('is_active', '=', 1)
        .orderBy('is_primary', 'desc')
        .execute(),
      db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'role', 'home_branch_id'])
        .where('org_id', '=', orgId)
        .where('is_active', '=', 1)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('accounts')
        .select(['id', 'code', 'name', 'type', 'subtype', 'is_system'])
        .where('org_id', '=', orgId)
        .where('is_active', '=', 1)
        .orderBy('code')
        .execute(),
      db
        .selectFrom('bank_accounts')
        .select([
          'id', 'kind', 'name', 'bank_name', 'account_last4', 'ifsc',
          'ledger_account_id', 'opening_balance', 'is_primary', 'feed_connected',
        ])
        .where('org_id', '=', orgId)
        .where('is_active', '=', 1)
        .orderBy('is_primary', 'desc')
        .execute(),
      // Which branches each user may raise documents for. Without this the
      // branch picker disappears for a multi-registration user, and every
      // document they raise silently defaults to their home GSTIN.
      db
        .selectFrom('user_branches')
        .innerJoin('users', 'users.id', 'user_branches.user_id')
        .select(['user_branches.user_id', 'user_branches.branch_id'])
        .where('users.org_id', '=', orgId)
        .execute(),
    ]);

    const branchesByUser = new Map<number, number[]>();
    for (const g of grants) {
      const list = branchesByUser.get(g.user_id) ?? [];
      list.push(g.branch_id);
      branchesByUser.set(g.user_id, list);
    }

    // Peeked, not allocated — showing a number in a form must not consume one,
    // or every abandoned draft leaves a gap in the series.
    // Invoices are numbered per branch — each GST registration keeps its own
    // series. Bills are numbered once for the organisation, because our
    // internal reference for a supplier's document is ours alone.
    const { nextInvoiceNumber, nextBillNumber } = await db.transaction().execute(async (trx) => ({
      nextInvoiceNumber: branchId
        ? await peekNumber(trx, orgId, branchId, 'INV', fyLabelFor(forDate), 'INV')
        : null,
      nextBillNumber: await peekOrgNumber(trx, orgId, 'BILL', fyLabelFor(forDate), 'BILL'),
    }));

    // The financial year the organisation is in on `forDate`. April-to-March,
    // read from the organisation rather than assumed, because the column exists
    // precisely so the calendar is data.
    const fyStartMonth = org?.fiscal_year_start_month ?? 4;
    const d = new Date(forDate);
    const fyStartYear = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
    // The last day of the year is the day before the next one starts, which is
    // the only definition that survives a non-April start month.
    const fyEnd = new Date(Date.UTC(fyStartYear + 1, fyStartMonth - 1, 1) - 86_400_000);

    return {
      org: org && {
        id: asId(org.id),
        name: org.name,
        legalName: org.legal_name,
        pan: org.pan,
        gstRegistrationType: org.gst_registration_type,
        aatoAbove5Cr: !!org.aato_above_5cr,
        fiscalYearLabel: `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`,
        fiscalYearStart: `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`,
        fiscalYearEnd: fyEnd.toISOString().slice(0, 10),
        baseCurrency: org.base_currency,
        address: org.address,
        email: org.email,
        phone: org.phone,
        isDemo: !!org.is_demo,
      },
      contacts: contacts.map((c) => ({
        id: asId(c.id),
        kind: c.kind,
        displayName: c.display_name,
        gstin: c.gstin,
        pan: c.pan,
        gstTreatment: c.gst_treatment,
        stateCode: c.state_code,
        email: c.email,
        phone: c.phone,
        paymentTerms: c.payment_terms,
        currency: c.currency,
        isMsme: !!c.is_msme,
        billWise: !!c.bill_wise,
        tdsSection: c.tds_section,
        billingAddress: c.billing_address,
      })),
      items: items.map((i) => ({
        id: asId(i.id),
        kind: i.kind,
        name: i.name,
        sku: i.sku,
        hsnSac: i.hsn_sac,
        uqc: i.uqc,
        salePricePaise: toPaiseFromSql(i.sale_price),
        purchasePricePaise: toPaiseFromSql(i.purchase_price),
        gstRatePct: Number(i.gst_rate_pct),
        taxPref: i.tax_pref,
        trackInventory: !!i.track_inventory,
        trackBatches: !!i.track_batches,
        trackSerials: !!i.track_serials,
        altUqc: i.alt_uqc,
        altFactor: i.alt_factor === null ? null : Number(i.alt_factor),
        mrpPaise: i.mrp === null ? null : toPaiseFromSql(i.mrp),
      })),
      // Dated rates travel with each code, so a form can pick the rate in
      // force on the document's own date rather than today's.
      hsnCodes: hsnCodes.map((h) => ({
        id: asId(h.id),
        code: h.code,
        kind: h.kind,
        description: h.description,
        gstRatePct: Number(h.gst_rate_pct),
        cessRatePct: Number(h.cess_rate_pct),
        rates: rateHistory.get(h.code) ?? [],
        uqc: h.uqc,
        isActive: !!h.is_active,
      })),
      branches: branches.map((b) => ({
        id: asId(b.id),
        name: b.name,
        gstin: b.gstin,
        stateCode: b.state_code,
        address: b.address,
        city: b.city,
        pincode: b.pincode,
        isPrimary: !!b.is_primary,
      })),
      users: users.map((u) => ({
        id: asId(u.id),
        name: u.name,
        email: u.email,
        role: u.role,
        branchId: u.home_branch_id ? asId(u.home_branch_id) : null,
        // No explicit grants means the home branch only.
        branchAccess: (branchesByUser.get(u.id) ?? (u.home_branch_id ? [u.home_branch_id] : []))
          .map(asId),
      })),
      accounts: accounts.map((a) => ({
        id: asId(a.id),
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        isSystem: !!a.is_system,
      })),
      bankAccounts: bankAccounts.map((b) => ({
        id: asId(b.id),
        kind: b.kind,
        name: b.name,
        bankName: b.bank_name,
        accountLast4: b.account_last4,
        ifsc: b.ifsc,
        ledgerAccountId: asId(b.ledger_account_id),
        openingBalancePaise: toPaiseFromSql(b.opening_balance),
        isPrimary: !!b.is_primary,
        feedConnected: !!b.feed_connected,
      })),
      nextInvoiceNumber,
      nextBillNumber,
      // What a new invoice starts with; set in Settings → Invoice print.
      invoiceDefaults: { terms: org?.default_invoice_terms ?? null, notes: org?.default_invoice_notes ?? null },
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);
