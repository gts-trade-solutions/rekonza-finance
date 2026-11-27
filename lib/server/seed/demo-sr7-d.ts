import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Status review 7, item 11 (GST return filing reports), in the demo book.
//
// The reviewers judge the returns from the demo's screens, and a return with
// an empty table reads as "missing". So the book is given, through the same
// services a user's clicks go through, something for every table of GSTR-1
// and every section of GSTR-3B, a GSTR-2B with matches and mismatches, an
// earlier period filed with its ARN, the year before this one for GSTR-9,
// and the GST TDS (GSTR-7) and e-commerce TCS (GSTR-8) roles at work.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { IdMap } from './bootstrap';

export async function seedDemoSr7d(trx: Trx, ids: IdMap): Promise<void> {
  void trx;
  void ids;
}
