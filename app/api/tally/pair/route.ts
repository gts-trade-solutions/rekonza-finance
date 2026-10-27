import { transaction } from '@/lib/server/db';
import { logAudit } from '@/lib/server/audit';
import { body, route } from '@/lib/server/http';
import { redeemPairingCode } from '@/lib/server/tally/connectors';
import { PairRequest, type PairReply } from '@/lib/tally/protocol';

// The connector trades a pairing code for its token. Public — the connector
// has no session — and guarded by the code itself: random, single-use, and
// gone in fifteen minutes.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(
  async ({ req }): Promise<PairReply> => {
    const input = await body(req, PairRequest);
    const paired = await transaction((trx) => redeemPairingCode(trx, input));
    await logAudit({
      orgId: paired.orgId,
      action: 'update',
      targetType: 'tally_connector',
      targetId: paired.connectorId,
      targetLabel: input.machineName,
      detail: `Tally connector ${input.connectorVersion} paired from ${input.machineName}`,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: req.headers.get('user-agent'),
    });
    return { token: paired.token, organisation: paired.organisation, connectorId: String(paired.connectorId) };
  },
  { public: true },
);
