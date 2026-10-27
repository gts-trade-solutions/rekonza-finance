'use client';

// Leave: each employee's balances, leave taken, opening balances, and the
// kinds of leave this book gives. Unpaid leave becomes the month's unpaid
// days when the payroll is prepared; the month's payroll accrues the leave.

import { useState } from 'react';
import { CalendarDays, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface LeaveType { id: string; code: string; name: string; paid: boolean; annualDays: number; accrual: 'monthly' | 'yearly'; carryForwardMax: number | null; encashable: boolean; isActive: boolean }
interface Data {
  asOf: string; types: LeaveType[];
  employees: { id: string; code: string; name: string; balances: Record<string, number> }[];
  register: { id: string; kind: string; days: number; from: string | null; to: string | null; note: string | null; status: string; employeeName: string; typeCode: string; typeName: string }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dmy = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '');
const today = () => new Date().toISOString().slice(0, 10);
const select = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';

export default function LeavePage() {
  const canEdit = usePermission('payroll', 'edit');
  const state = useApi(() => api.get<Data>('/api/payroll/leave'), []);
  const [f, setF] = useState({ employeeId: '', leaveTypeId: '', from: today(), to: today(), days: '', note: '' });
  const [g, setG] = useState({ employeeId: '', leaveTypeId: '', kind: 'opening' as 'opening' | 'adjustment', days: '', date: today() });
  const [busy, setBusy] = useState<string | null>(null);

  const post = async (key: string, payload: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await api.post('/api/payroll/leave', payload);
      toast.success(done);
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Leave" description="Balances, leave taken and the kinds of leave given. A month's payroll accrues its leave; unpaid leave becomes its unpaid days." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const active = d.types.filter((t) => t.isActive);
          return (
            <div className="space-y-4">
              {canEdit && (
                <Card className="space-y-3 p-5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="size-4 text-muted-foreground" /> Record leave</h3>
                  <div className="grid gap-3 sm:grid-cols-6 sm:items-end">
                    <Field label="Employee">
                      <div><select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} className={select}>
                        <option value="">Choose</option>
                        {d.employees.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                      </select></div>
                    </Field>
                    <Field label="Leave">
                      <div><select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })} className={select}>
                        <option value="">Choose</option>
                        {active.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select></div>
                    </Field>
                    <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} /></Field>
                    <Field label="To"><Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
                    <Field label="Days" hint="Blank: every day; 0.5 for half a day"><Input type="number" step="0.5" min="0.5" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
                    <Button size="sm" className="w-fit gap-1.5" disabled={busy === 'rec' || !f.employeeId || !f.leaveTypeId}
                      onClick={() => void post('rec', { action: 'record', employeeId: f.employeeId, leaveTypeId: f.leaveTypeId, from: f.from, to: f.to, days: f.days ? Number(f.days) : null, note: f.note || null }, 'Leave recorded')
                        .then((ok) => ok && setF({ ...f, days: '', note: '' }))}>
                      {busy === 'rec' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Record
                    </Button>
                  </div>
                </Card>
              )}

              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-semibold">Employee</th>
                      {active.filter((t) => t.paid).map((t) => <th key={t.id} className="px-4 py-2 text-right font-semibold" title={t.name}>{t.code}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.employees.length === 0 && <tr><td className="px-4 py-6 text-center text-muted-foreground" colSpan={active.length + 1}>No employees yet.</td></tr>}
                    {d.employees.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="px-4 py-2"><span className="font-mono text-xs text-muted-foreground">{e.code}</span> {e.name}</td>
                        {active.filter((t) => t.paid).map((t) => (
                          <td key={t.id} className={cn('px-4 py-2 text-right tabular-nums', (e.balances[t.id] ?? 0) < 0 && 'text-destructive')}>{(e.balances[t.id] ?? 0).toFixed(1)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">Balances as at {dmy(d.asOf)}.</p>
              </Card>

              <Card className="space-y-2 p-5">
                <h3 className="text-sm font-semibold">Register</h3>
                {d.register.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : (
                  <ul className="divide-y rounded-md border text-sm">
                    {d.register.map((r) => (
                      <li key={r.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-1.5', r.status === 'cancelled' && 'opacity-50 line-through')}>
                        <Badge variant="outline" className="text-[10px]">{r.typeCode}</Badge>
                        <span className="font-medium">{r.employeeName}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.kind === 'taken' ? `${dmy(r.from)}${r.to && r.to !== r.from ? ` to ${dmy(r.to)}` : ''}` : r.kind === 'encashed' ? 'Encashed' : r.kind === 'opening' ? 'Opening balance' : 'Adjustment'}
                          {' · '}{r.days} day{r.days === 1 ? '' : 's'}{r.note ? ` · ${r.note}` : ''}
                        </span>
                        {canEdit && r.status === 'approved' && r.kind !== 'encashed' && (
                          <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Cancel" onClick={() => void post(r.id, { action: 'cancel', id: r.id }, 'Cancelled')}><X className="size-3.5" /></Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {canEdit && (
                <Card className="space-y-3 p-5">
                  <h3 className="text-sm font-semibold">Opening balances and adjustments</h3>
                  <div className="grid gap-3 sm:grid-cols-6 sm:items-end">
                    <Field label="Employee">
                      <div><select value={g.employeeId} onChange={(e) => setG({ ...g, employeeId: e.target.value })} className={select}>
                        <option value="">Choose</option>
                        {d.employees.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                      </select></div>
                    </Field>
                    <Field label="Leave">
                      <div><select value={g.leaveTypeId} onChange={(e) => setG({ ...g, leaveTypeId: e.target.value })} className={select}>
                        <option value="">Choose</option>
                        {active.filter((t) => t.paid).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select></div>
                    </Field>
                    <Field label="As">
                      <div><select value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value as 'opening' | 'adjustment' })} className={select}>
                        <option value="opening">Opening balance</option><option value="adjustment">Adjustment (+ or −)</option>
                      </select></div>
                    </Field>
                    <Field label="Days"><Input type="number" step="0.5" value={g.days} onChange={(e) => setG({ ...g, days: e.target.value })} /></Field>
                    <Field label="On"><Input type="date" value={g.date} onChange={(e) => setG({ ...g, date: e.target.value })} /></Field>
                    <Button size="sm" variant="outline" className="w-fit" disabled={busy === 'grant' || !g.employeeId || !g.leaveTypeId || !Number(g.days)}
                      onClick={() => void post('grant', { action: 'grant', ...g, days: Number(g.days) }, 'Saved').then((ok) => ok && setG({ ...g, days: '' }))}>Save</Button>
                  </div>
                </Card>
              )}

              <Card className="space-y-2 p-5">
                <h3 className="text-sm font-semibold">Kinds of leave</h3>
                <p className="text-xs text-muted-foreground">Your state&apos;s Shops and Establishments Act and your own policy decide these; the defaults are a starting point.</p>
                <div className="space-y-2">
                  {d.types.map((t) => <LeaveTypeRow key={t.id} type={t} canEdit={canEdit} onSave={(x) => post(`t${t.id}`, { action: 'save-type', id: t.id, ...x }, `${x.name} saved`)} />)}
                </div>
              </Card>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}

function LeaveTypeRow({ type, canEdit, onSave }: { type: LeaveType; canEdit: boolean; onSave: (t: Omit<LeaveType, 'id'>) => Promise<boolean> }) {
  const [t, setT] = useState(type);
  const dirty = JSON.stringify(t) !== JSON.stringify(type);
  return (
    <div className={cn('grid gap-2 rounded-md border p-2 text-sm sm:grid-cols-[70px_1fr_90px_110px_110px_auto_auto_auto] sm:items-center', !t.isActive && 'opacity-60')}>
      <Input value={t.code} disabled className="h-8 font-mono" />
      <Input value={t.name} disabled={!canEdit} onChange={(e) => setT({ ...t, name: e.target.value })} className="h-8" />
      <Input type="number" step="0.5" min={0} value={t.annualDays} disabled={!canEdit || !t.paid} onChange={(e) => setT({ ...t, annualDays: Number(e.target.value) })} className="h-8" title="Days a year" />
      <select value={t.accrual} disabled={!canEdit || !t.paid} onChange={(e) => setT({ ...t, accrual: e.target.value as LeaveType['accrual'] })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
        <option value="monthly">Monthly</option><option value="yearly">Each April</option>
      </select>
      <Input type="number" step="0.5" min={0} placeholder="No limit" value={t.carryForwardMax ?? ''} disabled={!canEdit || !t.paid}
        onChange={(e) => setT({ ...t, carryForwardMax: e.target.value === '' ? null : Number(e.target.value) })} className="h-8" title="Most carried into the next year" />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Encash <Switch checked={t.encashable} disabled={!canEdit || !t.paid} onCheckedChange={(v) => setT({ ...t, encashable: v })} /></label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">In use <Switch checked={t.isActive} disabled={!canEdit} onCheckedChange={(v) => setT({ ...t, isActive: v })} /></label>
      {canEdit && <Button size="xs" variant="outline" disabled={!dirty} onClick={() => void onSave(t)}>Save</Button>}
    </div>
  );
}
