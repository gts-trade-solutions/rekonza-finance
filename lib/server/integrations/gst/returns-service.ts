import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GST returns through the GST system, for the app: connecting a GSTIN with
// its portal username and an OTP, pushing GSTR-1 / IFF / GSTR-3B, following
// what the portal made of them, filing with EVC, fetching GSTR-2B, and
// looking up any GSTIN's registered details.
//
// The connection is the integration row for portal 'returns' (016): its
// provider, the GSTIN it was made for, and the portal username in its config
// (the taxpayer API signs in with the username and an OTP, never a password).
// The session the OTP opens is sealed in integration_sessions, as the
// e-invoice token is. Every call is written to integration_calls; every
// return sent is kept in gst_return_submissions with what came back, and a
// filing marks the period done on the compliance calendar with its ARN.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { db, transaction, type Executor } from '../../db';
import { ApiError, badRequest, notFound } from '../../http';
import { encryptionAvailable } from '../crypto';
import { connectionFor, readSession, runPortalCall, toApiError, writeSession, type PortalConnection, type PortalSession } from './index';
import { PortalAuthFailed } from './provider';
import { GstnReturnsProvider, gstnConfigFromEnv, retPeriod } from './gstn-returns';
import { standinReturns, type ReturnsContext, type ReturnsProvider, type ReturnsSession, type ReturnType, type TaxpayerDetails } from './returns-provider';
import { gstr1PortalFile } from '../../gst/gstr1-json';
import { gstr3bForm, gstr3bPortalJson } from '../../gst/gstr3b-form';
import { importGstr2b, parseGstr2b } from '../../gst/gstr2b-import';

// ── Which provider ───────────────────────────────────────────────────────────

let gstn: GstnReturnsProvider | null = null;
function gstnProvider(): GstnReturnsProvider {
  return (gstn ??= new GstnReturnsProvider(gstnConfigFromEnv()));
}

export const RETURNS_PROVIDERS: Record<string, { label: string; make: () => ReturnsProvider }> = {
  fake: { label: 'Built-in stand-in (files nothing)', make: () => standinReturns },
  gstn: { label: 'GST system through your GSP', make: () => gstnProvider() },
};

export function returnsProvider(name: string): ReturnsProvider {
  const entry = RETURNS_PROVIDERS[name];
  if (!entry) throw badRequest(`No GST returns provider named "${name}". Available: ${Object.keys(RETURNS_PROVIDERS).join(', ')}.`);
  return entry.make();
}

export function returnsProviderOptions() {
  return Object.entries(RETURNS_PROVIDERS).map(([name, e]) => {
    const p = e.make();
    return {
      name, label: e.label, environment: p.environment, live: p.live,
      missing: p instanceof GstnReturnsProvider ? p.missingConfiguration() : [],
    };
  });
}

/** Whether a GSP is configured on this server, for GSTIN lookups that need no taxpayer session. */
const gspReady = () => gstnProvider().missingConfiguration().length === 0;

// ── Connections ──────────────────────────────────────────────────────────────

interface StoredSession extends PortalSession {
  /** Between asking for the OTP and entering it: what the OTP must be sent back with. */
  pending?: string;
  expiresAtIso?: string;
}

export interface ReturnsConnectionView {
  branchId: string;
  branchName: string;
  gstin: string | null;
  username: string | null;
  provider: string;
  providerLabel: string;
  environment: string;
  live: boolean;
  /** Signed in, with a session still good. */
  connected: boolean;
  sessionExpiresAt: string | null;
  /** An OTP has been asked for and not yet entered. */
  awaitingOtp: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

async function usernameOf(ex: Executor, connectionId: number | null): Promise<string | null> {
  if (!connectionId) return null;
  const row = await ex.selectFrom('integration_connections').select('config').where('id', '=', connectionId).executeTakeFirst();
  const cfg = (row?.config ?? {}) as { username?: unknown };
  return typeof cfg.username === 'string' ? cfg.username : null;
}

export async function returnsConnections(ex: Executor, orgId: number): Promise<ReturnsConnectionView[]> {
  const branches = await ex.selectFrom('branches').select(['id', 'name', 'gstin']).where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('name').execute();
  const out: ReturnsConnectionView[] = [];
  for (const b of branches) {
    const row = await ex.selectFrom('integration_connections')
      .select(['id', 'provider', 'status', 'config', 'last_verified_at', 'last_error'])
      .where('org_id', '=', orgId).where('branch_id', '=', b.id).where('portal', '=', 'returns').executeTakeFirst();
    const provider = row?.provider ?? 'fake';
    const p = RETURNS_PROVIDERS[provider] ? returnsProvider(provider) : standinReturns;
    let session: StoredSession | null = null;
    if (row && encryptionAvailable()) session = (await readSession(ex, row.id)) as StoredSession | null;
    const cfg = (row?.config ?? {}) as { username?: string };
    out.push({
      branchId: String(b.id),
      branchName: b.name,
      gstin: b.gstin,
      username: cfg.username ?? null,
      provider,
      providerLabel: RETURNS_PROVIDERS[provider]?.label ?? provider,
      environment: p.environment,
      live: p.live,
      connected: !!session?.authToken,
      sessionExpiresAt: session?.authToken ? session.expiresAtIso ?? null : null,
      awaitingOtp: !!session && !session.authToken && !!session.pending,
      lastVerifiedAt: row?.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
      lastError: row?.last_error ?? null,
    });
  }
  return out;
}

/** Store the portal username for a registration, and the provider it goes through. */
export async function setReturnsUser(
  trx: Executor, orgId: number, userId: number, branchId: number, input: { username: string; provider: string },
): Promise<number> {
  if (!RETURNS_PROVIDERS[input.provider]) throw badRequest('Choose how the returns are filed.');
  const branch = await trx.selectFrom('branches').select(['gstin']).where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That registration was not found.');
  if (!branch.gstin) throw badRequest('This branch has no GSTIN yet. Add it under Settings → Branches first.');
  const username = input.username.trim();
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) throw badRequest('That does not look like a GST portal username.');
  const existing = await trx.selectFrom('integration_connections').select('id')
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('portal', '=', 'returns').executeTakeFirst();
  const values = {
    provider: input.provider, gstin: branch.gstin, status: 'configured' as const,
    config: JSON.stringify({ username }), last_error: null,
  };
  let id: number;
  if (existing) {
    await trx.updateTable('integration_connections').set(values).where('id', '=', existing.id).execute();
    id = existing.id;
  } else {
    id = Number((await trx.insertInto('integration_connections').values({
      org_id: orgId, branch_id: branchId, portal: 'returns', created_by_user_id: userId, ...values,
    }).executeTakeFirstOrThrow()).insertId);
  }
  // A new username or provider ends any session opened under the old one.
  await trx.deleteFrom('integration_sessions').where('connection_id', '=', id).execute();
  return id;
}

export async function disconnectReturns(trx: Executor, orgId: number, branchId: number) {
  const row = await trx.selectFrom('integration_connections').select('id')
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('portal', '=', 'returns').executeTakeFirst();
  if (!row) return;
  await trx.deleteFrom('integration_sessions').where('connection_id', '=', row.id).execute();
  await trx.updateTable('integration_connections').set({ status: 'not_configured' }).where('id', '=', row.id).execute();
}

interface Live {
  connection: PortalConnection & { id: number };
  provider: ReturnsProvider;
  ctx: ReturnsContext;
}

async function live(ex: Executor, orgId: number, branchId: number, ipUser?: string): Promise<Live> {
  const row = await ex.selectFrom('integration_connections').select(['id', 'status'])
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('portal', '=', 'returns').executeTakeFirst();
  if (!row || row.status === 'not_configured' || row.status === 'disabled') {
    throw new ApiError(409, 'This GSTIN is not connected to the GST portal yet. Connect it with the portal username and an OTP first.', 'gstn_not_connected');
  }
  const connection = await connectionFor(ex, orgId, branchId, 'returns');
  const username = await usernameOf(ex, row.id);
  if (!username || !connection.gstin) throw new ApiError(409, 'The GST portal username is missing for this GSTIN.', 'gstn_not_connected');
  if (!encryptionAvailable()) {
    throw new ApiError(503, 'INTEGRATION_KEY is not set on the server, so the GST portal session cannot be kept safely. Set it, then connect again.', 'no_integration_key');
  }
  return {
    connection: { ...connection, id: row.id },
    provider: returnsProvider(connection.providerName),
    ctx: { gstin: connection.gstin, username, ipUser },
  };
}

async function sessionOf(ex: Executor, l: Live): Promise<ReturnsSession> {
  const s = (await readSession(ex, l.connection.id)) as StoredSession | null;
  if (!s?.authToken) {
    throw new ApiError(409, 'The GST portal session has ended. Sign in again with a fresh OTP.', 'gstn_session_expired');
  }
  return { authToken: s.authToken, sessionKey: s.sessionKey, expiresAt: s.expiresAtIso ?? '' };
}

const wrap = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err, label);
  }
};

/** Ask the GST system to send the OTP to the registered mobile. */
export async function requestOtp(orgId: number, branchId: number, ipUser?: string) {
  const l = await live(db, orgId, branchId, ipUser);
  const r = await wrap('the OTP request', () => runPortalCall(
    { orgId, connection: l.connection, operation: 'otp_request' }, { username: l.ctx.username },
    () => l.provider.requestOtp(l.ctx),
  ));
  const pending: StoredSession = { authToken: '', sessionKey: '', pending: r.pending };
  await writeSession(db, l.connection.id, pending, new Date(Date.now() + 15 * 60_000));
  return { message: r.message, environment: l.provider.environment };
}

/** Enter the OTP: the session it opens is kept, sealed, until the portal's access runs out. */
export async function verifyOtp(orgId: number, branchId: number, otp: string, ipUser?: string) {
  if (!/^\d{6}$/.test(otp.trim())) throw badRequest('The OTP is six digits.');
  const l = await live(db, orgId, branchId, ipUser);
  const pending = (await readSession(db, l.connection.id)) as StoredSession | null;
  if (!pending?.pending) throw new ApiError(409, 'Ask for an OTP first, or ask again: the last one has expired.', 'gstn_no_otp');
  try {
    const s = await runPortalCall({ orgId, connection: l.connection, operation: 'otp_verify' }, { username: l.ctx.username },
      () => l.provider.verifyOtp(l.ctx, pending.pending!, otp));
    const stored: StoredSession = { authToken: s.authToken, sessionKey: s.sessionKey, expiresAtIso: s.expiresAt };
    await writeSession(db, l.connection.id, stored, new Date(s.expiresAt));
    await db.updateTable('integration_connections').set({ status: 'verified', last_verified_at: new Date(), last_error: null })
      .where('id', '=', l.connection.id).execute();
    return { connected: true, expiresAt: s.expiresAt, environment: l.provider.environment };
  } catch (err) {
    if (err instanceof PortalAuthFailed) {
      await db.updateTable('integration_connections').set({ last_error: err.message.slice(0, 1000) }).where('id', '=', l.connection.id).execute();
    }
    throw toApiError(err, 'the OTP');
  }
}

// ── Returns ──────────────────────────────────────────────────────────────────

export interface SubmissionView {
  id: string;
  returnType: ReturnType;
  period: string;
  action: 'save' | 'file';
  provider: string;
  referenceId: string | null;
  status: 'pending' | 'processed' | 'processed_with_errors' | 'error' | 'filed';
  message: string | null;
  errorReport: unknown;
  arn: string | null;
  filedAt: string | null;
  totals: { taxable: number; tax: number } | null;
  by: string | null;
  at: string;
}

async function submissionView(ex: Executor, orgId: number, id: number): Promise<SubmissionView> {
  const [v] = await listSubmissions(ex, orgId, { id });
  return v;
}

export async function listSubmissions(
  ex: Executor, orgId: number, f: { id?: number; branchId?: number; returnType?: ReturnType; period?: string },
): Promise<SubmissionView[]> {
  const rows = await ex.selectFrom('gst_return_submissions as s').leftJoin('users as u', 'u.id', 's.created_by_user_id')
    .selectAll('s').select('u.name as by')
    .where('s.org_id', '=', orgId)
    .$if(!!f.id, (q) => q.where('s.id', '=', f.id!))
    .$if(!!f.branchId, (q) => q.where('s.branch_id', '=', f.branchId!))
    .$if(!!f.returnType, (q) => q.where('s.return_type', '=', f.returnType!))
    .$if(!!f.period, (q) => q.where('s.ret_period', '=', f.period!))
    .orderBy('s.created_at', 'desc').orderBy('s.id', 'desc').limit(50).execute();
  return rows.map((r) => ({
    id: String(r.id), returnType: r.return_type, period: r.ret_period, action: r.action, provider: r.provider,
    referenceId: r.reference_id, status: r.status, message: r.portal_message,
    errorReport: typeof r.error_report === 'string' ? JSON.parse(r.error_report) : r.error_report,
    arn: r.arn, filedAt: r.filed_at ? new Date(r.filed_at).toISOString() : null,
    totals: (typeof r.totals === 'string' ? JSON.parse(r.totals) : r.totals) as SubmissionView['totals'],
    by: r.by, at: new Date(r.created_at).toISOString(),
  }));
}

/** The return as the portal takes it, and the period it is for (MMYYYY). */
async function buildReturn(ex: Executor, orgId: number, branchId: number, type: ReturnType, periodKey: string, today: string) {
  if (type === 'GSTR3B') {
    const { documents, ...form } = await gstr3bForm(ex, orgId, periodKey, { branchId, today });
    void documents;
    const payload = gstr3bPortalJson(form);
    const tax = form.totals.liabilityPaise / 100;
    return { payload, period: payload.ret_period, totals: { taxable: (form.rows['3.1a'].taxablePaise + form.rows['3.1b'].taxablePaise) / 100, tax } };
  }
  if (!/^\d{4}-\d{2}$/.test(periodKey)) throw badRequest('Give the month as yyyy-mm.');
  const file = await gstr1PortalFile(ex, orgId, periodKey, { branchId, scope: type === 'IFF' ? 'iff' : 'gstr1' }) as unknown as Record<string, unknown>;
  const sum = (rows: unknown): { taxable: number; tax: number } => {
    let taxable = 0;
    let tax = 0;
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.txval === 'number') {
          taxable += o.txval;
          tax += ['iamt', 'camt', 'samt', 'csamt'].reduce((t, k) => t + (typeof o[k] === 'number' ? (o[k] as number) : 0), 0);
          return;
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(rows);
    return { taxable: Math.round(taxable * 100) / 100, tax: Math.round(tax * 100) / 100 };
  };
  return { payload: file, period: retPeriod(periodKey), totals: sum(file) };
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Push a return to the portal (Zoho's "Push to GSTN"), then ask straight away how it went. */
export async function pushReturn(orgId: number, branchId: number, userId: number, type: ReturnType, periodKey: string, ipUser?: string): Promise<SubmissionView> {
  const l = await live(db, orgId, branchId, ipUser);
  const session = await sessionOf(db, l);
  const built = await buildReturn(db, orgId, branchId, type, periodKey, localToday());
  const serialised = JSON.stringify(built.payload);
  const digest = createHash('sha256').update(serialised).digest('hex');
  const label = `${type} for ${built.period}`;
  const { referenceId } = await wrap(label, () => runPortalCall(
    { orgId, connection: l.connection, operation: `save_${type.toLowerCase()}` },
    { returnType: type, period: built.period, digest, totals: built.totals },
    () => l.provider.saveReturn(l.ctx, session, type, built.period, built.payload),
  ));
  const id = Number((await db.insertInto('gst_return_submissions').values({
    org_id: orgId, branch_id: branchId, gstin: l.ctx.gstin, return_type: type, ret_period: built.period, action: 'save',
    provider: l.provider.name, reference_id: referenceId, status: 'pending', payload_digest: digest,
    totals: JSON.stringify(built.totals), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  // The portal processes a save in the background; usually it is done at once.
  await refreshSubmission(orgId, id, ipUser).catch(() => undefined);
  return submissionView(db, orgId, id);
}

/** Ask the portal what it made of a pushed return. */
export async function refreshSubmission(orgId: number, submissionId: number, ipUser?: string): Promise<SubmissionView> {
  const s = await db.selectFrom('gst_return_submissions').selectAll().where('id', '=', submissionId).where('org_id', '=', orgId).executeTakeFirst();
  if (!s) throw notFound('That submission was not found.');
  if (s.action !== 'save' || !s.reference_id || s.status === 'processed' || s.status === 'error') return submissionView(db, orgId, submissionId);
  const l = await live(db, orgId, s.branch_id, ipUser);
  const session = await sessionOf(db, l);
  const r = await wrap(`the status of ${s.return_type} for ${s.ret_period}`, () => runPortalCall(
    { orgId, connection: l.connection, operation: 'return_status' }, { referenceId: s.reference_id },
    () => l.provider.returnStatus(l.ctx, session, s.ret_period, s.reference_id!),
  ));
  await db.updateTable('gst_return_submissions').set({
    status: r.status, portal_message: r.message?.slice(0, 1000) ?? null,
    error_report: r.errorReport ? JSON.stringify(r.errorReport) : null,
  }).where('id', '=', submissionId).execute();
  return submissionView(db, orgId, submissionId);
}

/** The PAN an EVC is signed with: the registration's own, as the GSTIN carries it. */
const panOf = (gstin: string) => gstin.slice(2, 12);

export async function requestEvcOtp(orgId: number, branchId: number, type: ReturnType, ipUser?: string) {
  const l = await live(db, orgId, branchId, ipUser);
  const session = await sessionOf(db, l);
  return wrap('the EVC OTP request', () => runPortalCall(
    { orgId, connection: l.connection, operation: 'evc_otp' }, { returnType: type },
    () => l.provider.requestEvcOtp(l.ctx, session, type, panOf(l.ctx.gstin)),
  ));
}

/** File with EVC (Zoho's "File return"): the ARN comes back and the period is marked done. */
export async function fileReturn(
  orgId: number, branchId: number, userId: number, type: ReturnType, periodKey: string, otp: string, ipUser?: string,
): Promise<SubmissionView> {
  if (!/^\d{6}$/.test(otp.trim())) throw badRequest('The EVC OTP is six digits.');
  const l = await live(db, orgId, branchId, ipUser);
  const session = await sessionOf(db, l);
  const period = type === 'GSTR3B' && /^\d{4}-Q[1-4]$/.test(periodKey)
    ? (await gstr3bForm(db, orgId, periodKey, { branchId, today: localToday() })).period.months.slice(-1).map(retPeriod)[0]
    : retPeriod(periodKey);
  const r = await wrap(`${type} for ${period}`, () => runPortalCall(
    { orgId, connection: l.connection, operation: `file_${type.toLowerCase()}` }, { returnType: type, period },
    () => l.provider.fileReturn(l.ctx, session, type, period, { pan: panOf(l.ctx.gstin), otp }),
  ));
  const filedAt = new Date(r.filedAt);
  const doneOn = `${filedAt.getFullYear()}-${String(filedAt.getMonth() + 1).padStart(2, '0')}-${String(filedAt.getDate()).padStart(2, '0')}`;
  const id = await transaction(async (trx) => {
    const sid = Number((await trx.insertInto('gst_return_submissions').values({
      org_id: orgId, branch_id: branchId, gstin: l.ctx.gstin, return_type: type, ret_period: period, action: 'file',
      provider: l.provider.name, status: 'filed', arn: r.arn, filed_at: filedAt, created_by_user_id: userId,
      portal_message: l.provider.live ? 'Filed with EVC.' : 'Filed with the stand-in only: nothing reached the GST system.',
    }).executeTakeFirstOrThrow()).insertId);
    // The compliance calendar shows it done, with the ARN — only a real filing.
    if (l.provider.live) {
      const values = { done_on: doneOn, reference: r.arn, note: 'Filed with EVC through the GST system', created_by_user_id: userId };
      await trx.insertInto('compliance_filings').values({ org_id: orgId, item_key: type === 'GSTR3B' ? 'gstr3b' : type === 'IFF' ? 'iff' : 'gstr1', period: periodKey, ...values })
        .onDuplicateKeyUpdate(values).execute();
    }
    return sid;
  });
  return submissionView(db, orgId, id);
}

/** GSTR-2B straight from the portal, into the reconciliation (the same importer as the JSON file). */
export async function fetchGstr2bFromPortal(orgId: number, branchId: number, month: string, ipUser?: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Give the month as yyyy-mm.');
  const l = await live(db, orgId, branchId, ipUser);
  const session = await sessionOf(db, l);
  const raw = await wrap(`GSTR-2B for ${month}`, () => runPortalCall(
    { orgId, connection: l.connection, operation: 'fetch_gstr2b' }, { period: retPeriod(month) },
    () => l.provider.fetchGstr2b(l.ctx, session, month),
  ));
  const parsed = parseGstr2b(raw);
  return transaction((trx) => importGstr2b(trx, orgId, parsed));
}

/**
 * A GSTIN's registered details (Zoho's "prefill from GSTIN"). Public data, so
 * it needs only the GSP's own credentials, not a taxpayer session; without a
 * GSP the stand-in can say only what the number itself carries.
 */
export async function lookupGstin(gstin: string, ipUser?: string): Promise<TaxpayerDetails> {
  const g = gstin.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) throw badRequest('That is not a GSTIN.');
  const p = gspReady() ? gstnProvider() : standinReturns;
  return wrap(`the details of ${g}`, () => p.searchTaxpayer({ ipUser }, g));
}

export async function trackFilings(orgId: number, branchId: number, fy: string, ipUser?: string) {
  const branch = await db.selectFrom('branches').select('gstin').where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch?.gstin) throw badRequest('This branch has no GSTIN.');
  const p = gspReady() ? gstnProvider() : standinReturns;
  return wrap('the filing history', () => p.trackReturns({ ipUser }, branch.gstin!, fy));
}
