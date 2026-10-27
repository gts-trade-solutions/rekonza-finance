import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { auditMeta, logAudit } from '@/lib/server/audit';
import { badRequest, body, route } from '@/lib/server/http';
import { createPairingCode, PAIRING_MINUTES, revokeConnector } from '@/lib/server/tally/connectors';
import { tallyOverview } from '@/lib/server/tally/reports';

// ─────────────────────────────────────────────────────────────────────────────
// The Tally screen: which PCs are connected, which companies they send, and
// the two things a person does here — make a pairing code for a new connector,
// or disconnect one.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async ({ orgId }) => tallyOverview(db, orgId), {
  permission: { module: 'tally', action: 'view' },
});

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-pairing-code') }),
  z.object({ action: z.literal('revoke'), connectorId: z.union([z.string(), z.number()]) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Action);

    if (input.action === 'create-pairing-code') {
      const org = await db.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirst();
      // The demo book is shared by every visitor. A connector paired to it would
      // let anyone push a Tally company in front of everyone else.
      if (org?.is_demo) {
        throw badRequest('The demo book cannot be connected to Tally. Create your own book to connect your Tally company.');
      }
      const created = await transaction((trx) => createPairingCode(trx, orgId, user.userId));
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'tally_connector', targetId: created.connectorId, targetLabel: 'Tally pairing code',
        detail: `Made a Tally pairing code, valid for ${PAIRING_MINUTES} minutes`,
        ...auditMeta(req),
      });
      return { code: created.code, expiresAt: created.expiresAt.toISOString(), minutes: PAIRING_MINUTES };
    }

    const connectorId = Number(input.connectorId);
    if (!Number.isInteger(connectorId) || connectorId <= 0) throw badRequest('Which connector?');
    const name = await transaction((trx) => revokeConnector(trx, orgId, connectorId));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'tally_connector', targetId: connectorId, targetLabel: name,
      detail: 'Disconnected the Tally connector. The data it sent stays; nothing more arrives from it.',
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'tally', action: 'edit' } },
);
