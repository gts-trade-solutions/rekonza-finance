import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Signing in to the portal by email, as Zoho Books' portal lets a customer or
// vendor do: give the email address the business has for you, get a six-digit
// code by email, and you are in — no link to keep, no password to forget.
//
// Only someone whose portal the business has turned on (a live portal link
// for their contact) can sign in, by the contact's own email or a contact
// person's. The answer to "send me a code" is the same whether or not the
// address is known, so the page cannot be used to find out who is a customer.
// Only a hash of the code is kept; it lasts ten minutes and five wrong tries,
// and no more than five codes an hour go to one address.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { ApiError, badRequest } from '../http';
import { mailReady, sendMail } from '../mail/mailer';
import { createPortalLink, logPortalActivity, type PortalSide } from './portal';

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const codeHash = (email: string, code: string) => createHash('sha256').update(`${email}|${code}`).digest('hex');
const norm = (email: string) => email.trim().toLowerCase();

interface Match { orgId: number; orgName: string; contactId: number; contactName: string; side: PortalSide }

/** Every portal the address may open: its contact's (or a contact person's), where the portal is on. */
export async function portalsFor(ex: Executor, email: string): Promise<Match[]> {
  const e = norm(email);
  const { rows } = await sql<{ org_id: number; org_name: string; contact_id: number; contact_name: string; side: PortalSide }>`
    SELECT DISTINCT a.org_id, COALESCE(o.legal_name, o.name) AS org_name, c.id AS contact_id, c.display_name AS contact_name, a.side
      FROM portal_access a
      JOIN contacts c ON c.id = a.contact_id
      JOIN organizations o ON o.id = a.org_id
      LEFT JOIN contact_persons p ON p.contact_id = c.id
     WHERE a.revoked_at IS NULL AND a.expires_at > NOW() AND c.erased_at IS NULL
       AND (LOWER(c.email) = ${e} OR LOWER(a.email) = ${e} OR LOWER(p.email) = ${e})
     ORDER BY org_name, contact_name`.execute(ex);
  return rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, contactId: r.contact_id, contactName: r.contact_name, side: r.side }));
}

/** Send a sign-in code, if the address has a portal. The reply never says whether it does. */
export async function requestPortalCode(ex: Executor, email: string, ip?: string | null): Promise<{ message: string }> {
  const e = norm(email);
  if (!EMAIL.test(e)) throw badRequest('Give the email address the business has for you.');
  const generic = { message: 'If that address has a portal, a six-digit code is on its way. It lasts ten minutes.' };
  const matches = await portalsFor(ex, e);
  if (!matches.length) return generic;
  if (!mailReady()) {
    throw new ApiError(503, 'Signing in by email is not set up for this business yet. Open the portal from the link in your last email from them.', 'mail_not_configured');
  }
  const recent = await ex.selectFrom('portal_login_codes').select(sql<string>`COUNT(*)`.as('n'))
    .where('email', '=', e).where('created_at', '>', new Date(Date.now() - 3600_000)).executeTakeFirst();
  if (Number(recent?.n ?? 0) >= CODES_PER_HOUR) return generic;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await ex.insertInto('portal_login_codes').values({
    email: e, code_hash: codeHash(e, code), expires_at: new Date(Date.now() + CODE_MINUTES * 60_000), ip: ip ?? null,
  }).execute();
  const first = matches[0];
  await sendMail(first.orgId, {
    to: [e],
    subject: `Your sign-in code for ${first.orgName}: ${code}`,
    text: `Your code to open your account with ${matches.map((m) => m.orgName).filter((v, i, a) => a.indexOf(v) === i).join(', ')} is ${code}.\n\nIt lasts ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.`,
    fromName: first.orgName,
  }, { docType: 'portal_login', ex });
  return generic;
}

/** Check the code; on success, a fresh portal link for each account the address may open. */
export async function verifyPortalCode(trx: Trx, email: string, code: string, ip?: string | null) {
  const e = norm(email);
  if (!/^\d{6}$/.test(code.trim())) throw badRequest('The code is six digits.');
  const row = await trx.selectFrom('portal_login_codes').selectAll()
    .where('email', '=', e).where('used_at', 'is', null).where('expires_at', '>', new Date())
    .orderBy('id', 'desc').limit(1).forUpdate().executeTakeFirst();
  const wrong = new ApiError(400, 'That code is not right, or it has expired. Ask for a new one.', 'bad_code');
  if (!row || row.attempts >= MAX_ATTEMPTS) throw wrong;
  if (row.code_hash !== codeHash(e, code.trim())) {
    await trx.updateTable('portal_login_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    throw wrong;
  }
  await trx.updateTable('portal_login_codes').set({ used_at: new Date() }).where('id', '=', row.id).execute();
  const matches = await portalsFor(trx, e);
  const portals = [];
  for (const m of matches) {
    // A week's link, as a signed-in session; the business's own links stand.
    const link = await createPortalLink(trx, m.orgId, null, { contactId: m.contactId, side: m.side, days: 7, email: e });
    await logPortalActivity(trx, { orgId: m.orgId, contactId: m.contactId, side: m.side, action: 'signed_in', detail: `Signed in by email (${e})`, ip });
    portals.push({ orgName: m.orgName, contactName: m.contactName, side: m.side, path: link.path });
  }
  return { portals };
}
