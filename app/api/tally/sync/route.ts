import { ZodError } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { ApiError, route } from '@/lib/server/http';
import { authenticateConnector } from '@/lib/server/tally/connectors';
import { applySync } from '@/lib/server/tally/sync';
import { SyncMessage, TALLY_PROTOCOL_VERSION } from '@/lib/tally/protocol';

// Where a paired connector pushes a Tally company. Public — there is no
// session — and authenticated instead by the connector's token. See
// lib/tally/protocol.ts for the five kinds of message.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(
  async ({ req }) => {
    const connector = await authenticateConnector(db, req.headers.get('authorization'));

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError(400, 'The message was not valid JSON.', 'bad_json');
    }

    // An older or newer connector is told to update, not handed a validation error.
    const protocol = (raw as { protocol?: unknown })?.protocol;
    if ((raw as { kind?: unknown })?.kind === 'hello' && protocol !== TALLY_PROTOCOL_VERSION) {
      throw new ApiError(
        426,
        `This connector speaks protocol ${String(protocol)}, and the portal speaks ${TALLY_PROTOCOL_VERSION}. Update the connector.`,
        'protocol_mismatch',
      );
    }

    let message;
    try {
      message = SyncMessage.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ApiError(400, 'The message did not match the protocol.', 'bad_message', err.issues.slice(0, 20));
      }
      throw err;
    }

    // Only rows this connector's organisation owns are touched, and every
    // write is an upsert keyed by Tally's names and GUIDs — safe to repeat.
    return transaction((trx) => applySync(trx, connector, message), { retryDeadlocks: true });
  },
  { public: true },
);
