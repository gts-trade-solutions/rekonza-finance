'use client';

// Leave: each employee's balances, leave taken, opening balances, and the
// kinds of leave this book gives. Unpaid leave becomes the month's unpaid
// days when the payroll is prepared; the month's payroll accrues the leave.

import { useState } from 'react';
import { CalendarDays, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DeleteButton, RowActions, reasonQuery, useConfirmDelete } from '@/components/shared/row-actions';
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
  register: RegisterRow[];
}
interface RegisterRow {
  id: string; kind: string; days: number; from: string | null; to: string | null; note: string | null; status: string;
  employeeName: string; leaveTypeId: string; typeCode: string; typeName: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dmy = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '');
const today = () => new Date().toISOString().slice(0, 10);
const select = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';

export default function LeavePage() {
  const canEdit = usePermission('payroll', 'edit');
  const canDelete = usePermission('payroll', 'void');
  const state = useApi(() => api.get<Data>('/api/payroll/leave'), []);
  const [editing, setEditing] = useState<RegisterRow | null>(null);
  const [addingType, setAddingType] = useState(false);
  const del = useConfirmDelete();
  const KIND: Record<string, string> = { taken: 'leave', opening: 'opening balance', adjustment: 'adjustment' };
  const removeEntry = (r: RegisterRow) => del.ask({ reasonRequired: true,
    title: `Delete this ${KIND[r.kind] ?? 'leave'} of ${r.employeeName}?`,
    description: r.kind === 'taken'
      ? 'The days go back to the balance; the record stays, marked cancelled. Unpaid leave in a month whose payroll is posted stays until that payroll is reopened.'
      : 'The days come off the balance; the record stays, marked cancelled. Refused if leave already taken against it would leave the balance below nothing.',
    run: (reason) => api.delete(`/api/payroll/leave?entryId=${r.id}${reasonQuery(reason, false)}`),
    done: 'Deleted', onDone: () => void state.refetch(),
  });
  const removeType = (t: LeaveType) => del.ask({
    title: `Delete the kind of leave ${t.name}?`,
    description: 'Only a kind nobody has leave under can be deleted. One that has been used is marked as inactive instead: it leaves the forms, and the balances and records stay.',
    run: (reason) => api.delete(`/api/payroll/leave?typeId=${t.id}${reasonQuery(reason, false)}`),
    done: `${t.name} deleted`, onDone: () => void state.refetch(),
    instead: {
      label: 'Mark as inactive instead',
      run: async () => {
        await api.post('/api/payroll/leave', { action: 'save-type', id: t.id, code: t.code, name: t.name, paid: t.paid, annualDays: t.annualDays, accrual: t.accrual, carryForwardMax: t.carryForwardMax, encashable: t.encashable, isActive: false });
        toast.success(`${t.name} is inactive`);
      },
    },
  });
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
                        {r.status === 'approved' && r.kind !== 'encashed' && (
                          <RowActions className="ml-auto" onEdit={canEdit && (() => setEditing(r))} onDelete={canDelete && (() => removeEntry(r))} />
                        )}
                        {r.kind === 'encashed' && <span className="ml-auto text-[11px] text-muted-foreground">Changed through the settlement</span>}
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Kinds of leave</h3>
                  {canEdit && !addingType && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddingType(true)}><Plus className="size-3.5" /> Add a kind</Button>}
                </div>
                <p className="text-xs text-muted-foreground">Your state&apos;s Shops and Establishments Act and your own policy decide these; the defaults are a starting point. Change one in its row and Save.</p>
                <div className="space-y-2">
                  {d.types.map((t) => (
                    <LeaveTypeRow key={t.id} type={t} canEdit={canEdit} onDelete={canDelete ? () => removeType(t) : undefined}
                      onSave={(x) => post(`t${t.id}`, { action: 'save-type', id: t.id, ...x }, `${x.name} saved`)} />
                  ))}
                  {addingType && (
                    <LeaveTypeRow isNew canEdit type={{ id: '', code: '', name: '', paid: true, annualDays: 12, accrual: 'yearly', carryForwardMax: 0, encashable: false, isActive: true }}
                      onCancel={() => setAddingType(false)}
                      onSave={(x) => post('t-new', { action: 'save-type', id: null, ...x }, `${x.name} added`).then((ok) => { if (ok) setAddingType(false); return ok; })} />
                  )}
                </div>
              </Card>
            </div>
          );
        }}
      </AsyncPage>
      <LeaveEditDialog row={editing} types={state.data?.types.filter((t) => t.isActive || t.id === editing?.leaveTypeId) ?? []} onClose={() => setEditing(null)}
        onSave={async (x) => { if (await post('edit', { action: 'update', id: editing!.id, ...x }, 'Leave changed')) setEditing(null); }} busy={busy === 'edit'} />
      {del.dialog}
    </>
  );
}

/** Correct leave recorded by hand: taken leave's kind, dates and days; a balance's days and date. */
function LeaveEditDialog({ row, types, onClose, onSave, busy }: {
  row: RegisterRow | null; types: LeaveType[]; onClose: () => void; busy: boolean;
  onSave: (x: Record<string, unknown>) => Promise<void>;
}) {
  const [x, setX] = useState({ leaveTypeId: '', from: '', to: '', days: '', note: '' });
  const [shown, setShown] = useState<string | null>(null);
  if (row && shown !== row.id) {
    setShown(row.id);
    setX({ leaveTypeId: row.leaveTypeId, from: row.from ?? '', to: row.to ?? row.from ?? '', days: String(row.days), note: row.note ?? '' });
  }
  const taken = row?.kind === 'taken';
  return (
    <Dialog open={!!row} onOpenChange={(v) => { if (!v) { onClose(); setShown(null); } }}>
      <DialogContent className="sm:max-w-md" data-slot="leave-edit">
        <DialogHeader>
          <DialogTitle>Edit {taken ? 'leave' : row?.kind === 'opening' ? 'opening balance' : 'adjustment'} · {row?.employeeName}</DialogTitle>
          <DialogDescription>
            {taken ? 'The same checks as recording it: within the balance for paid leave, and no clash with other leave.' : 'The balance changes by the difference.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {taken && (
            <Field label="Leave" className="sm:col-span-2">
              <div><select value={x.leaveTypeId} onChange={(e) => setX({ ...x, leaveTypeId: e.target.value })} className={select}>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></div>
            </Field>
          )}
          <Field label={taken ? 'From' : 'On'}><Input type="date" value={x.from} onChange={(e) => setX({ ...x, from: e.target.value, to: x.to < e.target.value ? e.target.value : x.to })} /></Field>
          {taken && <Field label="To"><Input type="date" value={x.to} min={x.from} onChange={(e) => setX({ ...x, to: e.target.value })} /></Field>}
          <Field label="Days" hint={taken ? 'Blank: every day' : undefined}><Input type="number" step="0.5" value={x.days} onChange={(e) => setX({ ...x, days: e.target.value })} /></Field>
          <Field label="Note"><Input value={x.note} onChange={(e) => setX({ ...x, note: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button disabled={busy || !x.from} onClick={() => void onSave(taken
            ? { leaveTypeId: x.leaveTypeId, from: x.from, to: x.to || x.from, days: x.days ? Number(x.days) : null, note: x.note || null }
            : { date: x.from, days: Number(x.days), note: x.note || null })}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Save
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeaveTypeRow({ type, canEdit, onSave, onDelete, isNew, onCancel }: {
  type: LeaveType; canEdit: boolean; onSave: (t: Omit<LeaveType, 'id'>) => Promise<boolean>;
  onDelete?: () => void; isNew?: boolean; onCancel?: () => void;
}) {
  const [t, setT] = useState(type);
  const dirty = isNew || JSON.stringify(t) !== JSON.stringify(type);
  return (
    <div className={cn('grid gap-2 rounded-md border p-2 text-sm sm:grid-cols-[70px_1fr_90px_110px_110px_auto_auto_auto] sm:items-center', !t.isActive && 'opacity-60')}>
      <Input value={t.code} disabled={!isNew} onChange={(e) => setT({ ...t, code: e.target.value.toUpperCase() })} placeholder="ML" className="h-8 font-mono" />
      <Input value={t.name} disabled={!canEdit} onChange={(e) => setT({ ...t, name: e.target.value })} className="h-8" />
      <Input type="number" step="0.5" min={0} value={t.annualDays} disabled={!canEdit || !t.paid} onChange={(e) => setT({ ...t, annualDays: Number(e.target.value) })} className="h-8" title="Days a year" />
      <select value={t.accrual} disabled={!canEdit || !t.paid} onChange={(e) => setT({ ...t, accrual: e.target.value as LeaveType['accrual'] })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
        <option value="monthly">Monthly</option><option value="yearly">Each April</option>
      </select>
      <Input type="number" step="0.5" min={0} placeholder="No limit" value={t.carryForwardMax ?? ''} disabled={!canEdit || !t.paid}
        onChange={(e) => setT({ ...t, carryForwardMax: e.target.value === '' ? null : Number(e.target.value) })} className="h-8" title="Most carried into the next year" />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Encash <Switch checked={t.encashable} disabled={!canEdit || !t.paid} onCheckedChange={(v) => setT({ ...t, encashable: v })} /></label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">In use <Switch checked={t.isActive} disabled={!canEdit} onCheckedChange={(v) => setT({ ...t, isActive: v })} /></label>
      {canEdit && (
        <span className="flex items-center gap-1">
          <Button size="xs" variant={dirty ? 'default' : 'outline'} disabled={!dirty || !t.name.trim() || !t.code.trim()} onClick={() => void onSave(t)}>Save</Button>
          {isNew ? <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button> : onDelete && <DeleteButton onClick={onDelete} />}
        </span>
      )}
    </div>
  );
}
