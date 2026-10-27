import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The seam a portal sits behind.
//
// There will be at least three implementations of this over the app's life:
// the built-in stand-in the demo book uses, NIC's public sandbox, and whichever
// GSP ends up under contract — and GSPs get changed. None of the calling code
// should know or care which is in use, and the demo book must keep working
// forever without a network.
//
// Everything above this interface deals in our own documents. Everything below
// it deals in the portal's. The conversion happens in the payload builders, and
// nowhere else.
// ─────────────────────────────────────────────────────────────────────────────

import type { EinvoicePayload } from './einvoice-payload';
import type { EwayBillPayload } from './eway-payload';
import type { EwbCancelReason, EwbExtendReason, VehicleChangeReason } from '../../../tax/eway';

/** Which portal a connection talks to. Mirrors the `portal` enum in the schema. */
export type Portal = 'einvoice' | 'ewaybill' | 'returns';

/**
 * A refusal from the portal, as opposed to the network failing.
 *
 * The distinction decides whether retrying is worth anything. A rejection is
 * about the document and will happen again identically; a transport failure is
 * about the moment and probably will not. The job queue needs to tell them
 * apart to avoid burning three attempts on a document that can never be
 * accepted, which then reads as a portal outage in the register.
 */
export class PortalRejection extends Error {
  readonly code: string;
  readonly retryable = false;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PortalRejection';
    this.code = code;
    this.details = details;
  }
}

/**
 * The portal already holds this document.
 *
 * Kept distinct from an ordinary rejection because it is the one refusal that
 * carries good news. It usually means an earlier attempt *succeeded* at the
 * portal and the reply was lost — a timeout, a crash, a rolled-back write —
 * so the portal has an IRN the books do not. The portal hands the existing
 * IRN back with the refusal, and recording it is how that state is repaired.
 */
export class PortalDuplicate extends PortalRejection {
  readonly irn: string;
  readonly ackNo: string | null;
  readonly ackDate: string | null;
  constructor(irn: string, ackNo: string | null, ackDate: string | null, message: string) {
    super('2150', message);
    this.name = 'PortalDuplicate';
    this.irn = irn;
    this.ackNo = ackNo;
    this.ackDate = ackDate;
  }
}

/** The portal was unreachable, slow, or broken. Worth trying again later. */
export class PortalUnavailable extends Error {
  readonly retryable = true;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PortalUnavailable';
    this.cause = cause;
  }
}

/**
 * Authentication failed in a way retrying will not fix — the portal password
 * changed, or the API user was removed. Separate because the remedy is to ask
 * the customer for credentials again, not to queue another attempt.
 */
export class PortalAuthFailed extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'PortalAuthFailed';
  }
}

/**
 * Where a portal session token is kept between calls.
 *
 * An interface rather than a table because the tests need to supply their own,
 * and because the provider has no business knowing there is a database. The
 * real one seals the token before storing it — see `dbSessionStore`.
 */
export interface SessionStore {
  get(connectionId: number): Promise<{ authToken: string; sessionKey: string } | null>;
  set(
    connectionId: number,
    session: { authToken: string; sessionKey: string },
    expiresAt: Date,
  ): Promise<void>;
  clear(connectionId: number): Promise<void>;
}

/** What a provider is told about the connection it is acting on behalf of. */
export interface ProviderContext {
  orgId: number;
  connectionId: number | null;
  /** The registration being acted for. Every portal credential is bound to one. */
  gstin: string;
  /**
   * Opened only when a call actually needs them, and never logged. The fake
   * provider ignores this entirely, which is why the demo book needs no key.
   */
  credentials?: { username: string; password: string; clientId?: string; clientSecret?: string };
  baseUrl?: string;
  /** Absent means every call authenticates afresh — correct, just slower. */
  sessions?: SessionStore;
}

// ── Time, as the portals tell it ─────────────────────────────────────────────
//
// Every timestamp the GST portals return is Indian Standard Time, written
// without a zone: "2026-09-11 14:18:00". Parsing that as the *server's* local
// time is right on a machine in India and five and a half hours wrong on a
// cloud host running UTC — which is exactly where the static-IP requirement
// is likely to push this app. So the zone is stated, not assumed.

const IST_OFFSET_MS = 330 * 60_000;

/** "yyyy-MM-dd HH:mm:ss" in IST, from the portal, to an absolute instant. */
export function parsePortalTimestamp(value: string): Date {
  const iso = value.trim().replace(' ', 'T');
  const d = new Date(`${iso.length === 10 ? `${iso}T00:00:00` : iso}+05:30`);
  if (Number.isNaN(d.getTime())) throw new Error(`Unreadable portal timestamp "${value}".`);
  return d;
}

/** An absolute instant, written the way the portals write it: IST, no zone. */
export function formatPortalTimestamp(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

// ── What comes back ──────────────────────────────────────────────────────────

export interface IrnResult {
  /** 64 hex characters. The portal's permanent fingerprint for this document. */
  irn: string;
  ackNo: string;
  /** yyyy-mm-dd HH:mm:ss, as the portal reports it. */
  ackDate: string;
  /** The government's own signed copy of the invoice, as a JWT. The legal proof. */
  signedInvoice: string | null;
  /** The QR payload that has to be printed on the invoice. Also a JWT. */
  signedQr: string | null;
  /** Present only when transport details were sent alongside the invoice. */
  ewbNo: string | null;
  ewbValidUntil: string | null;
}

export interface EwayBillResult {
  ewbNo: string;
  /** yyyy-mm-dd HH:mm:ss. Counted from when Part B was supplied, not generation. */
  validUntil: string;
  generatedAt: string;
}

/**
 * The reason codes the portal accepts for cancelling an IRN. Not free text:
 * sending anything else is a rejection.
 */
export type CancelReasonCode = '1' | '2' | '3' | '4';

export const CANCEL_REASONS: Record<CancelReasonCode, string> = {
  '1': 'Duplicate',
  '2': 'Data entry mistake',
  '3': 'Order cancelled',
  '4': 'Other',
};

/** A new vehicle, or transport document, for a bill already generated: Part B again. */
export interface EwbVehicleChange {
  ewbNo: string;
  vehicleNo: string | null;
  /** Where the goods are when the vehicle changes. The portal records it. */
  fromPlace: string;
  fromStateCode: string;
  reason: VehicleChangeReason;
  remark: string;
  mode: 'road' | 'rail' | 'air' | 'ship';
  transportDocNo: string | null;
  /** dd/mm/yyyy, the way the portals write dates. */
  transportDocDate: string | null;
}

/** More time for a bill whose goods have not arrived. */
export interface EwbExtension {
  ewbNo: string;
  /** Null when the goods are waiting somewhere rather than on a vehicle. */
  vehicleNo: string | null;
  fromPlace: string;
  fromStateCode: string;
  fromPincode: string;
  /** The new validity is counted from now on this, one day per 200 km. */
  remainingDistanceKm: number;
  reason: EwbExtendReason;
  remark: string;
  consignment: 'in_movement' | 'in_transit';
  mode: 'road' | 'rail' | 'air' | 'ship';
  isOverDimensional: boolean;
}

/** Part B for an e-way bill issued against an IRN already registered. */
export interface EwbByIrn {
  irn: string;
  /** Zero asks the portal to work it out from the two PIN codes. */
  distanceKm: number;
  mode: 'road' | 'rail' | 'air' | 'ship';
  vehicleNo: string | null;
  transporterId: string | null;
  transporterName: string | null;
  transportDocNo: string | null;
  /** dd/mm/yyyy, the way the portals write dates. */
  transportDocDate: string | null;
  isOverDimensional: boolean;
}

/**
 * Three different things, and the difference is what the user is told.
 *
 * `stand-in` never leaves the app. `sandbox` makes real calls to the real API
 * with test data — a genuine connection that files nothing. `production` files.
 * Collapsing sandbox into either neighbour would be a lie in one direction or
 * the other: it is not pretend, and it is not filed.
 */
export type ProviderEnvironment = 'stand-in' | 'sandbox' | 'production';

export interface GstProvider {
  /** Stored on every document this provider issued, so its origin stays known. */
  readonly name: string;
  /** Whether anything it produces is real. Drives the "nothing is filed" banner. */
  readonly live: boolean;
  readonly environment: ProviderEnvironment;

  /**
   * Authenticate and nothing else. The only way to tell a customer their
   * credentials work without registering an invoice to find out.
   */
  verify(ctx: ProviderContext): Promise<{ expiresAt: string | null }>;

  generateIrn(payload: EinvoicePayload, ctx: ProviderContext): Promise<IrnResult>;

  /**
   * Only possible within 24 hours of registration, and the portal enforces it.
   * After that the document legally exists and has to be reversed with a
   * credit note, which is itself registered.
   */
  cancelIrn(
    irn: string,
    reason: CancelReasonCode,
    remark: string,
    ctx: ProviderContext,
  ): Promise<{ cancelledAt: string }>;

  generateEwayBill(payload: EwayBillPayload, ctx: ProviderContext): Promise<EwayBillResult>;

  /**
   * An e-way bill for an invoice that already has its IRN: the usual order,
   * because the vehicle is often known only at dispatch. The invoice portal
   * serves it itself, so it needs no separate e-way bill connection.
   */
  generateEwbByIrn(req: EwbByIrn, ctx: ProviderContext): Promise<EwayBillResult>;

  /** Only while the bill is valid. A later change of lorry does not move the expiry. */
  updateEwayVehicle(
    change: EwbVehicleChange,
    ctx: ProviderContext,
  ): Promise<{ updatedAt: string; validUntil: string | null }>;

  /** Only within 8 hours either side of expiry; the portal enforces it too. */
  extendEwayBill(ext: EwbExtension, ctx: ProviderContext): Promise<{ extendedAt: string; validUntil: string }>;

  /** Only within 24 hours of generation. */
  cancelEwayBill(
    ewbNo: string,
    reason: EwbCancelReason,
    remark: string,
    ctx: ProviderContext,
  ): Promise<{ cancelledAt: string }>;
}
