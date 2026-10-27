'use client';

// Where a document stands with maker and checker, and the next step.
//
// Shown only when a rule catches the document. The maker submits it; someone
// with the rule's role, other than the maker, approves it (which posts it) or
// sends it back with a reason.

import { useState } from 'react';
import { CheckCircle2, Clock, Loader2, ShieldCheck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSession } from '@/components/layout/session-provider';
import { approvals, type ApprovalDoc } from '@/lib/api/client';
import { hasPermission } from '@/lib/rbac';

type Approval = {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  needed: boolean;
  approverRole: string | null;
  rejectionReason: string | null;
  submittedById: string | null;
};

const roleName = (r: string | null) => (r === 'admin' ? 'an admin' : r ? `an ${r}` : 'an approver');

export function ApprovalBar({
  doc, id, number, isDraft, approval, onChanged,
}: {
  doc: ApprovalDoc;
  id: string;
  number: string;
  isDraft: boolean;
  approval: Approval;
  onChanged: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  if (!approval.needed || !isDraft) return null;

  const me = session.user;
  const area = doc === 'invoice' ? 'sales' : 'purchases';
  const canSubmit = hasPermission(me.role, area, 'create');
  const mine = approval.submittedById === me.id;
  const canDecide = !mine && !!approval.approverRole && (me.role === 'admin' || me.role === approval.approverRole);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error('Could not do that', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (approval.status === 'pending') {
    return (
      <Card className="flex flex-wrap items-center gap-3 border-sky-500/40 bg-sky-500/5 p-4" data-slot="approval-bar">
        <Clock className="size-4 shrink-0 text-sky-600" />
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-medium">Waiting for approval by {roleName(approval.approverRole)}.</span>{' '}
          {mine ? 'You submitted it, so someone else has to approve it.' : 'It posts the moment it is approved.'}
        </p>
        {canDecide && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => {
              const reason = window.prompt(`Send ${number} back? Say what needs changing.`);
              if (reason?.trim()) void run(() => approvals.reject(doc, id, reason.trim()), `${number} sent back`);
            }}>
              <Undo2 className="size-3.5" /> Send back
            </Button>
            <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void run(() => approvals.approve(doc, id), `${number} approved and posted`)}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Approve and post
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="flex flex-wrap items-center gap-3 border-amber-500/40 bg-amber-500/5 p-4" data-slot="approval-bar">
      <ShieldCheck className="size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {approval.status === 'rejected' ? 'Sent back for changes' : `Needs approval by ${roleName(approval.approverRole)} before it posts`}
        </p>
        {approval.status === 'rejected' && approval.rejectionReason && (
          <p className="mt-0.5 text-xs text-muted-foreground">{approval.rejectionReason}</p>
        )}
      </div>
      {canSubmit && (
        <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void run(() => approvals.submit(doc, id), `${number} submitted for approval`)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} {approval.status === 'rejected' ? 'Submit again' : 'Submit for approval'}
        </Button>
      )}
    </Card>
  );
}
