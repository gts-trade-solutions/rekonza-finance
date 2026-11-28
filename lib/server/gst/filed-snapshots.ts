import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// What a return said, kept as it is marked filed (gst_filed_documents).
//
// However the mark is made — the filing bar on a return, the compliance
// calendar, the return status grid, or a filing through a GSP — the return's
// documents are kept as they stood, so that a document of a filed period
// changed afterwards is reported as an amendment in a later return and the
// screens can say the books no longer match what was filed.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { snapshotGstr1 } from './gstr1-amendments';
import { snapshotGstr7 } from './gstr7';
import { snapshotGstr8 } from './gstr8';

/** The return_type the snapshot rows are kept under, by compliance item key. */
const SNAPSHOT_TYPE: Record<string, string> = { gstr1: 'GSTR1', iff: 'GSTR1', gstr7: 'GSTR7', gstr8: 'GSTR8' };

/** Keep the return's documents as filed. Returns how many were kept (0 where a return has none). */
export async function snapshotReturn(trx: Trx, orgId: number, key: string, period: string): Promise<number> {
  if (!/^\d{4}-\d{2}$/.test(period)) return 0;
  switch (key) {
    case 'gstr1': return snapshotGstr1(trx, orgId, period, 'gstr1');
    case 'iff': return snapshotGstr1(trx, orgId, period, 'iff');
    case 'gstr7': return snapshotGstr7(trx, orgId, period);
    case 'gstr8': return snapshotGstr8(trx, orgId, period);
    default: return 0;
  }
}

/** The filed mark taken off: the documents are no longer "as filed" for that period. */
export async function dropSnapshot(trx: Trx, orgId: number, key: string, period: string): Promise<void> {
  const type = SNAPSHOT_TYPE[key];
  if (!type) return;
  await trx.deleteFrom('gst_filed_documents').where('org_id', '=', orgId).where('return_type', '=', type).where('period', '=', period).execute();
}
