'use client';

// "Sent to the admin for approval": shown when someone who is not an admin
// reverses, voids, deletes or uncategorises posted work, or changes a saved
// invoice (Settings → Controls; lib/server/services/admin-requests.ts). The
// request is kept and the admins have Approve and Reject on it; nothing has
// changed yet. The API client calls the notice this registers, so no screen has
// to know about it.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { setApprovalSentNotice, type ApprovalSent } from '@/lib/api/client';

export function ApprovalSentNotice() {
  const [sent, setSent] = useState<ApprovalSent | null>(null);
  useEffect(() => {
    setApprovalSentNotice((a) => setSent(a));
    return () => setApprovalSentNotice(null);
  }, []);

  return (
    <Dialog open={!!sent} onOpenChange={(o) => { if (!o) setSent(null); }}>
      <DialogContent className="max-w-md" data-slot="approval-sent">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clock className="size-4 text-primary" /> Sent to the admin for approval</DialogTitle>
          <DialogDescription>
            {sent?.action ? <>Your request to <b>{sent.action}</b> has gone to {sent.admins || 'the admins'}. </> : <>{sent?.message} </>}
            Nothing has changed yet: it is done as soon as an admin approves it, and you will be told in your notifications whether it was approved or rejected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" asChild><Link href="/approvals" onClick={() => setSent(null)}>See my requests</Link></Button>
          <Button onClick={() => setSent(null)} data-slot="approval-sent-ok">OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
