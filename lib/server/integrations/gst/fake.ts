import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The stand-in portal.
//
// This is not scaffolding to be deleted later. It is the provider the demo
// book uses permanently, and it has to keep working with no network, no
// credentials and no encryption key — a fully worked example that somebody can
// click through without signing up is the point of the demo, and it cannot
// depend on a government service being up.
//
// So it behaves like the portal in the ways that matter to the code around it:
// the reference numbers it issues are derived from the document exactly as the
// real ones are, which makes them stable across retries and unique per
// document. It differs in the one way that matters to a human: everything it
// produces is visibly marked, so no screen, print or export can pass a
// pretend registration off as a real one.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { validUntil as ewbValidUntil } from '../../../tax/eway';
import type { EinvoicePayload } from './einvoice-payload';
import { fromIrpDate } from './einvoice-payload';
import type { EwayBillPayload } from './eway-payload';
import {
  formatPortalTimestamp,
  type EwayBillResult, type EwbByIrn, type EwbExtension, type GstProvider, type IrnResult, type ProviderContext,
} from './provider';

/** The four characters that make a stand-in reference unmistakable. */
const MARK = 'DEMO';

/**
 * Timestamps in the portal's own convention — IST, no zone — so the code
 * reading them is exercised on exactly what the real portal sends. Formatting
 * in the server's local time instead would pass every test on a machine in
 * India and be five and a half hours out on a UTC host.
 */
const portalTimestamp = formatPortalTimestamp;

/**
 * The financial year a document falls in, as the portal labels it.
 *
 * India's year runs April to March, so a January invoice belongs to the year
 * that started the previous April. It is part of the real IRN's input, which
 * is why a document number may repeat across years without colliding.
 */
export function financialYear(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const start = month < 4 ? year - 1 : year;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The Invoice Reference Number, computed the way the portal computes it: a
 * SHA-256 over the supplier's GSTIN, the document type, its number and the
 * financial year. That is what makes an IRN a fingerprint rather than a serial
 * — the same document always hashes to the same value, and registering it
 * twice is refused because the hash already exists.
 *
 * The leading four characters are then overwritten with DEMO. It stays 64 hex-
 * ish characters so nothing downstream has to special-case its length, while
 * being obviously not a government-issued value at a glance.
 */
export function fakeIrn(gstin: string, docType: string, docNo: string, isoDate: string): string {
  const hash = createHash('sha256')
    .update(`${gstin}${docType}${docNo}${financialYear(isoDate)}`)
    .digest('hex');
  return MARK + hash.slice(MARK.length);
}

/** A 12-digit e-way bill number, derived from the document so retries agree. */
function fakeEwbNo(gstin: string, docNo: string, isoDate: string): string {
  const hash = createHash('sha256').update(`ewb${gstin}${docNo}${isoDate}`).digest('hex');
  // First digit forced to 1: NIC's numbers never begin with 0, and a leading
  // zero would be lost the moment anything treated this as a number.
  return `1${(BigInt(`0x${hash.slice(0, 16)}`) % 100_000_000_000n).toString().padStart(11, '0')}`;
}

/** A 16-digit acknowledgement number, in the shape the portal returns. */
function fakeAckNo(irn: string): string {
  const n = BigInt(`0x${irn.slice(4, 20)}`) % 1_000_000_000_000_000n;
  return `1${n.toString().padStart(15, '0')}`;
}

/**
 * A structurally valid but unsigned token, in place of the government's signed
 * copy.
 *
 * The real thing is a JWS: three base64 segments, the last a signature over
 * the first two. This produces the same three-segment shape with `alg: none`
 * and an explicit `demo` claim, so a QR renderer or a parser handles it
 * normally while anything that checks the signature correctly refuses it.
 * Returning a plausible-looking *signed* value would be the one genuinely
 * dangerous thing a stand-in could do.
 */
function unsignedToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, demo: true })}.`;
}

export class FakeGstProvider implements GstProvider {
  readonly name = 'fake';
  readonly live = false;
  readonly environment = 'stand-in' as const;

  async verify(): Promise<{ expiresAt: string | null }> {
    // Nothing to authenticate against. Reporting success here is honest only
    // because the UI never presents the stand-in as a connection.
    return { expiresAt: null };
  }

  async generateIrn(payload: EinvoicePayload, ctx: ProviderContext): Promise<IrnResult> {
    const isoDate = fromIrpDate(payload.DocDtls.Dt);
    const gstin = payload.SellerDtls.Gstin || ctx.gstin;
    const irn = fakeIrn(gstin, payload.DocDtls.Typ, payload.DocDtls.No, isoDate);
    const now = new Date();

    const result: IrnResult = {
      irn,
      ackNo: fakeAckNo(irn),
      ackDate: portalTimestamp(now),
      signedInvoice: unsignedToken({ data: JSON.stringify(payload) }),
      // The real QR carries exactly these eight fields and nothing else — it
      // has to fit in a scannable code, so the whole invoice is not in it.
      signedQr: unsignedToken({
        SellerGstin: gstin,
        BuyerGstin: payload.BuyerDtls.Gstin,
        DocNo: payload.DocDtls.No,
        DocTyp: payload.DocDtls.Typ,
        DocDt: payload.DocDtls.Dt,
        TotInvVal: payload.ValDtls.TotInvVal,
        ItemCnt: payload.ItemList.length,
        Irn: irn,
      }),
      ewbNo: null,
      ewbValidUntil: null,
    };

    // Transport details sent with the invoice mean the portal issues both
    // documents from one call. Reproduced here because the calling code has to
    // handle that branch, and it is easy to leave untested otherwise.
    if (payload.EwbDtls?.VehNo || payload.EwbDtls?.TransDocNo) {
      result.ewbNo = fakeEwbNo(gstin, payload.DocDtls.No, isoDate);
      result.ewbValidUntil = portalTimestamp(
        ewbValidUntil(now, payload.EwbDtls.Distance ?? 0, payload.EwbDtls.VehType === 'O'),
      );
    }

    return result;
  }

  // Takes none of the interface's arguments on purpose: TypeScript allows an
  // implementation to ignore trailing parameters, and there is nothing here
  // that could use them.
  async cancelIrn(): Promise<{ cancelledAt: string }> {
    // The 24-hour limit is not enforced here. It is the caller's rule to keep,
    // because it has to hold regardless of which provider is configured — and
    // a stand-in that silently allowed what the portal forbids would let a
    // bug through to production.
    return { cancelledAt: portalTimestamp(new Date()) };
  }

  async generateEwayBill(
    payload: EwayBillPayload,
    ctx: ProviderContext,
  ): Promise<EwayBillResult> {
    const now = new Date();
    const isoDate = fromIrpDate(payload.docDate);
    const distance = Number(payload.transDistance) || 0;

    return {
      ewbNo: fakeEwbNo(payload.fromGstin || ctx.gstin, payload.docNo, isoDate),
      // Validity runs from now, because "now" is when Part B arrived. If the
      // payload carries no vehicle the caller should not have got here.
      validUntil: portalTimestamp(ewbValidUntil(now, distance, payload.vehicleType === 'O')),
      generatedAt: portalTimestamp(now),
    };
  }

  async generateEwbByIrn(req: EwbByIrn, ctx: ProviderContext): Promise<EwayBillResult> {
    const now = new Date();
    return {
      // Derived from the IRN, so a retry on the same day gets the same number.
      ewbNo: fakeEwbNo(ctx.gstin, req.irn, portalTimestamp(now).slice(0, 10)),
      validUntil: portalTimestamp(ewbValidUntil(now, req.distanceKm, req.isOverDimensional)),
      generatedAt: portalTimestamp(now),
    };
  }

  async updateEwayVehicle(): Promise<{ updatedAt: string; validUntil: string | null }> {
    // A change of vehicle leaves validity alone. The first Part B does start
    // the clock, but the stand-in keeps no state to know which that is; the
    // caller does, and works the expiry out itself.
    return { updatedAt: portalTimestamp(new Date()), validUntil: null };
  }

  async extendEwayBill(ext: EwbExtension): Promise<{ extendedAt: string; validUntil: string }> {
    // As the portal does it: counted afresh from now, on the distance left.
    const now = new Date();
    return {
      extendedAt: portalTimestamp(now),
      validUntil: portalTimestamp(ewbValidUntil(now, ext.remainingDistanceKm, ext.isOverDimensional)),
    };
  }

  async cancelEwayBill(): Promise<{ cancelledAt: string }> {
    // The 24-hour limit is the caller's to keep, as with an IRN.
    return { cancelledAt: portalTimestamp(new Date()) };
  }
}

export const fakeProvider = new FakeGstProvider();
