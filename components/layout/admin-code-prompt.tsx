'use client';

// Asks for the admin's one-time code, when someone who is not an admin
// reverses, voids, deletes or uncategorises posted work, or changes a saved
// invoice (Settings → Controls; lib/server/services/admin-codes.ts). The
// server has already sent the code to the company's admins. The API client
// calls the asker this registers, then sends the same request again with the
// code typed, so no screen has to know about it (as reason-prompt.tsx does for
// the reason).

import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setAdminCodeAsker, type AdminCodeAsk } from '@/lib/api/client';

export function AdminCodePrompt() {
  const [ask, setAsk] = useState<AdminCodeAsk | null>(null);
  const [code, setCode] = useState('');
  const settle = useRef<((r: string | null) => void) | null>(null);

  useEffect(() => {
    setAdminCodeAsker((a) => new Promise<string | null>((resolve) => {
      settle.current = resolve;
      setCode('');
      setAsk(a);
    }));
    return () => setAdminCodeAsker(null);
  }, []);

  const finish = (r: string | null) => {
    settle.current?.(r);
    settle.current = null;
    setAsk(null);
  };
  const ready = /^\d{6}$/.test(code);

  return (
    <Dialog open={!!ask} onOpenChange={(o) => { if (!o) finish(null); }}>
      <DialogContent className="max-w-md" data-slot="admin-code-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /> An admin has to agree</DialogTitle>
          <DialogDescription>
            {ask?.action ? <>You are asking to <b>{ask.action}</b>. </> : null}
            A 6-digit code has been sent to {ask?.admins || 'the admins'} (in their notifications, the bell at the top). Ask for it and type it here; it works once, for this only, for ten minutes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (ready) finish(code); }} className="space-y-3">
          {ask?.wrong && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-slot="admin-code-wrong">{ask.message}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="admin-code">Admin code</Label>
            <Input id="admin-code" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 digits" className="tabular text-lg tracking-[0.3em]" data-slot="admin-code-input" />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => finish('resend')} data-slot="admin-code-resend">Send a new code</Button>
            <span className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => finish(null)}>Cancel</Button>
              <Button type="submit" disabled={!ready} data-slot="admin-code-go">Confirm</Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
