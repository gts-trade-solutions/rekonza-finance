import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail's hash chain: proof that no row was changed or removed.
//
// Rule 3(1) of the Companies (Accounts) Rules, 2014 (the proviso in force from
// 1 April 2023) requires accounting software to record an audit trail of every
// transaction, with an edit log of each change and the date it was made, and
// to ensure the audit trail "cannot be disabled". Rule 11(g) of the Companies
// (Audit and Auditors) Rules, 2014 then asks the auditor to report whether it
// operated throughout the year and "has not been tampered with". The first is
// met by how the trail is written (lib/server/audit.ts only inserts, and the
// database refuses updates and deletes once db/protect is installed). This
// gives the auditor a way to check the second for themselves.
//
// Each row, once sealed, gets a SHA-256 over its own content and the hash of
// the row sealed before it, kept in audit_chain beside it. Change a row behind
// the application's back — a direct UPDATE by someone with database access —
// and its hash no longer matches; delete one, and the link that pointed at it
// leads nowhere; delete a link too, and the next link's "previous hash" no
// longer agrees. Verify integrity walks the whole chain and says exactly where.
//
// Rows are sealed in the order they are found, not the order of their ids: an
// id is handed out when a transaction starts writing, and a long transaction
// can commit after a later one. Sealing by id would then leave the earlier row
// outside the chain for ever and report it as inserted behind our back. So a
// seal takes every row not yet in the chain, whatever its id.
//
// Sealing happens when the trail is opened, exported or verified, and when the
// scheduler runs; the chain's head (its last hash and length) is shown on the
// screen, so an auditor can note it and see later that nothing was cut from the
// end either.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { db, transaction, type Executor, type Trx } from './db';

const GENESIS = '0'.repeat(64);
const BATCH = 2_000;

interface Raw {
  id: number; org_id: number; actor_user_id: number | null; actor_name: string | null; action: string;
  target_type: string | null; target_id: string | null; target_label: string | null; detail: string | null;
  reason: string | null; payload: string | null; ip: string | null; user_agent: string | null; at_ms: string | number;
}

/**
 * Every column of a row, in a fixed order, as one string. The time is the
 * stored instant in milliseconds and the payload is MySQL's own JSON text, so
 * neither the server's time zone nor the driver's parsing can change it.
 */
function canonical(r: Raw): string {
  return JSON.stringify([
    Number(r.id), Number(r.org_id), r.actor_user_id === null ? null : Number(r.actor_user_id), r.actor_name, r.action,
    r.target_type, r.target_id, r.target_label, r.detail, r.reason, r.payload, r.ip, r.user_agent, Number(r.at_ms),
  ]);
}

export const linkHash = (prev: string, r: Raw) => createHash('sha256').update(`${prev}\n${canonical(r)}`).digest('hex');

const ROW = sql`a.id, a.org_id, a.actor_user_id, a.actor_name, a.action, a.target_type, a.target_id, a.target_label,
  a.detail, a.reason, CAST(a.payload AS CHAR) AS payload, a.ip, a.user_agent,
  CAST(ROUND(UNIX_TIMESTAMP(a.created_at) * 1000) AS UNSIGNED) AS at_ms`;

async function headFor(trx: Trx, orgId: number) {
  await sql`INSERT IGNORE INTO audit_chain_heads (org_id, last_seq, last_hash, max_audit_id) VALUES (${orgId}, 0, ${GENESIS}, 0)`.execute(trx);
  return trx.selectFrom('audit_chain_heads').selectAll().where('org_id', '=', orgId).forUpdate().executeTakeFirstOrThrow();
}

/**
 * Seal every row of the company's trail not yet in the chain. `full` also
 * looks below the highest id sealed, for a row whose transaction committed
 * late; without it only newer rows are read, which is what an ordinary page
 * load needs. Returns how many rows were sealed.
 */
export async function sealAuditChain(orgId: number, opts: { full?: boolean; trx?: Trx; max?: number } = {}): Promise<number> {
  const run = async (trx: Trx) => {
    const head = await headFor(trx, orgId);
    let seq = Number(head.last_seq);
    let prev = head.last_hash;
    let maxId = Number(head.max_audit_id);
    let sealed = 0;
    const limit = opts.max ?? Number.MAX_SAFE_INTEGER;
    for (;;) {
      const take = Math.min(BATCH, limit - sealed);
      if (take <= 0) break;
      const below = opts.full ? sql`` : sql`AND a.id > ${maxId}`;
      const { rows } = await sql<Raw>`
        SELECT ${ROW} FROM audit_log a
          LEFT JOIN audit_chain c ON c.audit_id = a.id
         WHERE a.org_id = ${orgId} ${below} AND c.id IS NULL
         ORDER BY a.id LIMIT ${take}`.execute(trx);
      if (!rows.length) break;
      const values = rows.map((r) => {
        seq += 1;
        const h = linkHash(prev, r);
        const v = { org_id: orgId, seq, audit_id: Number(r.id), prev_hash: prev, row_hash: h };
        prev = h;
        if (Number(r.id) > maxId) maxId = Number(r.id);
        return v;
      });
      await trx.insertInto('audit_chain').values(values).execute();
      sealed += rows.length;
      if (rows.length < take) break;
    }
    if (sealed) {
      await trx.updateTable('audit_chain_heads').set({ last_seq: seq, last_hash: prev, max_audit_id: maxId }).where('org_id', '=', orgId).execute();
    }
    return sealed;
  };
  return opts.trx ? run(opts.trx) : transaction(run);
}

/** Seal in the background after a write; never the reason a request fails. */
export function sealSoon(orgId: number) {
  void sealAuditChain(orgId, { max: 5_000 }).catch((err) => console.error('[audit-chain] seal failed', orgId, err instanceof Error ? err.message : err));
}

export interface ChainProblem {
  seq: number;
  auditId: number;
  /** changed: the row's content no longer matches its seal; missing: the row is gone; broken: a link was removed or rewritten. */
  kind: 'changed' | 'missing' | 'broken';
  detail: string;
}

export interface ChainStatus {
  ok: boolean;
  /** Rows in the chain, and rows checked. */
  sealed: number;
  checked: number;
  /** Rows of the trail outside the chain (should be none after a full seal). */
  unsealed: number;
  problems: ChainProblem[];
  /** The chain's last hash and length: noted by an auditor, it shows nothing was cut from the end later. */
  headHash: string;
  headSeq: number;
  verifiedAt: string;
}

/**
 * Seal what is outstanding, then walk the whole chain from the first link and
 * recompute every hash. Reports each row whose content changed, each link
 * whose row is gone, and each place the links themselves were tampered with.
 */
export async function verifyAuditChain(orgId: number, opts: { trx?: Trx } = {}): Promise<ChainStatus> {
  await sealAuditChain(orgId, { full: true, trx: opts.trx });
  const ex: Executor = opts.trx ?? db;
  const problems: ChainProblem[] = [];
  let prev = GENESIS;
  let expectSeq = 1;
  let checked = 0;
  let after = 0;
  for (;;) {
    const { rows } = await sql<{ seq: number; audit_id: number; prev_hash: string; row_hash: string } & Partial<Raw> & { present: number | null }>`
      SELECT c.seq, c.audit_id, c.prev_hash, c.row_hash, a.id AS present, ${ROW}
        FROM audit_chain c
        LEFT JOIN audit_log a ON a.id = c.audit_id
       WHERE c.org_id = ${orgId} AND c.seq > ${after}
       ORDER BY c.seq LIMIT ${BATCH}`.execute(ex);
    if (!rows.length) break;
    for (const c of rows) {
      const seq = Number(c.seq);
      if (seq !== expectSeq) {
        problems.push({ seq: expectSeq, auditId: 0, kind: 'broken', detail: `Links ${expectSeq} to ${seq - 1} of the chain are missing: rows of the trail and their seals were removed.` });
      }
      if (c.prev_hash !== prev) {
        problems.push({ seq, auditId: Number(c.audit_id), kind: 'broken', detail: `Link ${seq} does not follow from the link before it: the chain was rewritten here.` });
      }
      if (!c.present) {
        problems.push({ seq, auditId: Number(c.audit_id), kind: 'missing', detail: `Audit row ${c.audit_id}, sealed as link ${seq}, has been deleted.` });
      } else if (linkHash(c.prev_hash, c as unknown as Raw) !== c.row_hash) {
        problems.push({ seq, auditId: Number(c.audit_id), kind: 'changed', detail: `Audit row ${c.audit_id} (${c.action ?? ''} ${c.target_type ?? ''} ${c.target_label ?? ''}) was changed after it was recorded.`.replace(/\s+/g, ' ') });
      }
      prev = c.row_hash;
      expectSeq = seq + 1;
      after = seq;
      checked++;
    }
    if (rows.length < BATCH) break;
  }
  const head = await ex.selectFrom('audit_chain_heads').selectAll().where('org_id', '=', orgId).executeTakeFirst();
  if (head && Number(head.last_seq) !== checked && Number(head.last_seq) > after) {
    problems.push({ seq: after + 1, auditId: 0, kind: 'broken', detail: `The chain should have ${head.last_seq} links but ends at ${after}: the latest rows and their seals were removed.` });
  }
  const { rows: un } = await sql<{ n: string }>`
    SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN audit_chain c ON c.audit_id = a.id WHERE a.org_id = ${orgId} AND c.id IS NULL`.execute(ex);
  const status: ChainStatus = {
    ok: problems.length === 0, sealed: Number(head?.last_seq ?? checked), checked, unsealed: Number(un[0]?.n ?? 0),
    problems: problems.slice(0, 200), headHash: head?.last_hash ?? GENESIS, headSeq: Number(head?.last_seq ?? 0), verifiedAt: new Date().toISOString(),
  };
  await (opts.trx ?? db).updateTable('audit_chain_heads').set({ verified_at: new Date(), verified_ok: status.ok ? 1 : 0 }).where('org_id', '=', orgId).execute();
  return status;
}

/** The chain's head and when it was last verified, for the screen's banner. */
export async function chainHead(ex: Executor, orgId: number) {
  const head = await ex.selectFrom('audit_chain_heads').selectAll().where('org_id', '=', orgId).executeTakeFirst();
  return head ? {
    headHash: head.last_hash, headSeq: Number(head.last_seq),
    verifiedAt: head.verified_at ? new Date(head.verified_at).toISOString() : null,
    verifiedOk: head.verified_ok === null ? null : !!head.verified_ok,
  } : { headHash: GENESIS, headSeq: 0, verifiedAt: null, verifiedOk: null };
}

/** For the scheduler: seal every company's new rows, so the chain keeps up even when nobody opens the trail. */
export async function sealAllAuditChains(): Promise<number> {
  const { rows } = await sql<{ org_id: number }>`
    SELECT a.org_id FROM audit_log a LEFT JOIN audit_chain_heads h ON h.org_id = a.org_id
     WHERE a.id > COALESCE(h.max_audit_id, 0) GROUP BY a.org_id`.execute(db);
  let sealed = 0;
  for (const r of rows) sealed += await sealAuditChain(Number(r.org_id), { max: 50_000 }).catch(() => 0);
  return sealed;
}
