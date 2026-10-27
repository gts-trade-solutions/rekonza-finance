import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, notFound } from '@/lib/server/http';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import {
  addAsset, addCost, assetRegister, disposeAsset, ensureAssetClasses, itDepreciation, listAssetClasses,
  listRuns, minimumGstOnSale, nextRunFrom, previewDepreciation, putToUse, recordVerification, reverseLatestRun,
  runDepreciation, saveAssetClass, setItOpening,
} from '@/lib/server/services/fixed-assets';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed assets: the register, depreciation runs, disposals and the Income-tax
// book. See lib/server/services/fixed-assets.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const Id = z.union([z.string(), z.number()]);
const lastFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['register', 'runs', 'it', 'asset', 'preview', 'sale-advice']).default('register'),
      id: z.string().optional(),
      branchId: z.string().optional(),
      to: DATE.optional(),
      date: DATE.optional(),
      fy: z.coerce.number().int().min(2000).max(2100).optional(),
      asOf: DATE.optional(),
    }));
    await transaction((trx) => ensureAssetClasses(trx, orgId));

    switch (q.view) {
      case 'runs': {
        const branches = await db.selectFrom('branches').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).execute();
        const next = await Promise.all(branches.map(async (b) => ({ branchId: asId(b.id), branchName: b.name, from: await nextRunFrom(db, orgId, b.id) })));
        return { runs: await listRuns(db, orgId), next };
      }
      case 'preview': {
        const p = await previewDepreciation(db, orgId, Number(q.branchId), q.to ?? new Date().toISOString().slice(0, 10));
        return { ...p, lines: p.lines.map((l) => ({ ...l, assetId: asId(l.assetId) })) };
      }
      case 'it':
        return { fy: q.fy ?? lastFy(), blocks: await itDepreciation(db, orgId, q.fy ?? lastFy()) };
      case 'sale-advice': {
        const a = await db.selectFrom('fixed_assets').select(['itc_claimed', 'acquired_on'])
          .where('id', '=', Number(q.id)).where('org_id', '=', orgId).executeTakeFirst();
        if (!a) throw notFound('That asset is not in the register.');
        const on = q.date ?? new Date().toISOString().slice(0, 10);
        return {
          itcClaimedPaise: toPaiseFromSql(a.itc_claimed),
          minimumTaxPaise: minimumGstOnSale(toPaiseFromSql(a.itc_claimed), String(a.acquired_on).slice(0, 10), on),
        };
      }
      case 'asset': {
        const id = Number(q.id);
        const a = await db.selectFrom('fixed_assets as a').innerJoin('asset_classes as c', 'c.id', 'a.class_id')
          .leftJoin('contacts as v', 'v.id', 'a.vendor_id').leftJoin('bills as b', 'b.id', 'a.bill_id')
          .leftJoin('invoices as i', 'i.id', 'a.disposal_invoice_id')
          .select(['a.id', 'a.tag_no', 'a.name', 'a.description', 'a.serial_no', 'a.location', 'a.custodian', 'a.hsn_sac',
            'a.status', 'a.acquired_on', 'a.put_to_use_on', 'a.disposed_on', 'a.disposal_kind', 'a.disposal_value',
            'a.insurance_policy_no', 'a.insurance_expiry', 'a.amc_vendor', 'a.amc_expiry', 'a.notes', 'a.itc_claimed',
            'a.useful_life_years', 'a.residual_value', 'a.opening_accumulated', 'a.branch_id',
            'c.name as class_name', 'c.method', 'c.useful_life_years as class_life', 'c.residual_pct',
            'v.display_name as vendor_name', 'b.internal_no as bill_no', 'i.number as invoice_no'])
          .where('a.id', '=', id).where('a.org_id', '=', orgId).executeTakeFirst();
        if (!a) throw notFound('That asset is not in the register.');
        const [costs, dep, checks] = await Promise.all([
          db.selectFrom('asset_costs').selectAll().where('asset_id', '=', id).orderBy('cost_date').execute(),
          db.selectFrom('depreciation_lines').selectAll().where('asset_id', '=', id).where('reversed', '=', 0).orderBy('period_to').execute(),
          db.selectFrom('asset_verifications as v').leftJoin('users as u', 'u.id', 'v.verified_by_user_id')
            .select(['v.id', 'v.verified_on', 'v.found', 'v.condition', 'v.location', 'v.notes', 'u.name as by'])
            .where('v.asset_id', '=', id).orderBy('v.verified_on', 'desc').execute(),
        ]);
        const d = (v: unknown) => (v ? String(v).slice(0, 10) : null);
        return {
          asset: {
            id: asId(a.id), tagNo: a.tag_no, name: a.name, description: a.description, serialNo: a.serial_no,
            location: a.location, custodian: a.custodian, hsnSac: a.hsn_sac, status: a.status, branchId: asId(a.branch_id),
            acquiredOn: d(a.acquired_on), putToUseOn: d(a.put_to_use_on), disposedOn: d(a.disposed_on),
            disposalKind: a.disposal_kind, disposalValuePaise: a.disposal_value ? toPaiseFromSql(a.disposal_value) : null,
            insurancePolicyNo: a.insurance_policy_no, insuranceExpiry: d(a.insurance_expiry), amcVendor: a.amc_vendor,
            amcExpiry: d(a.amc_expiry), notes: a.notes, itcClaimedPaise: toPaiseFromSql(a.itc_claimed),
            className: a.class_name, method: a.method,
            usefulLifeYears: Number(a.useful_life_years ?? a.class_life),
            residualValuePaise: a.residual_value !== null ? toPaiseFromSql(a.residual_value) : null,
            residualPct: Number(a.residual_pct), openingAccumulatedPaise: toPaiseFromSql(a.opening_accumulated),
            vendorName: a.vendor_name, billNo: a.bill_no, invoiceNo: a.invoice_no,
          },
          costs: costs.map((c) => ({ id: asId(c.id), date: d(c.cost_date), amountPaise: toPaiseFromSql(c.amount), kind: c.kind, description: c.description })),
          depreciation: dep.map((l) => ({ id: asId(l.id), from: d(l.period_from), to: d(l.period_to), days: l.days, amountPaise: toPaiseFromSql(l.amount), disposal: !!l.disposal })),
          verifications: checks.map((v) => ({ id: asId(v.id), date: d(v.verified_on), found: !!v.found, condition: v.condition, location: v.location, notes: v.notes, by: v.by })),
        };
      }
      default: {
        const [assets, classes] = await Promise.all([assetRegister(db, orgId, q.asOf), listAssetClasses(db, orgId)]);
        return { asOf: q.asOf ?? new Date().toISOString().slice(0, 10), assets, classes };
      }
    }
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bill'), billId: Id, fromAccountId: Id.nullish() }),
  z.object({ kind: z.literal('paid'), fromAccountId: Id }),
  z.object({ kind: z.literal('opening'), accumulatedPaise: z.number().int().min(0).optional() }),
]);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    branchId: Id.optional(),
    classId: Id,
    tagNo: z.string().trim().max(30).nullish(),
    name: z.string().trim().min(1, 'Name the asset.').max(200),
    description: z.string().trim().max(500).nullish(),
    serialNo: z.string().trim().max(80).nullish(),
    location: z.string().trim().max(150).nullish(),
    custodian: z.string().trim().max(150).nullish(),
    hsnSac: z.string().trim().max(10).nullish(),
    acquiredOn: DATE,
    putToUseOn: DATE.nullish(),
    costPaise: z.number().int().positive(),
    source: Source,
    itcClaimedPaise: z.number().int().min(0).optional(),
    residualValuePaise: z.number().int().min(0).nullish(),
    usefulLifeYears: z.number().positive().max(100).nullish(),
    insurancePolicyNo: z.string().trim().max(60).nullish(),
    insuranceExpiry: DATE.nullish(),
    amcVendor: z.string().trim().max(150).nullish(),
    amcExpiry: DATE.nullish(),
    notes: z.string().trim().max(500).nullish(),
  }),
  z.object({ action: z.literal('cost'), id: Id, date: DATE, amountPaise: z.number().int().positive(), fromAccountId: Id, description: z.string().trim().max(300).nullish() }),
  z.object({ action: z.literal('put-to-use'), id: Id, date: DATE }),
  z.object({ action: z.literal('run'), branchId: Id, to: DATE }),
  z.object({ action: z.literal('reverse-run'), branchId: Id }),
  z.object({
    action: z.literal('dispose'), id: Id, date: DATE, kind: z.enum(['sold', 'scrapped']),
    customerId: Id.nullish(), salePaise: z.number().int().positive().nullish(), gstRatePct: z.number().min(0).max(40).nullish(),
  }),
  z.object({
    action: z.literal('verify'), id: Id, date: DATE, found: z.boolean(),
    condition: z.enum(['good', 'needs_repair', 'unusable']).nullish(), location: z.string().trim().max(150).nullish(), notes: z.string().trim().max(300).nullish(),
  }),
  z.object({
    action: z.literal('details'), id: Id,
    name: z.string().trim().min(1).max(200).optional(), location: z.string().trim().max(150).nullish(),
    custodian: z.string().trim().max(150).nullish(), serialNo: z.string().trim().max(80).nullish(),
    insurancePolicyNo: z.string().trim().max(60).nullish(), insuranceExpiry: DATE.nullish(),
    amcVendor: z.string().trim().max(150).nullish(), amcExpiry: DATE.nullish(), notes: z.string().trim().max(500).nullish(),
  }),
  z.object({
    action: z.literal('class'), id: Id.optional(), name: z.string().trim().min(1).max(100), accountId: Id,
    method: z.enum(['slm', 'wdv']), usefulLifeYears: z.number().positive().max(100), residualPct: z.number().min(0).max(99),
    itBlock: z.string().trim().min(1).max(60), itRatePct: z.number().min(0).max(100), isIntangible: z.boolean().optional(),
  }),
  z.object({ action: z.literal('it-opening'), fyStart: z.number().int().min(2000).max(2100), block: z.string().trim().min(1).max(60), ratePct: z.number().min(0).max(100), openingPaise: z.number().int().min(0) }),
]);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, Input);
    const audit = (action: 'create' | 'update' | 'void', targetId: number, label: string, detail: string, payload?: unknown) => ({
      orgId, actorUserId: user.userId, actorName: user.name, action, targetType: 'fixed_asset', targetId, targetLabel: label, detail, payload, ...auditMeta(req),
    });
    const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

    return transaction(async (trx) => {
      await ensureAssetClasses(trx, orgId);
      switch (input.action) {
        case 'add': {
          const source = input.source.kind === 'bill'
            ? { kind: 'bill' as const, billId: Number(input.source.billId), fromAccountId: n(input.source.fromAccountId) }
            : input.source.kind === 'paid'
              ? { kind: 'paid' as const, fromAccountId: Number(input.source.fromAccountId) }
              : { kind: 'opening' as const, accumulatedPaise: input.source.accumulatedPaise };
          const r = await addAsset(trx, orgId, user.userId, {
            ...input, branchId: n(input.branchId) ?? branchId, classId: Number(input.classId), source,
          });
          await logAudit({ trx, ...audit('create', r.id, r.tagNo, `${input.name}, cost ₹${(input.costPaise / 100).toLocaleString('en-IN')}, ${input.source.kind}`) });
          return { id: asId(r.id), tagNo: r.tagNo };
        }
        case 'cost': {
          await addCost(trx, orgId, user.userId, Number(input.id), {
            date: input.date, amountPaise: input.amountPaise, fromAccountId: Number(input.fromAccountId), description: input.description,
          });
          await logAudit({ trx, ...audit('update', Number(input.id), String(input.id), `Cost of ₹${(input.amountPaise / 100).toLocaleString('en-IN')} added on ${input.date}`) });
          return { ok: true };
        }
        case 'put-to-use': {
          const r = await putToUse(trx, orgId, user.userId, Number(input.id), input.date);
          await logAudit({ trx, ...audit('update', Number(input.id), String(input.id), `Put to use on ${input.date}; ₹${(r.costPaise / 100).toLocaleString('en-IN')} out of CWIP`) });
          return { ok: true };
        }
        case 'run': {
          const r = await runDepreciation(trx, orgId, user.userId, Number(input.branchId), input.to);
          if (r.runId) await logAudit({ trx, ...audit('create', r.runId, `Depreciation to ${input.to}`, `₹${(r.totalPaise / 100).toLocaleString('en-IN')} from ${r.from}`) });
          return { runId: r.runId ? asId(r.runId) : null, totalPaise: r.totalPaise, from: r.from, to: r.to };
        }
        case 'reverse-run': {
          const r = await reverseLatestRun(trx, orgId, user.userId, Number(input.branchId));
          await logAudit({ trx, ...audit('void', r.runId, `Depreciation run ${r.runId}`, 'Undone') });
          return { ok: true };
        }
        case 'dispose': {
          const r = await disposeAsset(trx, orgId, user.userId, Number(input.id), {
            date: input.date, kind: input.kind, customerId: n(input.customerId) ?? undefined,
            salePaise: input.salePaise ?? undefined, gstRatePct: input.gstRatePct ?? undefined,
          });
          await logAudit({ trx, ...audit('void', Number(input.id), String(input.id),
            `${input.kind === 'sold' ? `Sold on ${input.date}${r.invoiceNumber ? ` by ${r.invoiceNumber}` : ''}` : `Scrapped on ${input.date}`}; ` +
              `${r.gainPaise >= 0 ? 'gain' : 'loss'} ₹${(Math.abs(r.gainPaise) / 100).toLocaleString('en-IN')}`) });
          return {
            invoiceId: r.invoiceId ? asId(r.invoiceId) : null, invoiceNumber: r.invoiceNumber, gainPaise: r.gainPaise,
            minimumTaxPaise: r.minimumTaxPaise, invoiceTaxPaise: r.invoiceTaxPaise, shortTaxPaise: r.shortTaxPaise,
          };
        }
        case 'verify': {
          await recordVerification(trx, orgId, user.userId, Number(input.id), {
            date: input.date, found: input.found, condition: input.condition, location: input.location, notes: input.notes,
          });
          await logAudit({ trx, ...audit('update', Number(input.id), String(input.id), `Verified on ${input.date}: ${input.found ? 'found' : 'NOT FOUND'}`) });
          return { ok: true };
        }
        case 'details': {
          const id = Number(input.id);
          const patch: Record<string, unknown> = {};
          const set = (col: string, v: unknown) => { if (v !== undefined) patch[col] = v; };
          set('name', input.name); set('location', input.location); set('custodian', input.custodian);
          set('serial_no', input.serialNo); set('insurance_policy_no', input.insurancePolicyNo);
          set('insurance_expiry', input.insuranceExpiry); set('amc_vendor', input.amcVendor);
          set('amc_expiry', input.amcExpiry); set('notes', input.notes);
          const before = await snapshot(trx, 'fixed_assets', orgId, id, Object.keys(patch));
          if (!Object.keys(before).length && Object.keys(patch).length) throw notFound('That asset is not in the register.');
          if (Object.keys(patch).length) await trx.updateTable('fixed_assets').set(patch).where('id', '=', id).where('org_id', '=', orgId).execute();
          const changes = changesBetween(before, patch);
          await logAudit({ trx, ...audit('update', id, String(id), `Details: ${describeChanges(changes)}`, { changes }) });
          return { ok: true };
        }
        case 'class': {
          const id = await saveAssetClass(trx, orgId, {
            id: n(input.id) ?? undefined, name: input.name, accountId: Number(input.accountId), method: input.method,
            usefulLifeYears: input.usefulLifeYears, residualPct: input.residualPct, itBlock: input.itBlock,
            itRatePct: input.itRatePct, isIntangible: input.isIntangible,
          });
          await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
            targetType: 'asset_class', targetId: id, targetLabel: input.name,
            detail: `${input.method.toUpperCase()} over ${input.usefulLifeYears} years; IT block ${input.itBlock} at ${input.itRatePct}%`, ...auditMeta(req) });
          return { id: asId(id) };
        }
        case 'it-opening': {
          await setItOpening(trx, orgId, { fyStart: input.fyStart, block: input.block, ratePct: input.ratePct, openingPaise: input.openingPaise });
          await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
            targetType: 'it_block_opening', targetId: input.fyStart, targetLabel: input.block,
            detail: `Opening WDV for FY ${input.fyStart}: ₹${(input.openingPaise / 100).toLocaleString('en-IN')}`, ...auditMeta(req) });
          return { ok: true };
        }
      }
    });
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
