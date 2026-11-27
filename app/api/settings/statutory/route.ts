import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { toPaiseFromSql, toSqlFromPaise } from '@/lib/server/money-sql';
import {
  changeRegistration, einvoiceApplicability, registrationHistory, setEinvoicing,
} from '@/lib/server/services/statutory';
import { BASE_THRESHOLD_PAISE, thresholdPaise } from '@/lib/tax/eway';
import { COMPOSITION_RATES } from '@/lib/server/gst/composition';
import { stateName } from '@/lib/tax/gst';
import { roleGstinProblem } from '@/lib/gst/withholding';

// The statutory settings that change with the business: GST registration type
// (dated), e-invoicing, the TDS deductor and the person responsible, and each
// branch's intra-state e-way bill threshold. See services/statutory.ts.

/** Deductor categories as the TDS return codes them. */
const DEDUCTOR_TYPES = {
  K: 'Company', M: 'Branch or division of a company', F: 'Firm (including LLP)', Q: 'Individual or HUF',
  P: 'Association of persons', T: 'Association of persons (trust)', B: 'Body of individuals',
  J: 'Artificial juridical person', N: 'Local authority (state)', E: 'Statutory body (state)',
} as const;

export const GET = route(async ({ orgId }) => {
  const [org, history, einvoicing, branches] = await Promise.all([
    db.selectFrom('organizations')
      .select(['gst_registration_type', 'gst_filing_frequency', 'composition_category', 'deductor_type', 'tds_rp_name', 'tds_rp_designation', 'tds_rp_pan', 'tds_rp_mobile', 'tds_rp_email', 'pf_establishment_code', 'esi_employer_code',
        'gst_tds_deductor', 'gst_tds_gstin', 'gst_eco_operator', 'gst_eco_gstin'])
      .where('id', '=', orgId).executeTakeFirstOrThrow(),
    registrationHistory(db, orgId),
    einvoiceApplicability(db, orgId),
    db.selectFrom('branches').select(['id', 'name', 'state_code', 'eway_intra_threshold', 'gstin'])
      .where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('name').execute(),
  ]);
  return {
    registration: {
      current: org.gst_registration_type, frequency: org.gst_filing_frequency, history,
      compositionCategory: org.composition_category,
      compositionCategories: Object.fromEntries(Object.entries(COMPOSITION_RATES).map(([k, v]) => [k, `${v.label}: ${v.ratePct}%`])),
    },
    einvoicing,
    deductor: {
      type: org.deductor_type, types: DEDUCTOR_TYPES,
      name: org.tds_rp_name, designation: org.tds_rp_designation, pan: org.tds_rp_pan,
      mobile: org.tds_rp_mobile, email: org.tds_rp_email,
    },
    payroll: { pfCode: org.pf_establishment_code, esiCode: org.esi_employer_code },
    // The GST withholding roles (CGST Act s.51 and s.52): each turns on its own return, GSTR-7 or GSTR-8.
    gstRoles: {
      tdsDeductor: !!org.gst_tds_deductor, tdsGstin: org.gst_tds_gstin,
      ecoOperator: !!org.gst_eco_operator, ecoGstin: org.gst_eco_gstin,
      branchGstin: branches[0]?.gstin ?? null,
    },
    branches: branches.map((b) => ({
      id: asId(b.id), name: b.name, stateCode: b.state_code, stateName: stateName(b.state_code),
      builtInPaise: thresholdPaise(b.state_code, b.state_code),
      overridePaise: b.eway_intra_threshold === null ? null : toPaiseFromSql(b.eway_intra_threshold),
    })),
  };
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('registration'),
    toType: z.enum(['regular', 'composition', 'unregistered']), effectiveFrom: date, reason: z.string().max(300),
  }),
  z.object({ action: z.literal('einvoicing'), applicable: z.boolean(), from: date.nullish() }),
  z.object({ action: z.literal('gst-frequency'), frequency: z.enum(['monthly', 'quarterly']) }),
  z.object({ action: z.literal('composition-category'), category: z.enum(['manufacturer', 'trader', 'restaurant', 'services']) }),
  z.object({
    action: z.literal('deductor'),
    type: z.enum(Object.keys(DEDUCTOR_TYPES) as [keyof typeof DEDUCTOR_TYPES]).nullish(),
    name: z.string().trim().max(100).nullish(),
    designation: z.string().trim().max(60).nullish(),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'A PAN is five letters, four digits, a letter.').nullish().or(z.literal('')),
    mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'A ten-digit mobile number.').nullish().or(z.literal('')),
    email: z.string().trim().email().max(150).nullish().or(z.literal('')),
  }),
  z.object({ action: z.literal('payroll-codes'), pfCode: z.string().trim().max(30).nullish(), esiCode: z.string().trim().max(30).nullish() }),
  z.object({ action: z.literal('eway-threshold'), branchId: z.coerce.number().int().positive(), thresholdPaise: z.number().int().nullable() }),
  z.object({
    action: z.literal('gst-roles'),
    tdsDeductor: z.boolean(), tdsGstin: z.string().trim().toUpperCase().nullish(),
    ecoOperator: z.boolean(), ecoGstin: z.string().trim().toUpperCase().nullish(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const audit = (trx: Parameters<typeof logAudit>[0]['trx'], detail: string, payload?: unknown) => logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'organization', targetId: orgId, targetLabel: 'Statutory settings', detail, payload, ...auditMeta(req),
    });

    return transaction(async (trx) => {
      switch (input.action) {
        case 'registration': {
          const history = await changeRegistration(trx, orgId, user.userId, input);
          await audit(trx, `GST registration changed to ${input.toType} from ${input.effectiveFrom}: ${input.reason}`);
          return { history };
        }
        case 'einvoicing': {
          if (input.applicable && !input.from) throw badRequest('Say from which 1 April e-invoicing applies.');
          const before = await einvoiceApplicability(trx, orgId);
          const r = await setEinvoicing(trx, orgId, { applicable: input.applicable, from: input.from ?? null });
          await audit(trx, input.applicable
            ? `E-invoicing applies from ${input.from}; ${r.queued} issued invoice(s) now need an IRN`
            : `E-invoicing marked as not applicable; ${r.cleared} invoice(s) taken off the IRN queue`,
          { changes: { before, after: { applicable: input.applicable, from: input.from ?? null } } });
          return r;
        }
        case 'gst-frequency': {
          // QRMP is open to aggregate turnover up to ₹5 crore; e-invoicing starts above it.
          if (input.frequency === 'quarterly' && (await einvoiceApplicability(trx, orgId)).applicable) {
            throw badRequest('Quarterly returns (QRMP) are only for turnover up to ₹5 crore, and this book is e-invoicing.');
          }
          await trx.updateTable('organizations').set({ gst_filing_frequency: input.frequency }).where('id', '=', orgId).execute();
          await audit(trx, `GST returns filed ${input.frequency}`);
          return { ok: true };
        }
        case 'composition-category': {
          await trx.updateTable('organizations').set({ composition_category: input.category }).where('id', '=', orgId).execute();
          await audit(trx, `Composition category: ${COMPOSITION_RATES[input.category].label}`);
          return { ok: true };
        }
        case 'deductor': {
          const patch = {
            deductor_type: input.type ?? null, tds_rp_name: input.name || null, tds_rp_designation: input.designation || null,
            tds_rp_pan: input.pan || null, tds_rp_mobile: input.mobile || null, tds_rp_email: input.email || null,
          };
          await trx.updateTable('organizations').set(patch).where('id', '=', orgId).execute();
          await audit(trx, `TDS deductor details updated${input.name ? `: ${input.name}` : ''}`);
          return { ok: true };
        }
        case 'payroll-codes': {
          await trx.updateTable('organizations').set({ pf_establishment_code: input.pfCode || null, esi_employer_code: input.esiCode || null }).where('id', '=', orgId).execute();
          await audit(trx, 'PF and ESI registration numbers updated');
          return { ok: true };
        }
        case 'gst-roles': {
          // A deductor (s.51) and an operator (s.52) each register separately (Rule 12): the
          // TDS GSTIN carries D in its 14th place, the TCS one C. Left empty, the primary
          // branch's GSTIN stands in, and the GSTR-7 / GSTR-8 screens say so.
          const tdsGstin = input.tdsGstin?.trim() || null;
          const ecoGstin = input.ecoGstin?.trim() || null;
          const tdsProblem = tdsGstin ? roleGstinProblem(tdsGstin, 'tds') : null;
          if (tdsProblem) throw badRequest(`GST TDS registration: ${tdsProblem}`);
          const ecoProblem = ecoGstin ? roleGstinProblem(ecoGstin, 'tcs') : null;
          if (ecoProblem) throw badRequest(`E-commerce TCS registration: ${ecoProblem}`);
          const before = await trx.selectFrom('organizations').select(['gst_tds_deductor', 'gst_tds_gstin', 'gst_eco_operator', 'gst_eco_gstin']).where('id', '=', orgId).executeTakeFirstOrThrow();
          await trx.updateTable('organizations').set({
            gst_tds_deductor: input.tdsDeductor ? 1 : 0, gst_tds_gstin: tdsGstin,
            gst_eco_operator: input.ecoOperator ? 1 : 0, gst_eco_gstin: ecoGstin,
          }).where('id', '=', orgId).execute();
          await audit(trx,
            `GST roles: TDS deductor ${input.tdsDeductor ? `on${tdsGstin ? ` (${tdsGstin})` : ''}` : 'off'}; e-commerce operator ${input.ecoOperator ? `on${ecoGstin ? ` (${ecoGstin})` : ''}` : 'off'}`,
            { changes: { before, after: { gst_tds_deductor: input.tdsDeductor ? 1 : 0, gst_tds_gstin: tdsGstin, gst_eco_operator: input.ecoOperator ? 1 : 0, gst_eco_gstin: ecoGstin } } });
          return { ok: true };
        }
        case 'eway-threshold': {
          if (input.thresholdPaise !== null && input.thresholdPaise < BASE_THRESHOLD_PAISE) {
            throw badRequest('No state allows less than ₹50,000. Leave it empty to use the built-in figure.');
          }
          const b = await trx.selectFrom('branches').select('name').where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirst();
          if (!b) throw notFound('That branch is not in this book.');
          await trx.updateTable('branches')
            .set({ eway_intra_threshold: input.thresholdPaise === null ? null : toSqlFromPaise(input.thresholdPaise) })
            .where('id', '=', input.branchId).execute();
          await audit(trx, input.thresholdPaise === null
            ? `${b.name}: e-way bill threshold back to the built-in figure`
            : `${b.name}: intra-state e-way bill threshold set to ₹${(input.thresholdPaise / 100).toLocaleString('en-IN')}`);
          return { ok: true };
        }
      }
    });
  },
  { permission: { module: 'settings', action: 'edit' } },
);
