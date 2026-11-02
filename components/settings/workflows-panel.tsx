'use client';

// Settings → Workflow rules: when something happens and the record meets the
// conditions, tell people in the app or send an email. Rules only ever tell
// someone; nothing they do changes the books.

import { useState } from 'react';
import { Plus, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

type Cond = { field: string; op: string; value: string };
type Act = { type: 'notify'; to: 'admins' | 'accountants' | 'approvers'; message?: string } | { type: 'email'; to: string; subject: string; body: string };
interface Rule { id: string; name: string; event: string; conditions: Cond[]; actions: Act[]; isActive: boolean; runs: number; lastRunAt: string | null }
interface Data {
  rules: Rule[]; runs: { id: string; rule: string; event: string; status: string; detail: string | null; at: string }[];
  events: string[]; fields: Record<string, { key: string; label: string; type: 'number' | 'text' }[]>;
}

const OPS = [
  { value: 'gt', label: 'is more than' }, { value: 'gte', label: 'is at least' }, { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' }, { value: 'eq', label: 'is' }, { value: 'ne', label: 'is not' }, { value: 'contains', label: 'contains' },
];
const eventLabel = (e: string) => e.replace('_', ' ').replace('.', ' ').replace(/^./, (c) => c.toUpperCase());
const BLANK: Rule = { id: '', name: '', event: 'invoice.created', conditions: [], actions: [{ type: 'notify', to: 'admins' }], isActive: true, runs: 0, lastRunAt: null };

export function WorkflowsPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.get<Data>('/api/workflows'), []);
  const save = useApiAction((r: Rule) => api.post<{ id: string }>('/api/workflows', { ...r, id: r.id || null }));
  const [f, setF] = useState<Rule | null>(null);

  const submit = async () => {
    if (!f) return;
    if (!(await save.run(f))) { toast.error(save.error ?? 'Not saved'); return; }
    toast.success('Rule saved');
    setF(null);
    state.refetch();
  };

  return (
    <AsyncPage state={state}>
      {(d) => {
        const fields = f ? d.fields[f.event.split('.')[0]] ?? [] : [];
        return (
          <div className="space-y-4" data-slot="workflows">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">When something happens and the record meets the conditions, tell people here or send an email. Use {'{record}'}, {'{total}'} and the like in messages.</p>
              {canEdit && <Button size="sm" onClick={() => setF({ ...BLANK })} className="gap-1.5"><Plus className="size-4" /> New rule</Button>}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {d.rules.map((r) => (
                <Card key={r.id} className="space-y-1 p-4 text-sm">
                  <button type="button" className="flex w-full items-start justify-between text-left" disabled={!canEdit} onClick={() => setF(r)}>
                    <span className="font-medium"><Workflow className="mr-1.5 inline size-4 text-muted-foreground" />{r.name}</span>
                    <Badge variant={r.isActive ? 'secondary' : 'outline'} className="text-[10px]">{r.isActive ? 'On' : 'Off'}</Badge>
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {eventLabel(r.event)}{r.conditions.length ? `, when ${r.conditions.map((c) => `${c.field} ${OPS.find((o) => o.value === c.op)?.label} ${c.value}`).join(' and ')}` : ''}
                    {' → '}{r.actions.map((a) => (a.type === 'notify' ? `tell ${a.to}` : `email ${a.to === 'party' ? 'the customer or vendor' : a.to}`)).join(', ')}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Ran {r.runs} time{r.runs === 1 ? '' : 's'}{r.lastRunAt ? `, last ${new Date(r.lastRunAt).toLocaleString('en-IN')}` : ''}</p>
                </Card>
              ))}
              {!d.rules.length && <p className="text-sm text-muted-foreground">No rules yet.</p>}
            </div>
            {d.runs.length > 0 && (
              <Card className="p-4">
                <p className="mb-2 text-sm font-semibold">Lately</p>
                {d.runs.slice(0, 15).map((r) => (
                  <p key={r.id} className="flex justify-between gap-3 border-t py-1.5 text-xs">
                    <span>{r.rule} · {eventLabel(r.event)} · <span className={r.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{r.detail ?? r.status}</span></span>
                    <span className="shrink-0 text-muted-foreground">{new Date(r.at).toLocaleString('en-IN')}</span>
                  </p>
                ))}
              </Card>
            )}

            <Dialog open={!!f} onOpenChange={(o) => !o && setF(null)}>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>{f?.id ? 'Edit rule' : 'New rule'}</DialogTitle>
                  <DialogDescription>Runs a moment after the event, on the record as it then stands.</DialogDescription>
                </DialogHeader>
                {f && (
                  <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1 thin-scroll">
                    <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Large invoices to the admins" /></Field>
                    <Field label="When">
                      <select value={f.event} onChange={(e) => setF({ ...f, event: e.target.value, conditions: [] })} className="h-9 rounded-md border bg-background px-2 text-sm">
                        {d.events.map((e) => <option key={e} value={e}>{eventLabel(e)}</option>)}
                      </select>
                    </Field>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between"><p className="text-sm font-medium">Only if</p>
                        <Button size="sm" variant="ghost" onClick={() => setF({ ...f, conditions: [...f.conditions, { field: fields[0]?.key ?? '', op: 'gt', value: '' }] })}><Plus className="size-3.5" /> Condition</Button></div>
                      {f.conditions.map((c, i) => (
                        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                          <select value={c.field} onChange={(e) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} className="h-9 rounded-md border bg-background px-2 text-sm">
                            {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                          </select>
                          <select value={c.op} onChange={(e) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })} className="h-9 rounded-md border bg-background px-2 text-sm">
                            {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <Input value={c.value} onChange={(e) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                          <Button size="icon-sm" variant="ghost" aria-label="Remove condition" onClick={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between"><p className="text-sm font-medium">Then</p>
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setF({ ...f, actions: [...f.actions, { type: 'notify', to: 'admins' }] })}><Plus className="size-3.5" /> Tell people</Button>
                          <Button size="sm" variant="ghost" onClick={() => setF({ ...f, actions: [...f.actions, { type: 'email', to: 'party', subject: '{record}', body: '' }] })}><Plus className="size-3.5" /> Email</Button>
                        </div></div>
                      {f.actions.map((a, i) => (
                        <Card key={i} className="grid gap-2 p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">{a.type === 'notify' ? 'Tell in the app' : 'Send an email'}</span>
                            <Button size="icon-sm" variant="ghost" aria-label="Remove action" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                          </div>
                          {a.type === 'notify' ? (
                            <>
                              <select value={a.to} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...a, to: e.target.value as 'admins' } : x)) })} className="h-9 rounded-md border bg-background px-2 text-sm">
                                <option value="admins">The admins</option><option value="accountants">The accountants</option><option value="approvers">Those who approve this kind of document</option>
                              </select>
                              <Input placeholder="Message (optional)" value={a.message ?? ''} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...a, message: e.target.value } : x)) })} />
                            </>
                          ) : (
                            <>
                              <Input placeholder="To: party, or an email address" value={a.to} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...a, to: e.target.value } : x)) })} />
                              <Input placeholder="Subject" value={a.subject} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...a, subject: e.target.value } : x)) })} />
                              <Textarea placeholder="Message" rows={3} value={a.body} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...a, body: e.target.value } : x)) })} />
                            </>
                          )}
                        </Card>
                      ))}
                    </div>
                    <label className="flex items-center justify-between text-sm">On <Switch checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} /></label>
                  </div>
                )}
                {save.error && <p className="text-sm text-destructive">{save.error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setF(null)}>Cancel</Button>
                  <Button onClick={submit} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save rule'}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      }}
    </AsyncPage>
  );
}
