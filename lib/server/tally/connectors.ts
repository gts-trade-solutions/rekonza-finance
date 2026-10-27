import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Pairing a Tally connector with an organisation, and recognising it after.
//
// Someone signed in to the portal asks for a pairing code; it is shown once,
// lasts fifteen minutes, and works once. They type it into the connector on the
// PC running Tally, and the connector trades it for a token it keeps. From then
// on the token alone says which organisation's books a push belongs to — the
// connector never holds anybody's portal password.
//
// Only hashes are stored. A leaked database gives away neither a usable code
// nor a usable token.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Executor } from '../db';
import { ApiError, badRequest, notFound } from '../http';

/** No 0/O or 1/I/L: a code read aloud over the phone should survive it. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const PAIRING_MINUTES = 15;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** "k7q2 9mxp", "K7Q2-9MXP" and "K7Q29MXP" are the same code. */
export const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "K7Q2-9MXP" — shown in halves, typed however. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/**
 * A pairing code for a new connector.
 *
 * Any code this organisation had not used yet is withdrawn first: the newest
 * code is the only one that works, so a code left on a screen or in a chat
 * message stops working as soon as another is made.
 */
export async function createPairingCode(
  ex: Executor,
  orgId: number,
  userId: number | null,
  now = new Date(),
): Promise<{ code: string; expiresAt: Date; connectorId: number }> {
  await ex.deleteFrom('tally_connectors').where('org_id', '=', orgId).where('status', '=', 'pending').execute();
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  const row = await ex
    .insertInto('tally_connectors')
    .values({
      org_id: orgId,
      status: 'pending',
      pairing_code_hash: sha256(code),
      pairing_expires_at: expiresAt,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  return { code: formatCode(code), expiresAt, connectorId: Number(row.insertId) };
}

/**
 * Trade a pairing code for a connector token.
 *
 * One error for every reason a code does not work — unknown, used, expired —
 * because telling them apart would tell a guesser which codes exist.
 */
export async function redeemPairingCode(
  ex: Executor,
  input: { code: string; machineName: string; connectorVersion: string },
  now = new Date(),
): Promise<{ token: string; connectorId: number; orgId: number; organisation: string }> {
  const code = normaliseCode(input.code);
  const refused = new ApiError(
    401,
    'That pairing code does not work. Codes last 15 minutes and work once — make a new one in the portal under Tally.',
    'pairing_refused',
  );
  if (code.length !== CODE_LENGTH) throw refused;

  const row = await ex
    .selectFrom('tally_connectors as c')
    .innerJoin('organizations as o', 'o.id', 'c.org_id')
    .select(['c.id', 'c.org_id', 'c.pairing_expires_at', 'o.name'])
    .where('c.pairing_code_hash', '=', sha256(code))
    .where('c.status', '=', 'pending')
    .forUpdate()
    .executeTakeFirst();
  if (!row || !row.pairing_expires_at || new Date(row.pairing_expires_at) <= now) throw refused;

  const token = `tly_${randomBytes(32).toString('base64url')}`;
  await ex
    .updateTable('tally_connectors')
    .set({
      status: 'active',
      pairing_code_hash: null,
      pairing_expires_at: null,
      token_hash: sha256(token),
      token_prefix: token.slice(0, 10),
      machine_name: input.machineName.slice(0, 100),
      connector_version: input.connectorVersion.slice(0, 30),
      paired_at: now,
      last_seen_at: now,
    })
    .where('id', '=', row.id)
    .execute();

  return { token, connectorId: row.id, orgId: row.org_id, organisation: row.name };
}

export interface AuthenticatedConnector {
  connectorId: number;
  orgId: number;
  organisation: string;
}

/** The connector behind a `Bearer tly_…` header, or a 401 the connector can act on. */
export async function authenticateConnector(
  ex: Executor,
  authorization: string | null,
  now = new Date(),
): Promise<AuthenticatedConnector> {
  const token = authorization?.match(/^Bearer\s+(tly_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) {
    throw new ApiError(401, 'This connector is not paired. Pair it again with a code from the portal.', 'connector_unpaired');
  }
  const row = await ex
    .selectFrom('tally_connectors as c')
    .innerJoin('organizations as o', 'o.id', 'c.org_id')
    .select(['c.id', 'c.org_id', 'c.status', 'o.name'])
    .where('c.token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row || row.status !== 'active') {
    throw new ApiError(
      401,
      row?.status === 'revoked'
        ? 'This connector was disconnected in the portal. Pair it again to resume.'
        : 'This connector is not paired. Pair it again with a code from the portal.',
      'connector_unpaired',
    );
  }
  await ex.updateTable('tally_connectors').set({ last_seen_at: now }).where('id', '=', row.id).execute();
  return { connectorId: row.id, orgId: row.org_id, organisation: row.name };
}

/** Disconnect a connector. Its token stops working at once; the data it sent stays. */
export async function revokeConnector(ex: Executor, orgId: number, connectorId: number, now = new Date()): Promise<string> {
  const row = await ex
    .selectFrom('tally_connectors')
    .select(['id', 'status', 'machine_name'])
    .where('id', '=', connectorId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound('That connector does not belong to this organisation.');
  if (row.status === 'revoked') throw badRequest('That connector is already disconnected.');
  if (row.status === 'pending') {
    await ex.deleteFrom('tally_connectors').where('id', '=', row.id).execute();
  } else {
    await ex
      .updateTable('tally_connectors')
      .set({ status: 'revoked', revoked_at: now, token_hash: null })
      .where('id', '=', row.id)
      .execute();
  }
  return row.machine_name ?? 'Unpaired connector';
}
