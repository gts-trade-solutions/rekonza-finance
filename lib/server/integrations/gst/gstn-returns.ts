import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The GST system's returns API, spoken through a GSP.
//
// Written to GSTN's published taxpayer API, which most GST Suvidha Providers
// pass through unchanged behind their own host and their own headers:
//
//   Sign in   POST authenticate  OTPREQUEST, then AUTHTOKEN with the OTP.
//             A 32-byte app key of ours travels RSA-sealed with GSTN's public
//             key; the OTP is AES-sealed with it; the reply's session key
//             (sek) is AES-sealed under it too.
//   Every call after: the JSON is base64-encoded, AES-256-ECB sealed with the
//             session key, and signed with HMAC-SHA256 under the same key.
//             Replies carry their own key (rek), sealed with the session key,
//             and their data sealed with that.
//   Public    search (a GSTIN's details) and return tracking need only the
//             GSP's own credentials; their data comes back base64, unsealed.
//
// Everything that differs between GSPs — the host, the paths, extra headers —
// is configuration (GST_API_* in .env.example). Where GSTN's own documents
// leave room (the exact EVC signature, a reply base64-wrapped inside its
// ciphertext or not), every documented variant is accepted; the first call
// through a GSP's sandbox settles it. Verified here against a fake of that
// API (scripts/tests/gst-returns-api.test.ts), not yet against a live GSP.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { aesDecrypt, aesEncryptBase64, decryptJson, decryptSessionKey, loadPublicKey, rsaEncryptBase64 } from './nic-crypto';
import { PortalAuthFailed, PortalRejection, PortalUnavailable, type ProviderEnvironment } from './provider';
import type {
  FilingTrackRow, ReturnsContext, ReturnsProvider, ReturnsSession, ReturnType, SubmissionStatus, TaxpayerDetails,
} from './returns-provider';

export interface GstnConfig {
  baseUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  publicKey: KeyObject | null;
  publicKeyError: string | null;
  environment: 'sandbox' | 'production';
  headers: Record<string, string>;
  paths: Record<'auth' | 'gstr1' | 'iff' | 'gstr3b' | 'returns' | 'gstr2b' | 'search' | 'track', string>;
  timeoutMs: number;
}

const DEFAULT_PATHS: GstnConfig['paths'] = {
  auth: '/taxpayerapi/v1.0/authenticate',
  gstr1: '/taxpayerapi/v1.1/returns/gstr1',
  iff: '/taxpayerapi/v1.0/returns/iff',
  gstr3b: '/taxpayerapi/v1.0/returns/gstr3b',
  returns: '/taxpayerapi/v1.0/returns',
  gstr2b: '/taxpayerapi/v1.0/returns/gstr2b',
  search: '/commonapi/v1.1/search',
  track: '/commonapi/v1.0/returns',
};

function json<T>(raw: string | undefined, name: string): T | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

export function gstnConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GstnConfig {
  let publicKey: KeyObject | null = null;
  let publicKeyError: string | null = null;
  if (env.GST_API_PUBLIC_KEY?.trim()) {
    try {
      publicKey = loadPublicKey(env.GST_API_PUBLIC_KEY);
    } catch (err) {
      publicKeyError = `GST_API_PUBLIC_KEY could not be read: ${(err as Error).message}`;
    }
  }
  return {
    baseUrl: env.GST_API_BASE_URL?.trim().replace(/\/+$/, '') || null,
    clientId: env.GST_API_CLIENT_ID?.trim() || null,
    clientSecret: env.GST_API_CLIENT_SECRET?.trim() || null,
    publicKey,
    publicKeyError,
    environment: env.GST_API_ENV?.trim().toLowerCase() === 'production' ? 'production' : 'sandbox',
    headers: json<Record<string, string>>(env.GST_API_HEADERS, 'GST_API_HEADERS') ?? {},
    paths: { ...DEFAULT_PATHS, ...(json<Partial<GstnConfig['paths']>>(env.GST_API_PATHS, 'GST_API_PATHS') ?? {}) },
    timeoutMs: Number(env.GST_API_TIMEOUT_MS) || 60_000,
  };
}

interface Envelope {
  status_cd?: string | number;
  status?: string | number;
  error?: { error_cd?: string; message?: string } | string;
  data?: unknown;
  rek?: string;
  hmac?: string;
  auth_token?: string;
  expiry?: number | string;
  sek?: string;
  [k: string]: unknown;
}

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const hmac = (key: Buffer, message: string) => createHmac('sha256', key).update(message, 'utf8').digest('base64');

/** A GSTIN's state is its first two digits; the API wants it on every call. */
const stateOf = (gstin: string) => gstin.slice(0, 2);

/** MMYYYY, for a period given as MMYYYY already or as yyyy-mm. */
export function retPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${m[2]}${m[1]}` : period;
}

export class GstnReturnsProvider implements ReturnsProvider {
  readonly name = 'gstn';
  readonly live = true;
  private readonly cfg: GstnConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: GstnConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get environment(): ProviderEnvironment {
    return this.cfg.environment;
  }

  /** What the server still needs before this can be used, by name. */
  missingConfiguration(): string[] {
    const out: string[] = [];
    if (!this.cfg.baseUrl) out.push('GST_API_BASE_URL (your GSP’s address)');
    if (!this.cfg.clientId) out.push('GST_API_CLIENT_ID');
    if (!this.cfg.clientSecret) out.push('GST_API_CLIENT_SECRET');
    if (!this.cfg.publicKey) out.push(this.cfg.publicKeyError ?? 'GST_API_PUBLIC_KEY (GSTN’s public key, from your GSP)');
    return out;
  }

  private ready() {
    const missing = this.missingConfiguration();
    if (missing.length) throw new PortalUnavailable(`The GST returns connection is not set up on the server: ${missing.join(', ')}.`);
  }

  private baseHeaders(stateCd: string, ipUser?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      clientid: this.cfg.clientId ?? '',
      'client-secret': this.cfg.clientSecret ?? '',
      'state-cd': stateCd,
      'ip-usr': ipUser || '127.0.0.1',
      txn: randomUUID().replace(/-/g, '').slice(0, 25),
      ...this.cfg.headers,
    };
  }

  private async send(method: 'GET' | 'POST' | 'PUT', path: string, headers: Record<string, string>, body?: unknown, query?: Record<string, string>): Promise<Envelope> {
    this.ready();
    const url = new URL(this.cfg.baseUrl! + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      throw new PortalUnavailable(`The GST system did not answer: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let env: Envelope;
    try {
      env = text ? (JSON.parse(text) as Envelope) : {};
    } catch {
      throw new PortalUnavailable(`The GST system answered ${res.status} with something that is not JSON.`);
    }
    if (res.status >= 500) throw new PortalUnavailable(`The GST system is unavailable (${res.status}).`);
    const ok = String(env.status_cd ?? env.status ?? '') === '1';
    if (!ok) {
      const e = typeof env.error === 'object' && env.error ? env.error : { message: typeof env.error === 'string' ? env.error : undefined };
      const code = e.error_cd ?? String(res.status);
      const message = e.message ?? `The GST system refused the request (${code}).`;
      // Signing-in failures are for the person to fix (a wrong OTP, access not
      // turned on, the session over); retrying will not help.
      if (/^AUTH/i.test(code) || res.status === 401 || res.status === 403) throw new PortalAuthFailed(`${message} (${code})`);
      throw new PortalRejection(code, message, env);
    }
    return env;
  }

  /** A sealed reply opened: its own key (rek) under the session key, the data under that. */
  private open<T>(env: Envelope, sessionKey: Buffer): T {
    if (typeof env.data !== 'string') return env.data as T;
    if (!env.rek) return decryptJson<T>(sessionKey, env.data);
    const rek = decryptSessionKey(sessionKey, env.rek);
    // The data is the reply's JSON, base64-encoded, then sealed; the HMAC is
    // over that base64 text. A reply sealed without the base64 step is read too.
    const plain = aesDecrypt(rek, env.data).toString('utf8').trim();
    const isJson = plain.startsWith('{') || plain.startsWith('[');
    const b64 = isJson ? Buffer.from(plain, 'utf8').toString('base64') : plain;
    if (env.hmac && hmac(rek, b64) !== env.hmac) {
      throw new PortalRejection('HMAC', 'The reply from the GST system failed its integrity check.');
    }
    return JSON.parse(isJson ? plain : Buffer.from(plain, 'base64').toString('utf8')) as T;
  }

  /** A public reply: base64 JSON, or JSON as it is. */
  private plain<T>(env: Envelope): T {
    if (typeof env.data === 'string') {
      try {
        return JSON.parse(Buffer.from(env.data, 'base64').toString('utf8')) as T;
      } catch {
        return JSON.parse(env.data) as T;
      }
    }
    return env.data as T;
  }

  private taxpayerHeaders(ctx: ReturnsContext, s: ReturnsSession, period?: string) {
    return {
      ...this.baseHeaders(stateOf(ctx.gstin), ctx.ipUser),
      username: ctx.username,
      'auth-token': s.authToken,
      gstin: ctx.gstin,
      ...(period ? { ret_period: retPeriod(period) } : {}),
    };
  }

  private sealed(action: string, s: ReturnsSession, payload: unknown, extra: Record<string, unknown> = {}) {
    const ek = Buffer.from(s.sessionKey, 'base64');
    const data = b64json(payload);
    return { action, data: aesEncryptBase64(ek, data), hmac: hmac(ek, data), ...extra };
  }

  async requestOtp(ctx: ReturnsContext) {
    this.ready();
    const appKey = randomBytes(32);
    await this.send('POST', this.cfg.paths.auth, this.baseHeaders(stateOf(ctx.gstin), ctx.ipUser), {
      action: 'OTPREQUEST',
      app_key: rsaEncryptBase64(this.cfg.publicKey!, appKey),
      username: ctx.username,
    });
    return { pending: appKey.toString('base64'), message: 'The GST portal has sent an OTP to the mobile number registered for this GSTIN.' };
  }

  async verifyOtp(ctx: ReturnsContext, pending: string, otp: string): Promise<ReturnsSession> {
    const appKey = Buffer.from(pending, 'base64');
    if (appKey.length !== 32) throw new PortalAuthFailed('Ask for a new OTP; the earlier request has expired.');
    const env = await this.send('POST', this.cfg.paths.auth, this.baseHeaders(stateOf(ctx.gstin), ctx.ipUser), {
      action: 'AUTHTOKEN',
      app_key: rsaEncryptBase64(this.cfg.publicKey!, appKey),
      username: ctx.username,
      otp: aesEncryptBase64(appKey, otp.trim()),
    });
    if (!env.auth_token || !env.sek) throw new PortalAuthFailed('The GST system signed in but sent no session token.');
    const ek = decryptSessionKey(appKey, env.sek);
    const minutes = Number(env.expiry) || 360;
    return { authToken: env.auth_token, sessionKey: ek.toString('base64'), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
  }

  async searchTaxpayer(ctx: { ipUser?: string }, gstin: string): Promise<TaxpayerDetails> {
    const env = await this.send('GET', this.cfg.paths.search, this.baseHeaders(stateOf(gstin), ctx.ipUser), undefined, { action: 'TP', gstin });
    const d = this.plain<{
      gstin?: string; lgnm?: string; tradeNam?: string; sts?: string; dty?: string; ctb?: string; rgdt?: string; cxdt?: string;
      pradr?: { addr?: { bno?: string; bnm?: string; flno?: string; st?: string; loc?: string; city?: string; dst?: string; stcd?: string; pncd?: string } };
    }>(env);
    const a = d.pradr?.addr;
    const line = a ? [a.bno, a.flno, a.bnm, a.st, a.loc].filter(Boolean).join(', ') || null : null;
    return {
      gstin: d.gstin ?? gstin,
      legalName: d.lgnm ?? null,
      tradeName: d.tradeNam ?? null,
      status: d.sts ?? null,
      taxpayerType: d.dty ?? null,
      constitution: d.ctb ?? null,
      registeredOn: d.rgdt ?? null,
      cancelledOn: d.cxdt || null,
      address: a ? { line, city: a.city || a.loc || null, district: a.dst ?? null, stateCode: gstin.slice(0, 2), pincode: a.pncd ?? null } : null,
      fromPortal: true,
    };
  }

  private pathFor(type: ReturnType) {
    return type === 'GSTR3B' ? this.cfg.paths.gstr3b : type === 'IFF' ? this.cfg.paths.iff : this.cfg.paths.gstr1;
  }

  async saveReturn(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, period: string, payload: unknown) {
    const env = await this.send('PUT', this.pathFor(type), this.taxpayerHeaders(ctx, s, period), this.sealed('RETSAVE', s, payload));
    const out = this.open<{ reference_id?: string; ref_id?: string }>(env, Buffer.from(s.sessionKey, 'base64'));
    const referenceId = out?.reference_id ?? out?.ref_id;
    if (!referenceId) throw new PortalRejection('NOREF', 'The GST system accepted the return but gave no reference to follow it by.');
    return { referenceId };
  }

  async returnStatus(ctx: ReturnsContext, s: ReturnsSession, period: string, referenceId: string) {
    const env = await this.send('GET', this.cfg.paths.returns, this.taxpayerHeaders(ctx, s, period), undefined, {
      action: 'RETSTATUS', gstin: ctx.gstin, ret_period: retPeriod(period), ref_id: referenceId,
    });
    const out = this.open<{ status_cd?: string; error_report?: unknown; message?: string }>(env, Buffer.from(s.sessionKey, 'base64'));
    // P processed, PE processed with errors, ER error, IP/REC still in progress.
    const map: Record<string, SubmissionStatus> = { P: 'processed', PE: 'processed_with_errors', ER: 'error', IP: 'pending', REC: 'pending' };
    return { status: map[String(out?.status_cd ?? '').toUpperCase()] ?? 'pending', message: out?.message ?? null, errorReport: out?.error_report ?? null };
  }

  async requestEvcOtp(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, pan: string) {
    await this.send('GET', this.cfg.paths.auth, this.taxpayerHeaders(ctx, s), undefined, {
      action: 'EVCOTP', gstin: ctx.gstin, pan, form_type: type === 'GSTR3B' ? 'R3B' : type === 'IFF' ? 'IFF' : 'R1',
    });
    return { message: 'The GST portal has sent the EVC OTP to the authorised signatory’s mobile number.' };
  }

  async fileReturn(ctx: ReturnsContext, s: ReturnsSession, type: ReturnType, period: string, evc: { pan: string; otp: string }) {
    const ek = Buffer.from(s.sessionKey, 'base64');
    // What is filed is the portal's own summary of what was saved.
    const sumEnv = await this.send('GET', this.pathFor(type), this.taxpayerHeaders(ctx, s, period), undefined, {
      action: 'RETSUM', gstin: ctx.gstin, ret_period: retPeriod(period),
    });
    const summary = this.open<unknown>(sumEnv, ek);
    const summary64 = b64json(summary);
    // EVC: the summary signed with the OTP; the signer named by PAN and OTP.
    const sign = createHmac('sha256', Buffer.from(evc.otp.trim(), 'utf8')).update(summary64, 'utf8').digest('base64');
    const env = await this.send('POST', this.pathFor(type), this.taxpayerHeaders(ctx, s, period),
      this.sealed('RETFILE', s, summary, { sign, st: 'EVC', sid: `${evc.pan}|${evc.otp.trim()}` }));
    const out = this.open<{ ack_num?: string; arn?: string }>(env, ek);
    const arn = out?.ack_num ?? out?.arn;
    if (!arn) throw new PortalRejection('NOARN', 'The GST system gave no acknowledgement number for the filing.');
    return { arn, filedAt: new Date().toISOString() };
  }

  async fetchGstr2b(ctx: ReturnsContext, s: ReturnsSession, period: string) {
    const env = await this.send('GET', this.cfg.paths.gstr2b, this.taxpayerHeaders(ctx, s, period), undefined, {
      action: 'GET2B', gstin: ctx.gstin, rtnprd: retPeriod(period),
    });
    return this.open<unknown>(env, Buffer.from(s.sessionKey, 'base64'));
  }

  async trackReturns(ctx: { ipUser?: string }, gstin: string, fy: string): Promise<FilingTrackRow[]> {
    const env = await this.send('GET', this.cfg.paths.track, this.baseHeaders(stateOf(gstin), ctx.ipUser), undefined, { action: 'RETTRACK', gstin, fy });
    const d = this.plain<{ EFiledlist?: { rtntype?: string; ret_prd?: string; status?: string; arn?: string; dof?: string; mof?: string }[] }>(env);
    return (d?.EFiledlist ?? []).map((r) => ({
      returnType: r.rtntype ?? '', period: r.ret_prd ?? '', status: r.status ?? '', arn: r.arn ?? null, filedOn: r.dof ?? null, mode: r.mof ?? null,
    }));
  }
}
