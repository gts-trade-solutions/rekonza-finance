import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Generating an e-way bill, from an invoice or from a delivery challan.
//
// The challan half is the part most software leaves out, and it is where the
// risk actually sits. Sending material out for job work is not a sale — there
// is no invoice, no revenue and no tax — but the lorry still has to be
// declared, and for inter-state job work it has to be declared whatever the
// goods are worth. A register built only on invoices shows a clean screen
// while a vehicle is travelling illegally.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../../../types';
import {
  EWB_CANCEL_REASONS, EWB_EXTEND_REASONS, VEHICLE_CHANGE_REASONS,
  assessEwayBill, canExtend, ewbCancelDeadline, normaliseVehicleNo, validUntil as validityEnd,
  type EwayBillAssessment, type EwbCancelReason, type EwbExtendReason, type MovementReason,
  type VehicleChangeReason,
} from '../../../tax/eway';
import { db, type Executor, type Trx } from '../../db';
import { ApiError, badRequest, conflict, notFound } from '../../http';
import { toNumberFromSql, toPaiseFromSql } from '../../money-sql';
import { toIrpDate } from './einvoice-payload';
import {
  buildEwayBillPayload,
  type EwayBillPayload, type EwayBillSource, type EwbDocType, type EwbLine,
  type StoredSubSupplyType,
} from './eway-payload';
import {
  connectionFor, providerContext, providerLabel, providerServes, resolveProvider, runPortalCall,
  toApiError, type PortalCaller, type PortalConnection,
} from './index';
import {
  PortalRejection, PortalUnavailable, parsePortalTimestamp,
  type EwbByIrn, type EwbExtension, type EwbVehicleChange, type GstProvider,
} from './provider';

// ── What the caller asks for ─────────────────────────────────────────────────

export type EwayBillDocument = { kind: 'invoice'; id: number } | { kind: 'challan'; id: number };

export interface TransportInput {
  vehicleNo?: string | null;
  transporterId?: string | null;
  transporterName?: string | null;
  transportDocNo?: string | null;
  transportDocDate?: string | null;
  mode?: 'road' | 'rail' | 'air' | 'ship';
  distanceKm?: number | null;
  isOverDimensional?: boolean;
}

/**
 * A delivery challan's purpose, mapped to NIC's reason-for-movement code.
 *
 * `supply_on_approval` becomes line sales: goods sent out for the customer to
 * choose from, with the sale crystallising only on what they keep. NIC has no
 * closer code, and "others" would lose the distinction entirely.
 *
 * `liquid_gas` is an ordinary supply — the challan exists only because the
 * quantity is not known until it is delivered, not because the movement is
 * something other than a sale.
 */
const CHALLAN_REASON: Record<string, StoredSubSupplyType> = {
  job_work: 'job_work',
  supply_on_approval: 'line_sales',
  liquid_gas: 'supply',
  other: 'others',
};

// ── Loading ──────────────────────────────────────────────────────────────────

interface Loaded {
  rowId: number | null;
  status: string;
  existingNo: string | null;
  branchId: number;
  docLabel: string;
  docType: EwbDocType;
  reason: MovementReason;
  supplyKind: 'goods' | 'service' | 'both';
  /** SEZ and export supplies are inter-state by statute, wherever the lorry goes. */
  interStateSupply: boolean;
  consignmentPaise: Paise;
  fromStateCode: string;
  toStateCode: string;
  /** The branch's own intra-state threshold, when Settings gives one. */
  intraThresholdPaise: Paise | null;
  fromPincode: string | null;
  toPincode: string | null;
  source: Omit<EwayBillSource, 'transport'>;
}

async function loadDocument(
  ex: Executor,
  orgId: number,
  doc: EwayBillDocument,
): Promise<Loaded> {
  return doc.kind === 'invoice'
    ? loadFromInvoice(ex, orgId, doc.id)
    : loadFromChallan(ex, orgId, doc.id);
}

interface DocShipTo {
  name: string | null; gstin?: string | null; address: string | null; city: string | null;
  pincode: string | null; stateCode: string | null;
}

async function commonParties(
  ex: Executor,
  orgId: number,
  branchId: number,
  customerId: number,
  docShipTo?: DocShipTo | null,
) {
  const branch = await ex
    .selectFrom('branches as b')
    .innerJoin('organizations as o', 'o.id', 'b.org_id')
    .select([
      'b.gstin', 'b.address', 'b.city', 'b.pincode', 'b.state_code', 'b.eway_intra_threshold',
      'o.name as org_name', 'o.legal_name as org_legal_name',
    ])
    .where('b.id', '=', branchId)
    .where('b.org_id', '=', orgId)
    .executeTakeFirstOrThrow();

  const customer = await ex
    .selectFrom('contacts')
    .select([
      'display_name', 'legal_name', 'gstin', 'state_code',
      'billing_address', 'billing_city', 'billing_pincode',
      'shipping_address', 'shipping_city', 'shipping_pincode',
    ])
    .where('id', '=', customerId)
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();

  // Ship-to wins wherever it is filled in — the document's own first, then the
  // customer's. The bill has to describe where the goods are actually going,
  // which is not always where the invoice is sent — and it is the delivery
  // address an officer checks against the route.
  const own = docShipTo?.stateCode ? docShipTo : null;
  const toPlace = own ? own.city : customer.shipping_city ?? customer.billing_city;
  const toPincode = own ? own.pincode : customer.shipping_pincode ?? customer.billing_pincode;
  const toAddress = own ? own.address : customer.shipping_address ?? customer.billing_address;
  const toState = own?.stateCode ?? customer.state_code;

  return {
    from: {
      gstin: branch.gstin,
      tradeName: branch.org_legal_name ?? branch.org_name,
      address1: branch.address,
      place: branch.city,
      pincode: branch.pincode,
      stateCode: branch.state_code,
    },
    to: {
      gstin: own?.gstin ?? customer.gstin,
      tradeName: own?.name ?? customer.legal_name ?? customer.display_name,
      address1: toAddress,
      place: toPlace,
      pincode: toPincode,
      stateCode: toState,
    },
    fromStateCode: branch.state_code,
    toStateCode: toState,
    intraThresholdPaise: branch.eway_intra_threshold === null ? null : toPaiseFromSql(branch.eway_intra_threshold),
    fromPincode: branch.pincode,
    toPincode,
  };
}

async function loadFromInvoice(ex: Executor, orgId: number, invoiceId: number): Promise<Loaded> {
  const inv = await ex
    .selectFrom('invoices')
    .select([
      'id', 'branch_id', 'customer_id', 'number', 'invoice_date', 'status', 'supply_kind',
      'supply_type', 'place_of_supply', 'subtotal', 'cgst', 'sgst', 'igst', 'cess',
      'shipping_charge', 'adjustment', 'total',
      'ship_to_name', 'ship_to_gstin', 'ship_to_address', 'ship_to_city', 'ship_to_pincode', 'ship_to_state_code',
    ])
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.status === 'draft' || inv.status === 'void') {
    throw badRequest('Only an issued invoice can carry an e-way bill.');
  }

  const parties = await commonParties(ex, orgId, inv.branch_id, inv.customer_id, {
    name: inv.ship_to_name, gstin: inv.ship_to_gstin, address: inv.ship_to_address, city: inv.ship_to_city,
    pincode: inv.ship_to_pincode, stateCode: inv.ship_to_state_code,
  });
  const intra = inv.supply_type === 'intra';

  // Joined for the same reason as the e-invoice loader: a catalogue line
  // carries no description of its own, and an officer at a checkpost reading
  // "Line 1" instead of a product name is a conversation nobody wants.
  const lineRows = await ex
    .selectFrom('invoice_lines as l')
    .leftJoin('items as it', 'it.id', 'l.item_id')
    .select([
      'l.line_no', 'l.description', 'l.hsn_sac', 'l.qty', 'l.uqc', 'l.gst_rate_pct', 'l.taxable',
      'it.name as item_name',
    ])
    .where('l.invoice_id', '=', invoiceId)
    .orderBy('l.line_no')
    .execute();

  const lines: EwbLine[] = lineRows.map((l) => ({
    name: (l.description?.trim() || l.item_name || `Line ${l.line_no}`).slice(0, 100),
    description: l.description?.trim() || l.item_name || '',
    hsnSac: l.hsn_sac,
    qty: toNumberFromSql(l.qty),
    uqc: l.uqc,
    gstRatePct: toNumberFromSql(l.gst_rate_pct),
    intra,
    taxablePaise: toPaiseFromSql(l.taxable),
  }));

  const existing = await ex
    .selectFrom('eway_bills')
    .select(['id', 'status', 'eway_bill_no'])
    .where('invoice_id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();

  const reason: MovementReason =
    inv.supply_type === 'export_lut' || inv.supply_type === 'export_with_tax' ? 'export' : 'supply';

  return {
    rowId: existing?.id ?? null,
    status: existing?.status ?? 'pending',
    existingNo: existing?.eway_bill_no ?? null,
    branchId: inv.branch_id,
    docLabel: inv.number,
    docType: 'INV',
    reason,
    supplyKind: inv.supply_kind,
    interStateSupply: ['sez', 'export_lut', 'export_with_tax'].includes(inv.supply_type),
    consignmentPaise: toPaiseFromSql(inv.total),
    fromStateCode: parties.fromStateCode,
    intraThresholdPaise: parties.intraThresholdPaise,
    toStateCode: parties.toStateCode,
    fromPincode: parties.fromPincode,
    toPincode: parties.toPincode,
    source: {
      direction: 'O',
      subSupplyType: reason === 'export' ? 'export' : 'supply',
      docType: 'INV',
      docNo: inv.number,
      docDate: String(inv.invoice_date).slice(0, 10),
      from: parties.from,
      to: parties.to,
      taxablePaise: toPaiseFromSql(inv.subtotal),
      cgstPaise: toPaiseFromSql(inv.cgst),
      sgstPaise: toPaiseFromSql(inv.sgst),
      igstPaise: toPaiseFromSql(inv.igst),
      cessPaise: toPaiseFromSql(inv.cess),
      otherChargesPaise: toPaiseFromSql(inv.shipping_charge) + toPaiseFromSql(inv.adjustment),
      totalPaise: toPaiseFromSql(inv.total),
      lines,
    },
  };
}

async function loadFromChallan(ex: Executor, orgId: number, challanId: number): Promise<Loaded> {
  const ch = await ex
    .selectFrom('delivery_challans')
    .select([
      'id', 'branch_id', 'customer_id', 'number', 'challan_date', 'challan_type',
      'status', 'place_of_supply', 'total',
      'ship_to_name', 'ship_to_address', 'ship_to_city', 'ship_to_pincode', 'ship_to_state_code',
    ])
    .where('id', '=', challanId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!ch) throw notFound('That delivery challan does not exist.');
  if (ch.status === 'cancelled') {
    throw badRequest('A cancelled challan cannot carry an e-way bill.');
  }

  const parties = await commonParties(ex, orgId, ch.branch_id, ch.customer_id, {
    name: ch.ship_to_name, address: ch.ship_to_address, city: ch.ship_to_city,
    pincode: ch.ship_to_pincode, stateCode: ch.ship_to_state_code,
  });

  const lineRows = await ex
    .selectFrom('challan_lines as l')
    .leftJoin('items as it', 'it.id', 'l.item_id')
    .select([
      'l.line_no', 'l.description', 'l.hsn_sac', 'l.qty', 'l.uqc', 'l.line_total',
      'it.name as item_name',
    ])
    .where('l.challan_id', '=', challanId)
    .orderBy('l.line_no')
    .execute();

  // A challan carries no tax — it is not a supply. The value is declared so the
  // consignment can be valued at a checkpost, and the rate columns go as zero.
  const lines: EwbLine[] = lineRows.map((l) => ({
    name: (l.description?.trim() || l.item_name || `Line ${l.line_no}`).slice(0, 100),
    description: l.description?.trim() || l.item_name || '',
    hsnSac: l.hsn_sac,
    qty: toNumberFromSql(l.qty),
    uqc: l.uqc,
    gstRatePct: 0,
    intra: parties.fromStateCode === parties.toStateCode,
    taxablePaise: toPaiseFromSql(l.line_total),
  }));

  const existing = await ex
    .selectFrom('eway_bills')
    .select(['id', 'status', 'eway_bill_no'])
    .where('challan_id', '=', challanId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();

  const reason = (CHALLAN_REASON[ch.challan_type] ?? 'others') as StoredSubSupplyType;
  const total = toPaiseFromSql(ch.total);

  return {
    rowId: existing?.id ?? null,
    status: existing?.status ?? 'pending',
    existingNo: existing?.eway_bill_no ?? null,
    branchId: ch.branch_id,
    docLabel: ch.number,
    docType: 'CHL',
    reason: reason as MovementReason,
    supplyKind: 'goods',
    interStateSupply: false,
    consignmentPaise: total,
    fromStateCode: parties.fromStateCode,
    intraThresholdPaise: parties.intraThresholdPaise,
    toStateCode: parties.toStateCode,
    fromPincode: parties.fromPincode,
    toPincode: parties.toPincode,
    source: {
      direction: 'O',
      subSupplyType: reason,
      docType: 'CHL',
      docNo: ch.number,
      docDate: String(ch.challan_date).slice(0, 10),
      from: parties.from,
      to: parties.to,
      taxablePaise: total,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      cessPaise: 0,
      otherChargesPaise: 0,
      totalPaise: total,
      lines,
    },
  };
}

// ── Assessment, without generating anything ──────────────────────────────────

export interface EwayBillCheck {
  document: EwayBillDocument;
  label: string;
  assessment: EwayBillAssessment;
  /** Fields the portal needs that are not filled in yet. */
  missing: string[];
  existingNo: string | null;
  provider: string;
  live: boolean;
}

export async function checkEwayBill(
  ex: Executor,
  orgId: number,
  doc: EwayBillDocument,
): Promise<EwayBillCheck> {
  const loaded = await loadDocument(ex, orgId, doc);
  const connection = await connectionFor(ex, orgId, loaded.branchId, 'ewaybill');
  const provider = resolveProvider(connection.providerName);

  return {
    document: doc,
    label: loaded.docLabel,
    assessment: assessEwayBill({
      supplyKind: loaded.supplyKind,
      consignmentPaise: loaded.consignmentPaise,
      fromStateCode: loaded.fromStateCode,
      intraThresholdPaise: loaded.intraThresholdPaise,
      toStateCode: loaded.toStateCode,
      reason: loaded.reason,
      interStateSupply: loaded.interStateSupply,
      docDate: loaded.source.docDate,
    }),
    missing: missingFields(loaded),
    existingNo: loaded.existingNo,
    provider: provider.name,
    live: provider.live,
  };
}

/**
 * The Part A fields NIC will not accept a blank for.
 *
 * Reported as a list rather than thrown one at a time, so a user fixes an
 * address once instead of discovering the next missing field on each attempt.
 */
function missingFields(loaded: Loaded): string[] {
  const missing: string[] = [];
  const s = loaded.source;

  if (!s.from.gstin) missing.push('This branch has no GSTIN.');
  if (!s.from.address1) missing.push('This branch has no address.');
  if (!s.from.place) missing.push('This branch has no city.');
  if (!s.from.pincode) missing.push('This branch has no PIN code.');
  if (!s.to.address1) missing.push('The customer has no delivery address.');
  if (!s.to.place) missing.push('The customer has no city.');
  if (!s.to.pincode) missing.push('The customer has no PIN code.');

  for (const l of s.lines) {
    if (!l.hsnSac) {
      missing.push(`"${l.name}" has no HSN code.`);
      break; // one is enough to make the point; the rest surface after a fix
    }
  }
  return missing;
}

// ── Generating ───────────────────────────────────────────────────────────────

export interface GenerateEwayBillResult {
  ewayBillNo: string;
  status: 'generated';
  validUntil: string;
  provider: string;
  live: boolean;
  assessment: EwayBillAssessment;
}

export async function generateEwayBill(
  trx: Trx,
  orgId: number,
  doc: EwayBillDocument,
  transport: TransportInput,
  opts: { call?: PortalCaller; userId?: number | null } = {},
): Promise<GenerateEwayBillResult> {
  const call = opts.call ?? runPortalCall;
  const loaded = await loadDocument(trx, orgId, doc);

  if (loaded.status === 'generated' && loaded.existingNo) {
    throw conflict(
      `${loaded.docLabel} already has e-way bill ${loaded.existingNo}. A second one for the same ` +
        'consignment is a rejection — cancel the first if it is wrong.',
    );
  }

  const assessment = assessEwayBill({
    supplyKind: loaded.supplyKind,
    consignmentPaise: loaded.consignmentPaise,
    fromStateCode: loaded.fromStateCode,
    intraThresholdPaise: loaded.intraThresholdPaise,
    toStateCode: loaded.toStateCode,
    reason: loaded.reason,
    interStateSupply: loaded.interStateSupply,
    docDate: loaded.source.docDate,
  });

  if (assessment.blockers.length > 0) {
    throw badRequest(assessment.blockers.join(' '));
  }

  const missing = missingFields(loaded);
  if (missing.length > 0) {
    throw badRequest(
      `${loaded.docLabel} is missing details the portal requires. ${missing.slice(0, 3).join(' ')}`,
      { missing },
    );
  }

  // Part B. Without a vehicle or a transport document the bill authorises no
  // movement, and — more to the point — validity does not start, so generating
  // one now would put a bill on the register that nobody can rely on.
  const vehicleNo = transport.vehicleNo?.trim()
    ? normaliseVehicleNo(transport.vehicleNo)
    : null;
  if (transport.vehicleNo?.trim() && !vehicleNo) {
    throw badRequest(
      `"${transport.vehicleNo}" is not a vehicle number the portal will take. It should look like ` +
        'TN01AB1234 — between 7 and 11 letters and digits.',
    );
  }
  if (!vehicleNo && !transport.transportDocNo?.trim()) {
    throw badRequest(
      'Part B needs either a vehicle number, or the transport document number for rail, air or ship. ' +
        'Until one is supplied the bill does not authorise the goods to move, and its validity has not ' +
        'started counting.',
    );
  }

  const source: EwayBillSource = {
    ...loaded.source,
    transport: {
      transporterId: transport.transporterId ?? null,
      transporterName: transport.transporterName ?? null,
      transportDocNo: transport.transportDocNo ?? null,
      transportDocDate: transport.transportDocDate ?? null,
      mode: transport.mode ?? 'road',
      vehicleNo,
      isOverDimensional: transport.isOverDimensional ?? false,
      distanceKm: transport.distanceKm ?? null,
    },
  };

  // An invoice whose IRN a live portal issued gets its bill from that portal,
  // against the IRN, when no e-way bill system is connected.
  const byIrn = doc.kind === 'invoice' ? await irnRoute(trx, orgId, doc.id, loaded.branchId) : null;
  const connection = byIrn?.connection ?? (await connectionFor(trx, orgId, loaded.branchId, 'ewaybill'));
  const provider = byIrn?.provider ?? resolveProvider(connection.providerName);
  const payload: EwayBillPayload = buildEwayBillPayload(source);
  const ctx = await providerContext(trx, connection);

  let result;
  try {
    if (byIrn) {
      const req: EwbByIrn = {
        irn: byIrn.irn,
        distanceKm: transport.distanceKm ?? 0,
        mode: transport.mode ?? 'road',
        vehicleNo,
        transporterId: transport.transporterId ?? null,
        transporterName: transport.transporterName ?? null,
        transportDocNo: transport.transportDocNo?.trim() || null,
        transportDocDate: transport.transportDocDate ? toIrpDate(transport.transportDocDate) : null,
        isOverDimensional: transport.isOverDimensional ?? false,
      };
      result = await call(
        { orgId, connection, operation: 'generate_ewb_by_irn', referenceType: doc.kind, referenceId: doc.id },
        req,
        () => provider.generateEwbByIrn(req, ctx),
      );
    } else {
      result = await call(
        {
          orgId,
          connection,
          operation: 'generate_ewb',
          referenceType: doc.kind,
          referenceId: doc.id,
        },
        payload,
        () => provider.generateEwayBill(payload, ctx),
      );
    }
  } catch (err) {
    // Written through db, not trx: the throw below rolls the caller's
    // transaction back, and a failure recorded inside it would vanish with it.
    await recordFailure(db, orgId, doc, loaded, err);
    throw toApiError(err, loaded.docLabel);
  }

  const now = new Date();
  const values = {
    org_id: orgId,
    invoice_id: doc.kind === 'invoice' ? doc.id : null,
    challan_id: doc.kind === 'challan' ? doc.id : null,
    eway_bill_no: result.ewbNo,
    status: 'generated' as const,
    provider: provider.name,
    sub_supply_type: source.subSupplyType,
    transport_mode: transport.mode ?? ('road' as const),
    vehicle_no: vehicleNo,
    transporter_id: transport.transporterId ?? null,
    transporter_name: transport.transporterName ?? null,
    distance_km: transport.distanceKm ?? null,
    from_pincode: loaded.fromPincode,
    to_pincode: loaded.toPincode,
    generated_at: now,
    // Part B arrived with this call, so this is when the clock starts.
    part_b_at: now,
    valid_until: parsePortalTimestamp(result.validUntil),
    // A bill generated again after a cancellation starts clean.
    cancelled_at: null,
    cancel_reason: null,
    extended_count: 0,
    error_message: null,
  };

  let billId = loaded.rowId;
  if (billId !== null) {
    await trx.updateTable('eway_bills').set(values).where('id', '=', billId).execute();
  } else {
    const inserted = await trx.insertInto('eway_bills').values(values).executeTakeFirstOrThrow();
    billId = Number(inserted.insertId);
  }
  await recordEvent(trx, orgId, opts.userId ?? null, billId, result.ewbNo, 'generated', {
    vehicleNo,
    mode: values.transport_mode,
    validUntil: values.valid_until,
  });

  // Kept on the invoice too, because it has to print on the document and a
  // join to fetch one string on every invoice PDF is not worth it.
  if (doc.kind === 'invoice') {
    await trx
      .updateTable('invoices')
      .set({ eway_bill_no: result.ewbNo })
      .where('id', '=', doc.id)
      .execute();
  }

  return {
    ewayBillNo: result.ewbNo,
    status: 'generated',
    validUntil: result.validUntil,
    provider: provider.name,
    live: provider.live,
    assessment,
  };
}

/**
 * Whether this invoice's bill should come from the invoice portal, against its IRN.
 *
 * Only for an IRN a real portal issued — a stand-in IRN gets a stand-in bill
 * the ordinary way — and only while no e-way bill system is connected: when
 * one is, that is where bills belong. If the IRN's own connection has gone, a
 * stand-in bill would be a pretend document against a real registration, so
 * that is refused rather than quietly substituted.
 */
async function irnRoute(
  trx: Trx,
  orgId: number,
  invoiceId: number,
  branchId: number,
): Promise<{ provider: GstProvider; connection: PortalConnection; irn: string } | null> {
  const mark = await trx
    .selectFrom('einvoices')
    .select(['status', 'irn', 'provider'])
    .where('invoice_id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (mark?.status !== 'submitted' || !mark.irn || !mark.provider || mark.provider === 'fake') return null;

  const ewbConnection = await connectionFor(trx, orgId, branchId, 'ewaybill');
  if (ewbConnection.configured) return null;

  const einvoice = await connectionFor(trx, orgId, branchId, 'einvoice');
  if (einvoice.providerName !== mark.provider) {
    throw new ApiError(
      409,
      `This invoice's IRN was issued through ${providerLabel(mark.provider)}, and the branch is no longer ` +
        'connected to it, so its e-way bill cannot be issued against the IRN. Reconnect it in Settings → ' +
        "Integrations, or connect NIC's e-way bill system.",
      'provider_changed',
    );
  }
  return { provider: resolveProvider(mark.provider), connection: einvoice, irn: mark.irn };
}

async function recordFailure(
  ex: Executor,
  orgId: number,
  doc: EwayBillDocument,
  loaded: Loaded,
  err: unknown,
): Promise<void> {
  const rejection = err instanceof PortalRejection ? err : null;
  const message = `${rejection ? `[${rejection.code}] ` : ''}${(err as Error).message ?? 'The portal call failed.'}`;

  if (loaded.rowId !== null) {
    await ex
      .updateTable('eway_bills')
      .set({ status: 'pending', error_message: message.slice(0, 1000) })
      .where('id', '=', loaded.rowId)
      .execute();
    return;
  }

  await ex
    .insertInto('eway_bills')
    .values({
      org_id: orgId,
      invoice_id: doc.kind === 'invoice' ? doc.id : null,
      challan_id: doc.kind === 'challan' ? doc.id : null,
      status: 'pending',
      sub_supply_type: loaded.source.subSupplyType,
      error_message: message.slice(0, 1000),
    })
    .execute();
}

// ── After generation ─────────────────────────────────────────────────────────
//
// Three things can happen to a bill on the road, and each has a legal limit:
//
//   the vehicle changes     only while the bill is valid (Part B again)
//   validity is extended    only 8 hours either side of expiry, and never past
//                           360 days from generation
//   the bill is cancelled   only within 24 hours of generation
//
// Every check that can refuse runs before the portal is asked, and each change
// goes to the provider that issued the bill. A stand-in bill means nothing to
// NIC, and a NIC bill must never be changed by the stand-in, which would move
// the register and nothing else.

type EwbEventKind = 'generated' | 'vehicle_changed' | 'extended' | 'cancelled';
type Mode = 'road' | 'rail' | 'air' | 'ship';

async function recordEvent(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
  ewbNo: string,
  kind: EwbEventKind,
  e: {
    vehicleNo?: string | null;
    mode?: Mode | null;
    fromPlace?: string | null;
    reasonCode?: string | null;
    remark?: string | null;
    validUntil?: Date | null;
  } = {},
): Promise<void> {
  await trx
    .insertInto('eway_bill_events')
    .values({
      org_id: orgId,
      eway_bill_id: billId,
      eway_bill_no: ewbNo,
      kind,
      vehicle_no: e.vehicleNo ?? null,
      transport_mode: e.mode ?? null,
      from_place: e.fromPlace?.slice(0, 100) ?? null,
      reason_code: e.reasonCode ?? null,
      remark: e.remark?.slice(0, 200) ?? null,
      valid_until: e.validUntil ?? null,
      created_by_user_id: userId,
    })
    .execute();
}

interface LoadedBill {
  id: number;
  number: string;
  status: string;
  provider: string;
  vehicleNo: string | null;
  mode: Mode;
  distanceKm: number | null;
  generatedAt: Date | null;
  partBAt: Date | null;
  validUntil: Date | null;
  extendedCount: number;
  invoiceId: number | null;
  branchId: number;
  branchState: string;
}

/** The bill, locked for the change about to be made to it. */
async function loadBill(trx: Trx, orgId: number, billId: number): Promise<LoadedBill> {
  const row = await trx
    .selectFrom('eway_bills as w')
    .leftJoin('invoices as i', 'i.id', 'w.invoice_id')
    .leftJoin('delivery_challans as d', 'd.id', 'w.challan_id')
    .select([
      'w.id', 'w.eway_bill_no', 'w.status', 'w.provider', 'w.vehicle_no', 'w.transport_mode',
      'w.distance_km', 'w.generated_at', 'w.part_b_at', 'w.valid_until', 'w.extended_count',
      'w.invoice_id', 'i.branch_id as invoice_branch', 'd.branch_id as challan_branch',
    ])
    .where('w.id', '=', billId)
    .where('w.org_id', '=', orgId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound('That e-way bill does not exist.');

  const branchId = row.invoice_branch ?? row.challan_branch;
  if (branchId === null) throw notFound('That e-way bill is not attached to a document.');
  const branch = await trx
    .selectFrom('branches')
    .select('state_code')
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    number: row.eway_bill_no ?? '',
    status: row.status,
    provider: row.provider ?? 'fake',
    vehicleNo: row.vehicle_no,
    mode: row.transport_mode,
    distanceKm: row.distance_km,
    generatedAt: row.generated_at,
    partBAt: row.part_b_at,
    validUntil: row.valid_until,
    extendedCount: row.extended_count,
    invoiceId: row.invoice_id,
    branchId,
    branchState: branch.state_code,
  };
}

/** A bill that exists at the portal and has not been cancelled. */
function assertStanding(bill: LoadedBill, what: string): void {
  if (bill.status === 'cancelled') {
    throw conflict(`E-way bill ${bill.number} is cancelled, so ${what} is not possible.`);
  }
  if ((bill.status !== 'generated' && bill.status !== 'expired') || !bill.number) {
    throw conflict('There is no generated e-way bill here to change. Generate one first.');
  }
}

/** The provider that issued the bill: the only one that can change it. */
async function issuingProvider(
  trx: Trx,
  orgId: number,
  bill: LoadedBill,
): Promise<{ provider: GstProvider; connection: PortalConnection }> {
  const current = await connectionFor(trx, orgId, bill.branchId, 'ewaybill');
  if (bill.provider === 'fake') {
    // A stand-in bill is changed by the stand-in, whatever the branch uses now.
    const connection: PortalConnection =
      current.providerName === 'fake'
        ? current
        : { ...current, id: null, providerName: 'fake', baseUrl: null, configured: false };
    return { provider: resolveProvider('fake'), connection };
  }
  if (current.providerName !== bill.provider || !providerServes(bill.provider, 'ewaybill')) {
    throw new ApiError(
      409,
      `E-way bill ${bill.number} was issued through ${providerLabel(bill.provider)}. Changing it goes ` +
        "through NIC's e-way bill system, which needs its own connection in Settings → Integrations.",
      'ewb_connection_needed',
    );
  }
  return { provider: resolveProvider(bill.provider), connection: current };
}

/** A portal failure, in words that say what did not happen. */
function portalFailure(err: unknown, label: string, notDone: string): unknown {
  if (err instanceof PortalUnavailable) {
    return new ApiError(503, `${err.message} ${notDone}; it is safe to try again.`, 'portal_unavailable');
  }
  return toApiError(err, label);
}

function vehicleOrRefuse(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  const v = normaliseVehicleNo(input);
  if (!v) {
    throw badRequest(
      `"${input}" is not a vehicle number the portal will take. It should look like TN01AB1234 — ` +
        'between 7 and 11 letters and digits.',
    );
  }
  return v;
}

export interface EwbChangeResult {
  ewayBillNo: string;
  vehicleNo: string | null;
  validUntil: string | null;
  extendedCount: number;
  provider: string;
  live: boolean;
}

type ChangeOptions = { now?: Date; call?: PortalCaller };

// ── A new vehicle ────────────────────────────────────────────────────────────

export interface VehicleChangeInput {
  vehicleNo?: string | null;
  mode?: Mode;
  transportDocNo?: string | null;
  /** yyyy-mm-dd */
  transportDocDate?: string | null;
  /** The place the goods are when the vehicle changes. */
  fromPlace: string;
  fromStateCode?: string;
  reason: VehicleChangeReason;
  remark?: string;
}

export async function changeEwayVehicle(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
  input: VehicleChangeInput,
  opts: ChangeOptions = {},
): Promise<EwbChangeResult> {
  const now = opts.now ?? new Date();
  const call = opts.call ?? runPortalCall;
  const bill = await loadBill(trx, orgId, billId);
  assertStanding(bill, 'changing its vehicle');

  if (bill.validUntil && now.getTime() > bill.validUntil.getTime()) {
    throw new ApiError(
      409,
      `E-way bill ${bill.number} has expired, and a vehicle cannot be changed on an expired bill. Extend ` +
        'it within 8 hours of expiry, or generate a new one.',
      'ewb_expired',
    );
  }

  const mode = input.mode ?? bill.mode;
  const vehicleNo = vehicleOrRefuse(input.vehicleNo);
  const transportDocNo = input.transportDocNo?.trim() || null;
  if (mode === 'road' && !vehicleNo) throw badRequest('Give the new vehicle number.');
  if (mode !== 'road' && !vehicleNo && !transportDocNo) {
    throw badRequest('Give the vehicle number, or the transport document number for rail, air or ship.');
  }
  if (vehicleNo && vehicleNo === bill.vehicleNo && mode === bill.mode) {
    throw badRequest(`${vehicleNo} is already the vehicle on e-way bill ${bill.number}.`);
  }
  const fromPlace = input.fromPlace.trim();
  if (!fromPlace) throw badRequest('Where are the goods now? The portal records the place the vehicle changed.');

  // The first Part B is a reason of its own, and the one that starts the clock.
  const firstTime = bill.partBAt === null;
  const reason: VehicleChangeReason = firstTime ? '4' : input.reason;
  const remark = input.remark?.trim() || VEHICLE_CHANGE_REASONS[reason];

  const { provider, connection } = await issuingProvider(trx, orgId, bill);
  const ctx = await providerContext(trx, connection);
  const change: EwbVehicleChange = {
    ewbNo: bill.number,
    vehicleNo,
    fromPlace,
    fromStateCode: input.fromStateCode ?? bill.branchState,
    reason,
    remark,
    mode,
    transportDocNo,
    transportDocDate: input.transportDocDate ? toIrpDate(input.transportDocDate) : null,
  };

  let result;
  try {
    result = await call(
      { orgId, connection, operation: 'update_ewb_vehicle', referenceType: 'eway_bill', referenceId: bill.id },
      change,
      () => provider.updateEwayVehicle(change, ctx),
    );
  } catch (err) {
    throw portalFailure(
      err,
      `the vehicle change on e-way bill ${bill.number}`,
      `The vehicle on e-way bill ${bill.number} was not changed`,
    );
  }

  // Only the first Part B starts the clock. A later change of lorry leaves the
  // expiry where it was.
  const validUntil = result.validUntil
    ? parsePortalTimestamp(result.validUntil)
    : firstTime
      ? validityEnd(now, bill.distanceKm ?? 0)
      : bill.validUntil;

  await trx
    .updateTable('eway_bills')
    .set({
      vehicle_no: vehicleNo,
      transport_mode: mode,
      part_b_at: bill.partBAt ?? now,
      valid_until: validUntil,
      error_message: null,
    })
    .where('id', '=', bill.id)
    .execute();
  await recordEvent(trx, orgId, userId, bill.id, bill.number, 'vehicle_changed', {
    vehicleNo, mode, fromPlace, reasonCode: reason, remark, validUntil,
  });

  return {
    ewayBillNo: bill.number,
    vehicleNo,
    validUntil: validUntil?.toISOString() ?? null,
    extendedCount: bill.extendedCount,
    provider: provider.name,
    live: provider.live,
  };
}

// ── More time ────────────────────────────────────────────────────────────────

export interface ExtensionInput {
  remainingDistanceKm: number;
  fromPlace: string;
  fromPincode: string;
  fromStateCode?: string;
  reason: EwbExtendReason;
  remark?: string;
  /** On a vehicle still, or waiting at a place. */
  consignment: 'in_movement' | 'in_transit';
  vehicleNo?: string | null;
}

export async function extendEwayBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
  input: ExtensionInput,
  opts: ChangeOptions = {},
): Promise<EwbChangeResult> {
  const now = opts.now ?? new Date();
  const call = opts.call ?? runPortalCall;
  const bill = await loadBill(trx, orgId, billId);
  assertStanding(bill, 'extending it');

  if (!bill.validUntil || !bill.generatedAt) {
    throw conflict(`E-way bill ${bill.number} has no validity to extend yet. Give it a vehicle (Part B) first.`);
  }
  const verdict = canExtend(bill.validUntil, bill.generatedAt, now);
  if (!verdict.allowed) throw new ApiError(409, verdict.reason, 'extend_not_allowed');

  if (!Number.isInteger(input.remainingDistanceKm) || input.remainingDistanceKm <= 0) {
    throw badRequest('How far is left to go? The new validity is worked out from the remaining distance.');
  }
  const fromPincode = input.fromPincode.trim();
  if (!/^[1-9][0-9]{5}$/.test(fromPincode)) {
    throw badRequest('Give the six-digit PIN code of the place the goods are now.');
  }
  const fromPlace = input.fromPlace.trim();
  if (!fromPlace) throw badRequest('Where are the goods now? The portal asks for the current place.');

  let vehicleNo: string | null = null;
  if (input.consignment === 'in_movement') {
    vehicleNo = vehicleOrRefuse(input.vehicleNo) ?? bill.vehicleNo;
    if (!vehicleNo && bill.mode === 'road') throw badRequest('Goods still on the road need the vehicle number.');
  }
  const remark = input.remark?.trim() || EWB_EXTEND_REASONS[input.reason];

  const { provider, connection } = await issuingProvider(trx, orgId, bill);
  const ctx = await providerContext(trx, connection);
  const ext: EwbExtension = {
    ewbNo: bill.number,
    vehicleNo,
    fromPlace,
    fromStateCode: input.fromStateCode ?? bill.branchState,
    fromPincode,
    remainingDistanceKm: input.remainingDistanceKm,
    reason: input.reason,
    remark,
    consignment: input.consignment,
    mode: bill.mode,
    isOverDimensional: false,
  };

  let result;
  try {
    result = await call(
      { orgId, connection, operation: 'extend_ewb', referenceType: 'eway_bill', referenceId: bill.id },
      ext,
      () => provider.extendEwayBill(ext, ctx),
    );
  } catch (err) {
    throw portalFailure(err, `the extension of e-way bill ${bill.number}`, `E-way bill ${bill.number} was not extended`);
  }

  const validUntil = parsePortalTimestamp(result.validUntil);
  const extendedCount = bill.extendedCount + 1;
  await trx
    .updateTable('eway_bills')
    .set({
      valid_until: validUntil,
      extended_count: extendedCount,
      status: 'generated',
      ...(vehicleNo ? { vehicle_no: vehicleNo } : {}),
      error_message: null,
    })
    .where('id', '=', bill.id)
    .execute();
  await recordEvent(trx, orgId, userId, bill.id, bill.number, 'extended', {
    vehicleNo, mode: bill.mode, fromPlace, reasonCode: input.reason, remark, validUntil,
  });

  return {
    ewayBillNo: bill.number,
    vehicleNo: vehicleNo ?? bill.vehicleNo,
    validUntil: validUntil.toISOString(),
    extendedCount,
    provider: provider.name,
    live: provider.live,
  };
}

// ── Cancelling ───────────────────────────────────────────────────────────────

export interface EwbCancelResult {
  ewayBillNo: string;
  cancelledAt: string;
  provider: string;
  live: boolean;
  /** The portal said it was already cancelled: an earlier reply was lost. */
  recovered: boolean;
}

export async function cancelEwayBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
  input: { reason: EwbCancelReason; remark?: string },
  opts: ChangeOptions = {},
): Promise<EwbCancelResult> {
  const now = opts.now ?? new Date();
  const call = opts.call ?? runPortalCall;
  const bill = await loadBill(trx, orgId, billId);
  if (bill.status === 'cancelled') throw conflict(`E-way bill ${bill.number} is already cancelled.`);
  assertStanding(bill, 'cancelling it');

  const deadline = ewbCancelDeadline(bill.generatedAt);
  if (!deadline || now.getTime() > deadline.getTime()) {
    throw new ApiError(
      409,
      `E-way bill ${bill.number} was generated more than 24 hours ago, so the portal will not cancel it. ` +
        'A bill for goods that never moved simply expires.',
      'ewb_cancel_window_passed',
    );
  }

  const remark = input.remark?.trim() || EWB_CANCEL_REASONS[input.reason];
  const { provider, connection } = await issuingProvider(trx, orgId, bill);
  const ctx = await providerContext(trx, connection);

  let cancelledAt = now;
  let recovered = false;
  try {
    const result = await call(
      { orgId, connection, operation: 'cancel_ewb', referenceType: 'eway_bill', referenceId: bill.id },
      { ewbNo: bill.number, cancelRsnCode: input.reason, cancelRmrk: remark },
      () => provider.cancelEwayBill(bill.number, input.reason, remark, ctx),
    );
    if (result.cancelledAt) cancelledAt = parsePortalTimestamp(result.cancelledAt);
  } catch (err) {
    // An earlier cancellation went through and its reply was lost.
    if (err instanceof PortalRejection && /already\s+cancel/i.test(err.message)) {
      recovered = true;
    } else {
      throw portalFailure(
        err,
        `the cancellation of e-way bill ${bill.number}`,
        `E-way bill ${bill.number} was not cancelled`,
      );
    }
  }

  const reasonText = `${EWB_CANCEL_REASONS[input.reason]}: ${remark}`.slice(0, 200);
  await trx
    .updateTable('eway_bills')
    .set({ status: 'cancelled', cancelled_at: cancelledAt, cancel_reason: reasonText, error_message: null })
    .where('id', '=', bill.id)
    .execute();

  // The invoice prints its e-way bill number, and a cancelled one must not
  // appear on it as if it still covered the goods.
  if (bill.invoiceId !== null) {
    await trx
      .updateTable('invoices')
      .set({ eway_bill_no: null })
      .where('id', '=', bill.invoiceId)
      .where('eway_bill_no', '=', bill.number)
      .execute();
  }
  await recordEvent(trx, orgId, userId, bill.id, bill.number, 'cancelled', {
    reasonCode: input.reason,
    remark,
  });

  return {
    ewayBillNo: bill.number,
    cancelledAt: cancelledAt.toISOString(),
    provider: provider.name,
    live: provider.live,
    recovered,
  };
}
