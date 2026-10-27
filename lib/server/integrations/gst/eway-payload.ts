import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Turning a document into an e-way bill request.
//
// The e-way bill has two halves and the split is the whole design. Part A is
// the consignment — who, what, from where to where, how much — and comes almost
// entirely from a document we already hold. Part B is the vehicle, and until it
// is supplied the bill does not authorise anything to move.
//
// The consequence worth remembering while reading this file: validity is
// counted from when Part B is first entered, never from generation. A bill can
// be prepared the evening before and the lorry leave the next morning, and the
// clock starts with the lorry.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../../../types';
import { toIrpDate, toRupees2 } from './einvoice-payload';

// ── NIC's code lists ─────────────────────────────────────────────────────────
//
// All of these are sent as codes, not words, and an invented value is a
// rejection. They are modelled as unions rather than strings so a typo cannot
// reach the portal.

/** Outward — we are sending. Inward — goods are coming to us. */
export type EwbSupplyDirection = 'O' | 'I';

/**
 * *Why* the goods are moving. Not derivable from our document type: one
 * delivery challan can cover job work, own use, line sales or exhibition
 * goods, and NIC wants them told apart because the rules differ.
 */
export type EwbSubSupplyType =
  | '1'  // Supply — an ordinary sale
  | '2'  // Import
  | '3'  // Export
  | '4'  // Job work
  | '5'  // For own use
  | '6'  // Job work returns
  | '7'  // Sales return
  | '8'  // Others
  | '9'  // SKD / CKD / in lots
  | '10' // Line sales
  | '11' // Recipient not known
  | '12'; // Exhibition or fairs

export const SUB_SUPPLY_LABELS: Record<EwbSubSupplyType, string> = {
  '1': 'Supply', '2': 'Import', '3': 'Export', '4': 'Job work', '5': 'For own use',
  '6': 'Job work returns', '7': 'Sales return', '8': 'Others', '9': 'SKD/CKD or in lots',
  '10': 'Line sales', '11': 'Recipient not known', '12': 'Exhibition or fairs',
};

/** Our own stored value for the same thing, kept readable in the database. */
export type StoredSubSupplyType =
  | 'supply' | 'import' | 'export' | 'job_work' | 'own_use' | 'job_work_returns'
  | 'sales_return' | 'others' | 'skd_ckd' | 'line_sales' | 'recipient_not_known' | 'exhibition';

const SUB_SUPPLY_CODES: Record<StoredSubSupplyType, EwbSubSupplyType> = {
  supply: '1', import: '2', export: '3', job_work: '4', own_use: '5',
  job_work_returns: '6', sales_return: '7', others: '8', skd_ckd: '9',
  line_sales: '10', recipient_not_known: '11', exhibition: '12',
};

export function toSubSupplyCode(stored: string): EwbSubSupplyType {
  return SUB_SUPPLY_CODES[stored as StoredSubSupplyType] ?? '8';
}

/** Which document is backing the movement. */
export type EwbDocType = 'INV' | 'BIL' | 'BOE' | 'CHL' | 'CNT' | 'OTH';

/**
 * Whether the billing party and the delivery party are the same.
 *
 * 1 is the ordinary case. 2 is bill-to-ship-to: A bills B but the goods go to
 * C. 3 is the mirror on the sending side. 4 is both at once. Getting this
 * wrong is what makes a bill-to-ship-to consignment look like two sales.
 */
export type EwbTransactionType = 1 | 2 | 3 | 4;

/** 1 road, 2 rail, 3 air, 4 ship. */
export type EwbTransMode = '1' | '2' | '3' | '4';

const TRANS_MODE: Record<string, EwbTransMode> = { road: '1', rail: '2', air: '3', ship: '4' };

/** Regular cargo, or over-dimensional — which changes the validity rate entirely. */
export type EwbVehicleType = 'R' | 'O';

// ── The request NIC expects ──────────────────────────────────────────────────

export interface EwbItem {
  productName: string;
  productDesc: string;
  hsnCode: number;
  quantity: number;
  qtyUnit: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cessRate: number;
  cessNonAdvol: number;
  taxableAmount: number;
}

export interface EwayBillPayload {
  supplyType: EwbSupplyDirection;
  subSupplyType: EwbSubSupplyType;
  /** Only sent when subSupplyType is 8 (Others), where NIC wants it spelled out. */
  subSupplyDesc?: string;
  docType: EwbDocType;
  docNo: string;
  docDate: string;

  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromAddr2?: string;
  fromPlace: string;
  fromPincode: number;
  /** Where the goods physically leave from — can differ from the billing state. */
  actFromStateCode: number;
  /** The billing state on the document. */
  fromStateCode: number;

  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toAddr2?: string;
  toPlace: string;
  toPincode: number;
  actToStateCode: number;
  toStateCode: number;

  transactionType: EwbTransactionType;

  totalValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: number;
  cessNonAdvolValue: number;
  otherValue: number;
  totInvValue: number;

  transporterId?: string;
  transporterName?: string;
  transDocNo?: string;
  transDocDate?: string;
  transMode?: EwbTransMode;
  transDistance: string;
  vehicleNo?: string;
  vehicleType?: EwbVehicleType;

  itemList: EwbItem[];
}

// ── What we feed it ──────────────────────────────────────────────────────────

export interface EwbAddress {
  gstin: string | null;
  tradeName: string;
  address1: string | null;
  address2?: string | null;
  place: string | null;
  pincode: string | null;
  stateCode: string | null;
  /** Where the goods actually move from or to, when that differs from billing. */
  actualStateCode?: string | null;
}

export interface EwbLine {
  name: string;
  description: string;
  hsnSac: string | null;
  qty: number;
  uqc: string | null;
  gstRatePct: number;
  /** True on a supply within one state — decides whether the rate splits. */
  intra: boolean;
  taxablePaise: Paise;
}

export interface EwayBillSource {
  direction: EwbSupplyDirection;
  subSupplyType: StoredSubSupplyType;
  subSupplyDesc?: string | null;
  docType: EwbDocType;
  docNo: string;
  /** yyyy-mm-dd. */
  docDate: string;
  from: EwbAddress;
  to: EwbAddress;
  transactionType?: EwbTransactionType;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  otherChargesPaise: Paise;
  totalPaise: Paise;
  lines: EwbLine[];
  transport?: {
    transporterId?: string | null;
    transporterName?: string | null;
    transportDocNo?: string | null;
    transportDocDate?: string | null;
    mode?: 'road' | 'rail' | 'air' | 'ship' | null;
    vehicleNo?: string | null;
    isOverDimensional?: boolean;
    distanceKm?: number | null;
  } | null;
}

// ── The builder ──────────────────────────────────────────────────────────────

/**
 * NIC's own convention for an unregistered counterparty, and for a place with
 * no Indian PIN code. Same reasoning as the invoice portal: these are required
 * placeholders, not fallbacks we invented.
 */
const URP = 'URP';
const OVERSEAS_PIN = 999999;
const OVERSEAS_STATE = 96;

const pin = (v: string | null | undefined): number => {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) && n >= 100000 ? n : OVERSEAS_PIN;
};

const stateNum = (v: string | null | undefined): number => {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : OVERSEAS_STATE;
};

/**
 * Build the EWB-01 request.
 *
 * Like the invoice builder, this validates nothing — `preflightEwayBill` is a
 * separate pass so that an incomplete payload can still be inspected.
 *
 * `transDistance` is deliberately a string, and deliberately allowed to be
 * "0". Sending zero asks NIC to use its own pin-to-pin distance rather than
 * ours, which is the right default: their number is the one an officer at a
 * checkpost will see, so disagreeing with it gains nothing and costs an
 * argument.
 */
export function buildEwayBillPayload(src: EwayBillSource): EwayBillPayload {
  const t = src.transport;

  const items: EwbItem[] = src.lines.map((l) => ({
    productName: l.name.slice(0, 100),
    productDesc: (l.description || l.name).slice(0, 100),
    hsnCode: Number((l.hsnSac ?? '0').trim()) || 0,
    quantity: Number(l.qty.toFixed(3)),
    qtyUnit: (l.uqc ?? 'OTH').toUpperCase(),
    // The rate is reported as the split that actually applied. Within one
    // state that is half each on CGST and SGST; across states it is all IGST.
    cgstRate: l.intra ? l.gstRatePct / 2 : 0,
    sgstRate: l.intra ? l.gstRatePct / 2 : 0,
    igstRate: l.intra ? 0 : l.gstRatePct,
    cessRate: 0,
    cessNonAdvol: 0,
    taxableAmount: toRupees2(l.taxablePaise),
  }));

  const payload: EwayBillPayload = {
    supplyType: src.direction,
    subSupplyType: toSubSupplyCode(src.subSupplyType),
    docType: src.docType,
    docNo: src.docNo,
    docDate: toIrpDate(src.docDate),

    fromGstin: src.from.gstin ?? URP,
    fromTrdName: src.from.tradeName.slice(0, 100),
    fromAddr1: (src.from.address1 ?? '').slice(0, 120),
    fromPlace: (src.from.place ?? '').slice(0, 50),
    fromPincode: pin(src.from.pincode),
    actFromStateCode: stateNum(src.from.actualStateCode ?? src.from.stateCode),
    fromStateCode: stateNum(src.from.stateCode),

    toGstin: src.to.gstin ?? URP,
    toTrdName: src.to.tradeName.slice(0, 100),
    toAddr1: (src.to.address1 ?? '').slice(0, 120),
    toPlace: (src.to.place ?? '').slice(0, 50),
    toPincode: pin(src.to.pincode),
    actToStateCode: stateNum(src.to.actualStateCode ?? src.to.stateCode),
    toStateCode: stateNum(src.to.stateCode),

    transactionType: src.transactionType ?? 1,

    totalValue: toRupees2(src.taxablePaise),
    cgstValue: toRupees2(src.cgstPaise),
    sgstValue: toRupees2(src.sgstPaise),
    igstValue: toRupees2(src.igstPaise),
    cessValue: toRupees2(src.cessPaise),
    cessNonAdvolValue: 0,
    otherValue: toRupees2(src.otherChargesPaise),
    totInvValue: toRupees2(src.totalPaise),

    transDistance: String(t?.distanceKm ?? 0),
    itemList: items,
  };

  if (src.from.address2) payload.fromAddr2 = src.from.address2.slice(0, 120);
  if (src.to.address2) payload.toAddr2 = src.to.address2.slice(0, 120);
  if (src.subSupplyType === 'others' && src.subSupplyDesc) {
    payload.subSupplyDesc = src.subSupplyDesc.slice(0, 20);
  }

  if (t) {
    if (t.transporterId) payload.transporterId = t.transporterId.trim().toUpperCase();
    if (t.transporterName) payload.transporterName = t.transporterName.slice(0, 100);
    if (t.transportDocNo) payload.transDocNo = t.transportDocNo.slice(0, 15);
    if (t.transportDocDate) payload.transDocDate = toIrpDate(t.transportDocDate);
    if (t.mode) payload.transMode = TRANS_MODE[t.mode];
    if (t.vehicleNo) {
      // NIC wants it unpunctuated: TN01AB1234, not TN-01-AB-1234.
      payload.vehicleNo = t.vehicleNo.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }
    payload.vehicleType = t.isOverDimensional ? 'O' : 'R';
  }

  return payload;
}
