import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Outgoing email, through the SMTP server named in the environment:
//
//   SMTP_HOST, SMTP_PORT (587, or 465 for TLS from the start), SMTP_USER,
//   SMTP_PASSWORD, MAIL_FROM ("Accounts <accounts@yourcompany.in>")
//
// Any SMTP account works — Gmail or Google Workspace with an app password,
// Zoho Mail, Microsoft 365, or a provider such as Amazon SES or Brevo. The
// password stays in the server's environment, never in the database.
//
// The company's own name is put on each message and replies go to its email
// (Settings → Organisation), so the customer answers the business, not the
// mail account. Every message is written to email_log, sent or not.
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer, { type Transporter } from 'nodemailer';
import { db, type Executor } from '../db';
import { ApiError } from '../http';

export interface MailStatus { configured: boolean; from: string | null; host: string | null }

export function mailStatus(): MailStatus {
  const host = process.env.SMTP_HOST?.trim() || null;
  const from = process.env.MAIL_FROM?.trim() || process.env.SMTP_USER?.trim() || null;
  return { configured: !!host && !!from, from, host };
}

let transport: Transporter | null = null;
function transporter(): Transporter {
  if (transport) return transport;
  const port = Number(process.env.SMTP_PORT) || 587;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
  });
  return transport;
}

/** Tests and the demo put a stand-in here, so nothing leaves the machine. */
let override: ((m: OutgoingMail) => Promise<{ messageId: string }>) | null = null;
export function setMailTransport(fn: typeof override) { override = fn; }

/** Whether a message can go out at all: an SMTP server, or a stand-in under test. */
export function mailReady(): boolean {
  return !!override || mailStatus().configured;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
  fromName?: string | null;
  attachments?: { filename: string; content: Buffer | Uint8Array; contentType?: string }[];
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Send one message and log it. Throws (409 mail_not_configured) when no SMTP
 * server is set up, so the screen can say what to do instead of failing quietly.
 */
export async function sendMail(
  orgId: number,
  mail: OutgoingMail,
  log: { docType?: string | null; docId?: number | null; userId?: number | null; ex?: Executor } = {},
): Promise<{ messageId: string }> {
  const to = mail.to.map((t) => t.trim()).filter(Boolean);
  const bad = [...to, ...(mail.cc ?? [])].find((t) => !EMAIL.test(t));
  if (!to.length) throw new ApiError(400, 'There is no email address to send to.', 'bad_request');
  if (bad) throw new ApiError(400, `${bad} is not an email address.`, 'bad_request');
  const status = mailStatus();
  if (!override && !status.configured) {
    throw new ApiError(409, 'Email is not set up on this server. Add SMTP_HOST, SMTP_USER, SMTP_PASSWORD and MAIL_FROM to its environment.', 'mail_not_configured');
  }
  const ex = log.ex ?? db;
  const record = (s: 'sent' | 'failed', extra: { messageId?: string; error?: string }) =>
    ex.insertInto('email_log').values({
      org_id: orgId, doc_type: log.docType ?? null, doc_id: log.docId ?? null,
      to_address: to.join(', ').slice(0, 500), cc_address: mail.cc?.length ? mail.cc.join(', ').slice(0, 500) : null,
      subject: mail.subject.slice(0, 300), status: s, error: extra.error?.slice(0, 500) ?? null,
      message_id: extra.messageId?.slice(0, 200) ?? null, sent_by_user_id: log.userId ?? null,
    }).execute();
  try {
    const fromAddress = status.from ?? 'no-reply@localhost';
    const bare = fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress;
    const sent = override
      ? await override({ ...mail, to })
      : await transporter().sendMail({
          from: mail.fromName ? { name: mail.fromName, address: bare } : fromAddress,
          to, cc: mail.cc, replyTo: mail.replyTo ?? undefined,
          subject: mail.subject, text: mail.text, html: mail.html,
          attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
        });
    await record('sent', { messageId: sent.messageId });
    return { messageId: sent.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record('failed', { error: message });
    throw new ApiError(502, `The mail server refused the message: ${message.slice(0, 200)}`, 'mail_failed');
  }
}

/** Where documents for a contact go: the people marked to receive them, else the contact's own email. */
export async function documentRecipients(ex: Executor, orgId: number, contactId: number): Promise<string[]> {
  const people = await ex.selectFrom('contact_persons').select('email')
    .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('receives_documents', '=', 1).where('email', 'is not', null)
    .orderBy('is_primary', 'desc').execute();
  const list = people.map((p) => p.email!).filter((e) => EMAIL.test(e));
  if (list.length) return [...new Set(list)];
  const c = await ex.selectFrom('contacts').select('email').where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
  return c?.email && EMAIL.test(c.email) ? [c.email] : [];
}

/** The address links in an email point at: the site's own, or the request's. */
export function siteUrl(req?: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.APP_URL?.trim();
  if (env) return env.replace(/\/$/, '');
  if (req) return new URL(req.url).origin;
  return 'http://localhost:5000';
}
