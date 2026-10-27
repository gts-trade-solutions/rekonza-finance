import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail.
//
// MCA Rule 11(g) requires accounting software used by Indian companies to keep
// an audit trail of every transaction, with no facility to disable it, retained
// for eight years. So there is deliberately no `disabled` flag here and no
// update or delete path anywhere in the codebase — this module only inserts.
//
// Writing an audit row must never be the reason a business action fails. If the
// insert throws, it is logged to the server console and the caller continues:
// losing one audit line is bad, refusing a customer's invoice because of it is
// worse. A caller that needs the guarantee passes its own transaction, and then
// the row lives or dies with the action it describes.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, type Executor } from './db';

export type AuditAction =
  | 'create' | 'update' | 'void' | 'approve' | 'send' | 'match' | 'login' | 'export' | 'import';

export interface AuditInput {
  orgId: number;
  actorUserId?: number | null;
  actorName?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | number | null;
  targetLabel?: string | null;
  detail?: string | null;
  payload?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  /** Pass a transaction to tie the audit row to the action it records. */
  trx?: Executor;
}

export async function logAudit(input: AuditInput): Promise<void> {
  const ex = input.trx ?? db;
  try {
    await ex
      .insertInto('audit_log')
      .values({
        org_id: input.orgId,
        actor_user_id: input.actorUserId ?? null,
        actor_name: input.actorName ?? null,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId != null ? String(input.targetId) : null,
        target_label: input.targetLabel ?? null,
        detail: input.detail ?? null,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        ip: input.ip ?? null,
        user_agent: input.userAgent?.slice(0, 500) ?? null,
      })
      .execute();
    await queueWebhook(ex, input);
  } catch (err) {
    // Only swallowed for fire-and-forget calls. Inside a caller's transaction
    // the error propagates, because there the row is part of the action.
    if (input.trx) throw err;
    console.error('[audit] failed to record', input.action, input.targetType, err);
  }
}

/**
 * The audit row is also the webhook event: invoice.created, payment.voided.
 * Queued in the same transaction; a failure here is logged, never the reason
 * the action fails.
 */
async function queueWebhook(ex: Executor, input: AuditInput) {
  if (!input.targetType) return;
  try {
    const { eventFor, queueEvent } = await import('./integrations/webhooks');
    const event = eventFor(input.action, input.targetType);
    if (!event) return;
    await queueEvent(ex, input.orgId, event, {
      type: input.targetType, id: input.targetId != null ? String(input.targetId) : null,
      label: input.targetLabel ?? null, detail: input.detail ?? null, actor: input.actorName ?? null,
    });
  } catch (err) {
    console.error('[webhooks] not queued', input.action, input.targetType, err);
  }
}

// ── Edit logs ────────────────────────────────────────────────────────────────
//
// Rule 3(1) of the Companies (Accounts) Rules asks for an edit log of each
// change: not that a customer was "updated", but that their GSTIN went from
// one value to another, when, and by whom. A master edit therefore snapshots
// the columns it is about to change, and the audit row carries both sides.

export type Changes = Record<string, { from: unknown; to: unknown }>;

/** Tables whose rows are edited in place, and so need an edit log. */
type Edited = 'contacts' | 'items' | 'accounts' | 'hsn_codes' | 'organizations' | 'branches' | 'bank_accounts' | 'fixed_assets';

/** The current values of the columns a patch is about to change. */
export async function snapshot(
  ex: Executor, table: Edited, orgId: number, id: number, columns: string[],
): Promise<Record<string, unknown>> {
  if (!columns.length) return {};
  const scope = table === 'organizations' ? sql`id = ${orgId}` : sql`id = ${id} AND org_id = ${orgId}`;
  const { rows } = await sql<Record<string, unknown>>`
    SELECT ${sql.join(columns.map((c) => sql.ref(c)))} FROM ${sql.table(table)} WHERE ${scope}
  `.execute(ex);
  return rows[0] ?? {};
}

const norm = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  // DECIMAL columns come back as '100.0000'; the patch may say '100' or '100.00'.
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
};

/** Only what actually moved — saving a form unchanged is not an edit. */
export function changesBetween(before: Record<string, unknown>, patch: Record<string, unknown>): Changes {
  const out: Changes = {};
  for (const [col, to] of Object.entries(patch)) {
    if (norm(before[col]) !== norm(to)) out[col] = { from: before[col] ?? null, to: to ?? null };
  }
  return out;
}

/** "name, gstin and state_code" — for the one-line detail. */
export function describeChanges(changes: Changes): string {
  const cols = Object.keys(changes);
  if (!cols.length) return 'no change';
  return cols.length === 1 ? cols[0] : `${cols.slice(0, -1).join(', ')} and ${cols[cols.length - 1]}`;
}

/** Request metadata worth recording alongside an action. */
export function auditMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: req.headers.get('user-agent'),
  };
}
