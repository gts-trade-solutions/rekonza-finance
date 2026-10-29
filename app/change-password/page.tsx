'use client';

// Where a user lands when their password has to be changed before anything
// else: it was a temporary one an admin gave them, or it is older than the
// book allows (Settings → Controls). The server refuses everything else until
// it is done.

import { useState } from 'react';
import { KeyRound, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, auth, ApiError } from '@/lib/api/client';
import { Logo } from '@/components/brand/logo';

export default function ChangePasswordPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current, next });
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The password could not be changed.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex flex-col items-center text-center">
          <Logo width={180} priority />
          <h1 className="mt-4 text-lg font-semibold">Choose a new password to carry on</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your password was a temporary one, or it is older than this book allows. Your other devices are signed out once it is changed.
          </p>
        </div>
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cp-current">Current password</Label>
              <Input id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-next">New password</Label>
              <Input id="cp-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-again">New password again</Label>
              <Input id="cp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full gap-1.5" disabled={busy || !current || !next}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Change password
            </Button>
          </form>
        </Card>
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" className="gap-1.5"
            onClick={() => void auth.logout().finally(() => { window.location.href = '/login'; })}>
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
