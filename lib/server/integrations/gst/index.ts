import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Choosing a portal, opening its credentials, and writing down what happened.
//
// Three jobs, and the third is the one that is easy to leave out and expensive
// to add later. An assessment years from now asks one question about a
// disputed invoice — what did you send, when, and what did it say — and if
// that was not recorded at the time it cannot be reconstructed, because the
// only other copy of the answer belongs to the portal.
// ─────────────────────────────────────────────────────────────────────────────

import { db, type Executor } from '../../db';
import { ApiError, badRequest, conflict } from '../../http';
import { digest, openJson, sealJson, encryptionAvailable } from '../crypto';
import { fakeProvider } from './fake';
import { NicEinvoiceProvider, nicConfigFromEnv } from './nic-einvoice';
import {
  PortalAuthFailed, PortalDuplicate, PortalRejection, PortalUnavailable,
  type GstProvider, type Portal, type ProviderContext, type ProviderEnvironment, type SessionStore,
} from './provider';

export * from './provider';
export { encryptionAvailable };

// ── Which implementation ─────────────────────────────────────────────────────

/**
 * Every provider the app can talk to, and which portal each one serves.
 *
 * Adding a GSP is one more entry here plus one file implementing the
 * interface — which is the whole reason for the interface. Nothing outside
 * this map knows any provider's name.
 *
 * Built lazily, because the NIC provider reads its keys from the environment
 * and a missing key must not stop the app starting: every other screen, and
 * the demo book, works without one.
 */
interface ProviderEntry {
  label: string;
  portals: Portal[];
  make: () => GstProvider;
}

const PROVIDERS: Record<string, ProviderEntry> = {
  fake: {
    label: 'Built-in stand-in',
    portals: ['einvoice', 'ewaybill'],
    make: () => fakeProvider,
  },
  nic_einvoice: {
    label: 'NIC e-invoice API',
    portals: ['einvoice'],
    make: () => new NicEinvoiceProvider(nicConfigFromEnv()),
  },
};

const built = new Map<string, GstProvider>();

export function resolveProvider(name: string): GstProvider {
  const entry = PROVIDERS[name];
  if (!entry) {
    throw badRequest(
      `No portal provider named "${name}" is built into this app. Available: ` +
        `${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  let provider = built.get(name);
  if (!provider) {
    provider = entry.make();
    built.set(name, provider);
  }
  return provider;
}

/** Whether anything this org submits actually reaches a government system. */
export function isLive(providerName: string): boolean {
  return PROVIDERS[providerName] ? resolveProvider(providerName).live : false;
}

export function environmentOf(providerName: string): ProviderEnvironment {
  return PROVIDERS[providerName] ? resolveProvider(providerName).environment : 'stand-in';
}

export interface ProviderInfo {
  name: string;
  label: string;
  portals: Portal[];
  environment: ProviderEnvironment;
  live: boolean;
  /** Empty when it can be used. Otherwise, what the server still needs. */
  missing: string[];
}

/** For the settings screen: what can be chosen, and what each still lacks. */
export function availableProviders(): ProviderInfo[] {
  return Object.entries(PROVIDERS).map(([name, entry]) => {
    const p = resolveProvider(name);
    return {
      name,
      label: entry.label,
      portals: entry.portals,
      environment: p.environment,
      live: p.live,
      missing: p instanceof NicEinvoiceProvider ? p.missingConfiguration() : [],
    };
  });
}

export function providerServes(name: string, portal: Portal): boolean {
  return PROVIDERS[name]?.portals.includes(portal) ?? false;
}

/** The name a person knows a provider by. */
export function providerLabel(name: string): string {
  return PROVIDERS[name]?.label ?? name;
}

// ── Turning a portal's answer into one a person can act on ───────────────────

/**
 * Portal errors are not the app's own error type, so without this the route
 * wrapper would hide their message behind "Something went wrong" — which is
 * the one answer nobody can do anything with at a filing deadline.
 *
 * None of these is 401: the browser treats a 401 as "your session ended" and
 * sends the user to the sign-in page, and a portal refusing a GST password is
 * not that.
 */
export function toApiError(err: unknown, label: string): unknown {
  if (err instanceof PortalDuplicate) {
    return new ApiError(409, `${label} is already registered at the portal (IRN ${err.irn.slice(0, 16)}…).`, 'portal_duplicate');
  }
  if (err instanceof PortalRejection) {
    return new ApiError(422, `The portal refused ${label}. ${err.message}`, 'portal_rejected', {
      portalCode: err.code,
    });
  }
  if (err instanceof PortalAuthFailed) {
    return new ApiError(409, err.message, 'portal_auth');
  }
  if (err instanceof PortalUnavailable) {
    return new ApiError(
      503,
      `${err.message} Nothing was registered for ${label} — it is safe to try again.`,
      'portal_unavailable',
    );
  }
  return err;
}

// ── Connections ──────────────────────────────────────────────────────────────

export interface PortalConnection {
  id: number | null;
  orgId: number;
  branchId: number;
  portal: Portal;
  providerName: string;
  gstin: string | null;
  status: 'not_configured' | 'configured' | 'verified' | 'failed' | 'disabled';
  baseUrl: string | null;
  /** False when this is the built-in stand-in rather than a stored row. */
  configured: boolean;
}

interface ConnectionConfig {
  baseUrl?: string;
  [k: string]: unknown;
}

/**
 * The connection for a branch and portal, or the stand-in.
 *
 * Deliberately never fails for want of configuration. An org that has set
 * nothing up gets the fake provider and every screen keeps working — which is
 * what the demo book relies on, and what makes a new sign-up usable before
 * anybody has been asked for a GSTIN password.
 *
 * The one thing it does refuse is a stored connection whose GSTIN no longer
 * matches the branch's. Portal credentials are issued against a specific
 * registration; if somebody corrects the branch GSTIN, the stored credentials
 * now belong to a different entity, and authenticating with them would file
 * against the wrong taxpayer. Better to stop.
 */
export async function connectionFor(
  ex: Executor,
  orgId: number,
  branchId: number,
  portal: Portal,
): Promise<PortalConnection> {
  const row = await ex
    .selectFrom('integration_connections as c')
    .innerJoin('branches as b', 'b.id', 'c.branch_id')
    .select([
      'c.id', 'c.provider', 'c.gstin', 'c.status', 'c.config', 'b.gstin as branch_gstin',
    ])
    .where('c.org_id', '=', orgId)
    .where('c.branch_id', '=', branchId)
    .where('c.portal', '=', portal)
    .executeTakeFirst();

  // No row, a disabled one, or one whose credentials were deleted: all three
  // mean there is nothing to authenticate with, so the stand-in answers. The
  // third was missed at first — a forgotten connection kept routing to its
  // provider, which then failed looking for credentials that were gone.
  if (!row || row.status === 'disabled' || row.status === 'not_configured') {
    const branch = await ex
      .selectFrom('branches')
      .select('gstin')
      .where('id', '=', branchId)
      .executeTakeFirst();
    return {
      id: row?.id ?? null,
      orgId,
      branchId,
      portal,
      providerName: 'fake',
      gstin: branch?.gstin ?? null,
      status: row?.status ?? 'not_configured',
      baseUrl: null,
      configured: false,
    };
  }

  if (row.gstin && row.branch_gstin && row.gstin !== row.branch_gstin) {
    throw conflict(
      `The ${portal === 'einvoice' ? 'e-invoice' : 'e-way bill'} credentials stored for this branch were ` +
        `issued for GSTIN ${row.gstin}, but the branch is now ${row.branch_gstin}. Portal credentials ` +
        'belong to one registration — re-enter them for the new GSTIN before submitting anything.',
    );
  }

  const config = (row.config ?? {}) as ConnectionConfig;

  return {
    id: row.id,
    orgId,
    branchId,
    portal,
    providerName: row.provider,
    gstin: row.gstin ?? row.branch_gstin,
    status: row.status,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : null,
    configured: true,
  };
}

// ── Credentials ──────────────────────────────────────────────────────────────

export interface PortalCredentials {
  username: string;
  password: string;
  /** Issued by the GSP or the sandbox, and shared across a PAN's registrations. */
  clientId?: string;
  clientSecret?: string;
}

/** Bind sealed bytes to the row holding them, so a copied blob will not open. */
const credentialAad = (connectionId: number) => `integration_credentials:${connectionId}`;
const sessionAad = (connectionId: number) => `integration_sessions:${connectionId}`;

export async function saveCredentials(
  trx: Executor,
  connectionId: number,
  creds: PortalCredentials,
): Promise<void> {
  const sealed = sealJson(creds, credentialAad(connectionId));
  await trx
    .insertInto('integration_credentials')
    .values({
      connection_id: connectionId,
      key_version: sealed.keyVersion,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      ciphertext: sealed.ciphertext,
      rotated_at: new Date(),
    })
    .onDuplicateKeyUpdate({
      key_version: sealed.keyVersion,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      ciphertext: sealed.ciphertext,
      rotated_at: new Date(),
    })
    .execute();

  // A fresh password invalidates any token minted from the old one.
  await trx.deleteFrom('integration_sessions').where('connection_id', '=', connectionId).execute();
}

/**
 * Open a connection's credentials.
 *
 * Only ever called immediately before a call that needs them, never as part of
 * loading a page. The returned object must not be logged, echoed in an error,
 * or put on a response — it is the customer's government portal password.
 */
export async function readCredentials(
  ex: Executor,
  connectionId: number,
): Promise<PortalCredentials> {
  const row = await ex
    .selectFrom('integration_credentials')
    .select(['key_version', 'iv', 'auth_tag', 'ciphertext'])
    .where('connection_id', '=', connectionId)
    .executeTakeFirst();

  if (!row) {
    throw new PortalAuthFailed(
      'No portal credentials are stored for this registration. Add the API username and password ' +
        'created on the portal before submitting.',
    );
  }

  return openJson<PortalCredentials>(
    {
      keyVersion: row.key_version,
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    },
    credentialAad(connectionId),
  );
}

// ── The six-hour session ─────────────────────────────────────────────────────

export interface PortalSession {
  authToken: string;
  /** The key every payload after authentication is encrypted with. */
  sessionKey: string;
}

/**
 * Treat a token as dead this long before it really expires.
 *
 * Without the margin a call can start on a token with four seconds left and
 * fail mid-flight, which looks like a portal error and is not one.
 */
const SESSION_MARGIN_MS = 5 * 60 * 1000;

export async function readSession(
  ex: Executor,
  connectionId: number,
): Promise<PortalSession | null> {
  const row = await ex
    .selectFrom('integration_sessions')
    .select(['expires_at', 'key_version', 'iv', 'auth_tag', 'ciphertext'])
    .where('connection_id', '=', connectionId)
    .executeTakeFirst();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() - SESSION_MARGIN_MS <= Date.now()) return null;

  try {
    return openJson<PortalSession>(
      {
        keyVersion: row.key_version,
        iv: row.iv,
        authTag: row.auth_tag,
        ciphertext: row.ciphertext,
      },
      sessionAad(connectionId),
    );
  } catch {
    // A token we cannot read is worth nothing, and re-authenticating is cheap
    // compared with the alternative of failing the submission.
    return null;
  }
}

export async function writeSession(
  trx: Executor,
  connectionId: number,
  session: PortalSession,
  expiresAt: Date,
): Promise<void> {
  const sealed = sealJson(session, sessionAad(connectionId));
  await trx
    .insertInto('integration_sessions')
    .values({
      connection_id: connectionId,
      expires_at: expiresAt,
      key_version: sealed.keyVersion,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      ciphertext: sealed.ciphertext,
    })
    .onDuplicateKeyUpdate({
      expires_at: expiresAt,
      key_version: sealed.keyVersion,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      ciphertext: sealed.ciphertext,
    })
    .execute();
}

/**
 * Where providers keep the portal session: sealed rows, written through the
 * module-level connection rather than any caller's transaction.
 *
 * On purpose. A token the portal issued stays valid whether or not the invoice
 * that needed it committed, and writing it inside that transaction would throw
 * the token away on every rollback — costing a fresh login, and on the sandbox
 * an OTP-free but rate-limited one, for no reason.
 */
export const dbSessionStore: SessionStore = {
  async get(connectionId) {
    return readSession(db, connectionId);
  },
  async set(connectionId, session, expiresAt) {
    await writeSession(db, connectionId, session, expiresAt);
  },
  async clear(connectionId) {
    await db.deleteFrom('integration_sessions').where('connection_id', '=', connectionId).execute();
  },
};

// ── The call log ─────────────────────────────────────────────────────────────

export interface CallRecord {
  orgId: number;
  connection: PortalConnection;
  operation: string;
  referenceType?: string;
  referenceId?: number;
}

/**
 * Keys whose values never reach the log, wherever they appear in a payload.
 *
 * Matched case-insensitively on the key name rather than by path, because the
 * portals nest inconsistently and a path-based list silently stops covering a
 * field the day a schema version changes.
 */
const REDACT = /pass|secret|token|otp|sek|appkey|auth/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Run a portal call, and write down what happened either way.
 *
 * The log entry is written outside the caller's transaction on purpose. If a
 * submission's own transaction rolls back — because storing the IRN failed, say
 * — the record that we *made the call* has to survive, otherwise the portal
 * holds a registration the books have no trace of. That is the worst state to
 * be in, so it is the one thing insured against here.
 *
 * Which is why this takes no executor at all and always writes through the
 * module-level connection. It used to accept the caller's transaction and log
 * through it, so every failed call was erased by the rollback that followed —
 * the opposite of what this comment promised. Removing the parameter is what
 * stops that coming back.
 */
export async function runPortalCall<T>(
  record: CallRecord,
  payload: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const serialised = JSON.stringify(payload ?? null);

  const write = async (
    outcome: 'ok' | 'rejected' | 'error' | 'timeout',
    extra: { errorCode?: string | null; errorMessage?: string | null; response?: unknown },
  ) => {
    try {
      await db
        .insertInto('integration_calls')
        .values({
          org_id: record.orgId,
          connection_id: record.connection.id,
          portal: record.connection.portal,
          provider: record.connection.providerName,
          operation: record.operation,
          reference_type: record.referenceType ?? null,
          reference_id: record.referenceId ?? null,
          outcome,
          http_status: null,
          error_code: extra.errorCode ?? null,
          error_message: extra.errorMessage?.slice(0, 1000) ?? null,
          duration_ms: Date.now() - started,
          request_digest: digest(serialised),
          request_json: JSON.stringify(redact(payload)),
          response_json:
            extra.response === undefined ? null : JSON.stringify(redact(extra.response)),
        })
        .execute();
    } catch (err) {
      // Never let logging be the thing that fails a submission. A missing log
      // line is bad; a rejected invoice because the log table was full is worse.
      console.error('[integration] could not record call', record.operation, err);
    }
  };

  try {
    const result = await call();
    await write('ok', { response: result });
    return result;
  } catch (err) {
    if (err instanceof PortalRejection) {
      await write('rejected', { errorCode: err.code, errorMessage: err.message });
    } else if (err instanceof PortalUnavailable) {
      await write('timeout', { errorMessage: err.message });
    } else if (err instanceof PortalAuthFailed) {
      await write('error', { errorCode: 'auth', errorMessage: err.message });
    } else {
      await write('error', { errorMessage: (err as Error).message });
    }
    throw err;
  }
}

/** `runPortalCall`'s shape, so a service can take a stand-in for it in tests. */
export type PortalCaller = typeof runPortalCall;

/** Assemble what a provider needs to act, opening credentials only if configured. */
export async function providerContext(
  ex: Executor,
  connection: PortalConnection,
): Promise<ProviderContext> {
  const ctx: ProviderContext = {
    orgId: connection.orgId,
    connectionId: connection.id,
    gstin: connection.gstin ?? '',
    baseUrl: connection.baseUrl ?? undefined,
    sessions: dbSessionStore,
  };
  if (connection.configured && connection.id !== null) {
    ctx.credentials = await readCredentials(ex, connection.id);
  }
  return ctx;
}
