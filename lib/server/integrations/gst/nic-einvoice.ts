import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// NIC's e-invoice API, spoken directly.
//
// The Invoice Registration Portal run by NIC — IRP-1, the government's own.
// Pointed at einv-apisandbox.nic.in it is the public sandbox: real API, real
// encryption, test data, nothing filed. Pointed at production it files, which
// direct access permits only for taxpayers the portal has enabled for it —
// everyone else reaches the same API through a GSP, most of which pass it
// through unchanged behind their own host. So this is also the adapter a GSP
// connection will reuse, with a different base URL and headers.
//
// Written against NIC's published specification (auth v1.04, IRN v1.03). Where
// the specification is silent — the exact token-expiry error code, whether a
// reply is base64-wrapped inside its ciphertext — the code accepts every
// documented variant rather than guessing one. The first sandbox call settles
// those, and nothing else depends on the guess.
// ─────────────────────────────────────────────────────────────────────────────

import type { KeyObject } from 'node:crypto';
import type { EinvoicePayload } from './einvoice-payload';
import {
  aesEncryptBase64, decryptJson, decryptSessionKey, loadPublicKey, newAppKey, sealLoginPayload,
} from './nic-crypto';
import {
  PortalAuthFailed, PortalDuplicate, PortalRejection, PortalUnavailable,
  formatPortalTimestamp, parsePortalTimestamp,
  type CancelReasonCode, type EwayBillResult, type EwbByIrn, type GstProvider, type IrnResult,
  type ProviderContext, type ProviderEnvironment,
} from './provider';

export const NIC_SANDBOX_URL = 'https://einv-apisandbox.nic.in';

export interface NicConfig {
  baseUrl: string;
  /**
   * The paths are configuration because NIC versions them independently —
   * authentication moved to v1.04 while the invoice calls stayed on v1.03 —
   * and a GSP fronting the same API usually mounts it somewhere else.
   */
  authPath: string;
  invoicePath: string;
  cancelPath: string;
  /** An e-way bill against an IRN already registered. */
  ewbPath: string;
  /** Issued to us at registration; a connection may carry its own instead. */
  clientId: string | null;
  clientSecret: string | null;
  publicKey: KeyObject | null;
  /** What went wrong loading the key, so "not configured" can say why. */
  publicKeyError: string | null;
  /**
   * What NIC_EINV_ENV says this address is. Only NIC's own sandbox host is
   * recognised on sight; any other address — a GSP's test system as much as
   * the live portal — has to be declared, because guessing wrong labels a
   * filing as a test or a test as a filing.
   */
  declaredEnvironment: 'sandbox' | 'production' | null;
  /** NIC_EINV_ENV was set to something other than sandbox or production. */
  environmentError: string | null;
  timeoutMs: number;
}

/** NIC's public sandbox, the one address known without being told. */
const isNicSandbox = (url: string) => /^https:\/\/einv-apisandbox\.nic\.in(\/|$)/i.test(url);
/** The government's own live hosts. Never a test system, whatever is declared. */
const isGovernmentHost = (url: string) => /^https:\/\/([a-z0-9-]+\.)*gst\.gov\.in(\/|$)/i.test(url);

/** From the environment. Read once, when the provider is first used. */
export function nicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NicConfig {
  let publicKey: KeyObject | null = null;
  let publicKeyError: string | null = null;
  const keySource = env.NIC_EINV_PUBLIC_KEY?.trim();
  if (keySource) {
    try {
      publicKey = loadPublicKey(keySource);
    } catch (err) {
      publicKeyError = `NIC_EINV_PUBLIC_KEY could not be read: ${(err as Error).message}`;
    }
  }

  const declared = env.NIC_EINV_ENV?.trim().toLowerCase() || null;
  const declaredEnvironment = declared === 'sandbox' || declared === 'production' ? declared : null;
  const environmentError =
    declared && !declaredEnvironment ? `NIC_EINV_ENV is "${declared}"; it must be sandbox or production.` : null;

  return {
    baseUrl: (env.NIC_EINV_BASE_URL?.trim() || NIC_SANDBOX_URL).replace(/\/+$/, ''),
    authPath: env.NIC_EINV_AUTH_PATH?.trim() || '/eivital/v1.04/auth',
    invoicePath: env.NIC_EINV_INVOICE_PATH?.trim() || '/eicore/v1.03/Invoice',
    cancelPath: env.NIC_EINV_CANCEL_PATH?.trim() || '/eicore/v1.03/Invoice/Cancel',
    ewbPath: env.NIC_EINV_EWB_PATH?.trim() || '/eiewb/v1.03/ewaybill',
    clientId: env.NIC_EINV_CLIENT_ID?.trim() || null,
    clientSecret: env.NIC_EINV_CLIENT_SECRET?.trim() || null,
    publicKey,
    publicKeyError,
    declaredEnvironment,
    environmentError,
    timeoutMs: Number(env.NIC_EINV_TIMEOUT_MS) || 30_000,
  };
}

// ── The portal's reply shapes ────────────────────────────────────────────────

interface NicEnvelope {
  // The portal capitalises this inconsistently between success and failure.
  Status?: number | string;
  status?: number | string;
  Data?: unknown;
  ErrorDetails?: unknown;
  InfoDtls?: unknown;
}

interface NicAuthData {
  ClientId?: string;
  UserName?: string;
  AuthToken: string;
  Sek: string;
  TokenExpiry?: string;
}

interface NicIrnData {
  AckNo: number | string;
  AckDt: string;
  Irn: string;
  SignedInvoice?: string | null;
  SignedQRCode?: string | null;
  Status?: string;
  EwbNo?: number | string | null;
  EwbDt?: string | null;
  EwbValidTill?: string | null;
}

interface NicEwbData {
  EwbNo: number | string | null;
  EwbDt?: string | null;
  EwbValidTill?: string | null;
  Remarks?: string | null;
}

interface NicError {
  ErrorCode: string;
  ErrorMessage: string;
}

interface Session {
  authToken: string;
  sek: Buffer;
  expiresAt: Date | null;
}

const ok = (e: NicEnvelope) => Number(e.Status ?? e.status) === 1;

/**
 * The portal returns ErrorDetails as an array, a JSON string, or base64 of a
 * JSON string depending on which call failed. All three become one list.
 */
export function readErrors(raw: unknown): NicError[] {
  const list = (value: unknown): NicError[] =>
    (Array.isArray(value) ? value : [value])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        ErrorCode: String(e.ErrorCode ?? e.errorCode ?? 'unknown'),
        ErrorMessage: String(e.ErrorMessage ?? e.errorMessage ?? e.message ?? 'The portal gave no reason.'),
      }));

  if (!raw) return [];
  if (typeof raw !== 'string') return list(raw);
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      return list(JSON.parse(text));
    } catch {
      /* try the next reading */
    }
  }
  return [{ ErrorCode: 'unknown', ErrorMessage: raw.slice(0, 500) }];
}

/**
 * The IRN the portal already holds, if this refusal was a duplicate.
 *
 * On error 2150 the portal puts the existing registration in InfoDtls, tagged
 * DUPIRN. That is the whole recovery path for a registration whose reply was
 * lost, so it is read carefully — the shape varies as much as ErrorDetails.
 */
export function readDuplicate(
  raw: unknown,
): { irn: string; ackNo: string | null; ackDate: string | null } | null {
  let items: unknown = raw;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      return null;
    }
  }
  for (const item of Array.isArray(items) ? items : [items]) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (String(rec.InfCd ?? '').toUpperCase() !== 'DUPIRN') continue;
    let desc = rec.Desc;
    if (typeof desc === 'string') {
      try {
        desc = JSON.parse(desc);
      } catch {
        continue;
      }
    }
    const d = (desc ?? {}) as Record<string, unknown>;
    if (typeof d.Irn === 'string' && d.Irn.length === 64) {
      return {
        irn: d.Irn,
        ackNo: d.AckNo != null ? String(d.AckNo) : null,
        ackDate: typeof d.AckDt === 'string' ? d.AckDt : null,
      };
    }
  }
  return null;
}

/**
 * Whether a refusal means the session is stale rather than the document bad.
 *
 * NIC's public pages do not list the code for an expired or invalid token, so
 * this recognises both the commonly reported code and the wording. A false
 * positive costs one extra login; a false negative costs the submission, so
 * it leans towards retrying.
 */
function isTokenProblem(err: unknown): boolean {
  return (
    err instanceof PortalRejection &&
    (err.code === '1005' || /token|session|sek/i.test(err.message))
  );
}

/** The refusal for anything only NIC's e-way bill system can do. */
function ewbSystemOnly(): PortalRejection {
  return new PortalRejection(
    'not_supported',
    "Changing an e-way bill goes through NIC's e-way bill system, which is a separate connection from the " +
      'e-invoice one. Add it in Settings → Integrations.',
  );
}

/** The portal's transport mode codes. */
const TRANS_MODE = { road: '1', rail: '2', air: '3', ship: '4' } as const;

export class NicEinvoiceProvider implements GstProvider {
  readonly name = 'nic_einvoice';

  constructor(
    private readonly config: NicConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /**
   * Production only when it is certain. NIC's sandbox host is a sandbox; any
   * other address is whatever NIC_EINV_ENV declares, and until it declares
   * something the connection reports itself as not filing — and refuses to
   * make a call at all (see `missingConfiguration`), so that report is true.
   */
  get environment(): ProviderEnvironment {
    const { baseUrl, declaredEnvironment } = this.config;
    if (isNicSandbox(baseUrl)) return 'sandbox';
    if (isGovernmentHost(baseUrl)) return declaredEnvironment === 'production' ? 'production' : 'sandbox';
    return declaredEnvironment ?? 'sandbox';
  }

  get live(): boolean {
    return this.environment === 'production';
  }

  /** What is missing before this can make a call. Empty means ready. */
  missingConfiguration(): string[] {
    const missing: string[] = [];
    const { baseUrl, declaredEnvironment, environmentError } = this.config;
    if (environmentError) missing.push(environmentError);
    else if (!isNicSandbox(baseUrl) && !declaredEnvironment) {
      missing.push(
        `NIC_EINV_BASE_URL points at ${baseUrl}, which is not NIC's sandbox. Set NIC_EINV_ENV=production ` +
          'if invoices sent there are filed, or NIC_EINV_ENV=sandbox for a test system.',
      );
    } else if (isGovernmentHost(baseUrl) && declaredEnvironment !== 'production') {
      missing.push(
        `NIC_EINV_BASE_URL points at the live government portal (${baseUrl}), but NIC_EINV_ENV says sandbox. ` +
          'Invoices sent there are filed — set NIC_EINV_ENV=production, or point it at a test system.',
      );
    }
    if (this.config.publicKeyError) missing.push(this.config.publicKeyError);
    else if (!this.config.publicKey) {
      missing.push(
        "NIC_EINV_PUBLIC_KEY is not set — the public key downloaded from NIC's portal, as PEM, " +
          'base64, or a path to the file.',
      );
    }
    return missing;
  }

  // ── Public calls ──────────────────────────────────────────────────────────

  async verify(ctx: ProviderContext): Promise<{ expiresAt: string | null }> {
    // Deliberately bypasses the cache: the point is to prove the stored
    // credentials work *now*, not that they worked an hour ago.
    const s = await this.login(ctx);
    await this.remember(ctx, s);
    return { expiresAt: s.expiresAt?.toISOString() ?? null };
  }

  async generateIrn(payload: EinvoicePayload, ctx: ProviderContext): Promise<IrnResult> {
    const d = await this.withSession(ctx, (s) =>
      this.call<NicIrnData>(this.config.invoicePath, s, ctx, payload),
    );
    return {
      irn: d.Irn,
      ackNo: String(d.AckNo),
      ackDate: d.AckDt,
      signedInvoice: d.SignedInvoice ?? null,
      signedQr: d.SignedQRCode ?? null,
      ewbNo: d.EwbNo != null && d.EwbNo !== '' ? String(d.EwbNo) : null,
      ewbValidUntil: d.EwbValidTill ?? null,
    };
  }

  async cancelIrn(
    irn: string,
    reason: CancelReasonCode,
    remark: string,
    ctx: ProviderContext,
  ): Promise<{ cancelledAt: string }> {
    const d = await this.withSession(ctx, (s) =>
      this.call<{ Irn: string; CancelDate: string }>(this.config.cancelPath, s, ctx, {
        Irn: irn,
        CnlRsn: reason,
        // The portal caps the remark at 100 characters and rejects longer.
        CnlRem: remark.slice(0, 100),
      }),
    );
    return { cancelledAt: d.CancelDate };
  }

  async generateEwbByIrn(req: EwbByIrn, ctx: ProviderContext): Promise<EwayBillResult> {
    // The same field names the invoice schema uses for transport sent with an IRN.
    const body: Record<string, unknown> = {
      Irn: req.irn,
      Distance: req.distanceKm,
      TransMode: TRANS_MODE[req.mode],
    };
    if (req.transporterId) body.TransId = req.transporterId;
    if (req.transporterName) body.TransName = req.transporterName;
    if (req.transportDocNo) body.TransDocNo = req.transportDocNo;
    if (req.transportDocDate) body.TransDocDt = req.transportDocDate;
    if (req.vehicleNo) {
      body.VehNo = req.vehicleNo;
      body.VehType = req.isOverDimensional ? 'O' : 'R';
    }

    const d = await this.withSession(ctx, (s) => this.call<NicEwbData>(this.config.ewbPath, s, ctx, body));
    if (d.EwbNo == null || d.EwbNo === '' || !d.EwbValidTill) {
      throw new PortalRejection(
        'no_ewb',
        'The portal answered without an e-way bill number or validity, so nothing was issued that could ' +
          'cover the goods.',
      );
    }
    return {
      ewbNo: String(d.EwbNo),
      validUntil: d.EwbValidTill,
      generatedAt: d.EwbDt ?? formatPortalTimestamp(new Date()),
    };
  }

  async generateEwayBill(): Promise<EwayBillResult> {
    // Not a gap in this adapter so much as a different system. The invoice
    // portal issues an e-way bill *with* an IRN when transport details ride
    // along — which is how invoices get theirs — but a bill on its own, for a
    // delivery challan, goes through NIC's e-way bill system, with its own
    // credentials and its own connection in Settings.
    throw new PortalRejection(
      'not_supported',
      'This connection registers invoices. A stand-alone e-way bill goes through the NIC e-way bill ' +
        'system, which is a separate connection. For an invoice, add the vehicle before registering it ' +
        'and the e-way bill is issued with the IRN.',
    );
  }

  // Changing a bill is the e-way bill system's job too, however the bill was
  // issued: the invoice portal can issue one alongside an IRN, but not change
  // or cancel it afterwards.
  async updateEwayVehicle(): Promise<{ updatedAt: string; validUntil: string | null }> {
    throw ewbSystemOnly();
  }

  async extendEwayBill(): Promise<{ extendedAt: string; validUntil: string }> {
    throw ewbSystemOnly();
  }

  async cancelEwayBill(): Promise<{ cancelledAt: string }> {
    throw ewbSystemOnly();
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  private async withSession<T>(ctx: ProviderContext, fn: (s: Session) => Promise<T>): Promise<T> {
    const cached = await this.cached(ctx);
    const session = cached ?? (await this.remember(ctx, await this.login(ctx)));
    try {
      return await fn(session);
    } catch (err) {
      // A cached token the portal no longer honours. Log in once more and try
      // once more — never in a loop, because a portal that keeps refusing a
      // fresh token has a real problem that retrying will not fix.
      if (!cached || !isTokenProblem(err)) throw err;
      if (ctx.sessions && ctx.connectionId !== null) await ctx.sessions.clear(ctx.connectionId);
      const fresh = await this.remember(ctx, await this.login(ctx));
      return fn(fresh);
    }
  }

  private async cached(ctx: ProviderContext): Promise<Session | null> {
    if (!ctx.sessions || ctx.connectionId === null) return null;
    const s = await ctx.sessions.get(ctx.connectionId);
    return s ? { authToken: s.authToken, sek: Buffer.from(s.sessionKey, 'base64'), expiresAt: null } : null;
  }

  private async remember(ctx: ProviderContext, s: Session): Promise<Session> {
    if (ctx.sessions && ctx.connectionId !== null) {
      // Sandbox tokens last an hour and production ones six; the portal says
      // which in TokenExpiry. Without it, assume the shorter.
      const expiresAt = s.expiresAt ?? new Date(Date.now() + 55 * 60_000);
      await ctx.sessions.set(
        ctx.connectionId,
        { authToken: s.authToken, sessionKey: s.sek.toString('base64') },
        expiresAt,
      );
    }
    return s;
  }

  private clientCredentials(ctx: ProviderContext): { clientId: string; clientSecret: string } {
    const clientId = ctx.credentials?.clientId || this.config.clientId;
    const clientSecret = ctx.credentials?.clientSecret || this.config.clientSecret;
    if (!clientId || !clientSecret) {
      throw new PortalAuthFailed(
        'No client ID and secret for the e-invoice portal. They are issued when registering on NIC — ' +
          'set NIC_EINV_CLIENT_ID and NIC_EINV_CLIENT_SECRET, or enter them with the credentials.',
      );
    }
    return { clientId, clientSecret };
  }

  private async login(ctx: ProviderContext): Promise<Session> {
    const problems = this.missingConfiguration();
    if (problems.length) throw new PortalAuthFailed(problems.join(' '));
    if (!ctx.credentials) {
      throw new PortalAuthFailed(
        'No portal username and password are stored for this registration. Add them in Settings → ' +
          'Integrations.',
      );
    }
    const { clientId, clientSecret } = this.clientCredentials(ctx);
    const appKey = newAppKey();

    const envelope = await this.send(this.config.authPath, {
      client_id: clientId,
      client_secret: clientSecret,
      Gstin: ctx.gstin,
    }, {
      Data: sealLoginPayload(this.config.publicKey!, {
        username: ctx.credentials.username,
        password: ctx.credentials.password,
        appKey,
      }),
    });

    if (!ok(envelope)) {
      const errors = readErrors(envelope.ErrorDetails);
      throw new PortalAuthFailed(
        `The e-invoice portal refused the login for GSTIN ${ctx.gstin}: ` +
          (errors.map((e) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join(' ') || 'no reason given') +
          '. Check the API username and password created on the portal for this GSTIN.',
      );
    }

    const data = (typeof envelope.Data === 'string'
      ? JSON.parse(envelope.Data)
      : envelope.Data) as NicAuthData | null;
    if (!data?.AuthToken || !data.Sek) {
      throw new PortalUnavailable('The portal accepted the login but sent back no session token.');
    }

    return {
      authToken: data.AuthToken,
      sek: decryptSessionKey(appKey, data.Sek),
      expiresAt: data.TokenExpiry ? parsePortalTimestamp(data.TokenExpiry) : null,
    };
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /** A document call: encrypt under the session key, send, decrypt the reply. */
  private async call<T>(path: string, s: Session, ctx: ProviderContext, body: unknown): Promise<T> {
    const { clientId, clientSecret } = this.clientCredentials(ctx);
    const envelope = await this.send(path, {
      client_id: clientId,
      client_secret: clientSecret,
      Gstin: ctx.gstin,
      user_name: ctx.credentials?.username ?? '',
      AuthToken: s.authToken,
    }, {
      Data: aesEncryptBase64(s.sek, JSON.stringify(body)),
    });

    if (ok(envelope)) {
      if (typeof envelope.Data !== 'string') {
        throw new PortalUnavailable('The portal reported success but sent no document back.');
      }
      return decryptJson<T>(s.sek, envelope.Data);
    }

    const errors = readErrors(envelope.ErrorDetails);
    const first = errors[0] ?? { ErrorCode: 'unknown', ErrorMessage: 'The portal gave no reason.' };
    const message = errors.map((e) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join(' ');

    if (errors.some((e) => e.ErrorCode === '2150')) {
      const dup = readDuplicate(envelope.InfoDtls);
      if (dup) {
        throw new PortalDuplicate(dup.irn, dup.ackNo, dup.ackDate, message);
      }
    }
    throw new PortalRejection(first.ErrorCode, message, errors);
  }

  /**
   * One HTTP round trip. Network failures, timeouts and server errors become
   * PortalUnavailable — worth retrying — and are kept apart from refusals,
   * which are not.
   */
  private async send(
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<NicEnvelope> {
    const url = `${this.config.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'TimeoutError';
      throw new PortalUnavailable(
        timedOut
          ? `The e-invoice portal did not answer within ${Math.round(this.config.timeoutMs / 1000)} seconds.`
          : `Could not reach the e-invoice portal at ${this.config.baseUrl}.`,
        err,
      );
    }

    const text = await res.text();
    if (res.status >= 500) {
      throw new PortalUnavailable(`The e-invoice portal failed with HTTP ${res.status}.`);
    }
    if (!res.ok) {
      // A 404 here is nearly always a wrong path, not a missing document.
      throw new PortalRejection(
        `http_${res.status}`,
        res.status === 404
          ? `The portal has no endpoint at ${path}. Check the NIC_EINV_* path settings.`
          : `The e-invoice portal refused the request with HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text) as NicEnvelope;
    } catch {
      throw new PortalUnavailable(
        `The e-invoice portal replied with something that is not JSON: ${text.slice(0, 200)}`,
      );
    }
  }
}
