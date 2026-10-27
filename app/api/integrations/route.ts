import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { isValidGstin } from '@/lib/tax/gst';
import {
  availableProviders, connectionFor, encryptionAvailable, environmentOf, isLive, providerContext,
  providerServes, resolveProvider, saveCredentials, toApiError,
  type Portal,
} from '@/lib/server/integrations/gst';

// ─────────────────────────────────────────────────────────────────────────────
// Connecting a GST registration to a portal.
//
// The awkward shape of this is not ours: portal credentials are issued per
// GSTIN, per portal. A business registered in three states, using both
// e-invoicing and e-way bills, has to create six API users on two government
// websites — and this is the screen where that becomes obvious rather than
// where somebody discovers it halfway through.
//
// So the response is a grid of (registration × portal), each row carrying what
// is still missing rather than a bare "not connected". Every prerequisite is
// named, because the alternative is a rejection with a numeric code at the
// moment somebody is trying to send an invoice.
// ─────────────────────────────────────────────────────────────────────────────

const PORTALS: { portal: Portal; label: string; where: string; help: string }[] = [
  {
    portal: 'einvoice',
    label: 'E-invoicing',
    where: 'einvoice1.gst.gov.in',
    help:
      'Sign in to the e-invoice portal with this GSTIN, open API Registration → Create API User, ' +
      'choose Through GSP (or Through ERP when connecting to NIC directly), and set a username and ' +
      'password. Those two go here.',
  },
  {
    portal: 'ewaybill',
    label: 'E-way bills',
    where: 'ewaybillgst.gov.in',
    help:
      'A separate API user on a separate portal, even for the same GSTIN. Registration → For GSP, ' +
      'select your GSP, then set a username and password.',
  },
];

export const GET = route(
  async ({ orgId }) => {
    const branches = await db
      .selectFrom('branches')
      .select(['id', 'name', 'gstin', 'state_code', 'city', 'pincode', 'is_primary'])
      .where('org_id', '=', orgId)
      .where('is_active', '=', 1)
      .orderBy('is_primary', 'desc')
      .execute();

    // Which connections already have a sealed credential. Read as a set of ids
    // rather than joined onto the connection, so no query in this file can
    // accidentally select ciphertext into a response.
    const stored = await db
      .selectFrom('integration_credentials as cr')
      .innerJoin('integration_connections as c', 'c.id', 'cr.connection_id')
      .select(['cr.connection_id', 'cr.rotated_at'])
      .where('c.org_id', '=', orgId)
      .execute();
    const credentialAt = new Map(stored.map((s) => [s.connection_id, s.rotated_at]));

    const rows = await db
      .selectFrom('integration_connections')
      .select(['id', 'branch_id', 'portal', 'provider', 'gstin', 'status', 'last_verified_at', 'last_error'])
      .where('org_id', '=', orgId)
      .execute();
    const byKey = new Map(rows.map((r) => [`${r.branch_id}:${r.portal}`, r]));

    const keyAvailable = encryptionAvailable();
    const providers = availableProviders();
    const providerInfo = new Map(providers.map((p) => [p.name, p]));

    const connections = branches.flatMap((b) =>
      PORTALS.map((p) => {
        const row = byKey.get(`${b.id}:${p.portal}`) ?? null;
        const hasCredentials = row ? credentialAt.has(row.id) : false;

        // Everything that has to be true before a single document can be sent.
        // Ordered as somebody would work through them.
        const blocking: string[] = [];
        if (!b.gstin) {
          blocking.push('This registration has no GSTIN.');
        } else if (!isValidGstin(b.gstin)) {
          blocking.push(`${b.gstin} fails its checksum, so it is mistyped.`);
        }
        if (!b.city) blocking.push('No city. The portals require it as its own field.');
        if (!b.pincode) blocking.push('No PIN code. The portals require six digits.');
        if (!keyAvailable) {
          blocking.push(
            'INTEGRATION_KEY is not set on the server, so credentials cannot be stored safely.',
          );
        }
        if (!hasCredentials) {
          blocking.push('No API username and password have been entered yet.');
        } else if (row && row.gstin && b.gstin && row.gstin !== b.gstin) {
          // The stored credentials were issued against a GSTIN this
          // registration no longer carries. Submission refuses this outright —
          // authenticating as a different taxpayer is not something to guess
          // about — so it has to be visible here rather than discovered then.
          blocking.push(
            `The stored credentials were issued for GSTIN ${row.gstin}, but this registration is now ` +
              `${b.gstin}. Enter them again for the new GSTIN.`,
          );
        }

        const providerName = row?.provider ?? 'fake';

        // A provider the server is not set up for cannot work however good the
        // stored credentials are — say which setting is missing, on the row.
        const info = providerInfo.get(providerName);
        if (hasCredentials && info && info.missing.length > 0) blocking.push(...info.missing);

        return {
          id: row ? asId(row.id) : null,
          branchId: asId(b.id),
          branchName: b.name,
          gstin: b.gstin,
          stateCode: b.state_code,
          portal: p.portal,
          portalLabel: p.label,
          portalHost: p.where,
          help: p.help,
          provider: providerName,
          providerLabel: info?.label ?? providerName,
          environment: environmentOf(providerName),
          live: isLive(providerName),
          status: row?.status ?? 'not_configured',
          hasCredentials,
          credentialsUpdatedAt: row
            ? (credentialAt.get(row.id)?.toISOString() ?? null)
            : null,
          lastVerifiedAt: row?.last_verified_at?.toISOString() ?? null,
          lastError: row?.last_error ?? null,
          blocking,
          ready: blocking.length === 0,
        };
      }),
    );

    return {
      connections,
      /** Without a key, the credential form is refused rather than shown. */
      encryptionAvailable: keyAvailable,
      /**
       * What can be chosen, where each one files, and what the server still
       * lacks for it. The UI offers a provider only for the portals it
       * serves, and says plainly which ones are sandbox — real calls, nothing
       * filed — rather than letting "connected" imply "filing".
       */
      providers,
    };
  },
  { permission: { module: 'settings', action: 'view' } },
);

const CredentialsInput = z.object({
  branchId: z.union([z.string(), z.number()]),
  portal: z.enum(['einvoice', 'ewaybill']),
  username: z.string().trim().min(1, 'The portal username is required.').max(100),
  password: z.string().min(1, 'The portal password is required.').max(200),
  /** Issued by the GSP or the sandbox, and shared across a PAN's registrations. */
  clientId: z.string().trim().max(200).nullish().or(z.literal('').transform(() => null)),
  clientSecret: z.string().max(200).nullish().or(z.literal('').transform(() => null)),
  /** Which system these credentials are for. Defaults to the stand-in. */
  provider: z.string().trim().max(40).optional(),
});

/**
 * Store the API credentials a customer created on the portal.
 *
 * These are not our secrets. They are somebody's government portal access, so
 * they are sealed on the way in and there is no endpoint anywhere that reads
 * them back out — the only thing that opens them is a submission, immediately
 * before the call that needs them.
 */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CredentialsInput);
    const branchId = Number(input.branchId);
    const providerName = input.provider || 'fake';

    if (!encryptionAvailable()) {
      throw badRequest(
        'INTEGRATION_KEY is not set on the server, so portal credentials cannot be stored. Set it and ' +
          'restart before entering anything here — storing them unsealed is not an option.',
      );
    }

    // A provider built for one portal cannot authenticate against another —
    // the e-invoice and e-way bill systems issue separate credentials.
    resolveProvider(providerName);
    if (!providerServes(providerName, input.portal)) {
      throw badRequest(
        `"${providerName}" does not serve the ${input.portal === 'einvoice' ? 'e-invoice' : 'e-way bill'} ` +
          'portal. Pick a provider built for this one.',
      );
    }

    const branch = await db
      .selectFrom('branches')
      .select(['id', 'name', 'gstin', 'city', 'pincode'])
      .where('id', '=', branchId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!branch) throw notFound('That registration does not belong to this organisation.');

    // Refused rather than stored-and-broken. Credentials are bound to a GSTIN,
    // so accepting them for a registration that has none would produce a
    // connection that can never authenticate.
    if (!branch.gstin) {
      throw badRequest(
        `${branch.name} has no GSTIN. Portal credentials are issued against a registration, so add ` +
          'the GSTIN first.',
      );
    }
    if (!isValidGstin(branch.gstin)) {
      throw badRequest(
        `${branch.name} has GSTIN ${branch.gstin}, which fails its checksum. Correct it before ` +
          'connecting — the portal will not accept credentials for a GSTIN that does not exist.',
      );
    }

    const result = await transaction(async (trx) => {
      const existing = await trx
        .selectFrom('integration_connections')
        .select(['id'])
        .where('org_id', '=', orgId)
        .where('branch_id', '=', branchId)
        .where('portal', '=', input.portal)
        .executeTakeFirst();

      let connectionId = existing?.id ?? null;

      if (connectionId === null) {
        const row = await trx
          .insertInto('integration_connections')
          .values({
            org_id: orgId,
            branch_id: branchId,
            portal: input.portal,
            provider: providerName,
            gstin: branch.gstin,
            status: 'configured',
            created_by_user_id: user.userId,
          })
          .executeTakeFirstOrThrow();
        connectionId = Number(row.insertId);
      } else {
        await trx
          .updateTable('integration_connections')
          .set({
            // Re-stamped: credentials just entered belong to whatever GSTIN the
            // registration carries now, which is what makes the mismatch check
            // on submission meaningful.
            gstin: branch.gstin,
            provider: providerName,
            status: 'configured',
            last_error: null,
            last_verified_at: null,
          })
          .where('id', '=', connectionId)
          .execute();
      }

      await saveCredentials(trx, connectionId, {
        username: input.username,
        password: input.password,
        clientId: input.clientId ?? undefined,
        clientSecret: input.clientSecret ?? undefined,
      });

      return { connectionId, created: existing === undefined };
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'integration_connection', targetId: result.connectionId,
      targetLabel: `${branch.name} · ${input.portal}`,
      // The username is recorded; the password is not, anywhere, ever.
      detail:
        `${result.created ? 'Connected' : 'Re-entered credentials for'} the ` +
        `${input.portal === 'einvoice' ? 'e-invoice' : 'e-way bill'} portal as "${input.username}" ` +
        `for GSTIN ${branch.gstin}, via ${providerName}`,
      ...auditMeta(req),
    });

    const environment = environmentOf(providerName);

    return {
      id: asId(result.connectionId),
      status: 'configured',
      environment,
      /**
       * Said plainly on every save, and differently for each environment.
       * Credentials are necessary but not sufficient, and a customer who took
       * "stored" to mean "filing" would find out at a deadline.
       */
      live: isLive(providerName),
      note:
        environment === 'production'
          ? 'Credentials stored. Invoices registered from this registration are filed with the portal. ' +
            'Use Test connection to confirm the login before relying on it.'
          : environment === 'sandbox'
            ? "Credentials stored for NIC's sandbox — real calls to the real API, with test data. Nothing " +
              'is filed. Use Test connection to confirm the login works.'
            : 'Credentials stored. Nothing is filed with any portal yet: submissions still go to the ' +
              'built-in stand-in.',
    };
  },
  { permission: { module: 'settings', action: 'edit' } },
);

const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('forget'),
    branchId: z.union([z.string(), z.number()]),
    portal: z.enum(['einvoice', 'ewaybill']),
  }),
  z.object({
    action: z.enum(['disable', 'enable']),
    branchId: z.union([z.string(), z.number()]),
    portal: z.enum(['einvoice', 'ewaybill']),
  }),
  z.object({
    action: z.literal('verify'),
    branchId: z.union([z.string(), z.number()]),
    portal: z.enum(['einvoice', 'ewaybill']),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ActionInput);
    const branchId = Number(input.branchId);

    const connection = await db
      .selectFrom('integration_connections as c')
      .innerJoin('branches as b', 'b.id', 'c.branch_id')
      .select(['c.id', 'b.name as branch_name'])
      .where('c.org_id', '=', orgId)
      .where('c.branch_id', '=', branchId)
      .where('c.portal', '=', input.portal)
      .executeTakeFirst();
    if (!connection) throw notFound('That registration is not connected to this portal.');

    // ── Test connection ───────────────────────────────────────────────────────
    //
    // Log in with the stored credentials and do nothing else. It is the only
    // way to find out a password is wrong without registering an invoice to
    // discover it — and the result is written through `db`, outside any
    // transaction, so a failure is recorded rather than rolled back.
    if (input.action === 'verify') {
      const conn = await connectionFor(db, orgId, branchId, input.portal);
      if (!conn.configured || conn.id === null) {
        throw badRequest('There are no stored credentials to test. Add them first.');
      }
      const provider = resolveProvider(conn.providerName);
      const label = `${connection.branch_name} · ${input.portal === 'einvoice' ? 'e-invoicing' : 'e-way bills'}`;

      try {
        const result = await provider.verify(await providerContext(db, conn));
        await db
          .updateTable('integration_connections')
          .set({ status: 'verified', last_verified_at: new Date(), last_error: null })
          .where('id', '=', connection.id)
          .execute();
        await logAudit({
          orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'integration_connection', targetId: connection.id, targetLabel: label,
          detail: `Test connection succeeded against ${provider.environment}`,
          ...auditMeta(req),
        });
        return {
          status: 'verified',
          environment: provider.environment,
          live: provider.live,
          expiresAt: result.expiresAt,
          message:
            provider.environment === 'stand-in'
              ? 'This registration uses the built-in stand-in, so there is nothing to log in to.'
              : `Logged in to the ${provider.environment === 'sandbox' ? "NIC sandbox" : 'portal'} ` +
                'with the stored credentials.',
        };
      } catch (err) {
        await db
          .updateTable('integration_connections')
          .set({ status: 'failed', last_error: ((err as Error).message ?? 'Unknown').slice(0, 1000) })
          .where('id', '=', connection.id)
          .execute();
        throw toApiError(err, label);
      }
    }

    if (input.action === 'forget') {
      await transaction(async (trx) => {
        // Both, together. A session token is minted from the credentials, so
        // leaving one behind would keep access alive after the customer asked
        // for it to be removed.
        await trx.deleteFrom('integration_credentials')
          .where('connection_id', '=', connection.id).execute();
        await trx.deleteFrom('integration_sessions')
          .where('connection_id', '=', connection.id).execute();
        await trx.updateTable('integration_connections')
          .set({
            status: 'not_configured',
            // Cleared with them. The stored GSTIN only exists to detect that
            // credentials were issued against a registration that has since
            // changed, and there are no credentials left to detect it for.
            gstin: null,
            last_error: null,
          })
          .where('id', '=', connection.id).execute();
      });
    } else {
      await db
        .updateTable('integration_connections')
        .set({ status: input.action === 'disable' ? 'disabled' : 'configured' })
        .where('id', '=', connection.id)
        .execute();
    }

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'integration_connection', targetId: connection.id,
      targetLabel: `${connection.branch_name} · ${input.portal}`,
      detail:
        input.action === 'forget'
          ? 'Deleted the stored portal credentials and any live session'
          : `${input.action === 'disable' ? 'Disabled' : 'Re-enabled'} the connection`,
      ...auditMeta(req),
    });

    // Read the row back directly rather than through `connectionFor`. That
    // function is built for the submission path, where a GSTIN that no longer
    // matches the registration is a refusal — which is right there and wrong
    // here: it would report a completed deletion as a failure.
    const after = await db
      .selectFrom('integration_connections')
      .select(['status', 'provider'])
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow();

    return { status: after.status, provider: after.provider, live: isLive(after.provider) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
