'use client';

// Sign-ins: each session, where it came from, how long it was used and how it
// ended; failed attempts below. An admin sees everyone; others see their own.

import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

type Status = 'active' | 'expired' | 'signed_out' | 'idle' | 'revoked';
interface SignIns {
  scope: 'organization' | 'self';
  sessions: {
    id: string; name: string; email: string; ip: string | null; userAgent: string | null;
    startedAt: string; lastSeenAt: string | null; endedAt: string | null; status: Status; current: boolean;
  }[];
  failed: { name: string | null; detail: string | null; ip: string | null; userAgent: string | null; at: string }[];
}

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

const STATUS: Record<Status, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  signed_out: { label: 'Signed out', tone: 'text-muted-foreground' },
  idle: { label: 'Idle sign-out', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
  revoked: { label: 'Ended', tone: 'border-red-500/40 text-red-700 dark:text-red-300' },
  expired: { label: 'Expired', tone: 'text-muted-foreground' },
};

/** "Chrome on Windows" from a user-agent string: enough to recognise a device. */
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici|curl/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SignInsPanel() {
  const state = useApi<SignIns>(() => api.get('/api/settings/sign-ins'), []);
  const end = async (payload: { action: 'end'; id: string } | { action: 'end-others' }) => {
    try {
      const r = await api.post<{ ended: number }>('/api/settings/sign-ins', payload);
      toast.success(payload.action === 'end' ? 'Session ended' : `${r.ended} other session${r.ended === 1 ? '' : 's'} ended`);
      void state.refetch();
    } catch (e) {
      toast.error('Not ended', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <AsyncPage state={state}>
      {(d) => (
        <div className="space-y-4">
          <Card className="p-0">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
              <MonitorSmartphone className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{d.scope === 'organization' ? 'Sessions in this book' : 'Your sessions'}</h3>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void end({ action: 'end-others' })}>
                <LogOut className="size-3.5" /> Sign out my other devices
              </Button>
            </div>
            {d.sessions.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No sign-ins yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      {d.scope === 'organization' && <th className="px-4 py-2 font-medium">User</th>}
                      <th className="px-4 py-2 font-medium">Device</th>
                      <th className="px-4 py-2 font-medium">Signed in</th>
                      <th className="px-4 py-2 font-medium">Last active</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.sessions.map((s) => (
                      <tr key={s.id}>
                        {d.scope === 'organization' && (
                          <td className="px-4 py-2"><p className="font-medium">{s.name}</p><p className="text-xs text-muted-foreground">{s.email}</p></td>
                        )}
                        <td className="px-4 py-2">
                          <p>{device(s.userAgent)}{s.current && <span className="ml-1.5 text-xs text-primary">· this device</span>}</p>
                          <p className="text-xs text-muted-foreground">{s.ip === '::1' || s.ip === '127.0.0.1' ? 'localhost' : (s.ip ?? 'IP not recorded')}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs">{when(s.startedAt)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs">{when(s.lastSeenAt)}</td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={`text-[10px] ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</Badge>
                          {s.endedAt && <p className="mt-0.5 text-[11px] text-muted-foreground">{when(s.endedAt)}</p>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {s.status === 'active' && !s.current && (
                            <Button size="sm" variant="ghost" onClick={() => void end({ action: 'end', id: s.id })}>End</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <KeyRound className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Failed attempts</h3>
              <span className="text-xs text-muted-foreground">Eight in a row lock the account for 15 minutes.</span>
            </div>
            {d.failed.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="divide-y">
                {d.failed.map((f, i) => (
                  <li key={`${f.at}-${i}`} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-40 shrink-0 text-xs text-muted-foreground">{when(f.at)}</span>
                    {d.scope === 'organization' && <span className="font-medium">{f.name}</span>}
                    <span className="text-xs text-muted-foreground">{f.detail} · {device(f.userAgent)} · {f.ip ?? 'IP not recorded'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </AsyncPage>
  );
}
