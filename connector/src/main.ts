// ─────────────────────────────────────────────────────────────────────────────
// The REKONZA Tally connector.
//
// Runs on the PC where TallyPrime runs, reads the open companies over Tally's
// data port, and sends them to the portal. It only reads Tally; it never
// writes to it.
//
//   rekonza-tally pair K7Q2-9MXP --portal https://books.example.in
//   rekonza-tally sync              one sync, then exit
//   rekonza-tally run               sync every few minutes until stopped
//   rekonza-tally status            where it sends, and whether Tally answers
//   rekonza-tally forget            unpair this PC
//
// Options: --tally-host localhost  --tally-port 9000  --every 5 (minutes)
// ─────────────────────────────────────────────────────────────────────────────

import os from 'node:os';
import { runApp } from './app';
import { configPath, loadConfig, saveConfig, type ConnectorConfig } from './config';
import { ConnectorOutdated, ConnectorUnpaired, pairWithPortal, portalLink } from './portal';
import { syncOnce, type SyncSummary } from './sync';
import { fetchRows, TallyUnavailable } from './tally-client';
import { requests } from './tally-requests';

export const CONNECTOR_VERSION = '0.1.0';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function option(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? (args[i + 1] ?? null) : null;
}

const stamp = () => new Date().toLocaleTimeString('en-IN', { hour12: false });
const say = (line: string) => console.log(`[${stamp()}] ${line}`);

function withOptions(config: ConnectorConfig): ConnectorConfig {
  const host = option('tally-host');
  const port = option('tally-port');
  const every = option('every');
  return {
    ...config,
    tallyHost: host ?? config.tallyHost,
    tallyPort: port ? Number(port) : config.tallyPort,
    everyMinutes: every ? Math.max(1, Number(every)) : config.everyMinutes,
  };
}

function report(s: SyncSummary) {
  if (s.tallyError) say(s.tallyError);
  for (const c of s.companies) {
    const parts = [
      `${c.vouchersSent} voucher(s)`,
      c.mastersSent ? 'balances sent' : 'balances unchanged',
      c.deletions ? `${c.deletions} deletion(s)` : null,
      c.vouchersRejected.length ? `${c.vouchersRejected.length} refused` : null,
    ].filter(Boolean);
    say(`${c.name}: ${c.error ? `failed — ${c.error}` : parts.join(', ')}`);
    for (const r of c.vouchersRejected.slice(0, 5)) say(`  refused ${r.guid}: ${r.reason}`);
  }
}

async function runSync(config: ConnectorConfig): Promise<SyncSummary> {
  if (!config.token || !config.portalUrl) throw new ConnectorUnpaired('This PC is not paired. Run: rekonza-tally pair <CODE> --portal <address>');
  const summary = await syncOnce({
    tally: { host: config.tallyHost, port: config.tallyPort },
    portal: portalLink(config.portalUrl, config.token),
    state: config.companies,
    machineName: os.hostname(),
    connectorVersion: CONNECTOR_VERSION,
    log: say,
  });
  saveConfig(config);
  return summary;
}

async function main() {
  const config = withOptions(loadConfig());

  switch (command) {
    // Double-clicked, or started by Windows: the window and the loop, with no
    // command to type. Everything below stays for a terminal and for support.
    case 'help':
    case 'app': {
      await runApp(CONNECTOR_VERSION, { open: !args.includes('--no-window') });
      await new Promise(() => {});
      return;
    }

    case 'pair': {
      const code = args[1];
      const portalUrl = option('portal') ?? process.env.REKONZA_PORTAL_URL ?? config.portalUrl;
      if (!code || !portalUrl) {
        console.error('Usage: rekonza-tally pair <CODE> --portal <portal address>');
        process.exit(2);
      }
      const paired = await pairWithPortal(portalUrl, { code, machineName: os.hostname(), connectorVersion: CONNECTOR_VERSION });
      saveConfig({ ...config, portalUrl, token: paired.token, organisation: paired.organisation, companies: {} });
      say(`Paired with ${paired.organisation}. Run "rekonza-tally run" to keep it in sync.`);
      return;
    }

    case 'sync': {
      const s = await runSync(config);
      report(s);
      process.exit(s.tallyError || s.companies.some((c) => c.error) ? 1 : 0);
    }

    case 'run': {
      say(`Syncing ${config.organisation ?? 'the portal'} every ${config.everyMinutes} minute(s). Press Ctrl+C to stop.`);
      for (;;) {
        try {
          report(await runSync(config));
        } catch (err) {
          if (err instanceof ConnectorUnpaired || err instanceof ConnectorOutdated) {
            say((err as Error).message);
            process.exit(err instanceof ConnectorUnpaired ? 2 : 3);
          }
          say(`Sync failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, config.everyMinutes * 60_000));
      }
    }

    case 'status': {
      say(`Config: ${configPath()}`);
      say(`Portal: ${config.portalUrl ?? 'not set'} · ${config.token ? `paired with ${config.organisation}` : 'not paired'}`);
      try {
        const companies = await fetchRows(requests.companies(), { host: config.tallyHost, port: config.tallyPort, timeoutMs: 15_000 });
        say(`TallyPrime on ${config.tallyHost}:${config.tallyPort}: ${companies.length} open compan${companies.length === 1 ? 'y' : 'ies'}`);
        for (const c of companies) say(`  ${c.name} (books from ${c.booksFrom ?? '?'})`);
      } catch (err) {
        say(err instanceof TallyUnavailable ? err.message : `TallyPrime answered with an error: ${(err as Error).message}`);
      }
      return;
    }

    case 'forget': {
      saveConfig({ ...config, token: null, organisation: null, companies: {} });
      say('This PC is no longer paired. Disconnect it in the portal as well, under Tally.');
      return;
    }

    default:
      console.log('Usage: rekonza-tally [app | pair CODE --portal URL | sync | run | status | forget] [--tally-host H] [--tally-port P] [--every MIN]');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error((err as Error).message);
    process.exit(err instanceof ConnectorUnpaired ? 2 : err instanceof ConnectorOutdated ? 3 : 1);
  });
