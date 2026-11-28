import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, badRequest, forbidden, ApiError } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { monthLabel } from '@/lib/date-range';
import { roleProfile } from '@/lib/server/gst/withholding-common';
import {
  amendGstTds, deleteGstTds, deleteGstr7Payment, gstr7, gstr7PortalJson, gstr7aCertificate, previewGstTds,
  recordGstTds, recordGstr7Payment, setGstr7aNumber, undoGstTdsAmendment, updateGstTds, updateGstr7Payment,
} from '@/lib/server/gst/gstr7';
import {
  amendEcoSupply, deleteEcoSupply, gstr8, gstr8PortalJson, previewEcoSupply,
  recordEcoSupply, recordGstr8Payment, undoEcoAmendment, updateEcoSupply, updateGstr8Payment,
} from '@/lib/server/gst/gstr8';

// ─────────────────────────────────────────────────────────────────────────────
// GST withheld by this book: GSTR-7 (TDS deducted as a deductor under s.51)
// and GSTR-8 (TCS collected as an e-commerce operator under s.52). The returns
// are read (GET) from the deductions and operator records; the records, their
// amendments in later months and the tax paid with each return are kept here.
// See lib/server/gst/gstr7.ts and gstr8.ts.
// ─────────────────────────────────────────────────────────────────────────────

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'Give the month as yyyy-mm.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const ID = z.union([z.string(), z.number()]).transform(Number);
const PAISE = z.number().int('Amounts are in whole paise.');
const STATE = z.string().regex(/^\d{2}$/);

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function asPreview<T extends object>(view: string, run: () => Promise<T>) {
  try {
    return { view, problem: null, ...(await run()) };
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) return { view, problem: e.message };
    throw e;
  }
}

const Q = z.object({
  view: z.enum(['gstr7', 'gstr7-file', 'gstr7a', 'tds-preview', 'gstr8', 'gstr8-file', 'eco-preview', 'roles']),
  period: MONTH.optional(),
  gstin: z.string().trim().toUpperCase().length(15).optional(),
  billId: z.string().optional(),
  vendorId: z.string().optional(),
  date: DATE.optional(),
  contractValuePaise: z.coerce.number().int().optional(),
  taxablePaise: z.coerce.number().int().optional(),
  pos: STATE.optional(),
  // eco-preview
  supplierId: z.string().optional(),
  section: z.enum(['52', '9_5']).optional(),
  supR: z.coerce.number().int().optional(),
  retsupR: z.coerce.number().int().optional(),
  supU: z.coerce.number().int().optional(),
  retsupU: z.coerce.number().int().optional(),
  gstRatePct: z.coerce.number().optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const today = localToday();
    const period = q.period ?? today.slice(0, 7);
    switch (q.view) {
      case 'roles': {
        const r = await roleProfile(db, orgId);
        return { view: q.view, tds: r.tds, eco: r.eco, branchGstin: r.branch.gstin, stateCode: r.branch.stateCode };
      }
      case 'gstr7':
        return { view: q.view, ...(await gstr7(db, orgId, period, today)) };
      // Exactly the GSTN schema, nothing of ours mixed in.
      case 'gstr7-file':
        return gstr7PortalJson(await gstr7(db, orgId, period, today));
      case 'gstr7a': {
        if (!q.gstin) throw badRequest('Whose certificate? Pass the deductee\'s GSTIN.');
        return { view: q.view, ...(await gstr7aCertificate(db, orgId, period, q.gstin)) };
      }
      // A preview answers while the window is being filled in, so what is not
      // allowed yet comes back as a problem to show, not as a refused request.
      case 'tds-preview':
        return asPreview(q.view, () => previewGstTds(db, orgId, {
            billId: q.billId ? Number(q.billId) : null, vendorId: q.vendorId ? Number(q.vendorId) : null,
            deductionDate: q.date ?? today, contractValuePaise: q.contractValuePaise ?? null, taxablePaise: q.taxablePaise ?? null,
            placeOfSupply: q.pos ?? null,
          }));
      case 'gstr8':
        return { view: q.view, ...(await gstr8(db, orgId, period, today)) };
      case 'gstr8-file':
        return gstr8PortalJson(await gstr8(db, orgId, period, today));
      case 'eco-preview': {
        const { supplierId, section, pos } = q;
        if (!supplierId || !section || !pos) throw badRequest('Pick the supplier, the section and the place of supply.');
        return asPreview(q.view, () => previewEcoSupply(db, orgId, {
            supplierId: Number(supplierId), entryDate: q.date ?? today, section, placeOfSupply: pos,
            grossRegisteredPaise: q.supR ?? 0, returnsRegisteredPaise: q.retsupR ?? 0, grossUnregisteredPaise: q.supU ?? 0, returnsUnregisteredPaise: q.retsupU ?? 0,
            gstRatePct: q.gstRatePct ?? null,
          }));
      }
    }
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Deduction = z.object({
  billId: ID.nullish(),
  vendorId: ID.nullish(),
  deductionDate: DATE,
  contractRef: z.string().trim().max(100).nullish(),
  contractValuePaise: PAISE.nonnegative().nullish(),
  taxablePaise: PAISE.positive().nullish(),
  placeOfSupply: STATE.nullish(),
  notes: z.string().trim().max(300).nullish(),
});

const Supply = z.object({
  supplierId: ID,
  entryDate: DATE,
  section: z.enum(['52', '9_5']),
  placeOfSupply: STATE,
  grossRegisteredPaise: PAISE.nonnegative(),
  returnsRegisteredPaise: PAISE.nonnegative(),
  grossUnregisteredPaise: PAISE.nonnegative(),
  returnsUnregisteredPaise: PAISE.nonnegative(),
  gstRatePct: z.number().min(0).max(40).nullish(),
  notes: z.string().trim().max(300).nullish(),
});

const Payment = z.object({
  returnType: z.enum(['GSTR7', 'GSTR8']),
  period: MONTH,
  paidOn: DATE,
  cpin: z.string().trim().max(20).nullish(),
  bankAccountId: ID,
  igstPaise: PAISE.nonnegative(),
  cgstPaise: PAISE.nonnegative(),
  sgstPaise: PAISE.nonnegative(),
  interestPaise: PAISE.nonnegative().optional(),
  lateFeePaise: PAISE.nonnegative().optional(),
  notes: z.string().trim().max(300).nullish(),
});

const PostInput = z.discriminatedUnion('action', [
  Deduction.extend({ action: z.literal('tds-deduct') }),
  z.object({
    action: z.literal('tds-amend'), id: ID, date: DATE, deducteeGstin: z.string().trim().toUpperCase().length(15).nullish(),
    taxablePaise: PAISE.nonnegative(), placeOfSupply: STATE.nullish(), notes: z.string().trim().max(300).nullish(),
  }),
  Supply.extend({ action: z.literal('eco-supply') }),
  z.object({
    action: z.literal('eco-amend'), id: ID, date: DATE, supplierGstin: z.string().trim().toUpperCase().length(15).nullish(),
    grossRegisteredPaise: PAISE.nonnegative(), returnsRegisteredPaise: PAISE.nonnegative(),
    grossUnregisteredPaise: PAISE.nonnegative(), returnsUnregisteredPaise: PAISE.nonnegative(), notes: z.string().trim().max(300).nullish(),
  }),
  Payment.extend({ action: z.literal('payment') }),
  z.object({ action: z.literal('certificate'), period: MONTH, gstin: z.string().trim().toUpperCase().length(15), certificateNo: z.string().trim().max(30).nullish() }),
]);

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, PostInput);
    if ((input.action === 'tds-amend' || input.action === 'eco-amend' || input.action === 'certificate') && !hasPermission(role, 'gst', 'edit')) {
      throw forbidden('Your role cannot change GST records.');
    }
    const audit = (trx: Parameters<typeof logAudit>[0]['trx'], a: { action: 'create' | 'update'; type: string; id: number | string; label: string; detail: string }) => logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: a.action,
      targetType: a.type, targetId: a.id, targetLabel: a.label, detail: a.detail, ...auditMeta(req),
    });
    return transaction(async (trx) => {
      switch (input.action) {
        case 'tds-deduct': {
          const { action, ...rest } = input; void action;
          const r = await recordGstTds(trx, orgId, user.userId, rest);
          await audit(trx, { action: 'create', type: 'gst_tds', id: r.id, label: `GST TDS ${r.vendorName}`,
            detail: `GST TDS of ${rupees(r.totalPaise)} deducted from ${r.vendorName} (${r.deducteeGstin}) for ${monthLabel(r.period)}` });
          return r;
        }
        case 'tds-amend': {
          const { action, id, ...rest } = input; void action;
          const r = await amendGstTds(trx, orgId, user.userId, id, rest);
          await audit(trx, { action: 'update', type: 'gst_tds', id, label: `GST TDS ${id}`,
            detail: `GST TDS deduction ${id} amended in GSTR-7 for ${monthLabel(r.month)} (tax ${r.deltaPaise >= 0 ? 'up' : 'down'} ${rupees(Math.abs(r.deltaPaise))})` });
          return r;
        }
        case 'eco-supply': {
          const { action, ...rest } = input; void action;
          const r = await recordEcoSupply(trx, orgId, user.userId, rest);
          await audit(trx, { action: 'create', type: 'gst_eco_supply', id: r.id, label: `Supplies ${r.supplierName}`,
            detail: `${rest.section === '52' ? 'E-commerce TCS' : 'Section 9(5) GST'} of ${rupees(r.totalPaise)} on ${r.supplierName}'s supplies of ${rupees(r.netPaise)} for ${monthLabel(r.period)}` });
          return r;
        }
        case 'eco-amend': {
          const { action, id, ...rest } = input; void action;
          const r = await amendEcoSupply(trx, orgId, user.userId, id, rest);
          await audit(trx, { action: 'update', type: 'gst_eco_supply', id, label: `Supplies ${id}`,
            detail: `E-commerce TCS record ${id} amended in GSTR-8 for ${monthLabel(r.month)} (TCS ${r.deltaPaise >= 0 ? 'up' : 'down'} ${rupees(Math.abs(r.deltaPaise))})` });
          return r;
        }
        case 'payment': {
          const { action, returnType, ...rest } = input; void action;
          const r = returnType === 'GSTR7' ? await recordGstr7Payment(trx, orgId, user.userId, rest) : await recordGstr8Payment(trx, orgId, user.userId, rest);
          await audit(trx, { action: 'create', type: 'gst_tax_payment', id: r.id, label: `${returnType} ${rest.period}`,
            detail: `${returnType === 'GSTR7' ? 'GSTR-7 TDS' : 'GSTR-8 TCS'} for ${monthLabel(rest.period)} paid on ${rest.paidOn}: ${rupees(r.totalPaise)}${rest.cpin ? `, CPIN ${rest.cpin}` : ''}` });
          return r;
        }
        case 'certificate': {
          const r = await setGstr7aNumber(trx, orgId, input.period, input.gstin, input.certificateNo ?? null);
          await audit(trx, { action: 'update', type: 'gst_tds', id: `${input.gstin}:${input.period}`, label: `GSTR-7A ${input.gstin}`,
            detail: r.certificateNo ? `GSTR-7A ${r.certificateNo} recorded for ${input.gstin}, ${monthLabel(input.period)}` : `GSTR-7A number cleared for ${input.gstin}, ${monthLabel(input.period)}` });
          return r;
        }
      }
    });
  },
  { permission: { module: 'gst', action: 'create' } },
);

const PutInput = z.discriminatedUnion('kind', [
  Deduction.extend({ kind: z.literal('tds'), id: ID }),
  Supply.extend({ kind: z.literal('eco'), id: ID }),
  Payment.extend({ kind: z.literal('payment'), id: ID }),
]);

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, PutInput);
    return transaction(async (trx) => {
      const log = (type: string, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: type, targetId: input.id, detail, ...auditMeta(req),
      });
      if (input.kind === 'tds') {
        const { kind, id, ...rest } = input; void kind;
        const r = await updateGstTds(trx, orgId, user.userId, id, rest);
        await log('gst_tds', `GST TDS deduction ${id} changed: now ${rupees(r.totalPaise)} for ${monthLabel(r.period)} (entry reversed and posted again)`);
        return r;
      }
      if (input.kind === 'eco') {
        const { kind, id, ...rest } = input; void kind;
        const r = await updateEcoSupply(trx, orgId, user.userId, id, rest);
        await log('gst_eco_supply', `E-commerce supplies record ${id} changed: tax now ${rupees(r.totalPaise)} (entry reversed and posted again)`);
        return r;
      }
      const { kind, id, returnType, ...rest } = input; void kind;
      const r = returnType === 'GSTR7' ? await updateGstr7Payment(trx, orgId, user.userId, id, rest) : await updateGstr8Payment(trx, orgId, user.userId, id, rest);
      await log('gst_tax_payment', `${returnType} payment for ${monthLabel(rest.period)} changed (entry reversed and posted again)`);
      return r;
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({
      kind: z.enum(['tds', 'eco', 'payment', 'tds-amendment', 'eco-amendment']),
      id: ID,
      month: MONTH.optional(),
      reason: z.string().trim().max(300).optional(),
    }));
    return transaction(async (trx) => {
      let detail: string;
      let type: string;
      switch (q.kind) {
        case 'tds': {
          const r = await deleteGstTds(trx, orgId, user.userId, q.id, q.reason);
          detail = `${r.label} deleted (entry reversed, the bill owed again)`; type = 'gst_tds';
          break;
        }
        case 'eco': {
          const r = await deleteEcoSupply(trx, orgId, user.userId, q.id, q.reason);
          detail = `${r.label} deleted (entry reversed)`; type = 'gst_eco_supply';
          break;
        }
        case 'payment': {
          // One payment table for both returns: the record says which it was for.
          const r = await deleteGstr7Payment(trx, orgId, user.userId, q.id, q.reason);
          detail = `${r.label} deleted (entry reversed)`; type = 'gst_tax_payment';
          break;
        }
        case 'tds-amendment': {
          if (!q.month) throw badRequest('Which month\'s amendment? Pass month.');
          await undoGstTdsAmendment(trx, orgId, user.userId, q.id, q.month, q.reason);
          detail = `Amendment of GST TDS deduction ${q.id} in ${monthLabel(q.month)} undone`; type = 'gst_tds';
          break;
        }
        case 'eco-amendment': {
          if (!q.month) throw badRequest('Which month\'s amendment? Pass month.');
          await undoEcoAmendment(trx, orgId, user.userId, q.id, q.month, q.reason);
          detail = `Amendment of e-commerce supplies record ${q.id} in ${monthLabel(q.month)} undone`; type = 'gst_eco_supply';
          break;
        }
      }
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: type, targetId: q.id,
        detail, reason: q.reason ?? null, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'gst', action: 'void' } },
);
