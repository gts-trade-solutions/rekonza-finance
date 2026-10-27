'use client';

// The open API: keys for other software, webhooks to tell it what happened,
// and enough of a reference to start.

import { useState } from 'react';
import { Copy, KeyRound, Loader2, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface ApiKey { id: string; name: string; prefix: string; role: string; customRoleName: string | null; createdBy: string; expiresOn: string | null; lastUsedAt: string | null; revokedAt: string | null }
interface Hook {
  id: string; url: string; events: string[]; description: string | null; isActive: boolean;
  deliveries: { id: string; event: string; status: 'pending' | 'delivered' | 'failed'; attempts: number; responseCode: number | null; lastError: string | null; at: string }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const VERBS = ['created', 'updated', 'voided', 'approved'] as const;

function Secret({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <span className="flex-1 select-all break-all font-mono text-xs">{value}</span>
        <Button size="xs" variant="outline" className="gap-1" onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success('Copied'))}><Copy className="size-3" /> Copy</Button>
        <Button size="xs" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function ApiKeys() {
  const state = useApi(() => api.get<{ keys: ApiKey[] }>('/api/api-keys'), []);
  const roles = useApi(() => api.get<{ roles: { id: string; name: string }[] }>('/api/settings/users'), []);
  const [f, setF] = useState({ name: '', roleValue: 'role:viewer', expiresOn: '' });
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const custom = f.roleValue.startsWith('custom:');
      const r = await api.post<{ key: string }>('/api/api-keys', {
        action: 'create', name: f.name, role: custom ? 'viewer' : f.roleValue.slice(5), customRoleId: custom ? f.roleValue.slice(7) : null, expiresOn: f.expiresOn || null,
      });
      setShown(r.key);
      setF({ name: '', roleValue: 'role:viewer', expiresOn: '' });
      await state.refetch();
    } catch (e) {
      toast.error('No key made', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">API keys</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            For other software to read and write these books through the same endpoints the app uses. A key acts with the role you give it, in your name, and never reaches Settings. 120 requests a minute per key.
          </p>
        </div>
      </div>
      {shown && <Secret label="The key, shown only now. Store it where the other software keeps secrets." value={shown} onClose={() => setShown(null)} />}
      <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[1fr_180px_160px_auto] sm:items-end">
        <Field label="What will use it"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Shop website" /></Field>
        <Field label="Acting as">
          <div>
            <select value={f.roleValue} onChange={(e) => setF({ ...f, roleValue: e.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize">
              {['viewer', 'staff', 'sales', 'accountant', 'admin'].map((r) => <option key={r} value={`role:${r}`}>{r}</option>)}
              {(roles.data?.roles ?? []).map((r) => <option key={r.id} value={`custom:${r.id}`}>{r.name}</option>)}
            </select>
          </div>
        </Field>
        <Field label="Expires (optional)"><Input type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></Field>
        <Button size="sm" className="gap-1.5" disabled={busy || !f.name.trim()} onClick={() => void create()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Make key
        </Button>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={2} />}>
        {(d) => d.keys.length === 0 ? <p className="text-center text-sm text-muted-foreground">No keys yet.</p> : (
          <ul className="divide-y rounded-md border text-sm">
            {d.keys.map((k) => (
              <li key={k.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', k.revokedAt && 'opacity-50')}>
                <span className="font-medium">{k.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{k.prefix}…</span>
                <Badge variant="outline" className="text-[10px] capitalize">{k.customRoleName ?? k.role}</Badge>
                <span className="text-xs text-muted-foreground">
                  by {k.createdBy} · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString('en-IN')}` : 'never used'}{k.expiresOn ? ` · expires ${new Date(k.expiresOn).toLocaleDateString('en-IN')}` : ''}
                </span>
                {k.revokedAt ? <Badge variant="secondary" className="ml-auto text-[10px]">Revoked</Badge> : (
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => window.confirm(`Revoke ${k.name}? Anything using it stops at once.`) &&
                    void api.post('/api/api-keys', { action: 'revoke', id: k.id }).then(() => { toast.success('Revoked'); void state.refetch(); }).catch((e) => toast.error('Not revoked', { description: errorText(e) }))}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncPage>
    </Card>
  );
}

function Webhooks() {
  const state = useApi(() => api.get<{ webhooks: Hook[]; eventTypes: string[] }>('/api/webhooks'), []);
  const [url, setUrl] = useState('');
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const post = async <T,>(key: string, payload: Record<string, unknown>, done?: string) => {
    setBusy(key);
    try {
      const r = await api.post<T>('/api/webhooks', payload);
      if (done) toast.success(done);
      await state.refetch();
      return r;
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start gap-2">
        <Webhook className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">Webhooks</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            A POST to your address when something happens — invoice.created, payment.voided — with the record&apos;s type and id; fetch the rest through the API.
            Each is signed: <span className="font-mono">X-Rekonza-Signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</span>. Failures are retried for about fifteen hours.
          </p>
        </div>
      </div>
      {shown && <Secret label="Signing secret: check every delivery's signature with it." value={shown} onClose={() => setShown(null)} />}
      <AsyncPage state={state} loading={<LoadingRows rows={2} />}>
        {(d) => (
          <>
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-64 flex-1"><Field label="Send to"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/rekonza-events" /></Field></div>
                <label className="flex h-9 items-center gap-2 text-xs"><Checkbox checked={all} onCheckedChange={(v) => setAll(!!v)} /> Every event</label>
                <Button size="sm" className="gap-1.5" disabled={busy === 'add' || !url.trim() || (!all && !events.length)}
                  onClick={() => void post<{ secret: string }>('add', { action: 'save', url, events: all ? ['*'] : events }, 'Webhook added').then((r) => { if (r?.secret) { setShown(r.secret); setUrl(''); setEvents([]); } })}>
                  <Plus className="size-3.5" /> Add
                </Button>
              </div>
              {!all && (
                <div className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  {d.eventTypes.flatMap((t) => VERBS.map((v) => `${t}.${v}`)).map((e) => (
                    <label key={e} className="flex items-center gap-1.5 font-mono">
                      <Checkbox checked={events.includes(e)} onCheckedChange={(v) => setEvents(v ? [...events, e] : events.filter((x) => x !== e))} /> {e}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {d.webhooks.length === 0 ? <p className="text-center text-sm text-muted-foreground">No webhooks yet.</p> : d.webhooks.map((h) => (
              <div key={h.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-all font-mono text-xs">{h.url}</span>
                  <Badge variant="outline" className="text-[10px]">{h.events.includes('*') ? 'every event' : `${h.events.length} events`}</Badge>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="xs" variant="outline" className="gap-1" disabled={busy === h.id} onClick={() => void post(h.id, { action: 'test', id: h.id }, 'Test sent')}><Send className="size-3" /> Test</Button>
                    <Button size="xs" variant="ghost" disabled={busy === h.id} onClick={() => void post<{ secret: string }>(h.id, { action: 'secret', id: h.id }).then((r) => r && setShown(r.secret))}>Secret</Button>
                    <Switch checked={h.isActive} aria-label="On" onCheckedChange={(v) => void post(h.id, { action: 'save', id: h.id, url: h.url, events: h.events, isActive: v }, v ? 'On' : 'Off')} />
                    <Button size="icon-sm" variant="ghost" aria-label="Delete webhook" onClick={() => window.confirm('Delete this webhook?') && void post(h.id, { action: 'delete', id: h.id }, 'Deleted')}><Trash2 className="size-3.5" /></Button>
                  </span>
                </div>
                {h.deliveries.length > 0 && (
                  <ul className="space-y-0.5 text-xs">
                    {h.deliveries.map((x) => (
                      <li key={x.id} className="flex flex-wrap gap-2">
                        <span className="text-muted-foreground">{new Date(x.at).toLocaleString('en-IN')}</span>
                        <span className="font-mono">{x.event}</span>
                        <span className={cn(x.status === 'delivered' ? 'text-emerald-600' : x.status === 'failed' ? 'text-destructive' : 'text-amber-600')}>
                          {x.status}{x.responseCode ? ` (${x.responseCode})` : ''}{x.attempts > 1 ? ` after ${x.attempts} tries` : ''}
                        </span>
                        {x.lastError && x.status !== 'delivered' && <span className="text-muted-foreground">{x.lastError}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </>
        )}
      </AsyncPage>
    </Card>
  );
}

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/contacts', 'Customers and suppliers'],
  ['POST', '/api/contacts', 'Add a customer or supplier'],
  ['GET', '/api/items', 'Goods and services, with rates and HSN/SAC'],
  ['GET', '/api/invoices', 'Invoices, newest first'],
  ['GET', '/api/invoices/{id}', 'One invoice with its lines and tax'],
  ['POST', '/api/invoices', 'Raise an invoice: GST, numbering and posting as in the app'],
  ['GET', '/api/bills', 'Supplier bills'],
  ['POST', '/api/bills', 'Record a supplier bill'],
  ['POST', '/api/payments', 'Record money received or paid, and what it settles'],
  ['GET', '/api/journal', 'Journal entries'],
  ['GET', '/api/reports?report=trial-balance&to=2027-03-31', 'Any report: trial-balance, profit-and-loss, balance-sheet, ar-ageing…'],
];

function Reference() {
  return (
    <Card className="space-y-3 p-5">
      <h3 className="text-sm font-semibold">Using the API</h3>
      <p className="text-xs text-muted-foreground">
        JSON over HTTPS, with the key as a bearer token. Request bodies are the same JSON the app&apos;s own screens send; amounts are in paise.
        An error answers with a status and <span className="font-mono">{'{ "error", "code", "details" }'}</span>. Every change a key makes is in the audit trail under its name.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`curl https://YOUR-HOST/api/invoices \\
  -H "Authorization: Bearer rk_live_…"`}</pre>
      <table className="w-full text-xs">
        <tbody>
          {ENDPOINTS.map(([m, p, d]) => (
            <tr key={m + p} className="border-t">
              <td className="py-1.5 pr-3 font-mono font-semibold">{m}</td>
              <td className="py-1.5 pr-3 font-mono">{p}</td>
              <td className="py-1.5 text-muted-foreground">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function DeveloperPanel() {
  return (
    <div className="space-y-4">
      <ApiKeys />
      <Webhooks />
      <Reference />
    </div>
  );
}
