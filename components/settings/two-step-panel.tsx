'use client';

// Two-step sign-in for the person signed in: set it up with an authenticator
// app, keep the recovery codes, or turn it off. Used in Settings and on the
// page a user lands on when the book requires it and they have not set it up.

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Download, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Status { enabled: boolean; enabledAt: string | null; pending: boolean; recoveryLeft: number; requirement: 'off' | 'admins' | 'everyone'; required: boolean }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">Keep these recovery codes somewhere safe</p>
      <p className="text-xs text-muted-foreground">
        Each one signs you in once if the phone is lost. They are shown only now; the app keeps only a fingerprint of each.
      </p>
      <ol className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([`Recovery codes\n\n${text}\n`], { type: 'text/plain' }));
          a.download = 'recovery-codes.txt';
          a.click();
        }}>
          <Download className="size-3.5" /> Download
        </Button>
        <Button size="sm" onClick={onDone}>I have kept them</Button>
      </div>
    </div>
  );
}

export function TwoStepPanel({ onEnabled }: { onEnabled?: () => void }) {
  const state = useApi(() => api.get<Status>('/api/auth/mfa'), []);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'disable' | 'recovery' | null>(null);

  const run = async <T,>(fn: () => Promise<T>, then: (r: T) => void) => {
    setBusy(true);
    try {
      then(await fn());
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">Two-step sign-in</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            After the password, a six-digit code from an authenticator app on your phone — Google Authenticator,
            Microsoft Authenticator or any other. A stolen password alone then opens nothing.
          </p>
        </div>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={2} />}>
        {(s) => codes ? (
          <RecoveryCodes codes={codes} onDone={() => { setCodes(null); void state.refetch(); onEnabled?.(); }} />
        ) : s.enabled ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">On</Badge>
              <span className="text-muted-foreground">since {new Date(s.enabledAt!).toLocaleDateString('en-IN')} · {s.recoveryLeft} recovery code{s.recoveryLeft === 1 ? '' : 's'} left</span>
              {s.required && <Badge variant="secondary" className="text-[10px]">Required by this book</Badge>}
            </div>
            {asking ? (
              <div className="flex flex-wrap items-end gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the app" inputMode="numeric" autoComplete="one-time-code" className="h-9 w-48 font-mono" />
                <Button size="sm" variant={asking === 'disable' ? 'destructive' : 'default'} disabled={busy || code.trim().length < 6}
                  onClick={() => void run(
                    () => api.post<{ recoveryCodes?: string[] }>('/api/auth/mfa', { action: asking, code }),
                    (r) => { setAsking(null); setCode(''); if (r.recoveryCodes) setCodes(r.recoveryCodes); else { toast.success('Two-step sign-in is off'); void state.refetch(); } },
                  )}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} {asking === 'disable' ? 'Turn off' : 'Make new codes'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setAsking(null); setCode(''); }}>Cancel</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAsking('recovery')}><KeyRound className="size-3.5" /> New recovery codes</Button>
                {!s.required && <Button size="sm" variant="ghost" onClick={() => setAsking('disable')}>Turn off</Button>}
              </div>
            )}
          </div>
        ) : setup ? (
          <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <div className="w-fit rounded-md border bg-white p-3"><QRCodeSVG value={setup.uri} size={168} /></div>
            <div className="space-y-3 text-sm">
              <p>1. In the authenticator app, add an account and scan this code.</p>
              <p className="text-xs text-muted-foreground">
                Cannot scan? Type this key instead: <span className="select-all font-mono text-foreground">{grouped(setup.secret)}</span>
              </p>
              <p>2. Enter the six-digit code the app now shows.</p>
              <div className="flex flex-wrap gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="h-9 w-36 font-mono tracking-widest" />
                <Button size="sm" disabled={busy || code.replace(/\s/g, '').length !== 6}
                  onClick={() => void run(
                    () => api.post<{ recoveryCodes: string[] }>('/api/auth/mfa', { action: 'confirm', code }),
                    (r) => { setSetup(null); setCode(''); setCodes(r.recoveryCodes); toast.success('Two-step sign-in is on'); },
                  )}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} Turn on
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline">Off</Badge>
            {s.required && <span className="text-xs text-destructive">This book requires it for your role.</span>}
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.post<{ secret: string; uri: string }>('/api/auth/mfa', { action: 'start' }), setSetup)}>
              {busy && <Loader2 className="size-3.5 animate-spin" />} Set it up
            </Button>
          </div>
        )}
      </AsyncPage>
    </Card>
  );
}
