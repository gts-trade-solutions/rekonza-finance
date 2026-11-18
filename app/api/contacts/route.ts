import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest, conflict, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { seal } from '@/lib/server/crypto/fields';
import { bankNumberFor, isMasked } from '@/lib/server/bank-mask';
import { joinSections, parseSections } from '@/lib/tax/tds';
import { assertFresh } from '@/lib/server/concurrency';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';
import { isValidGstin } from '@/lib/tax/gst';
import { ZOHO_COLUMNS, zohoFields } from '@/lib/server/services/contact-fields';
import { outstandingBeyondDocuments } from '@/lib/server/services/party-outstanding';
import { stockPosition } from '@/lib/server/reports/stock';
import { addOpeningDocument, booksStartDate } from '@/lib/server/services/opening-balances';

const ListQuery = z.object({
  kind: z.enum(['customer', 'vendor', 'both', 'all']).optional(),
  search: z.string().optional(),
  /** Include archived rows. Off by default — an archive is meant to hide. */
  archived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The contact list, with each party's outstanding balance.
 *
 * The balance is aggregated in SQL rather than derived on the client. A
 * customer list is one of the screens people leave open all day, and shipping
 * every invoice to the browser so it can add them up does not scale past the
 * first few hundred.
 */
export const GET = route(
  async ({ orgId, req, role }) => {
    const q = query(req, ListQuery);

    let base = db.selectFrom('contacts').where('org_id', '=', orgId);
    if (!q.archived) base = base.where('is_archived', '=', 0);
    if (q.kind && q.kind !== 'all') {
      // A contact marked "both" is a customer *and* a vendor, so it belongs in
      // either list. Filtering on equality alone would hide it from both.
      base = q.kind === 'both'
        ? base.where('kind', '=', 'both')
        : base.where('kind', 'in', [q.kind, 'both']);
    }
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) =>
        eb.or([
          eb('display_name', 'like', term),
          eb('gstin', 'like', term),
          eb('email', 'like', term),
          eb('phone', 'like', term),
        ]),
      );
    }

    const rows = await base
      .select([
        'id', 'kind', 'display_name', 'legal_name', 'gstin', 'pan', 'gst_treatment', 'state_code',
        'email', 'phone', 'payment_terms', 'credit_limit', 'owner_user_id', 'is_msme', 'msme_udyam_no',
        'msme_category', 'msme_activity', 'msme_agreement_days', 'bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_name', 'currency', 'price_list_id',
        'tds_applicable', 'tds_section', 'billing_address', 'shipping_address', 'notes', 'is_archived', 'updated_at', 'bill_wise',
        'constitution', 'gst_status', 'gst_registered_on', 'cin', 'incorporated_on', 'country', 'supplies',
        'contact_type', 'salutation', 'first_name', 'last_name', 'mobile', 'language', 'website', 'twitter', 'facebook', 'skype',
        'department', 'designation', 'tax_preference', 'tax_exemption_reason', 'created_at', 'opening_balance',
        'billing_attention', 'billing_street2', 'billing_city', 'billing_state', 'billing_pincode', 'billing_country', 'billing_phone', 'billing_fax',
        'shipping_attention', 'shipping_street2', 'shipping_city', 'shipping_state', 'shipping_pincode', 'shipping_country', 'shipping_phone', 'shipping_fax',
        'business_legal_name', 'business_trade_name', 'linked_contact_id',
      ])
      .orderBy('display_name')
      .limit(q.limit)
      .offset(q.offset)
      .execute();

    const ids = rows.map((r) => r.id);

    // Receivable and payable per party, straight off the documents. Drafts and
    // voids are excluded: neither is a debt.
    const [receivable, payable] = ids.length
      ? await Promise.all([
          db
            .selectFrom('invoices')
            .select([
              'customer_id as id',
              sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('due'),
              sql<string>`COUNT(*)`.as('n'),
            ])
            .where('org_id', '=', orgId)
            .where('customer_id', 'in', ids)
            .where('status', 'not in', ['draft', 'void'])
            .groupBy('customer_id')
            .execute(),
          db
            .selectFrom('bills')
            .select([
              'vendor_id as id',
              sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('due'),
              sql<string>`COUNT(*)`.as('n'),
            ])
            .where('org_id', '=', orgId)
            .where('vendor_id', 'in', ids)
            .where('status', 'not in', ['draft', 'void'])
            .groupBy('vendor_id')
            .execute(),
        ])
      : [[], []];

    const arBy = new Map(receivable.map((r) => [r.id, r]));
    const apBy = new Map(payable.map((r) => [r.id, r]));

    // Zoho's "Unused Credits": money a party has paid or been credited that no
    // document has taken yet (an advance, a credit note or vendor credit still
    // open). Overdue: an issued invoice or bill past its due date and unpaid.
    // Portal: a customer's portal link that is neither revoked nor expired.
    const today = new Date().toISOString().slice(0, 10);
    const [unusedPay, unusedCn, unusedVc, overdueAr, overdueAp, portal] = ids.length
      ? await Promise.all([
          db.selectFrom('payments').select(['contact_id as id', 'kind', sql<string>`COALESCE(SUM(unapplied_amount), 0)`.as('amt')])
            .where('org_id', '=', orgId).where('contact_id', 'in', ids).where('status', '<>', 'void').groupBy(['contact_id', 'kind']).execute(),
          db.selectFrom('credit_notes').select(['customer_id as id', sql<string>`COALESCE(SUM(total - applied_amount), 0)`.as('amt')])
            .where('org_id', '=', orgId).where('customer_id', 'in', ids).where('status', '=', 'open').groupBy('customer_id').execute(),
          db.selectFrom('vendor_credits').select(['vendor_id as id', sql<string>`COALESCE(SUM(total - applied_amount), 0)`.as('amt')])
            .where('org_id', '=', orgId).where('vendor_id', 'in', ids).where('status', '=', 'open').groupBy('vendor_id').execute(),
          db.selectFrom('invoices').select('customer_id as id').distinct()
            .where('org_id', '=', orgId).where('customer_id', 'in', ids).where('status', 'not in', ['draft', 'void'])
            .where('due_date', '<', today).where(sql<boolean>`total > amount_paid`).execute(),
          db.selectFrom('bills').select('vendor_id as id').distinct()
            .where('org_id', '=', orgId).where('vendor_id', 'in', ids).where('status', 'not in', ['draft', 'void'])
            .where('due_date', '<', today).where(sql<boolean>`total > amount_paid`).execute(),
          db.selectFrom('portal_access').select('contact_id as id').distinct()
            .where('org_id', '=', orgId).where('contact_id', 'in', ids).where('side', '=', 'customer')
            .where('revoked_at', 'is', null).where('expires_at', '>', new Date()).execute(),
        ])
      : [[], [], [], [], [], []];
    const payUnused = new Map(unusedPay.map((r) => [`${r.id}:${r.kind}`, toPaiseFromSql(r.amt)]));
    const cnUnused = new Map(unusedCn.map((r) => [r.id, toPaiseFromSql(r.amt)]));
    const vcUnused = new Map(unusedVc.map((r) => [r.id, toPaiseFromSql(r.amt)]));
    const overdueC = new Set(overdueAr.map((r) => r.id));
    const overdueV = new Set(overdueAp.map((r) => r.id));
    const portalOn = new Set(portal.map((r) => r.id));
    // Zoho's "Duplicate Customers": the same GSTIN, the same PAN, or the same name in letters and digits.
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const count = (vals: (string | null)[]) => vals.reduce((m, v) => (v ? m.set(v, (m.get(v) ?? 0) + 1) : m), new Map<string, number>());
    const byGstin = count(rows.map((r) => r.gstin));
    const byPan = count(rows.map((r) => r.pan));
    const byName = count(rows.map((r) => key(r.display_name)));
    const duplicate = (r: (typeof rows)[number]) => (r.gstin && byGstin.get(r.gstin)! > 1) || (r.pan && byPan.get(r.pan)! > 1) || byName.get(key(r.display_name))! > 1;
    // Opening bills and journals (a Tally import's vouchers among them) owe too.
    const beyond = await outstandingBeyondDocuments(db, orgId, ids);
    // Zoho's "Vendors - Reorder Items": a vendor that is the preferred vendor of
    // an item at or below its reorder level. Worked out for a vendor list only.
    const reorderVendors = new Set<number>();
    if (q.kind === 'vendor' && ids.length) {
      const watched = await db.selectFrom('items').select(['id', 'preferred_vendor_id', 'reorder_level'])
        .where('org_id', '=', orgId).where('preferred_vendor_id', 'in', ids).where('reorder_level', 'is not', null).where('is_archived', '=', 0).execute();
      if (watched.length) {
        const position = await stockPosition(db, orgId, new Date().toISOString().slice(0, 10));
        const qty = new Map(position.lines.map((l) => [l.itemId, l.qty]));
        for (const w of watched) if ((qty.get(String(w.id)) ?? 0) <= Number(w.reorder_level)) reorderVendors.add(Number(w.preferred_vendor_id));
      }
    }

    return {
      contacts: rows.map((c) => ({
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
        ownerUserId: c.owner_user_id ? asId(c.owner_user_id) : null,
        billWise: !!c.bill_wise,
        isMsme: !!c.is_msme,
        msmeUdyamNo: c.msme_udyam_no,
        msmeCategory: c.msme_category,
        msmeActivity: c.msme_activity,
        msmeAgreementDays: c.msme_agreement_days,
        bankAccountName: c.bank_account_name,
        bankAccountNo: bankNumberFor(role, c.bank_account_no),
        bankIfsc: c.bank_ifsc,
        updatedAt: new Date(c.updated_at).toISOString(),
        currency: c.currency,
        priceListId: c.price_list_id ? String(c.price_list_id) : null,
        bankName: c.bank_name,
        tdsApplicable: !!c.tds_applicable,
        // The first is the default a bill takes; a contact may have several.
        tdsSection: parseSections(c.tds_section)[0] ?? null,
        tdsSections: parseSections(c.tds_section),
        constitution: c.constitution,
        gstStatus: c.gst_status,
        gstRegisteredOn: c.gst_registered_on ? String(c.gst_registered_on).slice(0, 10) : null,
        cin: c.cin,
        incorporatedOn: c.incorporated_on ? String(c.incorporated_on).slice(0, 10) : null,
        country: c.country,
        supplies: c.supplies,
        billingAddress: c.billing_address,
        shippingAddress: c.shipping_address,
        notes: c.notes,
        isArchived: !!c.is_archived,
        receivablePaise: toPaiseFromSql(arBy.get(c.id)?.due ?? '0') + (beyond.get(c.id)?.receivablePaise ?? 0),
        payablePaise: toPaiseFromSql(apBy.get(c.id)?.due ?? '0') + (beyond.get(c.id)?.payablePaise ?? 0),
        invoiceCount: Number(arBy.get(c.id)?.n ?? 0),
        billCount: Number(apBy.get(c.id)?.n ?? 0),
        unusedCreditsPaise: (payUnused.get(`${c.id}:received`) ?? 0) + (cnUnused.get(c.id) ?? 0),
        vendorUnusedCreditsPaise: (payUnused.get(`${c.id}:made`) ?? 0) + (vcUnused.get(c.id) ?? 0),
        overdue: overdueC.has(c.id),
        vendorOverdue: overdueV.has(c.id),
        reorder: reorderVendors.has(c.id),
        portalEnabled: portalOn.has(c.id),
        duplicate: duplicate(c),
        createdAt: new Date(c.created_at).toISOString(),
        openingBalancePaise: toPaiseFromSql(c.opening_balance),
        ...zohoFields(c),
        linkedContactId: c.linked_contact_id ? asId(c.linked_contact_id) : null,
      })),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

const ContactInput = z.object({
  kind: z.enum(['customer', 'vendor', 'both']),
  displayName: z.string().trim().min(1, 'A contact needs a name.').max(200),
  legalName: z.string().trim().max(200).nullish(),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, 'That is not a valid 15-character GSTIN.').nullish()
    .or(z.literal('').transform(() => null)),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'A PAN is five letters, four digits, a letter.').nullish()
    .or(z.literal('').transform(() => null)),
  gstTreatment: z.enum([
    'registered', 'registered_composition', 'unregistered', 'consumer',
    'overseas', 'sez', 'sez_developer', 'deemed_export', 'uin', 'tax_deductor',
  ]),
  stateCode: z.string().length(2, 'Pick a state.'),
  email: z.string().trim().email('That email does not look right.').nullish()
    .or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(20).nullish(),
  paymentTerms: z.string().trim().max(50).nullish(),
  creditLimitPaise: z.number().int().min(0).optional(),
  /** Off: payments are not matched to bills; they settle the oldest first. */
  billWise: z.boolean().optional(),
  isMsme: z.boolean().optional(),
  msmeUdyamNo: z.string().trim().max(30).nullish(),
  msmeCategory: z.enum(['micro', 'small', 'medium']).nullish(),
  msmeActivity: z.enum(['manufacturing', 'services', 'trading']).nullish(),
  /** The credit period agreed in writing; leave empty when there is none. */
  msmeAgreementDays: z.number().int().min(1).max(45, 'The MSMED Act caps an agreed period at 45 days.').nullish(),
  bankAccountName: z.string().trim().max(150).nullish(),
  // A masked number (••••1234) comes back from a form that was shown one: leave the stored number as it is.
  bankAccountNo: z.preprocess((v) => (isMasked(v) ? undefined : v), z.string().trim().regex(/^[0-9A-Za-z]{6,34}$/, 'An account number is 6 to 34 letters and digits.').nullish()
    .or(z.literal('').transform(() => null))),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is four letters, a zero, then six letters or digits.').nullish()
    .or(z.literal('').transform(() => null)),
  bankName: z.string().trim().max(120).nullish(),
  /** The currency they are invoiced or billed in. */
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A currency is a three-letter code, such as USD.').optional(),
  /** The price list a customer is charged from; null for the items' own prices. */
  priceListId: z.coerce.number().int().positive().nullish(),
  /** One section, as older callers send it; tdsSections wins when both come. */
  tdsSection: z.string().trim().max(10).nullish(),
  /** Every section they deduct, or are paid, under; the first is the default. */
  tdsSections: z.array(z.string().trim().toUpperCase().min(2).max(10)).max(10).nullish(),
  /** From the GSTIN and the CIN (integrations/party-lookup.ts), or typed. */
  constitution: z.string().trim().max(60).nullish(),
  gstStatus: z.string().trim().max(30).nullish(),
  gstRegisteredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.').nullish().or(z.literal('').transform(() => null)),
  cin: z.string().trim().toUpperCase().regex(/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$|^[A-Z]{3}-\d{4}$/, 'A CIN is 21 characters, like U74999TN2015PTC123456 (an LLPIN is like AAB-1234).').nullish()
    .or(z.literal('').transform(() => null)),
  incorporatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as yyyy-mm-dd.').nullish().or(z.literal('').transform(() => null)),
  /** An international party's country, as its two-letter ISO code (US, AE, GB …). */
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Pick the country.').nullish().or(z.literal('').transform(() => null)),
  /** What a customer buys: the items its documents offer. */
  supplies: z.enum(['goods', 'service', 'both']).optional(),
  billingAddress: z.string().trim().max(500).nullish(),
  shippingAddress: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  /** Who chases this customer's overdue invoices (services/exceptions.ts). */
  ownerUserId: z.coerce.number().int().positive().nullish(),
  // ── Zoho's customer and vendor fields (migration 112) ──
  contactType: z.enum(['business', 'individual']).optional(),
  salutation: z.string().trim().max(20).nullish(),
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  mobile: z.string().trim().max(30).nullish(),
  language: z.string().trim().max(40).optional(),
  website: z.string().trim().max(255).nullish(),
  twitter: z.string().trim().max(100).nullish(),
  facebook: z.string().trim().max(100).nullish(),
  skype: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  designation: z.string().trim().max(100).nullish(),
  taxPreference: z.enum(['taxable', 'exempt']).optional(),
  taxExemptionReason: z.string().trim().max(200).nullish(),
  billingAttention: z.string().trim().max(150).nullish(),
  billingStreet2: z.string().trim().max(255).nullish(),
  billingCity: z.string().trim().max(100).nullish(),
  billingState: z.string().trim().max(80).nullish(),
  billingPincode: z.string().trim().max(20).nullish(),
  billingCountry: z.string().trim().max(80).nullish(),
  billingPhone: z.string().trim().max(30).nullish(),
  billingFax: z.string().trim().max(30).nullish(),
  shippingAttention: z.string().trim().max(150).nullish(),
  shippingStreet2: z.string().trim().max(255).nullish(),
  shippingCity: z.string().trim().max(100).nullish(),
  shippingState: z.string().trim().max(80).nullish(),
  shippingPincode: z.string().trim().max(20).nullish(),
  shippingCountry: z.string().trim().max(80).nullish(),
  shippingPhone: z.string().trim().max(30).nullish(),
  shippingFax: z.string().trim().max(30).nullish(),
  businessLegalName: z.string().trim().max(200).nullish(),
  businessTradeName: z.string().trim().max(200).nullish(),
});


const CreateInput = ContactInput.extend({
  /**
   * Zoho's "Opening Balance": what they owed (or were owed) before the books
   * started. Kept as an opening bill dated the day before, as the Opening
   * Balances page enters one.
   */
  openingBalancePaise: z.number().int().min(0).max(1e15).optional(),
});

/** The day before a yyyy-mm-dd date. */
function dayBefore(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
const UpdateInput = ContactInput.partial().extend({
  id: z.string(),
  isArchived: z.boolean().optional(),
  /** The record's updatedAt as it was read: the edit is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
});

/** The sections to store: the list when it came, else the single one; undefined when neither came. */
function sectionsOf(input: Partial<z.infer<typeof ContactInput>>): string | null | undefined {
  if (input.tdsSections !== undefined) return joinSections(input.tdsSections ?? []);
  if (input.tdsSection !== undefined) return joinSections(input.tdsSection ? [input.tdsSection] : []);
  return undefined;
}

function toRow(input: z.infer<typeof ContactInput>) {
  return {
    kind: input.kind,
    display_name: input.displayName,
    legal_name: input.legalName ?? null,
    gstin: input.gstin ?? null,
    pan: input.pan ?? null,
    gst_treatment: input.gstTreatment,
    state_code: input.stateCode,
    email: input.email ?? null,
    phone: input.phone ?? null,
    payment_terms: input.paymentTerms ?? null,
    credit_limit: ((input.creditLimitPaise ?? 0) / 100).toFixed(4),
    bill_wise: input.billWise === false ? 0 : 1,
    is_msme: input.isMsme ? 1 : 0,
    msme_udyam_no: input.msmeUdyamNo ?? null,
    msme_category: input.isMsme ? input.msmeCategory ?? null : null,
    msme_activity: input.isMsme ? input.msmeActivity ?? null : null,
    msme_agreement_days: input.isMsme ? input.msmeAgreementDays ?? null : null,
    bank_account_name: input.bankAccountName ?? null,
    bank_account_no: seal(input.bankAccountNo ?? null),
    bank_ifsc: input.bankIfsc ?? null,
    bank_name: input.bankName ?? null,
    currency: input.currency ?? 'INR',
    price_list_id: input.priceListId ?? null,
    tds_applicable: sectionsOf(input) ? 1 : 0,
    tds_section: sectionsOf(input) ?? null,
    constitution: input.constitution ?? null,
    gst_status: input.gstStatus ?? null,
    gst_registered_on: input.gstRegisteredOn ?? null,
    cin: input.cin ?? null,
    incorporated_on: input.incorporatedOn ?? null,
    country: input.country ?? null,
    supplies: input.supplies ?? 'both',
    billing_address: input.billingAddress ?? null,
    shipping_address: input.shippingAddress ?? null,
    notes: input.notes ?? null,
    owner_user_id: input.ownerUserId ?? null,
    ...Object.fromEntries(Object.entries(ZOHO_COLUMNS).map(([k, col]) => [col, (input as Record<string, unknown>)[k] ?? null])),
    contact_type: input.contactType ?? 'business',
    language: input.language ?? 'English',
    tax_preference: input.taxPreference ?? 'taxable',
  };
}

/**
 * A registered party must carry a GSTIN, and its first two digits are the state
 * code. Letting those disagree produces invoices with the wrong place of supply
 * — which is the difference between charging IGST and charging CGST+SGST.
 */
function checkGstin(input: Partial<z.infer<typeof ContactInput>>) {
  // Zoho asks a GSTIN (or UIN) of every treatment but unregistered, consumer and overseas.
  const registered = ['registered', 'registered_composition', 'sez', 'sez_developer', 'deemed_export', 'tax_deductor'].includes(input.gstTreatment ?? '');
  if (registered && !input.gstin) {
    throw badRequest('Enter the GSTIN / UIN: a registered party needs one.');
  }
  // An international party is outside India: no GSTIN, and not India as its country.
  if (input.gstTreatment === 'overseas' && input.country === 'IN') {
    throw badRequest('An overseas party is outside India: pick the country it is in.');
  }
  if (input.gstTreatment === 'overseas' && input.gstin) {
    throw badRequest('An overseas party has no Indian GSTIN. Leave it empty, or choose another GST treatment.');
  }
  // 96 is the code for a place outside India: invoices to it go as exports, with no GST.
  if (input.gstTreatment && input.gstTreatment !== 'overseas' && input.stateCode === '96') {
    throw badRequest('This party is in India: pick its state. State 96 is only for a party outside India (GST treatment Overseas).');
  }
  if (input.gstin && input.stateCode && input.gstin.slice(0, 2) !== input.stateCode) {
    throw badRequest(
      `The GSTIN starts with ${input.gstin.slice(0, 2)}, which is a different state from the one selected. ` +
        'The first two digits of a GSTIN are the state code.',
    );
  }
  // The fifteenth character is a check digit over the other fourteen: a GSTIN
  // with one character mistyped fails it, and an invoice carrying it is refused
  // by the IRP and leaves the buyer without their input credit.
  if (input.gstin && !isValidGstin(input.gstin)) {
    throw badRequest(`${input.gstin} fails the GSTIN check digit, so a character is wrong. Check it against the party's registration certificate.`);
  }
  // Characters 3 to 12 of a GSTIN are the holder's PAN.
  const panInGstin = input.gstin?.slice(2, 12);
  if (input.pan && panInGstin && /^[A-Z]{5}\d{4}[A-Z]$/.test(panInGstin) && panInGstin !== input.pan) {
    throw badRequest(`The PAN inside the GSTIN is ${panInGstin}, not ${input.pan}. One of them is wrong.`);
  }
}

/**
 * The same party entered twice is how one bill gets paid twice and how a
 * customer's dues end up split where no credit limit sees them. The same GSTIN
 * is refused outright; the same PAN (another state's registration, which is
 * proper) or the same name is let through with a warning to look first.
 */
async function duplicates(orgId: number, input: { displayName?: string; gstin?: string | null; pan?: string | null }, exceptId?: number) {
  const warnings: string[] = [];
  const others = (q: ReturnType<typeof contactsOf>) => (exceptId ? q.where('id', '<>', exceptId) : q);
  function contactsOf() {
    return db.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId).where('is_archived', '=', 0);
  }
  if (input.gstin) {
    const same = await others(contactsOf().where('gstin', '=', input.gstin)).executeTakeFirst();
    if (same) {
      throw conflict(`${same.display_name} already has GSTIN ${input.gstin}. Open that ${same.kind} instead — if they are both a customer and a vendor, make them "both".`);
    }
  }
  if (input.pan) {
    const same = await others(contactsOf().where('pan', '=', input.pan)).execute();
    if (same.length) warnings.push(`Same PAN as ${same.map((c) => c.display_name).join(', ')}. Right for another state's registration; otherwise this may be a duplicate.`);
  }
  if (input.displayName) {
    // Compared as letters and digits only, so "Sharma Traders Pvt. Ltd." meets "SHARMA TRADERS PVT LTD".
    const key = input.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const same = (await others(contactsOf()).execute()).filter((c) => c.display_name.toLowerCase().replace(/[^a-z0-9]/g, '') === key);
    if (same.length) warnings.push(`There is already a ${same[0].kind} called ${same[0].display_name}. Check this is not the same party entered twice.`);
  }
  return warnings;
}

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, CreateInput);
    checkGstin(input);
    const warnings = await duplicates(orgId, input);

    const id = await transaction(async (trx) => {
      const inserted = await trx
        .insertInto('contacts')
        .values({ org_id: orgId, ...toRow(input) })
        .executeTakeFirstOrThrow();
      const id = Number(inserted.insertId);
      if (input.openingBalancePaise) {
        const before = dayBefore((await booksStartDate(trx, orgId)).date);
        await addOpeningDocument(trx, orgId, user.userId, {
          branchId, contactId: id, kind: input.kind === 'vendor' ? 'payable' : 'receivable', refNo: 'Opening Balance',
          docDate: before, dueDate: before, amountPaise: input.openingBalancePaise, notes: 'Entered with the contact',
        });
      }
      return id;
    });
    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'contact',
      targetId: id,
      targetLabel: input.displayName,
      detail: `Added ${input.kind} ${input.displayName}`,
      ...auditMeta(req),
    });

    return { id: asId(id), displayName: input.displayName, warnings };
  },
  { permission: { module: 'sales', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, UpdateInput);
    const id = Number(input.id);

    const existing = await db
      .selectFrom('contacts')
      .select(['id', 'display_name', 'gstin', 'pan', 'state_code', 'gst_treatment', 'country'])
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!existing) throw badRequest('That contact does not exist.');

    // Validate the merged shape, not the patch: a partial update that changes
    // only the state code still has to agree with the GSTIN already on file.
    // A GSTIN or PAN sent empty is being cleared, not left as it was.
    const merged = <T>(sent: T | null | undefined, kept: T | null) => (sent === undefined ? kept : sent) ?? undefined;
    checkGstin({
      gstin: merged(input.gstin, existing.gstin),
      stateCode: input.stateCode ?? existing.state_code,
      gstTreatment: (input.gstTreatment ?? existing.gst_treatment) as never,
      pan: merged(input.pan, existing.pan),
      country: merged(input.country, existing.country),
    });
    // Only what the edit changes is checked against the others: the party
    // already on file is not its own duplicate.
    const warnings = await duplicates(orgId, {
      gstin: input.gstin && input.gstin !== existing.gstin ? input.gstin : null,
      pan: input.pan && input.pan !== existing.pan ? input.pan : null,
      displayName: input.displayName && input.displayName !== existing.display_name ? input.displayName : undefined,
    }, id);

    const patch: Record<string, unknown> = {};
    const set = <K extends string>(col: K, v: unknown) => {
      if (v !== undefined) patch[col] = v;
    };
    set('kind', input.kind);
    set('display_name', input.displayName);
    set('legal_name', input.legalName);
    set('gstin', input.gstin);
    set('pan', input.pan);
    set('gst_treatment', input.gstTreatment);
    set('state_code', input.stateCode);
    set('email', input.email);
    set('phone', input.phone);
    set('payment_terms', input.paymentTerms);
    set('credit_limit', input.creditLimitPaise === undefined ? undefined : (input.creditLimitPaise / 100).toFixed(4));
    set('bill_wise', input.billWise === undefined ? undefined : input.billWise ? 1 : 0);
    set('is_msme', input.isMsme === undefined ? undefined : input.isMsme ? 1 : 0);
    set('msme_udyam_no', input.msmeUdyamNo);
    set('msme_category', input.msmeCategory);
    set('msme_activity', input.msmeActivity);
    set('msme_agreement_days', input.msmeAgreementDays);
    set('bank_account_name', input.bankAccountName);
    set('bank_account_no', input.bankAccountNo === undefined ? undefined : seal(input.bankAccountNo));
    set('bank_ifsc', input.bankIfsc);
    set('bank_name', input.bankName);
    set('currency', input.currency);
    set('price_list_id', input.priceListId);
    const sections = sectionsOf(input);
    set('tds_applicable', sections === undefined ? undefined : sections ? 1 : 0);
    set('tds_section', sections);
    set('constitution', input.constitution);
    set('gst_status', input.gstStatus);
    set('gst_registered_on', input.gstRegisteredOn);
    set('cin', input.cin);
    set('incorporated_on', input.incorporatedOn);
    set('country', input.country);
    set('supplies', input.supplies);
    set('billing_address', input.billingAddress);
    set('shipping_address', input.shippingAddress);
    set('notes', input.notes);
    set('owner_user_id', input.ownerUserId);
    set('is_archived', input.isArchived === undefined ? undefined : input.isArchived ? 1 : 0);
    for (const [k, col] of Object.entries(ZOHO_COLUMNS)) set(col, (input as Record<string, unknown>)[k]);

    if (input.isArchived) {
      // Archiving a party with money outstanding hides a debt somebody still
      // has to chase or settle. The row stays; the archive is refused.
      const [ar, ap] = await Promise.all([
        db.selectFrom('invoices')
          .select(sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('due'))
          .where('org_id', '=', orgId).where('customer_id', '=', id)
          .where('status', 'not in', ['draft', 'void']).executeTakeFirst(),
        db.selectFrom('bills')
          .select(sql<string>`COALESCE(SUM(total - amount_paid), 0)`.as('due'))
          .where('org_id', '=', orgId).where('vendor_id', '=', id)
          .where('status', 'not in', ['draft', 'void']).executeTakeFirst(),
      ]);
      const open = toPaiseFromSql(ar?.due ?? '0') + toPaiseFromSql(ap?.due ?? '0');
      if (open > 0) {
        throw conflict(
          `${existing.display_name} still has an open balance. Settle or write it off before archiving.`,
        );
      }
    }

    await assertFresh(db, 'contacts', orgId, id, input.expectedUpdatedAt, existing.display_name);
    const before = await snapshot(db, 'contacts', orgId, id, Object.keys(patch));
    if (Object.keys(patch).length) {
      await db.updateTable('contacts').set(patch).where('id', '=', id).where('org_id', '=', orgId).execute();
    }
    const changes = changesBetween(before, patch);

    await logAudit({
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'update',
      targetType: 'contact',
      targetId: id,
      targetLabel: existing.display_name,
      detail: `${input.isArchived ? 'Archived' : 'Updated'} ${existing.display_name}: ${describeChanges(changes)}`,
      payload: { changes },
      ...auditMeta(req),
    });

    return { id: asId(id), warnings };
  },
  { permission: { module: 'sales', action: 'edit' } },
);

/**
 * Delete a customer or vendor that was never used, as Zoho's "Delete" does.
 * Its own contact persons, extra addresses and portal links go with it; any
 * document, payment, journal line or other record that names it keeps it, and
 * the answer says to mark it inactive instead.
 */
export const DELETE = route(
  async ({ orgId, user, role, req }) => {
    const { id: raw } = query(req, z.object({ id: z.string() }));
    const id = Number(raw);
    const existing = await db.selectFrom('contacts').select(['id', 'display_name', 'kind'])
      .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw badRequest('That contact does not exist.');
    const needs = existing.kind === 'both' ? ['sales', 'purchases'] : [existing.kind === 'vendor' ? 'purchases' : 'sales'];
    if (!needs.every((m) => hasPermission(role, m, 'void'))) throw forbidden('You cannot delete this contact.');
    const posted = await db.selectFrom('journal_lines').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('contact_id', '=', id).executeTakeFirst();
    if (Number(posted?.n ?? 0) > 0) {
      throw conflict(`${existing.display_name} has entries in the books, so it cannot be deleted. Mark it as inactive instead.`);
    }
    try {
      await transaction(async (trx) => {
        await trx.deleteFrom('contact_persons').where('org_id', '=', orgId).where('contact_id', '=', id).execute();
        await trx.deleteFrom('contact_addresses').where('org_id', '=', orgId).where('contact_id', '=', id).execute();
        await trx.deleteFrom('portal_access').where('org_id', '=', orgId).where('contact_id', '=', id).execute();
        await trx.deleteFrom('contacts').where('id', '=', id).where('org_id', '=', orgId).execute();
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'contact', targetId: id,
          targetLabel: existing.display_name, detail: `Deleted unused ${existing.kind} ${existing.display_name}`, ...auditMeta(req),
        });
      });
    } catch (e) {
      // A document, payment or other record still names it (a foreign key refused the delete).
      if ((e as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') {
        throw conflict(`${existing.display_name} is still used on documents or other records, so it cannot be deleted. Mark it as inactive instead.`);
      }
      throw e;
    }
    return { id: asId(id) };
  },
  { permission: { module: 'sales', action: 'view' } },
);
