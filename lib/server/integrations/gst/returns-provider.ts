import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Filing GST returns through the GST system's API: the seam, and the stand-in.
//
// Zoho Books' "connect to GSTN" is this: the taxpayer turns on API access on
// the GST portal (Profile → Manage API Access, for six hours up to thirty
// days), gives the software their portal username, and enters the OTP the
// portal sends to their phone. From then until the access runs out the
// software can push GSTR-1 and GSTR-3B, read back what the portal made of
// them, fetch GSTR-2B, and file with an EVC — a second OTP, to the
// authorised signatory — which returns the ARN.
//
// Only a GST Suvidha Provider may call the GST system, so a live connection
// runs through a GSP's account (gstn-returns.ts, configured from the
// environment). Without one the stand-in below answers: it behaves like the
// GSTN sandbox (OTP 575757), keeps what it is sent in memory, and files
// nothing — and every screen says so.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { PortalAuthFailed, PortalRejection, type ProviderEnvironment } from './provider';

export type ReturnType = 'GSTR1' | 'IFF' | 'GSTR3B';

/** Who the call is for. The username is the taxpayer's GST portal login, not a password. */
export interface ReturnsContext {
  gstin: string;
  username: string;
  /** The user's address, which the GST system asks for on every call. */
  ipUser?: string;
}

/** What signing in leaves behind: a token, and the key every payload is sealed with. */
export interface ReturnsSession {
  authToken: string;
  /** Base64 of the 32-byte session key (EK). */
  sessionKey: string;
  expiresAt: string;
}

export type SubmissionStatus = 'processed' | 'processed_with_errors' | 'error' | 'pending';

export interface TaxpayerDetails {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  /** Active, Cancelled, Suspended… as the GST system reports it. */
  status: string | null;
  /** Regular, Composition, SEZ Unit, Input Service Distributor… */
  taxpayerType: string | null;
  constitution: string | null;
  registeredOn: string | null;
  cancelledOn: string | null;
  address: { line: string | null; city: string | null; district: string | null; stateCode: string; pincode: string | null } | null;
  /** True when the details came from the GST system; false for the stand-in's guesses. */
  fromPortal: boolean;
}

export interface FilingTrackRow {
  returnType: string;
  period: string;
  status: string;
  arn: string | null;
  filedOn: string | null;
  mode: string | null;
}

export interface ReturnsProvider {
  readonly name: string;
  readonly environment: ProviderEnvironment;
  readonly live: boolean;
  /** Ask the GST system to send the OTP. Returns what must be kept until the OTP is entered. */
  requestOtp(ctx: ReturnsContext): Promise<{ pending: string; message: string }>;
  verifyOtp(ctx: ReturnsContext, pending: string, otp: string): Promise<ReturnsSession>;
  /** Public details of any registration; needs no taxpayer session. */
  searchTaxpayer(ctx: { ipUser?: string }, gstin: string): Promise<TaxpayerDetails>;
  saveReturn(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, period: string, payload: unknown): Promise<{ referenceId: string }>;
  returnStatus(ctx: ReturnsContext, s: ReturnsSession, period: string, referenceId: string): Promise<{ status: SubmissionStatus; message: string | null; errorReport: unknown }>;
  /** The second OTP, to the authorised signatory's phone, that an EVC filing is signed with. */
  requestEvcOtp(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, pan: string): Promise<{ message: string }>;
  fileReturn(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, period: string, evc: { pan: string; otp: string }): Promise<{ arn: string; filedAt: string }>;
  fetchGstr2b(ctx: ReturnsContext, s: ReturnsSession, period: string): Promise<unknown>;
  trackReturns(ctx: { ipUser?: string }, gstin: string, fy: string): Promise<FilingTrackRow[]>;
}

/** The GSTN sandbox's fixed OTP, which the stand-in honours too. */
export const STANDIN_OTP = '575757';

const PAN_KIND: Record<string, string> = {
  C: 'Private Limited Company', F: 'Partnership', P: 'Proprietorship', H: 'Hindu Undivided Family',
  A: 'Association of Persons', T: 'Trust', B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government',
};

/**
 * The stand-in: the GSTN sandbox's behaviour, kept in this process's memory.
 * It never leaves the app, so it can verify the flow end to end without a
 * GSP account — and it never claims to have filed anything with anyone.
 */
class StandinReturns implements ReturnsProvider {
  readonly name = 'fake';
  readonly environment: ProviderEnvironment = 'stand-in';
  readonly live = false;
  private readonly saved = new Map<string, { referenceId: string; payload: unknown }>();
  private readonly filed = new Map<string, { arn: string; filedAt: string; type: ReturnType; period: string }>();

  async requestOtp(ctx: ReturnsContext) {
    if (!ctx.username.trim()) throw new PortalAuthFailed('Give the GST portal username first.');
    return { pending: randomBytes(16).toString('hex'), message: `The stand-in sends no SMS: the OTP is ${STANDIN_OTP}, as on the GSTN sandbox.` };
  }

  async verifyOtp(_ctx: ReturnsContext, pending: string, otp: string): Promise<ReturnsSession> {
    if (!pending) throw new PortalAuthFailed('Ask for an OTP first.');
    if (otp.trim() !== STANDIN_OTP) throw new PortalAuthFailed(`That OTP is not right. On the stand-in it is ${STANDIN_OTP}.`);
    return {
      authToken: `standin-${randomBytes(12).toString('hex')}`,
      sessionKey: randomBytes(32).toString('base64'),
      expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    };
  }

  async searchTaxpayer(_ctx: { ipUser?: string }, gstin: string): Promise<TaxpayerDetails> {
    // Only what the number itself says: the state, and the kind of PAN holder.
    return {
      gstin,
      legalName: null,
      tradeName: null,
      status: null,
      taxpayerType: gstin[13] === 'Z' ? 'Regular' : null,
      constitution: PAN_KIND[gstin[5]] ?? null,
      registeredOn: null,
      cancelledOn: null,
      address: { line: null, city: null, district: null, stateCode: gstin.slice(0, 2), pincode: null },
      fromPortal: false,
    };
  }

  async saveReturn(ctx: ReturnsContext, _s: ReturnsSession, type: ReturnType, period: string, payload: unknown) {
    const p = (payload ?? {}) as { gstin?: string; fp?: string; ret_period?: string };
    if (p.gstin && p.gstin !== ctx.gstin) throw new PortalRejection('RET11402', `The return is for ${p.gstin}, but the session is for ${ctx.gstin}.`);
    const fp = p.fp ?? p.ret_period;
    if (fp && fp !== period) throw new PortalRejection('RET11403', `The return is for period ${fp}, not ${period}.`);
    if (this.filed.has(`${ctx.gstin}|${type}|${period}`)) throw new PortalRejection('RET191113', `${type} for ${period} has already been filed.`);
    const referenceId = `SI${period}${randomBytes(5).toString('hex').toUpperCase()}`;
    this.saved.set(`${ctx.gstin}|${type}|${period}`, { referenceId, payload });
    return { referenceId };
  }

  async returnStatus(_ctx: ReturnsContext, _s: ReturnsSession, _period: string, referenceId: string) {
    const known = [...this.saved.values()].some((v) => v.referenceId === referenceId);
    return known
      ? { status: 'processed' as const, message: 'Processed by the stand-in. Nothing was sent to the GST system.', errorReport: null }
      : { status: 'error' as const, message: 'The stand-in has no record of that reference (it forgets on restart).', errorReport: null };
  }

  async requestEvcOtp() {
    return { message: `The stand-in sends no SMS: the EVC OTP is ${STANDIN_OTP}.` };
  }

  async fileReturn(ctx: ReturnsContext, _s: ReturnsSession, type: ReturnType, period: string, evc: { pan: string; otp: string }) {
    const key = `${ctx.gstin}|${type}|${period}`;
    if (!this.saved.has(key)) throw new PortalRejection('RET191114', `Push ${type} for ${period} to the portal before filing it.`);
    if (evc.otp.trim() !== STANDIN_OTP) throw new PortalAuthFailed(`That EVC OTP is not right. On the stand-in it is ${STANDIN_OTP}.`);
    if (evc.pan !== ctx.gstin.slice(2, 12)) throw new PortalRejection('RET13509', 'The PAN is not that of an authorised signatory of this registration.');
    // AA + state + MMYY + seven digits + a check letter: the shape of a real ARN.
    const arn = `AA${ctx.gstin.slice(0, 2)}${period.slice(0, 2)}${period.slice(4, 6)}${String(randomBytes(4).readUInt32BE() % 10_000_000).padStart(7, '0')}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[randomBytes(1)[0] % 24]}`;
    const filedAt = new Date().toISOString();
    this.filed.set(key, { arn, filedAt, type, period });
    return { arn, filedAt };
  }

  async fetchGstr2b(): Promise<unknown> {
    throw new PortalRejection('STANDIN', 'The stand-in has no GST system to fetch GSTR-2B from. Connect through a GSP, or import the JSON downloaded from the portal.');
  }

  async trackReturns(_ctx: { ipUser?: string }, gstin: string): Promise<FilingTrackRow[]> {
    return [...this.filed.entries()].filter(([k]) => k.startsWith(`${gstin}|`)).map(([, f]) => ({
      returnType: f.type, period: f.period, status: 'Filed (stand-in)', arn: f.arn, filedOn: f.filedAt.slice(0, 10), mode: 'EVC',
    }));
  }
}

const g = globalThis as unknown as { __rekonzaStandinReturns?: StandinReturns };
export const standinReturns: ReturnsProvider = (g.__rekonzaStandinReturns ??= new StandinReturns());
