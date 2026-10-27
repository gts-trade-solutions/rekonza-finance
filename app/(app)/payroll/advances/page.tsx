'use client';

// Salary advances and loans: given from a bank account, recovered from salary
// a monthly instalment at a time, with what is still owed always in view.

import { useState } from 'react';
import { HandCoins, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Loan {
  id: string; employeeId: string; code: string; name: string; kind: 'advance' | 'loan'; amountPaise: number; instalmentPaise: number;
  givenOn: string; firstMonth: string; status: 'active' | 'cancelled'; notes: string | null; recoveredPaise: number; balancePaise: number;
}
interface Employee { id: string; code: string; name: string; dateOfLeaving: string | null }

const today = () => new Date().toISOString().slice(0, 10);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';
const dmy = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function AdvancesPage() {
  const canApprove = usePermission('payroll', 'approve');
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank' || b.kind === 'cash');
  const state = useApi(() => api.get<{ loans: Loan[] }>('/api/payroll/loans'), []);
  const employees = useApi(() => api.get<{ employees: Employee[] }>('/api/payroll/employees'), []);
  const blank = { employeeId: '', kind: 'advance' as 'advance' | 'loan', amount: 0, instalment: 0, givenOn: today(), firstMonth: today().slice(0, 7), bankAccountId: '', notes: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);

  const give = async () => {
    setBusy(true);
    try {
      await api.post('/api/payroll/loans', {
        employeeId: f.employeeId, kind: f.kind, amountPaise: f.amount, instalmentPaise: f.instalment, givenOn: f.givenOn,
        firstMonth: f.firstMonth, bankAccountId: f.bankAccountId, notes: f.notes || null,
      });
      toast.success(f.kind === 'loan' ? 'Loan given' : 'Advance given', { description: 'Paid from the bank and recovered with each payroll from now.' });
      setF({ ...blank, bankAccountId: f.bankAccountId });
      await state.refetch();
    } catch (e) {
      toast.error('Not given', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (l: Loan) => {
    const reason = window.prompt(`Cancel the ${l.kind} to ${l.name}? The payment out is reversed. Give the reason.`);
    if (!reason) return;
    try {
      await api.patch('/api/payroll/loans', { id: l.id, reason });
      toast.success('Cancelled');
      await state.refetch();
    } catch (e) {
      toast.error('Not cancelled', { description: errorText(e) });
    }
  };

  const months = f.instalment > 0 ? Math.ceil(f.amount / f.instalment) : 0;
  return (
    <>
      <PageHeader title="Advances & loans" description="Money lent to employees, recovered from salary by monthly instalment. Each payroll takes the instalment; never more than the month leaves to pay." />
      <div className="space-y-4">
        {canApprove && (
          <Card className="space-y-3 p-5">
            <h3 className="text-sm font-semibold">Give an advance or a loan</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Employee" required>
                <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} className={select}>
                  <option value="">Choose…</option>
                  {(employees.data?.employees ?? []).filter((e) => !e.dateOfLeaving).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                </select>
              </Field>
              <Field label="Kind">
                <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'advance' | 'loan' })} className={select}>
                  <option value="advance">Salary advance</option>
                  <option value="loan">Loan</option>
                </select>
              </Field>
              <Field label="Amount" required><MoneyInput valuePaise={f.amount} onChangePaise={(v) => setF({ ...f, amount: v })} /></Field>
              <Field label="Recovered a month" required hint={months ? `${months} month${months === 1 ? '' : 's'}` : undefined}>
                <MoneyInput valuePaise={f.instalment} onChangePaise={(v) => setF({ ...f, instalment: v })} />
              </Field>
              <Field label="Given on"><Input type="date" value={f.givenOn} onChange={(e) => setF({ ...f, givenOn: e.target.value })} /></Field>
              <Field label="Recovery from"><Input type="month" value={f.firstMonth} onChange={(e) => setF({ ...f, firstMonth: e.target.value })} /></Field>
              <Field label="Paid from" required>
                <select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })} className={select}>
                  <option value="">Choose…</option>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Note"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Medical emergency" /></Field>
            </div>
            <Button size="sm" className="w-fit gap-1.5" disabled={busy || !f.employeeId || !f.amount || !f.instalment || !f.bankAccountId} onClick={() => void give()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <HandCoins className="size-3.5" />} Give it
            </Button>
          </Card>
        )}

        <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
          {(d) => (
            <Card className="gap-0 overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-semibold">Employee</th>
                      <th className="px-3 py-2 font-semibold">Given</th>
                      <th className="px-3 py-2 text-right font-semibold">Amount</th>
                      <th className="px-3 py-2 text-right font-semibold">A month</th>
                      <th className="px-3 py-2 text-right font-semibold">Recovered</th>
                      <th className="px-3 py-2 text-right font-semibold">Still owed</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.loans.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No advances or loans.</td></tr>}
                    {d.loans.map((l) => (
                      <tr key={l.id} className={cn(l.status === 'cancelled' && 'text-muted-foreground line-through')}>
                        <td className="px-3 py-2">
                          <p className="font-medium">{l.name}</p>
                          <p className="text-xs text-muted-foreground no-underline">{l.code} · {l.kind === 'loan' ? 'Loan' : 'Advance'}{l.notes ? ` · ${l.notes}` : ''}</p>
                        </td>
                        <td className="px-3 py-2 text-xs">{dmy(l.givenOn)}<p className="text-muted-foreground">from {l.firstMonth}</p></td>
                        <td className="px-3 py-2 text-right"><Money value={l.amountPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={l.instalmentPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={l.recoveredPaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right font-medium">
                          {l.status === 'cancelled' ? <Badge variant="outline" className="text-[10px]">Cancelled</Badge>
                            : l.balancePaise === 0 ? <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300">Recovered</Badge>
                              : <Money value={l.balancePaise} />}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canApprove && l.status === 'active' && l.recoveredPaise === 0 && (
                            <Button size="xs" variant="ghost" onClick={() => void cancel(l)}>Cancel</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </AsyncPage>
      </div>
    </>
  );
}
