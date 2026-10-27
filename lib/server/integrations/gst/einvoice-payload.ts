import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Turning one of our invoices into the government's INV-01 document.
//
// This is the largest single piece of the e-invoice integration and it needs
// no provider, no contract and no network. The IRP accepts one shape, it is
// published, and it is unforgiving: field names are abbreviated and
// case-sensitive, dates are dd/mm/yyyy, and every amount is rupees to two
// decimals — while everything inside this app is integer paise, precisely so
// that no rupee value ever passes through a float.
//
// The conversion happens here, once, at the boundary. Nothing upstream changes
// units to suit the portal.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise, SupplyType } from '../../../types';

// ── What the IRP expects ─────────────────────────────────────────────────────
//
// Typed rather than assembled as a bare object so that a renamed field is a
// compile error instead of a rejection three weeks later. Only the fields this
// app can actually populate are modelled; the schema has many more, all
// optional, and inventing values for them would be worse than omitting them.

/** Supply type codes. Deemed exports and SEZ-with-tax exist; we map what we model. */
export type IrpSupplyType = 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' | 'DEXP';

/** Document type. A credit or debit note is registered the same way an invoice is. */
export type IrpDocType = 'INV' | 'CRN' | 'DBN';

export interface IrpParty {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  /** Place of supply — on the buyer only, and a state code. */
  Pos?: string;
  Addr1: string;
  Addr2?: string;
  /** City / town / village. The schema calls it location. */
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

export interface IrpItem {
  SlNo: string;
  PrdDesc: string;
  /** 'Y' for a service line, 'N' for goods. Decides whether Qty and Unit are required. */
  IsServc: 'Y' | 'N';
  HsnCd: string;
  Qty?: number;
  FreeQty?: number;
  Unit?: string;
  UnitPrice: number;
  /** Quantity times unit price, before discount. */
  TotAmt: number;
  Discount: number;
  /** What tax is charged on: TotAmt minus Discount. */
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt: number;
  CesAmt: number;
  CesNonAdvlAmt: number;
  OthChrg: number;
  /** AssAmt plus every tax and charge on the line. */
  TotItemVal: number;
}

export interface IrpValueDetails {
  AssVal: number;
  CgstVal: number;
  SgstVal: number;
  IgstVal: number;
  CesVal: number;
  StCesVal: number;
  Discount: number;
  OthChrg: number;
  RndOffAmt: number;
  TotInvVal: number;
}

/** Transport details. Sent with the invoice, the IRP returns an e-way bill number too. */
export interface IrpEwbDetails {
  /** Transporter's GSTIN, or a 15-character transporter id. */
  Transid?: string;
  Transname?: string;
  Distance: number;
  TransDocNo?: string;
  TransDocDt?: string;
  VehNo?: string;
  /** 'O' for over-dimensional cargo, 'R' for regular. Decides the validity rate. */
  VehType?: 'O' | 'R';
  /** 1 road, 2 rail, 3 air, 4 ship. */
  TransMode?: '1' | '2' | '3' | '4';
}

export interface IrpExportDetails {
  ShipBNo?: string;
  ShipBDt?: string;
  Port?: string;
  /** 'Y' when a refund of the IGST paid is being claimed. */
  RefClm?: 'Y' | 'N';
  ForCur?: string;
  CntCode?: string;
}

export interface EinvoicePayload {
  Version: '1.1';
  TranDtls: {
    TaxSch: 'GST';
    SupTyp: IrpSupplyType;
    /** 'Y' when the buyer pays the tax under reverse charge. */
    RegRev: 'Y' | 'N';
    /** 'Y' only for the rare case of IGST charged on an intra-state supply. */
    IgstOnIntra: 'Y' | 'N';
  };
  DocDtls: { Typ: IrpDocType; No: string; Dt: string };
  SellerDtls: IrpParty;
  BuyerDtls: IrpParty;
  ShipDtls?: Omit<IrpParty, 'Pos'>;
  ItemList: IrpItem[];
  ValDtls: IrpValueDetails;
  EwbDtls?: IrpEwbDetails;
  ExpDtls?: IrpExportDetails;
}

// ── What we feed it ──────────────────────────────────────────────────────────
//
// Assembled by a query rather than read here, so the builder stays pure and
// testable without a database.

export interface EinvoiceParty {
  gstin: string | null;
  legalName: string;
  tradeName?: string | null;
  address1: string | null;
  address2?: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface EinvoiceLine {
  lineNo: number;
  description: string;
  hsnSac: string | null;
  qty: number;
  uqc: string | null;
  /** Unit price before discount. */
  ratePaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  gstRatePct: number;
  /** Ad valorem cess rate; 0 when the goods attract none. */
  cessRatePct?: number;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  lineTotalPaise: Paise;
}

export interface EinvoiceTransport {
  transporterId?: string | null;
  transporterName?: string | null;
  distanceKm?: number | null;
  mode?: 'road' | 'rail' | 'air' | 'ship' | null;
  vehicleNo?: string | null;
  isOverDimensional?: boolean;
  transportDocNo?: string | null;
  transportDocDate?: string | null;
}

export interface EinvoiceSource {
  docType: IrpDocType;
  number: string;
  /** yyyy-mm-dd, as it comes out of a DATE column. */
  date: string;
  supplyType: SupplyType;
  supplyKind: 'goods' | 'service' | 'both';
  placeOfSupply: string;
  reverseCharge?: boolean;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  shipTo?: EinvoiceParty | null;
  lines: EinvoiceLine[];
  /** Document-level, outside the lines. */
  docDiscountPaise: Paise;
  shippingChargePaise: Paise;
  adjustmentPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
  transport?: EinvoiceTransport | null;
  export?: {
    shippingBillNo?: string | null;
    shippingBillDate?: string | null;
    portCode?: string | null;
    claimRefund?: boolean;
    currency?: string | null;
    countryCode?: string | null;
  } | null;
}

// ── Conversions ──────────────────────────────────────────────────────────────

/**
 * Integer paise to rupees with two decimals.
 *
 * Exact, not approximate: an integer divided by 100 has at most two decimal
 * places, so nothing is being rounded away here. The `toFixed` is only to
 * strip the binary representation's trailing noise before it becomes JSON.
 */
export function toRupees2(paise: Paise): number {
  return Number((paise / 100).toFixed(2));
}

/** yyyy-mm-dd to dd/mm/yyyy, the only date format the portal accepts. */
export function toIrpDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** dd/mm/yyyy back to yyyy-mm-dd, for reading a portal response. */
export function fromIrpDate(irpDate: string): string {
  const [d, m, y] = irpDate.slice(0, 10).split('/');
  return `${y}-${m}-${d}`;
}

/**
 * Our supply type to the portal's.
 *
 * SEZ and export both split on whether the tax was charged. We model
 * `export_with_tax` and `export_lut` separately but treat every SEZ supply as
 * without payment, because that is what `computeLineTax` actually does — it
 * charges nothing on an SEZ line. Claiming SEZWP while sending zero tax is the
 * kind of contradiction the portal rejects.
 */
export function toIrpSupplyType(t: SupplyType): IrpSupplyType {
  switch (t) {
    case 'export_with_tax': return 'EXPWP';
    case 'export_lut':      return 'EXPWOP';
    case 'sez':             return 'SEZWOP';
    // Intra, inter and nil-rated are all ordinary business-to-business
    // supplies as far as the portal is concerned. Which tax applied is read
    // off the amounts, not off this field.
    case 'intra':
    case 'inter':
    case 'nil_or_exempt':   return 'B2B';
  }
}

const TRANSPORT_MODE: Record<string, '1' | '2' | '3' | '4'> = {
  road: '1', rail: '2', air: '3', ship: '4',
};

/**
 * Is this line a service?
 *
 * The service accounting code shares its numbering space with HSN, and every
 * one of them begins 99 — that is the reliable test, and it works per line,
 * which matters on a mixed invoice where the document-level `supply_kind` is
 * 'both' and says nothing useful about any individual row.
 */
export function isServiceLine(hsnSac: string | null, supplyKind: 'goods' | 'service' | 'both'): boolean {
  if (hsnSac && hsnSac.length >= 2) return hsnSac.startsWith('99');
  return supplyKind === 'service';
}

/**
 * An export buyer has no Indian state and no PIN code.
 *
 * The portal's convention is state code 96 and PIN 999999, and it is a
 * convention rather than a fallback — sending the customer's real foreign
 * postcode is a rejection.
 */
const OVERSEAS_STATE = '96';
const OVERSEAS_PIN = 999999;

function isOverseas(t: SupplyType): boolean {
  return t === 'export_lut' || t === 'export_with_tax';
}

function party(p: EinvoiceParty, opts: { pos?: string; overseas?: boolean }): IrpParty {
  const out: IrpParty = {
    Gstin: p.gstin ?? 'URP', // unregistered person — the portal's own placeholder
    LglNm: p.legalName,
    Addr1: p.address1 ?? '',
    Loc: p.city ?? '',
    Pin: opts.overseas ? OVERSEAS_PIN : Number(p.pincode ?? 0),
    Stcd: opts.overseas ? OVERSEAS_STATE : (p.stateCode ?? ''),
  };
  if (p.tradeName && p.tradeName !== p.legalName) out.TrdNm = p.tradeName;
  if (p.address2) out.Addr2 = p.address2;
  if (p.phone) out.Ph = p.phone.replace(/\D/g, '').slice(-12);
  if (p.email) out.Em = p.email;
  if (opts.pos) out.Pos = opts.pos;
  return out;
}

// ── The builder ──────────────────────────────────────────────────────────────

/**
 * Build the INV-01 document.
 *
 * Deliberately does no validating. A payload built from incomplete data is
 * still a useful thing to look at, and the pre-flight check is a separate pass
 * whose whole job is to explain what is missing in words a user can act on.
 * Mixing the two would mean you cannot see the payload until it is already
 * perfect, which is the opposite of what you want while debugging one.
 */
export function buildEinvoicePayload(src: EinvoiceSource): EinvoicePayload {
  const overseas = isOverseas(src.supplyType);

  const items: IrpItem[] = src.lines.map((l) => {
    const isService = isServiceLine(l.hsnSac, src.supplyKind);
    const grossPaise = l.taxablePaise + l.discountPaise;

    const item: IrpItem = {
      SlNo: String(l.lineNo),
      PrdDesc: l.description.slice(0, 300),
      IsServc: isService ? 'Y' : 'N',
      HsnCd: l.hsnSac ?? '',
      UnitPrice: toRupees2(l.ratePaise),
      TotAmt: toRupees2(grossPaise),
      Discount: toRupees2(l.discountPaise),
      AssAmt: toRupees2(l.taxablePaise),
      GstRt: l.gstRatePct,
      IgstAmt: toRupees2(l.igstPaise),
      CgstAmt: toRupees2(l.cgstPaise),
      SgstAmt: toRupees2(l.sgstPaise),
      CesRt: l.cessRatePct ?? 0,
      CesAmt: toRupees2(l.cessPaise),
      CesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: toRupees2(l.lineTotalPaise),
    };

    // Quantity and unit are mandatory on goods and meaningless on services.
    // Sending them on a service line is one of the more common rejections.
    if (!isService) {
      item.Qty = Number(l.qty.toFixed(3));
      item.Unit = l.uqc ?? '';
      item.FreeQty = 0;
    }

    return item;
  });

  const sum = (pick: (l: EinvoiceLine) => Paise) => src.lines.reduce((t, l) => t + pick(l), 0);

  const payload: EinvoicePayload = {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: toIrpSupplyType(src.supplyType),
      RegRev: src.reverseCharge ? 'Y' : 'N',
      IgstOnIntra: 'N',
    },
    DocDtls: {
      Typ: src.docType,
      No: src.number,
      Dt: toIrpDate(src.date),
    },
    SellerDtls: party(src.seller, {}),
    BuyerDtls: party(src.buyer, {
      pos: overseas ? OVERSEAS_STATE : src.placeOfSupply,
      overseas,
    }),
    ItemList: items,
    ValDtls: {
      AssVal: toRupees2(sum((l) => l.taxablePaise)),
      CgstVal: toRupees2(sum((l) => l.cgstPaise)),
      SgstVal: toRupees2(sum((l) => l.sgstPaise)),
      IgstVal: toRupees2(sum((l) => l.igstPaise)),
      CesVal: toRupees2(sum((l) => l.cessPaise)),
      StCesVal: 0,
      Discount: toRupees2(src.docDiscountPaise),
      OthChrg: toRupees2(src.shippingChargePaise + src.adjustmentPaise),
      RndOffAmt: toRupees2(src.roundOffPaise),
      TotInvVal: toRupees2(src.totalPaise),
    },
  };

  // Ship-to is only sent when it is genuinely a different place. Repeating the
  // buyer's own address there tells the portal nothing and gives the schema
  // another set of fields to reject.
  if (src.shipTo && src.shipTo.address1) {
    const s = party(src.shipTo, {});
    delete s.Pos;
    payload.ShipDtls = s;
  }

  // Transport details turn one call into two documents: the response carries
  // the e-way bill number alongside the IRN.
  if (src.transport && (src.transport.vehicleNo || src.transport.transportDocNo)) {
    const t = src.transport;
    const ewb: IrpEwbDetails = { Distance: t.distanceKm ?? 0 };
    if (t.transporterId) ewb.Transid = t.transporterId;
    if (t.transporterName) ewb.Transname = t.transporterName.slice(0, 100);
    if (t.vehicleNo) ewb.VehNo = t.vehicleNo.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (t.transportDocNo) ewb.TransDocNo = t.transportDocNo;
    if (t.transportDocDate) ewb.TransDocDt = toIrpDate(t.transportDocDate);
    if (t.mode) ewb.TransMode = TRANSPORT_MODE[t.mode];
    ewb.VehType = t.isOverDimensional ? 'O' : 'R';
    payload.EwbDtls = ewb;
  }

  if (overseas && src.export) {
    const e = src.export;
    const exp: IrpExportDetails = {};
    if (e.shippingBillNo) exp.ShipBNo = e.shippingBillNo;
    if (e.shippingBillDate) exp.ShipBDt = toIrpDate(e.shippingBillDate);
    if (e.portCode) exp.Port = e.portCode;
    if (e.currency) exp.ForCur = e.currency;
    if (e.countryCode) exp.CntCode = e.countryCode;
    // Only meaningful on an export made with tax paid — there is nothing to
    // refund on a zero-rated supply under a letter of undertaking.
    exp.RefClm = src.supplyType === 'export_with_tax' && e.claimRefund ? 'Y' : 'N';
    payload.ExpDtls = exp;
  }

  return payload;
}
