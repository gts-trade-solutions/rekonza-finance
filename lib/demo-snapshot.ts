// ─────────────────────────────────────────────────────────────────────────────
// The online demo, without a database.
//
// A deployment with no database behind it — a Vercel link someone only wants
// to click through — answers /api from a recording of the demo book rather
// than failing on every screen. scripts/demo-snapshot.ts makes the recording
// from a running copy; middleware.ts plays it back. It is reads only: anything
// that would save is refused with a message that says so, since there is
// nowhere to save it.
// ─────────────────────────────────────────────────────────────────────────────

/** Under public/, so the recorded replies are served as plain files. */
export const SNAPSHOT_DIR = 'demo-snapshot';

export interface SnapshotManifest {
  recordedAt: string;
  /** For each API path, the queries it was recorded with and the file holding each reply. */
  routes: Record<string, [query: string, file: string][]>;
}

export const DEMO_READ_ONLY =
  'This is the online demo: it shows a sample company, and saving is switched off. Nothing you enter here is kept.';

/**
 * Whether this deployment plays the recording. DEMO_SNAPSHOT=1 or 0 decides
 * outright; otherwise a Vercel deployment with no database configured does,
 * since without one every screen would only say the database is unreachable.
 */
export function snapshotMode(): boolean {
  const flag = process.env.DEMO_SNAPSHOT;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  const host = process.env.DB_HOST;
  return !!process.env.VERCEL && !process.env.DATABASE_URL && (!host || host === 'localhost' || host === '127.0.0.1');
}

/** A query in a fixed order, so the same view always has the same key. */
export function snapshotQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** A value that may differ from the recorded one and still mean the same view: a date, a period, a count. */
const looseValue = (v: string) => /^-?\d+(\.\d+)?$/.test(v) || /^\d{4}(-\d{2}){0,2}$/.test(v);

function pairs(query: string): Map<string, string> {
  return new Map(query ? query.split('&').map((p) => p.split('=') as [string, string]) : []);
}

/**
 * The recorded reply for a request: the one with the same query, else the one
 * sharing most of it (a report asked for a day later than it was recorded),
 * else the plainest. A recording that names a different report, view or
 * status never stands in, since it would be another screen's figures. Null
 * when nothing fits.
 */
export function pickRecording(variants: [string, string][] | undefined, query: string): string | null {
  if (!variants?.length) return null;
  const exact = variants.find(([q]) => q === query);
  if (exact) return exact[1];
  const wanted = pairs(query);
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [q, file] of variants) {
    const have = pairs(q);
    let shared = 0;
    let fits = true;
    for (const [k, v] of have) {
      const w = wanted.get(k);
      if (w === v) shared++;
      else if (w !== undefined && !(looseValue(w) && looseValue(v))) fits = false;
    }
    const score = shared * 100 - have.size;
    if (fits && score > bestScore) {
      best = file;
      bestScore = score;
    }
  }
  return best;
}
