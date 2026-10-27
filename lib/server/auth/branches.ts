import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Which branches a user may act in.
//
// A branch is a GST registration, and a user limited to one registration must
// not be able to raise an invoice under another just by putting its id in a
// request. Hiding the branch in the picker is a courtesy; this is the control.
//
//   * an admin acts in every active branch;
//   * anyone else acts in the branches granted in user_branches, or, with no
//     grants at all, in their home branch alone.
// ─────────────────────────────────────────────────────────────────────────────

import { db, type Executor } from '../db';

export async function allowedBranchIds(
  user: { userId: number; orgId: number; role: string; homeBranchId: number | null },
  ex: Executor = db,
): Promise<Set<number>> {
  const active = await ex.selectFrom('branches').select('id')
    .where('org_id', '=', user.orgId).where('is_active', '=', 1).execute();
  const all = new Set(active.map((b) => b.id));
  if (user.role === 'admin') return all;

  const grants = await ex.selectFrom('user_branches').select('branch_id')
    .where('user_id', '=', user.userId).execute();
  const ids = grants.length ? grants.map((g) => g.branch_id) : user.homeBranchId ? [user.homeBranchId] : [];
  return new Set(ids.filter((id) => all.has(id)));
}

/**
 * Pull a branch id out of a request, wherever a route would look for it: the
 * query string, or the top level of a JSON body. Null when it names none.
 */
export async function requestedBranchId(req: Request): Promise<number | null> {
  const fromQuery = new URL(req.url).searchParams.get('branchId');
  if (fromQuery) return Number(fromQuery) || null;
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const raw = (await req.clone().json()) as { branchId?: unknown } | null;
    const v = raw && typeof raw === 'object' ? raw.branchId : undefined;
    return typeof v === 'string' || typeof v === 'number' ? Number(v) || null : null;
  } catch {
    return null; // the handler reports a malformed body in its own words
  }
}
