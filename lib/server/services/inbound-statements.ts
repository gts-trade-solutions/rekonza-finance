import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' "Auto-upload bank statements from email" and "Bank Statements
// From Inbox": each bank account has an address of its own,
//   statements+<token>@<INBOUND_EMAIL_DOMAIN>
// and a statement forwarded to it is imported into that account, as Import
// Statement would import it (banking.ts importStatement: duplicates kept out,
// rules and matching run as Banking Preferences say).
//
// The mail itself arrives through an inbound-mail service that turns an email
// into an HTTP POST to /api/inbound/statements (secret: INBOUND_WEBHOOK_SECRET).
// Mailgun Routes, SendGrid Inbound Parse and Postmark Inbound are read here;
// which one sent it is told from the request, so any of them can be pointed at
// the same address.
//
// Who may send: the organisation's own users (forwarding their bank's mail),
// and the addresses or @domains listed in Banking Preferences — usually the
// bank's statement sender. Anything else is refused and written down, so a
// stranger who learns the address cannot put lines into the books.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { db, transaction, type Executor, type Trx } from '../db';
import { badRequest } from '../http';
import { logAudit } from '../audit';
import { importStatement } from './banking';
import { bankingPreferences } from './banking-preferences';
import { readStatementFile, STATEMENT_FILE } from '../statement-file';

export type InboundProvider = 'mailgun' | 'sendgrid' | 'postmark';
export interface InboundAttachment { filename: string; contentType: string | null; data: Uint8Array }
export interface InboundEmail {
  provider: InboundProvider;
  recipients: string[];
  sender: string | null;
  subject: string | null;
  attachments: InboundAttachment[];
}

/** Whether the server can receive statements: a domain to receive at and a secret for the webhook. */
export function inboundSettings() {
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() || null;
  const local = process.env.INBOUND_EMAIL_LOCAL?.trim().toLowerCase() || 'statements';
  const secret = process.env.INBOUND_WEBHOOK_SECRET?.trim() || null;
  return { configured: !!domain && !!secret, domain, local, secretSet: !!secret };
}

export function inboundAddress(token: string): string | null {
  const s = inboundSettings();
  return s.domain ? `${s.local}+${token}@${s.domain}` : null;
}

/** The webhook's secret, compared in constant time; no secret set means nothing is accepted. */
export function inboundSecretOk(given: string | null | undefined): boolean {
  const want = inboundSettings();
  if (!want.secretSet || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(process.env.INBOUND_WEBHOOK_SECRET?.trim()));
  return a.length === b.length && timingSafeEqual(a, b);
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const emailsIn = (s: unknown): string[] => (String(s ?? '').match(EMAIL) ?? []).map((e) => e.toLowerCase());

/** An email as the inbound service posted it: Postmark's JSON, or Mailgun's / SendGrid's multipart form. */
export async function readInboundRequest(req: Request): Promise<InboundEmail> {
  const type = req.headers.get('content-type') ?? '';
  const forced = new URL(req.url).searchParams.get('provider') as InboundProvider | null;
  if (type.includes('application/json')) {
    const j = await req.json() as {
      From?: string; FromFull?: { Email?: string }; To?: string; ToFull?: { Email?: string }[]; OriginalRecipient?: string;
      Subject?: string; Attachments?: { Name?: string; Content?: string; ContentType?: string }[];
    };
    return {
      provider: forced ?? 'postmark',
      recipients: [...new Set([...emailsIn(j.OriginalRecipient), ...(j.ToFull ?? []).flatMap((t) => emailsIn(t.Email)), ...emailsIn(j.To)])],
      sender: emailsIn(j.FromFull?.Email ?? j.From)[0] ?? null,
      subject: j.Subject ?? null,
      attachments: (j.Attachments ?? []).filter((a) => a.Content).map((a) => ({
        filename: a.Name || 'statement', contentType: a.ContentType ?? null, data: new Uint8Array(Buffer.from(a.Content!, 'base64')),
      })),
    };
  }
  if (!type.includes('multipart/form-data') && !type.includes('application/x-www-form-urlencoded')) {
    throw badRequest('Send the email as multipart form data (Mailgun, SendGrid) or JSON (Postmark).');
  }
  const form = await req.formData();
  const text = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : null; };
  const files: InboundAttachment[] = [];
  for (const [, v] of form.entries()) {
    if (typeof v === 'object' && v && 'arrayBuffer' in v) {
      const f = v as File;
      files.push({ filename: f.name || 'statement', contentType: f.type || null, data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  // Mailgun: recipient, sender, subject, attachment-1…; SendGrid: to, from, subject, envelope, attachment1….
  const mailgun = forced === 'mailgun' || (!forced && (form.has('recipient') || form.has('attachment-count') || form.has('body-plain')));
  if (mailgun) {
    return { provider: 'mailgun', recipients: emailsIn(text('recipient') ?? text('To')), sender: emailsIn(text('sender') ?? text('from'))[0] ?? null, subject: text('subject'), attachments: files };
  }
  let envelope: { to?: string[]; from?: string } = {};
  try { envelope = JSON.parse(text('envelope') ?? '{}'); } catch { /* the headers below are enough */ }
  return {
    provider: 'sendgrid',
    recipients: [...new Set([...(envelope.to ?? []).flatMap(emailsIn), ...emailsIn(text('to'))])],
    sender: emailsIn(envelope.from ?? text('from'))[0] ?? null,
    subject: text('subject'),
    attachments: files,
  };
}

/** Each active bank account's own address, made the first time it is asked for. */
export async function ensureInboundTokens(orgId: number, opts: { trx?: Trx } = {}): Promise<{ id: number; name: string; kind: string; token: string }[]> {
  const run = <T>(fn: (trx: Trx) => Promise<T>) => (opts.trx ? fn(opts.trx) : transaction(fn));
  return run(async (trx) => {
    const accounts = await trx.selectFrom('bank_accounts').select(['id', 'name', 'kind', 'inbound_token'])
      .where('org_id', '=', orgId).where('is_active', '=', 1).where('kind', '<>', 'clearing').orderBy('name').forUpdate().execute();
    const out: { id: number; name: string; kind: string; token: string }[] = [];
    for (const a of accounts) {
      let token = a.inbound_token;
      if (!token) {
        token = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(12, '0');
        await trx.updateTable('bank_accounts').set({ inbound_token: token }).where('id', '=', a.id).execute();
      }
      out.push({ id: a.id, name: a.name, kind: a.kind, token });
    }
    return out;
  });
}

export interface InboundResult { status: 'imported' | 'refused' | 'failed'; filename: string | null; imported: number; duplicates: number; reason: string | null }

async function note(ex: Executor, orgId: number, accountId: number | null, email: InboundEmail, r: InboundResult & { importId?: number | null }) {
  await ex.insertInto('inbound_statements').values({
    org_id: orgId, bank_account_id: accountId, provider: email.provider, sender: email.sender?.slice(0, 255) ?? null,
    recipient: email.recipients.join(', ').slice(0, 255) || null, subject: email.subject?.slice(0, 255) ?? null,
    filename: r.filename?.slice(0, 255) ?? null, status: r.status, rows_imported: r.imported, rows_duplicate: r.duplicates,
    import_id: r.importId ?? null, error: r.reason?.slice(0, 500) ?? null,
  }).execute();
}

/**
 * Import what an email brought, into the account its address belongs to.
 * An address nobody owns is answered with nothing written (there is no book
 * to write it in); everything else is written down, imported or not.
 */
export async function receiveInboundStatement(email: InboundEmail, opts: { trx?: Trx } = {}): Promise<{ account: string | null; results: InboundResult[] }> {
  // A test passes its own transaction; the webhook gives each statement one of its own.
  const ex: Executor = opts.trx ?? db;
  const run = <T>(fn: (trx: Trx) => Promise<T>) => (opts.trx ? fn(opts.trx) : transaction(fn));
  const token = email.recipients.map((r) => /\+([a-z0-9]{8,32})@/i.exec(r)?.[1]?.toLowerCase()).find(Boolean);
  const account = token
    ? await ex.selectFrom('bank_accounts').select(['id', 'org_id', 'name', 'is_active']).where('inbound_token', '=', token).executeTakeFirst()
    : undefined;
  if (!account) return { account: null, results: [{ status: 'refused', filename: null, imported: 0, duplicates: 0, reason: 'No bank account has that address.' }] };
  const orgId = account.org_id;
  const refuse = async (reason: string) => {
    const r: InboundResult = { status: 'refused', filename: null, imported: 0, duplicates: 0, reason };
    await note(ex, orgId, account.id, email, r);
    return { account: account.name, results: [r] };
  };
  if (!account.is_active) return refuse(`${account.name} is inactive.`);
  const prefs = await bankingPreferences(ex, orgId);
  if (!prefs.inboundEnabled) return refuse('Auto-upload of bank statements from email is switched off in Banking Preferences.');
  const sender = email.sender?.toLowerCase() ?? '';
  const user = sender
    ? await ex.selectFrom('users').select('id').where('org_id', '=', orgId).where('is_active', '=', 1).where(sql<boolean>`LOWER(email) = ${sender}`).executeTakeFirst()
    : undefined;
  const listed = prefs.inboundSenders.some((s) => (s.startsWith('@') ? sender.endsWith(s) : sender === s));
  if (!sender || (!user && !listed)) return refuse(`${sender || 'An unknown sender'} may not send statements. Forward it from your own login's email, or add the sender in Banking Preferences.`);
  const files = email.attachments.filter((a) => STATEMENT_FILE.test(a.filename));
  if (!files.length) return refuse('No statement was attached (CSV, Excel, OFX, QIF, camt.053, MT940 or JSON).');

  const results: InboundResult[] = [];
  for (const f of files) {
    let r: InboundResult & { importId?: number | null };
    try {
      const read = await readStatementFile(f.filename, f.data);
      if (!read.rows.length) throw badRequest(read.problem ?? 'The file had no statement lines.');
      const done = await run((trx) => importStatement(trx, orgId, user?.id ?? null, account.id, `Email: ${f.filename}`, read.rows));
      r = { status: 'imported', filename: f.filename, imported: done.imported, duplicates: done.duplicates, reason: read.problem, importId: done.importId };
      await logAudit({
        trx: opts.trx, orgId, actorUserId: user?.id ?? null, actorName: `Email from ${sender}`, action: 'import', targetType: 'bank_statement',
        targetId: done.importId, targetLabel: f.filename, detail: `${done.imported} imported, ${done.duplicates} already present, ${done.autoMatched} auto-matched (by email)`,
      });
    } catch (e) {
      r = { status: 'failed', filename: f.filename, imported: 0, duplicates: 0, reason: e instanceof Error ? e.message : String(e) };
    }
    await note(ex, orgId, account.id, email, r);
    results.push(r);
  }
  return { account: account.name, results };
}

/** What the Auto-upload window and the account page's strip show. */
export async function inboundOverview(ex: Executor, orgId: number, accountId?: number, opts: { trx?: Trx } = {}) {
  const s = inboundSettings();
  const prefs = await bankingPreferences(ex, orgId);
  const tokens = await ensureInboundTokens(orgId, opts);
  let q = ex.selectFrom('inbound_statements as i').leftJoin('bank_accounts as b', 'b.id', 'i.bank_account_id')
    .select(['i.id', 'i.received_at', 'i.sender', 'i.filename', 'i.status', 'i.rows_imported', 'i.rows_duplicate', 'i.error', 'b.name as account_name', 'i.bank_account_id'])
    .where('i.org_id', '=', orgId);
  if (accountId) q = q.where('i.bank_account_id', '=', accountId);
  const recent = await q.orderBy('i.id', 'desc').limit(20).execute();
  return {
    configured: s.configured,
    domain: s.domain,
    enabled: prefs.inboundEnabled,
    senders: prefs.inboundSenders,
    accounts: tokens.filter((t) => !accountId || t.id === accountId).map((t) => ({ id: String(t.id), name: t.name, kind: t.kind, address: inboundAddress(t.token) })),
    recent: recent.map((r) => ({
      id: String(r.id), at: new Date(r.received_at).toISOString(), sender: r.sender, filename: r.filename, status: r.status,
      imported: r.rows_imported, duplicates: r.rows_duplicate, reason: r.error, account: r.account_name, accountId: r.bank_account_id ? String(r.bank_account_id) : null,
    })),
  };
}
