// ─────────────────────────────────────────────────────────────────────────────
// What the connector remembers between runs.
//
// The portal's address, the token it was given when it paired, where Tally
// answers, and two dates per company — the last day balances and the voucher
// list were sent in full. Kept in the user's application data folder, readable
// only by the Windows account that paired it. The token is the only secret in
// it, and it opens nothing but this organisation's Tally sync.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CompanyState {
  /** The day balances were last sent in full. */
  mastersSentOn?: string;
  /** The day the complete voucher list was last compared, to notice deletions. */
  indexSentOn?: string;
}

export interface ConnectorConfig {
  portalUrl: string | null;
  token: string | null;
  organisation: string | null;
  tallyHost: string;
  tallyPort: number;
  /** Minutes between syncs when running continuously. */
  everyMinutes: number;
  companies: Record<string, CompanyState>;
}

export const DEFAULTS: ConnectorConfig = {
  portalUrl: null,
  token: null,
  organisation: null,
  tallyHost: 'localhost',
  tallyPort: 9000,
  everyMinutes: 5,
  companies: {},
};

export function configPath(): string {
  if (process.env.REKONZA_TALLY_CONFIG) return process.env.REKONZA_TALLY_CONFIG;
  const base = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  return path.join(base, 'REKONZA', 'tally-connector.json');
}

export function loadConfig(file = configPath()): ConnectorConfig {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ConnectorConfig>) };
  } catch {
    return { ...DEFAULTS, companies: {} };
  }
}

export function saveConfig(config: ConnectorConfig, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole to a temporary file first, so a crash mid-write cannot leave
  // a half-written config that loses the token.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
