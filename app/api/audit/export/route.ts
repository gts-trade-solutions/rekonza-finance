import { z } from 'zod';
import { route, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { AuditFilter, auditRows, changeText, changesIn, istStamp } from '@/lib/server/audit-query';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail as a file, for the auditor: every row the screen's filters
// find (not just the page on screen), newest first, times in Indian time, with
// the IP address and each field's old and new value. The screen turns the rows
// into CSV, XLS or XLSX (Zoho's export dialog), and the export itself is
// recorded in the trail.
// ─────────────────────────────────────────────────────────────────────────────

const MAX = 100_000;
const BATCH = 5_000;

export const GET = route(
  async ({ orgId, user, req }) => {
    const q = query(req, AuditFilter.extend({ pii: z.enum(['0', '1']).default('1') }));
    const withIp = q.pii === '1';
    const header = ['Date and time (IST)', 'User', 'Action', 'Record type', 'Record ID', 'Record', 'Detail', 'Reason', ...(withIp ? ['IP address'] : []), 'Fields changed (old → new)'];
    const rows: string[][] = [];
    // Newest first, in batches by (created_at, id), so a long trail is read in pieces, not all at once.
    let cursor: { at: Date; id: number } | null = null;
    for (;;) {
      let qb = auditRows(orgId, q)
        .select(['id', 'actor_name', 'action', 'target_type', 'target_id', 'target_label', 'detail', 'reason', 'ip', 'created_at', 'payload']);
      if (cursor) {
        const c: { at: Date; id: number } = cursor;
        qb = qb.where((eb) => eb.or([eb('created_at', '<', c.at), eb.and([eb('created_at', '=', c.at), eb('id', '<', c.id)])]));
      }
      const batch = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(BATCH).execute();
      for (const r of batch) {
        const at = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
        rows.push([
          istStamp(at), r.actor_name ?? 'System', r.action, (r.target_type ?? 'other').replace(/[_-]/g, ' '), r.target_id ?? '',
          r.target_label ?? '', r.detail ?? '', r.reason ?? '', ...(withIp ? [r.ip ?? ''] : []), changeText(changesIn(r.payload)),
        ]);
      }
      if (batch.length < BATCH || rows.length >= MAX) break;
      const last = batch[batch.length - 1];
      cursor = { at: last.created_at instanceof Date ? last.created_at : new Date(String(last.created_at)), id: Number(last.id) };
    }
    const truncated = rows.length >= MAX;
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: 'output', targetId: 'audit-trail',
      targetLabel: 'Audit trail',
      detail: `Exported the audit trail: ${rows.length} event${rows.length === 1 ? '' : 's'}${q.from || q.to ? ` from ${q.from ?? 'the start'} to ${q.to ?? 'today'}` : ''}`,
      ...auditMeta(req),
    });
    return { header, rows: rows.slice(0, MAX), truncated };
  },
  { permission: { module: 'accountant', action: 'export' } },
);
