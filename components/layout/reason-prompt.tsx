'use client';

// Asks why, when the book keeps a reason with every change (Settings →
// Controls). The API client calls the asker this registers when the server
// answers that a reason is needed, then sends the same request again with the
// answer, so no form has to know about it.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { setReasonAsker } from '@/lib/api/client';

export function ReasonPrompt() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const settle = useRef<((r: string | null) => void) | null>(null);

  useEffect(() => {
    setReasonAsker(() => new Promise<string | null>((resolve) => {
      settle.current = resolve;
      setText('');
      setOpen(true);
    }));
    return () => setReasonAsker(null);
  }, []);

  const finish = (reason: string | null) => {
    settle.current?.(reason);
    settle.current = null;
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) finish(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Why is this being changed?</DialogTitle>
          <DialogDescription>
            This book keeps a reason with every change, beside who made it and when. It goes into the audit trail.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) finish(text.trim()); }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="change-reason">Reason</Label>
            <Textarea
              id="change-reason"
              autoFocus
              rows={3}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Customer's GSTIN was entered wrongly; corrected from their certificate"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>Cancel</Button>
            <Button type="submit" disabled={text.trim().length < 3}>Save with this reason</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
