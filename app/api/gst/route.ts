import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { gstr1, gstr3b, iff } from '@/lib/server/gst/returns';
import { gstr9 } from '@/lib/server/gst/gstr9';
import { gstr9c } from '@/lib/server/gst/gstr9c';
import { gstr1PortalFile } from '@/lib/server/gst/gstr1-json';
import { einvoiceQueue, itcReconciliation, tdsSummary } from '@/lib/server/gst/compliance';
import { cancelEinvoice, previewEinvoice, registerInvoice } from '@/lib/server/integrations/gst/einvoice-service';
import { CANCEL_REASONS } from '@/lib/server/integrations/gst';
import { einvoiceReadiness } from '@/lib/server/integrations/gst/readiness';
import {
  cancelEwayBill, changeEwayVehicle, checkEwayBill, extendEwayBill, generateEwayBill,
} from '@/lib/server/integrations/gst/eway-service';
import {
  EWB_CANCEL_REASONS, EWB_EXTEND_REASONS, VEHICLE_CHANGE_REASONS,
  assessEwayBill, canExtend, ewbCancelDeadline,
} from '@/lib/tax/eway';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { queuedRetries, retryAfterOutage } from '@/lib/server/jobs/queue';
import '@/lib/server/jobs/boot';

// ─────────────────────────────────────────────────────────────────────────────
// One endpoint for the GST screens.
//
// They all read the same invoices and bills through different lenses, and every
// one is recomputed on request. A return is a statement about a closed period;
// the only way it can be wrong is by disagreeing with the documents behind it,
// so nothing is cached in between.
//
// The portal actions are the exception — registering and cancelling an IRN,
// and generating, changing or cancelling an e-way bill. They leave the app and
// change state somewhere else. All of them live in lib/server/integrations/gst,
// behind a provider interface, and this file only decides who is allowed to ask.
// ─────────────────────────────────────────────────────────────────────────────

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'Give the period as yyyy-mm.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Q = z.object({
  view: z.enum([
    'gstr1', 'gstr1-file', 'gstr3b', 'iff', 'gstr9', 'gstr9c', 'einvoices', 'eway-bills', 'itc', 'tds',
    'einvoice-preview', 'eway-check',
  ]),
  /** gstr1-file: the whole return, or only the B2B part that IFF takes. */
  scope: z.enum(['gstr1', 'iff']).optional(),
  period: MONTH.optional(),
  /** GSTR-9: the year the financial year starts in, e.g. 2026 for 2026-27. */
  fy: z.coerce.number().int().min(2017).max(2100).optional(),
  from: DATE.optional(),
  to: DATE.optional(),
  status: z.string().optional(),
  branchId: z.string().optional(),
  /** For the two single-document views. */
  invoiceId: z.string().optional(),
  challanId: z.string().optional(),
});

const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * ₹50,000 — the floor below which no state requires a bill, so nothing under
 * it is worth listing. States may set a *higher* intra-state limit, and that
 * is applied per row afterwards by `assessEwayBill`; SQL cannot do it, because
 * the threshold depends on the pair of states involved.
 *
 * In rupees, because that is the unit the DECIMAL columns hold.
 */
const EWB_FLOOR_RUPEES = 50_000;

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const period = q.period ?? thisMonth();
    const branchId = q.branchId ? Number(q.branchId) : undefined;

    switch (q.view) {
      case 'gstr1':
        return { view: q.view, ...(await gstr1(db, orgId, period, branchId)) };

      case 'gstr1-file':
        // Exactly the portal's file, with nothing of ours mixed in.
        return gstr1PortalFile(db, orgId, period, { branchId, scope: q.scope });

      case 'iff':
        return { view: q.view, ...(await iff(db, orgId, period, branchId)) };

      case 'gstr9': {
        const now = new Date();
        const fy = q.fy ?? now.getFullYear() - (now.getMonth() < 3 ? 1 : 0) - 1;
        return { view: q.view, ...(await gstr9(db, orgId, fy, branchId)) };
      }

      case 'gstr9c': {
        const now = new Date();
        const fy = q.fy ?? now.getFullYear() - (now.getMonth() < 3 ? 1 : 0) - 1;
        return { view: q.view, ...(await gstr9c(db, orgId, fy, branchId)) };
      }

      case 'gstr3b':
        return { view: q.view, ...(await gstr3b(db, orgId, period, branchId)) };

      case 'einvoices': {
        const [{ rows, counts }, portal] = await Promise.all([
          einvoiceQueue(db, orgId, q.status),
          einvoiceReadiness(db, orgId),
        ]);
        return { view: q.view, einvoices: rows, statusCounts: counts, portal };
      }

      case 'itc':
        return { view: q.view, period, ...(await itcReconciliation(db, orgId, period)) };

      case 'tds': {
        // The financial year to date by default: TDS thresholds are annual, so
        // a monthly view of them tells you nothing about whether one was crossed.
        const today = new Date().toISOString().slice(0, 10);
        const fyStart = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
        const from = q.from ?? `${fyStart}-04-01`;
        const to = q.to ?? today;
        return { view: q.view, from, to, ...(await tdsSummary(db, orgId, from, to)) };
      }

      // Build the document and check it, without submitting anything. The
      // useful half of the e-invoice integration before a GSP exists: it says
      // whether the portal would accept this invoice, and if not why, in words
      // rather than error codes — and it costs no attempt.
      case 'einvoice-preview': {
        if (!q.invoiceId) throw badRequest('Which invoice? Pass invoiceId.');
        return { view: q.view, ...(await previewEinvoice(db, orgId, Number(q.invoiceId))) };
      }

      case 'eway-check': {
        const doc = q.invoiceId
          ? ({ kind: 'invoice', id: Number(q.invoiceId) } as const)
          : q.challanId
            ? ({ kind: 'challan', id: Number(q.challanId) } as const)
            : null;
        if (!doc) throw badRequest('Which document? Pass invoiceId or challanId.');
        return { view: q.view, ...(await checkEwayBill(db, orgId, doc)) };
      }

      case 'eway-bills': {
        // Two kinds of document move goods, and only one of them is a sale.
        //
        // An invoice is the obvious case. A delivery challan is the one that
        // catches people out: material going to a job worker, stock moving
        // between your own branches, goods out on approval. None of those is a
        // sale, none has an invoice, and every one of them still needs a bill
        // before the lorry leaves — for inter-state job work, whatever the
        // goods are worth. A register built only on invoices shows a clean
        // screen while a vehicle is travelling illegally.
        const { rows } = await sql<{
          doc_kind: 'invoice' | 'challan';
          doc_id: number; id: number | null; number: string; doc_date: string;
          customer_name: string; place_of_supply: string; total: string;
          supply_kind: 'goods' | 'service' | 'both'; movement: string; deemed_inter: number;
          from_state: string; to_state: string; intra_threshold: string | null;
          eway_bill_no: string | null; status: string | null; vehicle_no: string | null;
          transporter_name: string | null; distance_km: number | null;
          // DATETIME columns arrive as Date objects: the pool keeps only DATE as text.
          valid_until: Date | null; generated_at: Date | null; transport_mode: string | null;
          extended_count: number | null; error_message: string | null;
        }>`
          SELECT 'invoice' AS doc_kind, i.id AS doc_id, w.id, i.number,
                 i.invoice_date AS doc_date, c.display_name AS customer_name,
                 i.place_of_supply, i.total, i.supply_kind,
                 CASE WHEN i.supply_type IN ('export_lut','export_with_tax')
                      THEN 'export' ELSE 'supply' END AS movement,
                 -- Inter-state by statute even when the SEZ is next door, so
                 -- a state's higher intra-state limit must not apply.
                 CASE WHEN i.supply_type IN ('sez','export_lut','export_with_tax')
                      THEN 1 ELSE 0 END AS deemed_inter,
                 b.state_code AS from_state, c.state_code AS to_state, b.eway_intra_threshold AS intra_threshold,
                 w.eway_bill_no, w.status, w.vehicle_no, w.transporter_name,
                 w.distance_km, w.valid_until, w.generated_at, w.transport_mode,
                 w.extended_count, w.error_message
            FROM invoices i
            JOIN contacts c ON c.id = i.customer_id
            JOIN branches b ON b.id = i.branch_id
            LEFT JOIN eway_bills w ON w.invoice_id = i.id
           WHERE i.org_id = ${orgId}
             AND i.status NOT IN ('draft', 'void')
             AND i.supply_kind <> 'service'
             AND i.total >= ${EWB_FLOOR_RUPEES}

          UNION ALL

          SELECT 'challan' AS doc_kind, d.id AS doc_id, w.id, d.number,
                 d.challan_date AS doc_date, c.display_name AS customer_name,
                 d.place_of_supply, d.total, 'goods' AS supply_kind,
                 CASE d.challan_type
                   WHEN 'job_work' THEN 'job_work'
                   WHEN 'supply_on_approval' THEN 'line_sales'
                   WHEN 'liquid_gas' THEN 'supply'
                   ELSE 'others' END AS movement,
                 0 AS deemed_inter,
                 b.state_code AS from_state, c.state_code AS to_state, b.eway_intra_threshold AS intra_threshold,
                 w.eway_bill_no, w.status, w.vehicle_no, w.transporter_name,
                 w.distance_km, w.valid_until, w.generated_at, w.transport_mode,
                 w.extended_count, w.error_message
            FROM delivery_challans d
            JOIN contacts c ON c.id = d.customer_id
            JOIN branches b ON b.id = d.branch_id
            LEFT JOIN eway_bills w ON w.challan_id = d.id
           WHERE d.org_id = ${orgId}
             AND d.status <> 'cancelled'
             -- No floor on job work between states: those need a bill at any
             -- value, so filtering them out by amount would hide the risk.
             AND (d.total >= ${EWB_FLOOR_RUPEES}
                  OR (d.challan_type = 'job_work' AND b.state_code <> c.state_code))

           ORDER BY doc_date DESC
           LIMIT 300
        `.execute(db);

        const today = new Date().toISOString().slice(0, 10);
        const now = new Date();
        const retries = await queuedRetries(db, orgId, 'ewb.generate');

        return {
          view: q.view,
          ewayBills: rows.map((r) => {
            const date = String(r.doc_date).slice(0, 10);
            const assessment = assessEwayBill({
              supplyKind: r.supply_kind,
              consignmentPaise: toPaiseFromSql(r.total),
              fromStateCode: r.from_state,
              intraThresholdPaise: r.intra_threshold === null ? null : toPaiseFromSql(r.intra_threshold),
              toStateCode: r.to_state,
              reason: r.movement as Parameters<typeof assessEwayBill>[0]['reason'],
              interStateSupply: Number(r.deemed_inter) === 1,
              docDate: date,
              today,
            });
            // What can still be done to a generated bill, decided here so the
            // screen offers exactly what the server will accept.
            const standing = r.status === 'generated';
            const validUntil = r.valid_until ? new Date(r.valid_until) : null;
            const generatedAt = r.generated_at ? new Date(r.generated_at) : null;
            const cancelBy = standing ? ewbCancelDeadline(generatedAt) : null;
            return {
              id: r.id === null ? null : asId(r.id),
              docKind: r.doc_kind,
              docId: asId(r.doc_id),
              // Kept for the existing screen, which keys off an invoice id.
              invoiceId: r.doc_kind === 'invoice' ? asId(r.doc_id) : null,
              number: r.number,
              date,
              customerName: r.customer_name,
              placeOfSupply: r.place_of_supply,
              totalPaise: toPaiseFromSql(r.total),
              status: r.status ?? 'not_generated',
              ewayBillNo: r.eway_bill_no,
              vehicleNo: r.vehicle_no,
              transporterName: r.transporter_name,
              distanceKm: r.distance_km,
              validUntil: validUntil?.toISOString() ?? null,
              generatedAt: generatedAt?.toISOString() ?? null,
              transportMode: (r.transport_mode ?? 'road') as 'road' | 'rail' | 'air' | 'ship',
              extendedCount: Number(r.extended_count ?? 0),
              errorMessage: r.status === 'pending' ? r.error_message : null,
              cancelUntil: cancelBy && cancelBy > now ? cancelBy.toISOString() : null,
              extension: standing && validUntil && generatedAt ? canExtend(validUntil, generatedAt, now) : null,
              changeable: standing && (!validUntil || validUntil > now),
              retry: retries.get(`${r.doc_kind}:${r.doc_id}`) ?? null,
              // Why this row is on the list, in the words the UI can show.
              required: assessment.required,
              requirementReason: assessment.reason,
              blockers: assessment.blockers,
            };
          }),
        };
      }
    }
  },
  { permission: { module: 'gst', action: 'view' } },
);

const BILL_ID = z.union([z.string(), z.number()]);
const PLACE = z.string().trim().min(1, 'Where are the goods now?').max(100);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('submit-einvoice'),
    invoiceId: z.union([z.string(), z.number()]),
  }),
  z.object({
    action: z.literal('cancel-einvoice'),
    invoiceId: z.union([z.string(), z.number()]),
    // The portal's own reason codes; anything free-form goes in the remark.
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().max(100).optional(),
  }),
  z.object({
    action: z.literal('generate-eway-bill'),
    // One or the other. A challan moves goods just as an invoice does, and the
    // screen has to be able to say which it is asking about.
    invoiceId: z.union([z.string(), z.number()]).optional(),
    challanId: z.union([z.string(), z.number()]).optional(),
    vehicleNo: z.string().trim().max(20).nullish(),
    transporterId: z.string().trim().max(20).nullish(),
    transporterName: z.string().trim().max(150).nullish(),
    transportDocNo: z.string().trim().max(20).nullish(),
    transportDocDate: DATE.nullish(),
    distanceKm: z.number().int().nonnegative().max(4000).nullish(),
    transportMode: z.enum(['road', 'rail', 'air', 'ship']).optional(),
    isOverDimensional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('update-eway-vehicle'),
    ewayBillId: BILL_ID,
    vehicleNo: z.string().trim().max(20).nullish(),
    transportMode: z.enum(['road', 'rail', 'air', 'ship']).optional(),
    transportDocNo: z.string().trim().max(20).nullish(),
    transportDocDate: DATE.nullish(),
    fromPlace: PLACE,
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().max(100).optional(),
  }),
  z.object({
    action: z.literal('extend-eway-bill'),
    ewayBillId: BILL_ID,
    remainingDistanceKm: z.number().int().positive().max(4000),
    fromPlace: PLACE,
    fromPincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Give the six-digit PIN code.'),
    reason: z.enum(['1', '2', '4', '5', '99']),
    remark: z.string().trim().max(100).optional(),
    consignment: z.enum(['in_movement', 'in_transit']),
    vehicleNo: z.string().trim().max(20).nullish(),
  }),
  z.object({
    action: z.literal('cancel-eway-bill'),
    ewayBillId: BILL_ID,
    reason: z.enum(['1', '2', '3', '4']),
    remark: z.string().trim().max(100).optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);

    if (input.action === 'submit-einvoice') {
      const invoiceId = Number(input.invoiceId);
      // A portal that did not answer is queued to try again, not left to a person.
      const result = await transaction((trx) => registerInvoice(trx, orgId, invoiceId)).catch((err: unknown) =>
        retryAfterOutage(err, {
          orgId, userId: user.userId, kind: 'einvoice.register', key: `invoice:${invoiceId}`, payload: { invoiceId },
        }),
      );

      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'approve',
        targetType: 'einvoice', targetId: invoiceId,
        detail:
          `IRN registered via ${result.provider}: ${result.irn.slice(0, 16)}…` +
          (result.ewayBillNo ? ` (e-way bill ${result.ewayBillNo} issued with it)` : ''),
        ...auditMeta(req),
      });

      return result;
    }

    if (input.action === 'cancel-einvoice') {
      const invoiceId = Number(input.invoiceId);
      const result = await transaction((trx) =>
        cancelEinvoice(trx, orgId, user.userId, invoiceId, { reason: input.reason, remark: input.remark ?? '' }),
      );

      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'einvoice', targetId: invoiceId,
        detail:
          `IRN cancelled via ${result.provider} (${CANCEL_REASONS[input.reason]}): ${result.irn.slice(0, 16)}…; ` +
          'the invoice was voided with it' + (result.recovered ? ' (the portal had already cancelled it)' : ''),
        ...auditMeta(req),
      });

      return result;
    }

    if (input.action === 'update-eway-vehicle') {
      const billId = Number(input.ewayBillId);
      const result = await transaction((trx) =>
        changeEwayVehicle(trx, orgId, user.userId, billId, {
          vehicleNo: input.vehicleNo ?? null,
          mode: input.transportMode,
          transportDocNo: input.transportDocNo ?? null,
          transportDocDate: input.transportDocDate ?? null,
          fromPlace: input.fromPlace,
          reason: input.reason,
          remark: input.remark,
        }),
      );

      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'eway_bill', targetId: billId,
        detail:
          `Vehicle on e-way bill ${result.ewayBillNo} changed to ${result.vehicleNo ?? 'a transport document'} ` +
          `at ${input.fromPlace} (${VEHICLE_CHANGE_REASONS[input.reason]})`,
        ...auditMeta(req),
      });

      return result;
    }

    if (input.action === 'extend-eway-bill') {
      const billId = Number(input.ewayBillId);
      const result = await transaction((trx) =>
        extendEwayBill(trx, orgId, user.userId, billId, {
          remainingDistanceKm: input.remainingDistanceKm,
          fromPlace: input.fromPlace,
          fromPincode: input.fromPincode,
          reason: input.reason,
          remark: input.remark,
          consignment: input.consignment,
          vehicleNo: input.vehicleNo ?? null,
        }),
      );

      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'eway_bill', targetId: billId,
        detail:
          `E-way bill ${result.ewayBillNo} extended to ${result.validUntil} ` +
          `(${EWB_EXTEND_REASONS[input.reason]}, ${input.remainingDistanceKm} km to go); ` +
          `extension ${result.extendedCount}`,
        ...auditMeta(req),
      });

      return result;
    }

    if (input.action === 'cancel-eway-bill') {
      const billId = Number(input.ewayBillId);
      const result = await transaction((trx) =>
        cancelEwayBill(trx, orgId, user.userId, billId, { reason: input.reason, remark: input.remark }),
      );

      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'eway_bill', targetId: billId,
        detail:
          `E-way bill ${result.ewayBillNo} cancelled via ${result.provider} (${EWB_CANCEL_REASONS[input.reason]})` +
          (result.recovered ? '; the portal had already cancelled it' : ''),
        ...auditMeta(req),
      });

      return result;
    }

    const doc = input.invoiceId
      ? ({ kind: 'invoice', id: Number(input.invoiceId) } as const)
      : input.challanId
        ? ({ kind: 'challan', id: Number(input.challanId) } as const)
        : null;
    if (!doc) throw badRequest('Which document is moving? Pass invoiceId or challanId.');

    const transport = {
      vehicleNo: input.vehicleNo ?? null,
      transporterId: input.transporterId ?? null,
      transporterName: input.transporterName ?? null,
      transportDocNo: input.transportDocNo ?? null,
      transportDocDate: input.transportDocDate ?? null,
      mode: input.transportMode,
      distanceKm: input.distanceKm ?? null,
      isOverDimensional: input.isOverDimensional,
    };
    const result = await transaction((trx) =>
      generateEwayBill(trx, orgId, doc, transport, { userId: user.userId }),
    ).catch((err: unknown) =>
      retryAfterOutage(err, {
        orgId, userId: user.userId, kind: 'ewb.generate', key: `${doc.kind}:${doc.id}`, payload: { doc, transport },
      }),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'approve',
      targetType: 'eway_bill', targetId: doc.id,
      detail:
        `E-way bill ${result.ewayBillNo} generated via ${result.provider} against ${doc.kind} ` +
        `${doc.id}, valid until ${result.validUntil}`,
      ...auditMeta(req),
    });

    return result;
  },
  { permission: { module: 'gst', action: 'approve' } },
);
