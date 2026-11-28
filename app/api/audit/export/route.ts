import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { AuditFilter } from '@/lib/server/audit-query';
import { auditExportHeader, auditExportRows } from '@/lib/server/audit-export';
import { chainHead, sealAuditChain } from '@/lib/server/audit-chain';

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail as a file, for the auditor: every row the screen's filters
// find (not just the page on screen), built by lib/server/audit-export.ts. The
// screen turns the rows into CSV, XLS, XLSX or PDF and names the file after
// the company and the range; the filters come back in words for the file's
// heading, with the hash chain's head (audit-chain.ts) as it stood. The export
// itself is recorded in the trail, with the format and the filters it used.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId, user, req }) => {
    const q = query(req, AuditFilter.extend({ pii: z.enum(['0', '1']).default('1'), format: z.enum(['csv', 'xls', 'xlsx', 'pdf']).optional() }));
    const withIp = q.pii === '1';
    // Everything recorded up to now is in the chain before it is handed over.
    await sealAuditChain(orgId, { full: true }).catch(() => 0);
    const { rows, instants, truncated } = await auditExportRows(db, orgId, q, withIp);

    // What the file covers, in words, for its heading and the trail.
    const org = await db.selectFrom('organizations').select(['name', 'legal_name']).where('id', '=', orgId).executeTakeFirst();
    const actor = q.actorUserId ? await db.selectFrom('users').select('name').where('id', '=', Number(q.actorUserId)).where('org_id', '=', orgId).executeTakeFirst() : null;
    const filters = [
      `Period (IST): ${q.from ?? 'the start'} to ${q.to ?? 'today'}`,
      `User: ${actor?.name ?? (q.actorUserId ? `#${q.actorUserId}` : 'everyone')}`,
      `Action: ${q.action && q.action !== 'all' ? q.action : 'all actions'}`,
      `Record type: ${q.targetType && q.targetType !== 'all' ? q.targetType.replace(/[_-]/g, ' ') : 'all record types'}`,
      ...(q.search?.trim() ? [`Search: "${q.search.trim()}"`] : []),
      `IP addresses: ${withIp ? 'included' : 'left out'}`,
    ];
    const head = await chainHead(db, orgId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'export', targetType: 'output', targetId: 'audit-trail',
      targetLabel: 'Audit trail',
      detail: `Exported the audit trail${q.format ? ` as ${q.format.toUpperCase()}` : ''}: ${rows.length} event${rows.length === 1 ? '' : 's'}. ${filters.join('; ')}`.slice(0, 1000),
      ...auditMeta(req),
    });
    return {
      header: auditExportHeader(withIp), rows, instants, truncated,
      company: org?.legal_name ?? org?.name ?? 'Company', filters,
      chain: { headHash: head.headHash, headSeq: head.headSeq },
    };
  },
  { permission: { module: 'accountant', action: 'export' } },
);
