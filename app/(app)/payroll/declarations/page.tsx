'use client';

// Investment declarations for a year, and the proofs behind them. Until
// December, TDS under the old regime is worked out on what was declared; from
// January only what the proofs bear out and someone has accepted counts, so
// the last months' TDS makes up for a declaration that was never proved.

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { Attachments } from '@/components/shared/attachments';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type Status = 'declared' | 'submitted' | 'accepted' | 'rejected';
interface Declaration {
  id: string; employeeId: string; code: string; name: string; regime: 'new' | 'old'; section: string; description: string | null;
  declaredPaise: number; provedPaise: number | null; status: Status; reviewNote: string | null;
}
interface Loaded { fy: number; sections: { key: string; label: string }[]; declarations: Declaration[] }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';
const currentFy = () => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
const LABEL: Record<Status, string> = { declared: 'Declared', submitted: 'Proof in', accepted: 'Proof accepted', rejected: 'Not accepted' };
const TONE: Record<Status, string> = {
  declared: 'text-muted-foreground', submitted: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  accepted: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300', rejected: 'border-red-500/40 text-red-700 dark:text-red-300',
};

export default function DeclarationsPage() {
  const canEdit = usePermission('payroll', 'edit');
  const canApprove = usePermission('payroll', 'approve');
  const [fy, setFy] = useState(currentFy());
  const state = useApi(() => api.get<Loaded>('/api/payroll/declarations', { fy }), [fy]);
  const employees = useApi(() => api.get<{ employees: { id: string; code: string; name: string; taxRegime: 'new' | 'old'; dateOfLeaving: string | null }[] }>('/api/payroll/employees'), []);
  const blank = { employeeId: '', section: '80C', description: '', declared: 0 };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const proof = (d: Declaration) => {
    const v = window.prompt(`What do ${d.name}'s proofs for ${d.section} bear out, in rupees?`, String((d.provedPaise ?? d.declaredPaise) / 100));
    if (v === null) return;
    const paise = Math.round(Number(v) * 100);
    if (!Number.isFinite(paise) || paise < 0) { toast.error('Give an amount in rupees.'); return; }
    void call(() => api.patch('/api/payroll/declarations', { action: 'proof', id: d.id, provedPaise: paise }), 'Proof recorded; attach the papers below');
    setOpen(d.id);
  };
  const review = (d: Declaration, accept: boolean) => {
    const note = accept ? null : window.prompt('Why is the proof not accepted?');
    if (!accept && !note) return;
    void call(() => api.patch('/api/payroll/declarations', { action: 'review', id: d.id, accept, note }), accept ? 'Proof accepted' : 'Proof not accepted');
  };

  const fyLabel = (y: number) => `${y}-${String(y + 1).slice(2)}`;
  return (
    <>
      <PageHeader
        title="Investment declarations"
        description="What each employee means to claim under the old regime, then the proofs. Declarations decide TDS until December; from January only accepted proofs count."
        actions={(
          <select value={fy} onChange={(e) => setFy(Number(e.target.value))} className={cn(select, 'w-36')} aria-label="Financial year">
            {[currentFy() + 1, currentFy(), currentFy() - 1, currentFy() - 2].map((y) => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
          </select>
        )}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => {
          const people = [...new Map(d.declarations.map((x) => [x.employeeId, x])).values()];
          return (
            <div className="space-y-4">
              {canEdit && (
                <Card className="space-y-3 p-5">
                  <h3 className="text-sm font-semibold">Add a declaration for FY {fyLabel(d.fy)}</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Employee" required>
                      <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} className={select}>
                        <option value="">Choose…</option>
                        {(employees.data?.employees ?? []).filter((e) => !e.dateOfLeaving).map((e) => (
                          <option key={e.id} value={e.id}>{e.code} · {e.name}{e.taxRegime === 'new' ? ' (new regime)' : ''}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Section">
                      <select value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} className={select}>
                        {d.sections.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </Field>
                    <Field label={f.section === 'HRA' ? 'Rent for the year' : 'Amount for the year'} required>
                      <MoneyInput valuePaise={f.declared} onChangePaise={(v) => setF({ ...f, declared: v })} />
                    </Field>
                    <Field label="Details"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={f.section === 'HRA' ? "Landlord's name and PAN" : 'PPF, LIC policy…'} /></Field>
                  </div>
                  <Button size="sm" className="w-fit gap-1.5" disabled={busy || !f.employeeId} onClick={() => void call(() => api.post('/api/payroll/declarations', {
                    employeeId: f.employeeId, fyStart: d.fy, section: f.section, description: f.description || null, declaredPaise: f.declared,
                  }), 'Declared').then((ok) => ok && setF({ ...blank, employeeId: f.employeeId }))}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
                  </Button>
                </Card>
              )}
              {people.length === 0 ? (
                <Card className="p-6 text-sm text-muted-foreground">Nothing declared for FY {fyLabel(d.fy)}. Until something is, an old-regime employee&apos;s TDS uses the single deductions figure on their record.</Card>
              ) : people.map((p) => {
                const rows = d.declarations.filter((x) => x.employeeId === p.employeeId);
                return (
                  <Card key={p.employeeId} className="gap-0 overflow-hidden p-0">
                    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
                      <span className="font-medium">{p.name}</span><span className="text-xs text-muted-foreground">{p.code}</span>
                      {p.regime === 'new' && <Badge variant="outline" className="text-[10px]">New regime: kept as a record, does not reduce TDS</Badge>}
                      <span className="ml-auto text-xs text-muted-foreground">Declared <Money value={rows.reduce((t, r) => t + r.declaredPaise, 0)} /></span>
                    </div>
                    <table className="w-full text-sm">
                      <tbody className="divide-y">
                        {rows.map((r) => (
                          <Fragment key={r.id}>
                            <tr className="cursor-pointer hover:bg-accent/40" onClick={() => setOpen(open === r.id ? null : r.id)}>
                              <td className="w-6 px-2 py-2 text-muted-foreground">{open === r.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
                              <td className="px-3 py-2"><span className="font-mono text-xs">{r.section}</span>{r.description && <span className="ml-2 text-muted-foreground">{r.description}</span>}</td>
                              <td className="px-3 py-2 text-right"><Money value={r.declaredPaise} /><p className="text-[10px] text-muted-foreground">declared</p></td>
                              <td className="px-3 py-2 text-right">{r.provedPaise !== null ? <><Money value={r.provedPaise} /><p className="text-[10px] text-muted-foreground">proved</p></> : <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-3 py-2">
                                <Badge variant="outline" className={cn('text-[10px]', TONE[r.status])}>{LABEL[r.status]}</Badge>
                                {r.reviewNote && <p className="text-xs text-muted-foreground">{r.reviewNote}</p>}
                              </td>
                              <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                {canEdit && r.status !== 'accepted' && <Button size="xs" variant="outline" onClick={() => proof(r)}>Proof</Button>}
                                {canApprove && r.status === 'submitted' && (
                                  <>
                                    <Button size="xs" className="ml-1" onClick={() => review(r, true)}>Accept</Button>
                                    <Button size="xs" variant="ghost" onClick={() => review(r, false)}>Reject</Button>
                                  </>
                                )}
                              </td>
                            </tr>
                            {open === r.id && (
                              <tr className="bg-muted/10"><td colSpan={6} className="px-4 py-3">
                                <Attachments targetType="tax_declaration" targetId={r.id} canEdit={canEdit && r.status !== 'accepted'} title="Proofs" />
                              </td></tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                );
              })}
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
