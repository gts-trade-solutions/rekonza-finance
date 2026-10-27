import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// How far each registration is from registering invoices with the real portal.
//
// Five steps, in the order somebody works through them, each answered from
// what the app already holds — the server's keys, the branch's details, the
// stored connection, its last login test, and the IRNs it has issued. Nothing
// here opens a credential or calls a portal: it is safe to show on the
// e-invoice screen to anyone who can see that screen.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../../db';
import { isValidGstin } from '../../../tax/gst';
import { availableProviders, encryptionAvailable, environmentOf, providerLabel } from './index';
import type { ProviderEnvironment } from './provider';

/** The connector for talking to the invoice portal directly or through a NIC-compatible GSP. */
const PORTAL_PROVIDER = 'nic_einvoice';

export type StepKey = 'server' | 'details' | 'credentials' | 'login' | 'first_irn';

export interface ReadinessStep {
  key: StepKey;
  done: boolean;
  /** What is still missing, in words someone can act on. Empty when done. */
  todo: string[];
}

export interface BranchReadiness {
  branchId: string;
  name: string;
  gstin: string | null;
  provider: string;
  providerLabel: string;
  environment: ProviderEnvironment;
  steps: ReadinessStep[];
  /** IRNs issued through a real connection — sandbox or production, never the stand-in. */
  realIrns: number;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface PortalReadiness {
  /** At least one registration issues IRNs through a real connection. */
  connected: boolean;
  /** At least one of those files for real. */
  filing: boolean;
  branches: BranchReadiness[];
}

export async function einvoiceReadiness(ex: Executor, orgId: number): Promise<PortalReadiness> {
  const [branches, connections, irns] = await Promise.all([
    ex
      .selectFrom('branches')
      .select(['id', 'name', 'gstin', 'city', 'pincode', 'is_primary'])
      .where('org_id', '=', orgId)
      .where('is_active', '=', 1)
      .orderBy('is_primary', 'desc')
      .orderBy('id')
      .execute(),
    ex
      .selectFrom('integration_connections as c')
      .leftJoin('integration_credentials as cr', 'cr.connection_id', 'c.id')
      .select(['c.branch_id', 'c.provider', 'c.status', 'c.gstin', 'c.last_verified_at', 'c.last_error', 'cr.connection_id as sealed'])
      .where('c.org_id', '=', orgId)
      .where('c.portal', '=', 'einvoice')
      .execute(),
    sql<{ branch_id: number; n: number | string }>`
      SELECT i.branch_id, COUNT(*) AS n
        FROM einvoices e JOIN invoices i ON i.id = e.invoice_id
       WHERE e.org_id = ${orgId} AND e.provider IS NOT NULL AND e.provider <> 'fake'
         AND e.status IN ('submitted', 'cancelled')
       GROUP BY i.branch_id
    `.execute(ex),
  ]);

  const byBranch = new Map(connections.map((c) => [c.branch_id, c]));
  const irnsByBranch = new Map(irns.rows.map((r) => [Number(r.branch_id), Number(r.n)]));
  const portal = availableProviders().find((p) => p.name === PORTAL_PROVIDER);
  const serverTodo = [
    ...(encryptionAvailable() ? [] : ['Set INTEGRATION_KEY on the server, so portal passwords can be stored sealed.']),
    ...(portal?.missing ?? []),
  ];

  const out = branches.map((b): BranchReadiness => {
    const c = byBranch.get(b.id);
    const provider = c && c.status !== 'not_configured' ? c.provider : 'fake';
    const real = provider !== 'fake';

    const details: string[] = [];
    if (!b.gstin) details.push('Add the GSTIN to this registration.');
    else if (!isValidGstin(b.gstin)) details.push(`The GSTIN ${b.gstin} fails its checksum — correct it.`);
    if (!b.city) details.push('Add the city.');
    if (!b.pincode) details.push('Add the six-digit PIN code.');

    const credentials: string[] = [];
    if (!c?.sealed || !real) {
      credentials.push(
        'Create an API user for this GSTIN on the e-invoice portal, then enter it in Settings → Integrations with "Submit through" set to the NIC e-invoice API.',
      );
    } else if (c.status === 'disabled') {
      credentials.push('The connection is disabled. Re-enable it in Settings → Integrations.');
    } else if (c.gstin && b.gstin && c.gstin !== b.gstin) {
      credentials.push(`The stored API user was created for ${c.gstin}, but this registration is now ${b.gstin}. Enter it again.`);
    }

    const verified = real && c?.status === 'verified';
    const login = verified
      ? []
      : [c?.status === 'failed' && c.last_error ? `The last login test failed: ${c.last_error}` : 'Press Test connection in Settings → Integrations.'];

    const realIrns = irnsByBranch.get(b.id) ?? 0;
    const steps: ReadinessStep[] = [
      { key: 'server', done: serverTodo.length === 0, todo: serverTodo },
      { key: 'details', done: details.length === 0, todo: details },
      { key: 'credentials', done: credentials.length === 0, todo: credentials },
      { key: 'login', done: login.length === 0, todo: login },
      {
        key: 'first_irn',
        done: realIrns > 0,
        todo: realIrns > 0 ? [] : ['Register one invoice from this registration and check its IRN and QR code on the printed invoice.'],
      },
    ];

    return {
      branchId: String(b.id),
      name: b.name,
      gstin: b.gstin,
      provider,
      providerLabel: providerLabel(provider),
      environment: environmentOf(provider),
      steps,
      realIrns,
      lastVerifiedAt: c?.last_verified_at ? new Date(c.last_verified_at).toISOString() : null,
      lastError: c?.last_error ?? null,
    };
  });

  const ready = out.filter((b) => b.steps.every((s) => s.done));
  return {
    connected: ready.length > 0,
    filing: ready.some((b) => b.environment === 'production'),
    branches: out,
  };
}
