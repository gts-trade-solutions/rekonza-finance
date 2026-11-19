import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail's filters, shared by the screen (GET /api/audit) and the
// export (GET /api/audit/export), so what is exported is exactly what was
// filtered on screen.
//
// Days are Indian days. A date range "15 Nov to 15 Nov" means midnight to
// midnight in India, whatever timezone the server runs in: the instants are
// built with +05:30, and the driver turns them into the database's own time.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { db } from './db';

export const AuditFilter = z.object({
  targetType: z.string().optional(),
  action: z.string().optional(),
  actorUserId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  search: z.string().max(200).optional(),
});
export type AuditFilterInput = z.infer<typeof AuditFilter>;

/** The start and the end of an Indian day, as instants. */
export const istStart = (day: string) => new Date(`${day}T00:00:00.000+05:30`);
export const istEnd = (day: string) => new Date(`${day}T23:59:59.999+05:30`);

export function auditRows(orgId: number, q: AuditFilterInput) {
  let base = db.selectFrom('audit_log').where('org_id', '=', orgId);
  if (q.targetType && q.targetType !== 'all') base = base.where('target_type', '=', q.targetType);
  if (q.action && q.action !== 'all') base = base.where('action', '=', q.action);
  if (q.actorUserId) base = base.where('actor_user_id', '=', Number(q.actorUserId));
  if (q.from) base = base.where('created_at', '>=', istStart(q.from));
  // Inclusive of the end date, so a single-day filter shows that whole day.
  if (q.to) base = base.where('created_at', '<=', istEnd(q.to));
  if (q.search?.trim()) {
    const term = `%${q.search.trim()}%`;
    base = base.where((eb) => eb.or([
      eb('actor_name', 'like', term), eb('target_label', 'like', term), eb('detail', 'like', term), eb('reason', 'like', term),
      eb('ip', 'like', term), eb('target_id', 'like', term),
    ]));
  }
  return base;
}

/** The edit log an update carries, if it carries one. */
export function changesIn(payload: unknown): Record<string, { from: unknown; to: unknown }> | null {
  let p: unknown = payload;
  if (typeof payload === 'string') {
    try { p = JSON.parse(payload); } catch { p = null; }
  }
  const c = p && typeof p === 'object' ? (p as { changes?: unknown }).changes : null;
  return c && typeof c === 'object' && Object.keys(c).length ? (c as Record<string, { from: unknown; to: unknown }>) : null;
}

/** "19 Nov 2026, 10:04:31": an instant in Indian time, as the auditor reads it. */
export function istStamp(at: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}

const value = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** One change list as one cell: "rate: 450 → 500; gst rate: 18 → 28". */
export const changeText = (c: Record<string, { from: unknown; to: unknown }> | null) =>
  c ? Object.entries(c).map(([f, x]) => `${f.replace(/_/g, ' ')}: ${value(x.from)} → ${value(x.to)}`).join('; ') : '';
