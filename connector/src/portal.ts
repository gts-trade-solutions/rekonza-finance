// ─────────────────────────────────────────────────────────────────────────────
// Talking to the portal.
//
// Outbound only, over HTTPS: the connector calls the portal, never the other
// way round, so nothing on the customer's network has to be opened. A dropped
// connection or a busy server is tried again a few times; a disconnected
// connector or one too old for the portal stops, with the reason, because
// retrying cannot fix either.
// ─────────────────────────────────────────────────────────────────────────────

import type { PairReply, SyncMessage } from '../../lib/tally/protocol';

/** The portal no longer accepts this connector: pair it again. */
export class ConnectorUnpaired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUnpaired';
  }
}

/** The portal speaks a newer protocol: update the connector. */
export class ConnectorOutdated extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorOutdated';
  }
}

/** Where sync messages go. The real one posts to the portal; a test can supply its own. */
export interface PortalLink {
  send<T = unknown>(message: SyncMessage): Promise<T>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(url: string, body: unknown, token: string | null, attempts = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      last = err;
      if (attempt < attempts) await pause(1500 * attempt * attempt);
      continue;
    }
    const text = await res.text();
    let json: { error?: string; code?: string; details?: unknown } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: a proxy's error page, or the wrong address.
    }
    if (res.ok) return json as T;
    if (res.status === 401) throw new ConnectorUnpaired(json.error ?? 'The portal refused this connector. Pair it again.');
    if (res.status === 426) throw new ConnectorOutdated(json.error ?? 'Update the connector.');
    if (res.status >= 500 || res.status === 429) {
      last = new Error(`The portal answered HTTP ${res.status}.`);
      if (attempt < attempts) await pause(1500 * attempt * attempt);
      continue;
    }
    const details = json.details ? ` ${JSON.stringify(json.details).slice(0, 600)}` : '';
    throw new Error(`${json.error ?? `The portal refused the request (HTTP ${res.status}).`}${details}`);
  }
  throw new Error(`Could not reach the portal at ${url}: ${(last as Error)?.message ?? 'no answer'}.`);
}

export async function pairWithPortal(portalUrl: string, input: { code: string; machineName: string; connectorVersion: string }): Promise<PairReply> {
  return request<PairReply>(`${portalUrl.replace(/\/+$/, '')}/api/tally/pair`, input, null, 2);
}

export function portalLink(portalUrl: string, token: string): PortalLink {
  const url = `${portalUrl.replace(/\/+$/, '')}/api/tally/sync`;
  return { send: <T>(message: SyncMessage) => request<T>(url, message, token) };
}
