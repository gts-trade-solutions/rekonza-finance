'use client';

// Full and final settlement: gratuity, leave encashed, notice paid or
// recovered, other recoveries and tax — worked out, checked, posted and paid.
// The last month's salary is paid by that month's payroll, to the last day.

import { useState } from 'react';
import { HandCoins, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';

interface Statement {
  name: string; joined: string; lastDay: string; monthlyBasicDaPaise: number; monthlyGrossPaise: number;
  years: { completed: number; counted: number }; gratuityEligible: boolean; gratuityPaise: number; gratuityCapped: boolean;
  encashDays: number; encashableDays: number; encashmentPaise: number; noticePayPaise: number; noticeRecoveryPaise: number;
  otherEarningsPaise: number; otherRecoveriesPaise: number; tdsPaise: number; netPaise: number;
}
interface Settlement { id: string; name: string; code: string; lastDay: string; netPaise: number; status: 'posted' | 'paid' | 'reversed'; paidOn: string | null; statement: Statement }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dmy = (d: string) => new Date(d).toLocaleDateString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

export default function FullAndFinalPage() {
  const canApprove = usePermission('payroll', 'approve');
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const list = useApi(() => api.get<{ settlements: Settlement[] }>('/api/payroll/fnf'), []);
  const employees = useApi(() => api.get<{ employees: { id: string; code: string; name: string; dateOfLeaving: string | null }[] }>('/api/payroll/employees'), []);
  const [f, setF] = useState({
    employeeId: '', lastDay: today(), waiveFiveYears: false, encashDays: '', encashDivisor: 26 as 26 | 30,
    noticePayDays: '', noticeShortDays: '', otherEarningsPaise: 0, otherRecoveriesPaise: 0, tdsPaise: 0,
  });
  const [preview, setPreview] = useState<Statement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pay, setPay] = useState<{ id: string; bankAccountId: string; date: string } | null>(null);

  const payload = () => ({
    employeeId: f.employeeId, lastDay: f.lastDay, waiveFiveYears: f.waiveFiveYears, encashDays: f.encashDays === '' ? null : Number(f.encashDays),
    encashDivisor: f.encashDivisor, noticePayDays: Number(f.noticePayDays) || 0, noticeShortDays: Number(f.noticeShortDays) || 0,
    otherEarningsPaise: f.otherEarningsPaise, otherRecoveriesPaise: f.otherRecoveriesPaise, tdsPaise: f.tdsPaise,
  });
  const run = async <T,>(key: string, body: Record<string, unknown>, then: (r: T) => void) => {
    setBusy(key);
    try {
      then(await api.post<T>('/api/payroll/fnf', body));
    } catch (e) {
      toast.error('Not done', { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const row = (label: string, paise: number, hint?: string, minus = false) => (
    <tr className="border-b last:border-0">
      <td className="py-1.5 pr-3">{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</td>
      <td className="py-1.5 text-right"><Money value={minus ? -paise : paise} /></td>
    </tr>
  );

  return (
    <>
      <PageHeader title="Full & final settlement" description="Gratuity, leave encashed, notice and recoveries for someone leaving. Their last month's salary is paid by that month's payroll, to the last day." />
      <div className="space-y-4">
        {canApprove && (
          <Card className="space-y-4 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><HandCoins className="size-4 text-muted-foreground" /> New settlement</h3>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Employee">
                <div><select value={f.employeeId} onChange={(e) => { setF({ ...f, employeeId: e.target.value }); setPreview(null); }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Choose</option>
                  {(employees.data?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                </select></div>
              </Field>
              <Field label="Last working day"><Input type="date" value={f.lastDay} onChange={(e) => { setF({ ...f, lastDay: e.target.value }); setPreview(null); }} /></Field>
              <Field label="Leave to encash (days)" hint="Blank: the whole encashable balance"><Input type="number" step="0.5" min={0} value={f.encashDays} onChange={(e) => setF({ ...f, encashDays: e.target.value })} /></Field>
              <Field label="Encashment: days in a month">
                <div><select value={f.encashDivisor} onChange={(e) => setF({ ...f, encashDivisor: Number(e.target.value) as 26 | 30 })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value={26}>26</option><option value={30}>30</option>
                </select></div>
              </Field>
              <Field label="Notice paid in lieu (days)"><Input type="number" min={0} value={f.noticePayDays} onChange={(e) => setF({ ...f, noticePayDays: e.target.value })} /></Field>
              <Field label="Notice not served (days)"><Input type="number" min={0} value={f.noticeShortDays} onChange={(e) => setF({ ...f, noticeShortDays: e.target.value })} /></Field>
              <Field label="Other payments"><MoneyInput valuePaise={f.otherEarningsPaise} onChangePaise={(p) => setF({ ...f, otherEarningsPaise: p })} /></Field>
              <Field label="Advances and other recoveries"><MoneyInput valuePaise={f.otherRecoveriesPaise} onChangePaise={(p) => setF({ ...f, otherRecoveriesPaise: p })} /></Field>
              <Field label="TDS" hint="Gratuity exempt to ₹20 lakh; encashment to ₹25 lakh"><MoneyInput valuePaise={f.tdsPaise} onChangePaise={(p) => setF({ ...f, tdsPaise: p })} /></Field>
              <label className="flex items-center gap-2 self-end pb-2 text-xs text-muted-foreground">
                <Checkbox checked={f.waiveFiveYears} onCheckedChange={(v) => setF({ ...f, waiveFiveYears: !!v })} /> Death or disablement (gratuity without five years)
              </label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!f.employeeId || busy === 'preview'} onClick={() => void run<Statement>('preview', { action: 'preview', ...payload() }, setPreview)}>
                {busy === 'preview' && <Loader2 className="size-3.5 animate-spin" />} Work it out
              </Button>
              {preview && (
                <Button size="sm" disabled={busy === 'post'} onClick={() => window.confirm(`Post ${preview.name}'s settlement and set their last day to ${dmy(preview.lastDay)}?`) &&
                  void run('post', { action: 'post', ...payload() }, () => { toast.success('Settlement posted'); setPreview(null); void list.refetch(); })}>
                  {busy === 'post' && <Loader2 className="size-3.5 animate-spin" />} Post settlement
                </Button>
              )}
            </div>
            {preview && (
              <div className="max-w-xl rounded-md border p-4">
                <p className="text-sm font-medium">{preview.name}: joined {dmy(preview.joined)}, last day {dmy(preview.lastDay)}</p>
                <p className="mb-2 text-xs text-muted-foreground">
                  {preview.years.completed} completed year(s), counted as {preview.years.counted} · basic and DA <Money value={preview.monthlyBasicDaPaise} /> a month
                </p>
                <table className="w-full text-sm"><tbody>
                  {row('Gratuity', preview.gratuityPaise, preview.gratuityEligible ? `15/26 × basic and DA × ${preview.years.counted}${preview.gratuityCapped ? ', held to ₹20 lakh' : ''}` : 'Not due: less than five years of service')}
                  {row('Leave encashed', preview.encashmentPaise, `${preview.encashDays} of ${preview.encashableDays} day(s) encashable`)}
                  {preview.noticePayPaise > 0 && row('Notice pay in lieu', preview.noticePayPaise)}
                  {preview.otherEarningsPaise > 0 && row('Other payments', preview.otherEarningsPaise)}
                  {preview.noticeRecoveryPaise > 0 && row('Less: notice not served', preview.noticeRecoveryPaise, undefined, true)}
                  {preview.otherRecoveriesPaise > 0 && row('Less: recoveries', preview.otherRecoveriesPaise, undefined, true)}
                  {preview.tdsPaise > 0 && row('Less: TDS', preview.tdsPaise, undefined, true)}
                  <tr className="border-t-2 font-semibold"><td className="py-2">{preview.netPaise >= 0 ? 'Payable' : 'Owed by the employee'}</td><td className="py-2 text-right"><Money value={Math.abs(preview.netPaise)} /></td></tr>
                </tbody></table>
              </div>
            )}
          </Card>
        )}

        <AsyncPage state={list} loading={<LoadingRows rows={3} />}>
          {(d) => d.settlements.length === 0 ? null : (
            <Card className="p-0">
              <ul className="divide-y text-sm">
                {d.settlements.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">left {dmy(s.lastDay)} · gratuity <Money value={s.statement.gratuityPaise} /> · leave <Money value={s.statement.encashmentPaise} /></span>
                    <Badge variant="outline" className="capitalize">{s.status}{s.paidOn ? ` ${dmy(s.paidOn)}` : ''}</Badge>
                    <Money value={s.netPaise} className="ml-auto font-semibold" />
                    {canApprove && s.status === 'posted' && s.netPaise > 0 && (
                      pay?.id === s.id ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <select value={pay.bankAccountId} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                            <option value="">Bank</option>
                            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                          <Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} className="h-8 w-36" />
                          <Button size="xs" disabled={!pay.bankAccountId || busy === s.id}
                            onClick={() => void run(s.id, { action: 'pay', ...pay }, () => { toast.success('Paid'); setPay(null); void list.refetch(); })}>Record payment</Button>
                        </span>
                      ) : <Button size="xs" variant="outline" onClick={() => setPay({ id: s.id, bankAccountId: banks[0]?.id ?? '', date: today() })}>Pay</Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </AsyncPage>
      </div>
    </>
  );
}
