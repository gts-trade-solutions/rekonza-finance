import { route } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { verifyAuditChain } from '@/lib/server/audit-chain';

// ─────────────────────────────────────────────────────────────────────────────
// Verify integrity: seal whatever is outstanding, then recompute every link of
// the audit trail's hash chain (lib/server/audit-chain.ts) and report any row
// changed or removed behind the application's back. Open to anyone who may
// read the trail, the auditor above all (Companies (Audit and Auditors) Rules,
// rule 11(g): whether the audit trail "has been tampered with"). It changes
// no record; it adds one: that the check was run, and what it found.
// ─────────────────────────────────────────────────────────────────────────────

// A GET as well, so the online demo (which replays recorded GETs) can run the check too.
export const POST = route(
  async ({ orgId, user, req }) => {
    const status = await verifyAuditChain(orgId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'verify', targetType: 'output', targetId: 'audit-trail',
      targetLabel: 'Audit trail integrity',
      detail: status.ok
        ? `Verified the audit trail: all ${status.checked} sealed events are unchanged (chain head ${status.headHash.slice(0, 16)}…, ${status.headSeq} links)`
        : `Verified the audit trail: ${status.problems.length} problem(s) found — ${status.problems.slice(0, 3).map((p) => p.detail).join(' ')}`.slice(0, 1000),
      ...auditMeta(req),
    });
    return status;
  },
  { permission: { module: 'accountant', action: 'view' } },
);

export const GET = POST;
