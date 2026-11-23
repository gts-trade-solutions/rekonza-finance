'use client';

// On screen only, above a document printed without a logo: the way to add one
// right there, as Zoho asks for it ("Upload your logo"), instead of a trip to
// Settings → Organization Profile. Once uploaded, every document prints it.

import { useState } from 'react';
import { ImageUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LogoUpload } from '@/components/settings/logo-upload';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';

export function LogoPrompt() {
  const orgId = useAppStore((s) => s.org?.id);
  const canEdit = usePermission('settings', 'edit');
  const [open, setOpen] = useState(false);
  if (!orgId || !canEdit) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-[3px] border border-dashed border-primary/50 bg-primary/5 px-3 py-2 text-sm no-print" data-slot="logo-prompt">
        <ImageUp className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">Your invoices print without a logo. Add your organization logo and it prints on every invoice, quote and receipt.</span>
        <Button size="sm" onClick={() => setOpen(true)} data-slot="logo-prompt-upload">Upload logo</Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" data-slot="logo-prompt-dialog">
          <DialogHeader>
            <DialogTitle>Organization Logo</DialogTitle>
            <DialogDescription>The same logo as in Settings → Organization Profile and PDF Templates.</DialogDescription>
          </DialogHeader>
          {/* The document re-reads the business once the logo is in. */}
          <LogoUpload orgId={String(orgId)} logoFileId={null} canEdit onChanged={() => window.location.reload()} />
        </DialogContent>
      </Dialog>
    </>
  );
}
