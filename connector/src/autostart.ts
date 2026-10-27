// ─────────────────────────────────────────────────────────────────────────────
// Starting with Windows.
//
// The connector is useful only while it runs, and nobody remembers to start it
// after a reboot — so it offers to start itself. That is one value under the
// current user's Run key: no service, no administrator rights, and the person
// who switched it on can switch it off from the same screen or from Task
// Manager's Startup tab, which is where they will look.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'REKONZA Tally Connector';

/** How Windows should start it: the packaged exe, or node running this script. */
function command(): string {
  // A packaged build is one file and launches itself; a development run needs
  // the runtime and the script it was started with.
  const exe = process.execPath;
  const packaged = !/node(\.exe)?$/i.test(exe);
  return packaged ? `"${exe}"` : `"${exe}" "${process.argv[1] ?? ''}"`;
}

export const canAutostart = () => process.platform === 'win32';

export async function autostartEnabled(): Promise<boolean> {
  if (!canAutostart()) return false;
  try {
    const { stdout } = await run('reg', ['query', KEY, '/v', NAME]);
    return stdout.includes(NAME);
  } catch {
    // Absent from the key: reg exits non-zero, which is the answer, not a fault.
    return false;
  }
}

export async function setAutostart(on: boolean): Promise<void> {
  if (!canAutostart()) return;
  if (on) await run('reg', ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', command(), '/f']);
  else await run('reg', ['delete', KEY, '/v', NAME, '/f']).catch(() => {});
}
