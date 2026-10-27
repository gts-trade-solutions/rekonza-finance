'use client';

// Expense claims: what an employee spent for the business, with the bills
// attached. Approved claims are repaid with the payroll of the month they
// fall in, as reimbursements — not salary, so not taxed.

import Link from 'next/link';
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
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Claim {
  id: string; employeeId: string; code: string; name: string; claimDate: string; category: string; description: string | null;
  amountPaise: number; status: 'submitted' | 'approved' | 'rejected'; reviewNote: string | null;
  runId: string | null; runMonth: string | null; runStatus: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';
const TONE: Record<Claim['status'], string> = {
  submitted: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  approved: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  rejected: 'text-muted-foreground',
};

export default function ClaimsPage() {
  const canCreate = usePermission('payroll', 'create');
  const canEdit = usePermission('payroll', 'edit');
  const canApprove = usePermission('payroll', 'approve');
  const state = useApi(() => api.get<{ claims: Claim[]; categories: string[] }>('/api/payroll/claims'), []);
  const employees = useApi(() => api.get<{ employees: { id: string; code: string; name: string; dateOfLeaving: string | null }[] }>('/api/payroll/employees'), []);
  const blank = { employeeId: '', claimDate: today(), category: 'Local conveyance', description: '', amount: 0 };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/payroll/claims', {
        employeeId: f.employeeId, claimDate: f.claimDate, category: f.category, description: f.description || null, amountPaise: f.amount,
      });
      toast.success('Claim recorded', { description: 'Attach the bills to it below.' });
      setF({ ...blank, employeeId: f.employeeId });
      await state.refetch();
      setOpen(r.id);
    } catch (e) {
      if (e instanceof ApiError && e.isQueued) {
        toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
        setF({ ...blank, employeeId: f.employeeId });
        return;
      }
      toast.error('Not recorded', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const review = async (c: Claim, approve: boolean) => {
    const note = approve ? null : window.prompt(`Reject ${c.name}'s ${c.category.toLowerCase()} claim? Say why.`);
    if (!approve && !note) return;
    try {
      await api.patch('/api/payroll/claims', { id: c.id, approve, note });
      toast.success(approve ? 'Approved: repaid with the payroll for its month' : 'Rejected');
      await state.refetch();
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
    }
  };

  return (
    <>
      <PageHeader title="Expense claims" description="Expenses employees paid for the business, with the bills attached. Once approved, they are repaid with that month's salary." />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => (
          <div className="space-y-4">
            {canCreate && (
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">New claim</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Field label="Employee" required>
                    <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} className={select}>
                      <option value="">Choose…</option>
                      {(employees.data?.employees ?? []).filter((e) => !e.dateOfLeaving).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Spent on"><Input type="date" value={f.claimDate} onChange={(e) => setF({ ...f, claimDate: e.target.value })} /></Field>
                  <Field label="For">
                    <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className={select}>
                      {d.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Amount" required><MoneyInput valuePaise={f.amount} onChangePaise={(v) => setF({ ...f, amount: v })} /></Field>
                  <Field label="Details"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Auto to the client's site" /></Field>
                </div>
                <Button size="sm" className="w-fit gap-1.5" disabled={busy || !f.employeeId || !f.amount} onClick={() => void save()}>
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Record claim
                </Button>
              </Card>
            )}
            <Card className="gap-0 overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-6 px-2 py-2" />
                      <th className="px-3 py-2 font-semibold">Employee</th>
                      <th className="px-3 py-2 font-semibold">Claim</th>
                      <th className="px-3 py-2 text-right font-semibold">Amount</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.claims.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No claims yet.</td></tr>}
                    {d.claims.map((c) => {
                      const settled = !!c.runStatus && c.runStatus !== 'draft';
                      return (
                        <Fragment key={c.id}>
                          <tr className="cursor-pointer hover:bg-accent/40" onClick={() => setOpen(open === c.id ? null : c.id)}>
                            <td className="px-2 py-2 text-muted-foreground">{open === c.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
                            <td className="px-3 py-2"><p className="font-medium">{c.name}</p><p className="text-xs text-muted-foreground">{c.code}</p></td>
                            <td className="px-3 py-2">
                              <p>{c.category}{c.description ? <span className="text-muted-foreground"> · {c.description}</span> : null}</p>
                              <p className="text-xs text-muted-foreground">{new Date(`${c.claimDate}T00:00:00`).toLocaleDateString('en-IN')}</p>
                            </td>
                            <td className="px-3 py-2 text-right"><Money value={c.amountPaise} /></td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className={cn('text-[10px] capitalize', TONE[c.status])}>{c.status === 'submitted' ? 'Waiting' : c.status}</Badge>
                              {c.runMonth && (
                                <Link href={`/payroll/runs/${c.runId}`} onClick={(e) => e.stopPropagation()} className="ml-2 text-xs text-primary hover:underline">
                                  {settled ? 'Repaid' : 'On'} {c.runMonth} payroll
                                </Link>
                              )}
                              {c.reviewNote && <p className="text-xs text-muted-foreground">{c.reviewNote}</p>}
                            </td>
                            <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                              {canApprove && !settled && c.status !== 'approved' && <Button size="xs" onClick={() => void review(c, true)}>Approve</Button>}
                              {canApprove && !settled && c.status !== 'rejected' && <Button size="xs" variant="ghost" onClick={() => void review(c, false)}>Reject</Button>}
                            </td>
                          </tr>
                          {open === c.id && (
                            <tr className="bg-muted/10"><td colSpan={6} className="px-4 py-3">
                              <Attachments targetType="reimbursement_claim" targetId={c.id} canEdit={canEdit && !settled} title="Bills" />
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </AsyncPage>
    </>
  );
}
