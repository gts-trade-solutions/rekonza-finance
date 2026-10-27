'use client';

// Connecting a GST registration to a portal.
//
// The shape of this screen is not a design choice, it is the government's:
// credentials are issued per GSTIN, per portal. A business in three states
// using both e-invoicing and e-way bills has to create six API users on two
// different websites. That is the single step customers get stuck on, so the
// grid makes it visible up front rather than letting somebody discover the
// fifth one at a filing deadline.
//
// Each row lists what is still missing by name. The alternative is a numeric
// rejection code at the moment somebody is trying to send an invoice, which is
// not something they can act on.

import { useState } from 'react';
import { CheckCircle2, CircleDashed, KeyRound, Loader2, Plug, PlugZap, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { stateName } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';

interface Connection {
  id: string | null;
  branchId: string;
  branchName: string;
  gstin: string | null;
  stateCode: string;
  portal: 'einvoice' | 'ewaybill';
  portalLabel: string;
  portalHost: string;
  help: string;
  provider: string;
  providerLabel: string;
  environment: Environment;
  live: boolean;
  status: string;
  hasCredentials: boolean;
  credentialsUpdatedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  blocking: string[];
  ready: boolean;
}

type Environment = 'stand-in' | 'sandbox' | 'production';

interface ProviderOption {
  name: string;
  label: string;
  portals: ('einvoice' | 'ewaybill' | 'returns')[];
  environment: Environment;
  live: boolean;
  /** What the server still needs before this provider can make a call. */
  missing: string[];
}

interface Response {
  connections: Connection[];
  encryptionAvailable: boolean;
  providers: ProviderOption[];
}

/**
 * Where a connection's submissions actually go, in words. The three are kept
 * visibly different because "connected" is easy to read as "filing", and only
 * one of them files.
 */
const ENVIRONMENT: Record<Environment, { label: string; note: string; tone: string }> = {
  'stand-in': {
    label: 'Stand-in',
    note: 'Submissions get DEMO reference numbers. Nothing leaves the app.',
    tone: 'border-border text-muted-foreground',
  },
  sandbox: {
    label: 'NIC sandbox',
    note: 'Real calls to the real API, with test data. Nothing is filed.',
    tone: 'border-sky-500/40 text-sky-700 dark:text-sky-300',
  },
  production: {
    label: 'Production — files',
    note: 'Invoices registered through this connection are filed with the portal.',
    tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  },
};

export function IntegrationsPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi<Response>(() => api.get('/api/integrations'), []);
  const [target, setTarget] = useState<Connection | null>(null);
  const [form, setForm] = useState({
    username: '', password: '', clientId: '', clientSecret: '', provider: 'fake',
  });
  const [testing, setTesting] = useState<string | null>(null);

  const saveCreds = useApiAction((input: unknown) =>
    api.put<{ id: string; note: string }>('/api/integrations', input),
  );
  const act = useApiAction((input: unknown) =>
    api.post<{ status: string; message?: string }>('/api/integrations', input),
  );

  const open = (c: Connection) => {
    // Start on whatever the connection already uses — re-entering a password
    // should not quietly switch somebody back to the stand-in.
    setForm({ username: '', password: '', clientId: '', clientSecret: '', provider: c.provider });
    saveCreds.reset();
    setTarget(c);
  };

  const test = async (c: Connection) => {
    const key = `${c.branchId}:${c.portal}`;
    setTesting(key);
    const done = await act.run({ action: 'verify', branchId: c.branchId, portal: c.portal });
    setTesting(null);
    if (!done) {
      toast.error('The login did not work', { description: act.error ?? undefined });
    } else {
      toast.success('Connection works', { description: (done as { message?: string }).message });
    }
    state.refetch();
  };

  const submit = async () => {
    if (!target) return;
    const done = await saveCreds.run({
      branchId: target.branchId,
      portal: target.portal,
      username: form.username,
      password: form.password,
      clientId: form.clientId || null,
      clientSecret: form.clientSecret || null,
      provider: form.provider,
    });
    if (!done) {
      toast.error(saveCreds.error ?? 'The credentials were not stored');
      return;
    }
    toast.success(`${target.branchName} · ${target.portalLabel} connected`, { description: done.note });
    setTarget(null);
    state.refetch();
  };

  const forget = async (c: Connection) => {
    const done = await act.run({ action: 'forget', branchId: c.branchId, portal: c.portal });
    if (!done) {
      toast.error(act.error ?? 'Nothing was changed');
      return;
    }
    toast.success('Stored credentials deleted', {
      description: 'Any live session token was dropped with them.',
    });
    state.refetch();
  };

  return (
    <>
      <AsyncPage state={state}>
        {(d) => {
          const byBranch = new Map<string, Connection[]>();
          for (const c of d.connections) {
            const list = byBranch.get(c.branchId) ?? [];
            list.push(c);
            byBranch.set(c.branchId, list);
          }
          const connected = d.connections.filter((c) => c.hasCredentials).length;
          const filing = d.connections.some(
            (c) => c.hasCredentials && c.environment === 'production' && c.status !== 'disabled',
          );

          return (
            <div className="space-y-3">
              {/* The honest headline. Everything below can be green and still
                  nothing is filed, because only a production connection files
                  — and that is a commercial arrangement, not a setting. */}
              {filing ? (
                <Card className="flex items-start gap-3 border-emerald-500/30 bg-emerald-500/5 p-4">
                  <Plug className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">At least one registration files for real.</span>{' '}
                    Invoices registered through a connection marked Production are filed with the government
                    portal and cannot be quietly undone — only cancelled within 24 hours, or reversed by a
                    credit note after that.
                  </p>
                </Card>
              ) : (
                <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-4">
                  <Plug className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p className="font-medium text-foreground">Nothing here is filed with any portal yet.</p>
                    <p className="mt-1">
                      Filing needs production access — through a licensed GST Suvidha Provider, or directly for
                      the taxpayers NIC permits. Until then there are two ways to submit: the built-in stand-in,
                      which never leaves the app, and <span className="font-medium">NIC&apos;s sandbox</span>,
                      which makes real calls to the real API with test data and files nothing. Both check every
                      document against the portal&apos;s own rules first.
                    </p>
                    <p className="mt-1">
                      Storing credentials here is still worth doing — it is the step your customers have to
                      complete, and it is the one they get stuck on.
                    </p>
                  </div>
                </Card>
              )}

              {!d.encryptionAvailable && (
                <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    <p className="font-medium text-foreground">
                      Credentials cannot be stored on this server.
                    </p>
                    <p className="mt-1">
                      <span className="font-mono">INTEGRATION_KEY</span> is not set, and a portal username
                      and password are not ours to hold unsealed — they are somebody&apos;s tax registration.
                      Generate 32 bytes, set it, and restart. Every other screen works without it.
                    </p>
                  </div>
                </Card>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  {connected} of {d.connections.length} registration-and-portal pairs have credentials stored
                </span>
              </div>

              {[...byBranch.values()].map((group) => (
                <Card key={group[0].branchId} className="overflow-hidden p-0">
                  <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{group[0].branchName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {stateName(group[0].stateCode)}
                      </p>
                    </div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {group[0].gstin ?? 'No GSTIN'}
                    </Badge>
                  </div>

                  <div className="divide-y">
                    {group.map((c) => (
                      <div key={c.portal} className="flex flex-wrap items-start gap-3 p-4">
                        <span className="mt-0.5 shrink-0">
                          {c.hasCredentials ? (
                            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <CircleDashed className="size-4 text-muted-foreground" />
                          )}
                        </span>

                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">{c.portalLabel}</p>
                            <Badge variant="outline" className="font-mono text-[9px]">{c.portalHost}</Badge>
                            {c.hasCredentials && (
                              <Badge variant="outline" className={cn('text-[9px]', ENVIRONMENT[c.environment].tone)}>
                                {ENVIRONMENT[c.environment].label}
                              </Badge>
                            )}
                            {c.status === 'verified' && (
                              <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-700 dark:text-emerald-300">
                                Login tested
                              </Badge>
                            )}
                            {c.status === 'disabled' && (
                              <Badge variant="outline" className="text-[9px]">Disabled</Badge>
                            )}
                          </div>

                          {c.hasCredentials ? (
                            <p className="text-xs text-muted-foreground">
                              {c.providerLabel}. Credentials stored
                              {c.credentialsUpdatedAt
                                ? ` on ${new Date(c.credentialsUpdatedAt).toLocaleDateString('en-IN')}`
                                : ''}
                              {c.lastVerifiedAt
                                ? `, login last tested ${new Date(c.lastVerifiedAt).toLocaleString('en-IN')}`
                                : ''}
                              . {ENVIRONMENT[c.environment].note}
                            </p>
                          ) : (
                            <p className="text-xs leading-relaxed text-muted-foreground">{c.help}</p>
                          )}

                          {/* Named, one per line. A user can work through this
                              list; they cannot work through an error code. */}
                          {c.blocking.length > 0 && (
                            <ul className="space-y-0.5 pt-0.5">
                              {c.blocking.map((b) => (
                                <li key={b} className="text-xs text-amber-700 dark:text-amber-300">
                                  {b}
                                </li>
                              ))}
                            </ul>
                          )}

                          {c.lastError && (
                            <p className="text-xs text-destructive">{c.lastError}</p>
                          )}
                        </div>

                        {canEdit && (
                          <div className="flex shrink-0 items-center gap-1.5">
                            {/* Only where there is something to log in to — the
                                stand-in would always "pass", which proves nothing. */}
                            {c.hasCredentials && c.environment !== 'stand-in' && (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={testing !== null}
                                onClick={() => void test(c)}
                              >
                                {testing === `${c.branchId}:${c.portal}` ? (
                                  <Loader2 className="mr-1 size-3 animate-spin" />
                                ) : (
                                  <PlugZap className="mr-1 size-3" />
                                )}
                                Test connection
                              </Button>
                            )}
                            <Button size="xs" variant={c.hasCredentials ? 'outline' : 'default'} onClick={() => open(c)}>
                              <KeyRound className="mr-1 size-3" />
                              {c.hasCredentials ? 'Replace' : 'Add credentials'}
                            </Button>
                            {c.hasCredentials && (
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={act.busy}
                                onClick={() => void forget(c)}
                                aria-label={`Delete stored credentials for ${c.branchName} ${c.portalLabel}`}
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          );
        }}
      </AsyncPage>

      <Dialog open={!!target} onOpenChange={(v) => !v && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.portalLabel} — {target?.branchName}
            </DialogTitle>
            <DialogDescription>
              These are the credentials <span className="font-medium">you</span> create on{' '}
              <span className="font-mono">{target?.portalHost}</span> for GSTIN{' '}
              <span className="font-mono">{target?.gstin}</span> — not your portal login. They are sealed
              before they are stored, and nothing in this app can read them back out: the only thing that
              opens them is a submission, immediately before the call that needs them.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <p className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              {target?.help}
            </p>

            {/* Where these credentials will be used. Offered only for this
                portal, and a provider the server is not set up for is shown
                with what it lacks rather than hidden — otherwise nobody would
                know the option exists. */}
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Submit through</legend>
              {(state.data?.providers ?? [])
                .filter((p) => target && p.portals.includes(target.portal))
                .map((p) => {
                  const unavailable = p.missing.length > 0;
                  return (
                    <label
                      key={p.name}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5',
                        form.provider === p.name && 'border-primary bg-primary/5',
                        unavailable && 'cursor-not-allowed opacity-70',
                      )}
                    >
                      <input
                        type="radio"
                        name="provider"
                        className="mt-0.5"
                        checked={form.provider === p.name}
                        disabled={unavailable}
                        onChange={() => setForm({ ...form, provider: p.name })}
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">{p.label}</span>
                          <Badge variant="outline" className={cn('text-[9px]', ENVIRONMENT[p.environment].tone)}>
                            {ENVIRONMENT[p.environment].label}
                          </Badge>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {ENVIRONMENT[p.environment].note}
                        </span>
                        {p.missing.map((m) => (
                          <span key={m} className="block text-xs text-amber-700 dark:text-amber-300">
                            {m}
                          </span>
                        ))}
                      </span>
                    </label>
                  );
                })}
            </fieldset>

            <Field label="API username" required error={saveCreds.fieldErrors.username}>
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <Field label="API password" required error={saveCreds.fieldErrors.password}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
                className="font-mono"
              />
            </Field>

            {/* Issued by the GSP, not by the portal, and shared across every
                registration under one PAN — so it is optional here and usually
                the same value on each row. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client ID" hint="From your GSP, if they issued one">
                <Input
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Field label="Client secret" hint="Optional">
                <Input
                  type="password"
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  autoComplete="new-password"
                  className="font-mono"
                />
              </Field>
            </div>

            {saveCreds.error && <p className="text-sm text-destructive">{saveCreds.error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button onClick={submit} disabled={saveCreds.busy || !form.username || !form.password}>
              {saveCreds.busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {saveCreds.busy ? 'Storing…' : 'Store credentials'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
