import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, query, asId, badRequest, conflict } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { seal, unseal } from '@/lib/server/crypto/fields';
import { assertFresh } from '@/lib/server/concurrency';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';

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
  async ({ orgId, req }) => {
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
        'email', 'phone', 'payment_terms', 'credit_limit', 'is_msme', 'msme_udyam_no',
        'msme_category', 'msme_activity', 'msme_agreement_days', 'bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_name', 'currency', 'price_list_id',
        'tds_applicable', 'tds_section', 'billing_address', 'shipping_address', 'notes', 'is_archived', 'updated_at', 'bill_wise',
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
        billWise: !!c.bill_wise,
        isMsme: !!c.is_msme,
        msmeUdyamNo: c.msme_udyam_no,
        msmeCategory: c.msme_category,
        msmeActivity: c.msme_activity,
        msmeAgreementDays: c.msme_agreement_days,
        bankAccountName: c.bank_account_name,
        bankAccountNo: unseal(c.bank_account_no),
        bankIfsc: c.bank_ifsc,
        updatedAt: new Date(c.updated_at).toISOString(),
        currency: c.currency,
        priceListId: c.price_list_id ? String(c.price_list_id) : null,
        bankName: c.bank_name,
        tdsApplicable: !!c.tds_applicable,
        tdsSection: c.tds_section,
        billingAddress: c.billing_address,
        shippingAddress: c.shipping_address,
        notes: c.notes,
        isArchived: !!c.is_archived,
        receivablePaise: toPaiseFromSql(arBy.get(c.id)?.due ?? '0'),
        payablePaise: toPaiseFromSql(apBy.get(c.id)?.due ?? '0'),
        invoiceCount: Number(arBy.get(c.id)?.n ?? 0),
        billCount: Number(apBy.get(c.id)?.n ?? 0),
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
    'overseas', 'sez', 'sez_developer', 'deemed_export', 'uin',
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
  bankAccountNo: z.string().trim().regex(/^[0-9A-Za-z]{6,34}$/, 'An account number is 6 to 34 letters and digits.').nullish()
    .or(z.literal('').transform(() => null)),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is four letters, a zero, then six letters or digits.').nullish()
    .or(z.literal('').transform(() => null)),
  bankName: z.string().trim().max(120).nullish(),
  /** The currency they are invoiced or billed in. */
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A currency is a three-letter code, such as USD.').optional(),
  /** The price list a customer is charged from; null for the items' own prices. */
  priceListId: z.coerce.number().int().positive().nullish(),
  tdsSection: z.string().trim().max(10).nullish(),
  billingAddress: z.string().trim().max(500).nullish(),
  shippingAddress: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

const CreateInput = ContactInput;
const UpdateInput = ContactInput.partial().extend({
  id: z.string(),
  isArchived: z.boolean().optional(),
  /** The record's updatedAt as it was read: the edit is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
});

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
    tds_applicable: input.tdsSection ? 1 : 0,
    tds_section: input.tdsSection ?? null,
    billing_address: input.billingAddress ?? null,
    shipping_address: input.shippingAddress ?? null,
    notes: input.notes ?? null,
  };
}

/**
 * A registered party must carry a GSTIN, and its first two digits are the state
 * code. Letting those disagree produces invoices with the wrong place of supply
 * — which is the difference between charging IGST and charging CGST+SGST.
 */
function checkGstin(input: Partial<z.infer<typeof ContactInput>>) {
  const registered = input.gstTreatment === 'registered'
    || input.gstTreatment === 'registered_composition'
    || input.gstTreatment === 'sez';
  if (registered && !input.gstin) {
    throw badRequest('A registered party needs a GSTIN.');
  }
  if (input.gstin && input.stateCode && input.gstin.slice(0, 2) !== input.stateCode) {
    throw badRequest(
      `The GSTIN starts with ${input.gstin.slice(0, 2)}, which is a different state from the one selected. ` +
        'The first two digits of a GSTIN are the state code.',
    );
  }
}

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);
    checkGstin(input);

    const inserted = await db
      .insertInto('contacts')
      .values({ org_id: orgId, ...toRow(input) })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
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

    return { id: asId(id), displayName: input.displayName };
  },
  { permission: { module: 'sales', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, UpdateInput);
    const id = Number(input.id);

    const existing = await db
      .selectFrom('contacts')
      .select(['id', 'display_name', 'gstin', 'state_code', 'gst_treatment'])
      .where('id', '=', id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!existing) throw badRequest('That contact does not exist.');

    // Validate the merged shape, not the patch: a partial update that changes
    // only the state code still has to agree with the GSTIN already on file.
    checkGstin({
      gstin: input.gstin ?? existing.gstin ?? undefined,
      stateCode: input.stateCode ?? existing.state_code,
      gstTreatment: (input.gstTreatment ?? existing.gst_treatment) as never,
    });

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
    set('tds_applicable', input.tdsSection === undefined ? undefined : input.tdsSection ? 1 : 0);
    set('tds_section', input.tdsSection);
    set('billing_address', input.billingAddress);
    set('shipping_address', input.shippingAddress);
    set('notes', input.notes);
    set('is_archived', input.isArchived === undefined ? undefined : input.isArchived ? 1 : 0);

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

    return { id: asId(id) };
  },
  { permission: { module: 'sales', action: 'edit' } },
);
