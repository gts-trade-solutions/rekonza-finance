import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail's rows for a file (GET /api/audit/export): every row the
// screen's filters find, newest first, in batches by (created_at, id) so a
// trail of 50,000 or 200,000 events is read in pieces rather than one query
// that holds the table; times in Indian time; the IP address when asked for;
// each field's old and new value; and for a deletion, what was deleted — its
// number, date, party and amount, as deleted_documents kept them when it went
// (Companies (Accounts) Rules, rule 3(1): the edit log must show what changed,
// and a deletion is the largest change there is).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from './db';
import { auditRows, changeText, changesIn, istStamp, typeKey, type AuditFilterInput } from './audit-query';
import { toPaiseFromSql } from './money-sql';

export const AUDIT_EXPORT_MAX = 200_000;
const BATCH = 10_000;

/** A deleted document's type as the trail names it, where deleted_documents names it otherwise. */
const DELETED_TYPE: Record<string, string> = { journal_entry: 'journal' };

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function auditExportHeader(withIp: boolean): string[] {
  return ['Date and time (IST)', 'User', 'Action', 'Record type', 'Record ID', 'Record', 'Detail', 'Reason', ...(withIp ? ['IP address'] : []), 'Fields changed (old → new)', 'What was deleted'];
}

export async function auditExportRows(ex: Executor, orgId: number, q: AuditFilterInput, withIp: boolean, max = AUDIT_EXPORT_MAX) {
  const rows: string[][] = [];
  /** Each row's instant, so a spreadsheet can carry it as a real date and time. */
  const instants: string[] = [];
  let cursor: { at: Date; id: number } | null = null;
  for (;;) {
    let qb = auditRows(orgId, q, ex)
      .select(['id', 'actor_name', 'action', 'target_type', 'target_id', 'target_label', 'detail', 'reason', 'ip', 'created_at', 'payload']);
    if (cursor) {
      const c: { at: Date; id: number } = cursor;
      qb = qb.where((eb) => eb.or([eb('created_at', '<', c.at), eb.and([eb('created_at', '=', c.at), eb('id', '<', c.id)])]));
    }
    const batch = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(BATCH).execute();
    const deletions = batch.filter((r) => r.action === 'delete' && r.target_id && /^\d+$/.test(r.target_id));
    const gone = new Map<string, string>();
    if (deletions.length) {
      const { rows: dd } = await sql<{ doc_type: string; doc_id: number; number: string | null; doc_date: string | null; total: string | null; reason: string | null; party: string | null }>`
        SELECT d.doc_type, d.doc_id, d.number, DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS doc_date, d.total, d.reason, c.display_name AS party
          FROM deleted_documents d LEFT JOIN contacts c ON c.id = d.contact_id
         WHERE d.org_id = ${orgId} AND d.doc_id IN (${sql.join([...new Set(deletions.map((r) => Number(r.target_id)))])})`.execute(ex);
      for (const d of dd) {
        gone.set(`${d.doc_type}:${d.doc_id}`, [
          d.number ? `${d.number}` : `#${d.doc_id}`,
          d.doc_date ? `dated ${d.doc_date}` : '',
          d.party ? `party ${d.party}` : '',
          d.total !== null ? `amount ${rupees(toPaiseFromSql(d.total))}` : '',
          d.reason ? `reason given: ${d.reason}` : '',
        ].filter(Boolean).join(', '));
      }
    }
    for (const r of batch) {
      const at = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
      const type = r.target_type ?? 'other';
      // "credit-note" in the trail is "credit_note" in deleted_documents.
      const deleted = r.action === 'delete' ? gone.get(`${DELETED_TYPE[typeKey(type)] ?? typeKey(type)}:${r.target_id}`) ?? gone.get(`${type}:${r.target_id}`) ?? '' : '';
      instants.push(at.toISOString());
      rows.push([
        istStamp(at), r.actor_name ?? 'System', r.action, type.replace(/[_-]/g, ' '), r.target_id ?? '',
        r.target_label ?? '', r.detail ?? '', r.reason ?? '', ...(withIp ? [r.ip ?? ''] : []), changeText(changesIn(r.payload)), deleted,
      ]);
    }
    if (batch.length < BATCH || rows.length >= max) break;
    const last = batch[batch.length - 1];
    cursor = { at: last.created_at instanceof Date ? last.created_at : new Date(String(last.created_at)), id: Number(last.id) };
  }
  return { rows: rows.slice(0, max), instants: instants.slice(0, max), truncated: rows.length >= max };
}
