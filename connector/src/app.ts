// ─────────────────────────────────────────────────────────────────────────────
// The connector as the customer runs it: double-clicked, and then left alone.
//
// It keeps three things going — a sync every few minutes, a look at Tally so
// the window can say what it sees, and the window itself. Closing the window
// does not stop it; that is the point of a background program, and the page
// says so.
//
// Every failure here is somebody else's ordinary day: Tally shut for the night,
// a laptop off the network, a connector disconnected in the portal. None of
// them stop the loop except the last, which cannot be retried into working.
// ─────────────────────────────────────────────────────────────────────────────

import os from 'node:os';
import { autostartEnabled, canAutostart, setAutostart } from './autostart';
import { configPath, loadConfig, saveConfig, type ConnectorConfig } from './config';
import { ConnectorOutdated, ConnectorUnpaired, pairWithPortal, portalLink } from './portal';
import { syncOnce } from './sync';
import { fetchRows, TallyUnavailable } from './tally-client';
import { requests } from './tally-requests';
import { openInBrowser, startUi, type AppStatus, type ConnectorApp } from './ui';

export const UI_PORT = 7865;
const LOOK_AT_TALLY_EVERY_MS = 20_000;

export async function runApp(version: string, options: { open?: boolean } = {}) {
  let config: ConnectorConfig = loadConfig();
  let syncing = false;
  let lastSync: AppStatus['lastSync'] = null;
  let nextSyncAt: Date | null = null;
  let autostart = await autostartEnabled();
  let tally: AppStatus['tally'] = { ok: false, message: 'Looking for TallyPrime…', companies: [] };

  const say = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

  // What the window reports about Tally, kept fresh whether or not a sync is due.
  const lookAtTally = async () => {
    try {
      const rows = await fetchRows(requests.companies(), {
        host: config.tallyHost, port: config.tallyPort, timeoutMs: 15_000,
      });
      const companies = rows.map((r) => r.name).filter((n): n is string => !!n);
      tally = companies.length
        ? { ok: true, message: '', companies }
        : { ok: false, message: 'TallyPrime is open, but no company is. Open your company in Tally.', companies: [] };
    } catch (err) {
      tally = {
        ok: false,
        companies: [],
        message: err instanceof TallyUnavailable
          ? 'TallyPrime is not answering. Open it, and check F1 Help → Settings → Connectivity is set to act as a server on port ' + config.tallyPort + '.'
          : (err as Error).message,
      };
    }
  };

  const sync = async (): Promise<void> => {
    if (syncing || !config.token || !config.portalUrl) return;
    syncing = true;
    try {
      const summary = await syncOnce({
        tally: { host: config.tallyHost, port: config.tallyPort },
        portal: portalLink(config.portalUrl, config.token),
        state: config.companies,
        machineName: os.hostname(),
        connectorVersion: version,
        log: say,
      });
      saveConfig(config);
      const failed = summary.companies.find((c) => c.error);
      // Short, because the Tally row above it already carries the long version.
      lastSync = {
        at: new Date().toISOString(),
        ok: !summary.tallyError && !failed,
        message: summary.tallyError
          ? 'Nothing to send: TallyPrime was not reachable.'
          : failed?.error ?? `${summary.companies.reduce((t, c) => t + c.vouchersSent, 0)} voucher(s) sent.`,
      };
    } catch (err) {
      if (err instanceof ConnectorUnpaired) {
        // The portal has let this PC go. Nothing to retry; ask to pair again.
        config = { ...config, token: null, organisation: null, companies: {} };
        saveConfig(config);
        lastSync = { at: new Date().toISOString(), ok: false, message: (err as Error).message };
      } else if (err instanceof ConnectorOutdated) {
        lastSync = { at: new Date().toISOString(), ok: false, message: (err as Error).message };
      } else {
        lastSync = { at: new Date().toISOString(), ok: false, message: (err as Error).message };
      }
      say(lastSync.message);
    } finally {
      syncing = false;
      nextSyncAt = new Date(Date.now() + config.everyMinutes * 60_000);
    }
  };

  const app: ConnectorApp = {
    status: () => ({
      paired: Boolean(config.token),
      organisation: config.organisation,
      portalUrl: config.portalUrl,
      machineName: os.hostname(),
      version,
      configPath: configPath(),
      tallyHost: config.tallyHost,
      tallyPort: config.tallyPort,
      tally,
      lastSync,
      syncing,
      nextSyncAt: nextSyncAt ? nextSyncAt.toISOString() : null,
      autostart,
      canAutostart: canAutostart(),
    }),

    pair: async ({ portalUrl, code }) => {
      const url = portalUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) throw new Error('The REKONZA address should start with https://');
      const paired = await pairWithPortal(url, {
        code: code.trim(), machineName: os.hostname(), connectorVersion: version,
      });
      config = { ...config, portalUrl: url, token: paired.token, organisation: paired.organisation, companies: {} };
      saveConfig(config);
      say(`Paired with ${paired.organisation}.`);
      // Straight into the first sync, so the window has something to show and
      // the portal's pairing dialog turns green while the person is still there.
      void sync();
    },

    syncNow: async () => {
      if (!config.token) throw new Error('This PC is not connected yet.');
      // Whatever happened is already on the screen, in the rows above the
      // button. Throwing would only print it a second time, in red.
      await sync();
    },

    unpair: async () => {
      config = { ...config, token: null, organisation: null, companies: {} };
      saveConfig(config);
      lastSync = null;
      say('Disconnected. Nothing more will be sent.');
    },

    setAutostart: async (on: boolean) => {
      await setAutostart(on);
      autostart = await autostartEnabled();
    },
  };

  const ui = await startUi(app, UI_PORT);
  say(`REKONZA Tally Connector ${version} — window at ${ui.url}`);
  if (options.open !== false) openInBrowser(ui.url);

  await lookAtTally();
  setInterval(() => void lookAtTally(), LOOK_AT_TALLY_EVERY_MS);

  if (config.token) void sync();
  setInterval(() => void sync(), Math.max(1, config.everyMinutes) * 60_000);

  // Nothing else to wait for: the timers and the window hold the process open.
  return ui;
}
