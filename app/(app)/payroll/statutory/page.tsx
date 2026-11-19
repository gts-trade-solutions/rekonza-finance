'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Payroll → Statutory Registers: the registers an auditor or a labour
// inspector asks for, over any months, and each month's dues against what
// has been paid, with a way to pay them.
//
//   Dues & Payments  PF, ESI, PT and LWF per month: due, paid, left, due date;
//                    Pay posts Dr the payable, Cr the bank, with the challan.
//   PF Register      UAN, PF and EPS wages, employee 12%, employer EPF and
//                    EPS, EDLI, admin charges.
//   ESI Register     IP number, ESI wages, employee and employer.
//   PT Register      Professional Tax by employee and month.
//   LWF Register     Labour Welfare Fund, employee and employer.
//   TDS on Salary    the tax deducted; deposited through the TDS challans.
//
// Every register exports to Excel or CSV as it shows.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { Download, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { downloadCsv } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

type Component = 'pf' | 'esi' | 'pt' | 'lwf';
interface Line {
  month: string; employeeId: string; code: string; name: string; uan: string | null; esiIp: string | null; pan: string | null;
  grossPaise: number; pfWagePaise: number; epsWagePaise: number; pfEmployeePaise: number; epfEmployerPaise: number; epsEmployerPaise: number;
  edliPaise: number; pfAdminPaise: number; esiWagePaise: number; esiEmployeePaise: number; esiEmployerPaise: number; ptPaise: number;
  lwfEmployeePaise: number; lwfEmployerPaise: number; tdsPaise: number;
}
interface Due {
  month: string; component: Component; dueDate: string | null; duePaise: number; paidPaise: number; balancePaise: number;
  payments: { id: string; paidOn: string; amountPaise: number; reference: string | null; bank: string }[];
}

const LABEL: Record<Component, string> = { pf: 'Provident Fund', esi: 'ESI', pt: 'Professional Tax', lwf: 'Labour Welfare Fund' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const r2 = (p: number) => (p / 100).toFixed(2);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const fyStartMonth = () => {
  const d = new Date();
  return `${d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear()}-04`;
};

/** A register: its columns (label and value), its rows, totals, and an export of exactly that. */
function Register({ name, lines, cols, file }: {
  name: string; lines: Line[]; file: string;
  cols: { label: string; value: (l: Line) => string | number; money?: boolean }[];
}) {
  const months = [...new Set(lines.map((l) => l.month))];
  const exportIt = () => downloadCsv(file, [
    ['Month', 'Code', 'Employee', ...cols.map((c) => c.label)],
    ...lines.map((l) => [monthName(l.month), l.code, l.name, ...cols.map((c) => (c.money ? r2(Number(c.value(l))) : String(c.value(l) ?? '')))]),
    ['Total', '', '', ...cols.map((c) => (c.money ? r2(lines.reduce((t, l) => t + Number(c.value(l)), 0)) : ''))],
  ]);
  if (!lines.length) return <Card className="p-6 text-sm text-muted-foreground">No posted payroll in these months.</Card>;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <p className="text-sm font-medium">{name}</p>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={exportIt} data-slot={`export-${file}`}><Download className="size-3.5" /> Export</Button>
      </div>
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 text-left font-semibold">Employee</th>
              {cols.map((c) => <th key={c.label} className={`px-3 py-2 font-semibold ${c.money ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const ofMonth = lines.filter((l) => l.month === m);
              return [
                <tr key={`h-${m}`} className="bg-muted/30"><td colSpan={cols.length + 1} className="px-3 py-1.5 font-semibold">{monthName(m)}</td></tr>,
                ...ofMonth.map((l) => (
                  <tr key={`${m}-${l.employeeId}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5"><span className="font-mono text-muted-foreground">{l.code}</span> {l.name}</td>
                    {cols.map((c) => (
                      <td key={c.label} className={`whitespace-nowrap px-3 py-1.5 ${c.money ? 'text-right tabular-nums' : ''}`}>
                        {c.money ? <Money value={Number(c.value(l))} /> : (c.value(l) || '—')}
                      </td>
                    ))}
                  </tr>
                )),
                <tr key={`t-${m}`} className="border-b font-medium">
                  <td className="px-3 py-1.5 text-muted-foreground">Total {monthName(m)}</td>
                  {cols.map((c) => <td key={c.label} className="px-3 py-1.5 text-right tabular-nums">{c.money ? <Money value={ofMonth.reduce((t, l) => t + Number(c.value(l)), 0)} /> : ''}</td>)}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function StatutoryRegistersPage() {
  const canApprove = usePermission('payroll', 'approve');
  const canBank = usePermission('banking', 'create');
  const canPay = canApprove && canBank;
  const [from, setFrom] = useState(fyStartMonth());
  const [to, setTo] = useState(thisMonth());
  const state = useApi<{ lines: Line[]; dues: Due[] }>(() => api.get('/api/payroll/statutory', { from, to }), [from, to]);
  const banks = useApi<{ accounts: { id: string; name: string; kind?: string }[] }>(() => api.get('/api/banking/accounts'), []);
  const [paying, setPaying] = useState<Due | null>(null);
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const openPay = (d: Due) => { setPaying(d); setAmount(d.balancePaise); setReference(''); setDate(new Date().toISOString().slice(0, 10)); setBankId(banks.data?.accounts[0]?.id ?? ''); };
  const pay = async () => {
    if (!paying) return;
    setBusy(true);
    try {
      await api.post('/api/payroll/statutory', { component: paying.component, period: paying.month, amountPaise: amount, date, bankAccountId: bankId, reference: reference || null });
      toast.success(`${LABEL[paying.component]} for ${monthName(paying.month)} paid`, { description: 'Posted: the payable is cleared against the bank.' });
      setPaying(null);
      state.refetch();
    } catch (e) {
      toast.error('Not paid', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const money = (label: string, value: (l: Line) => number) => ({ label, value, money: true });
  const dues = useMemo(() => state.data?.dues ?? [], [state.data]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Statutory Registers"
        description="PF, ESI, Professional Tax, LWF and TDS on salary, employee by employee and month by month, with each month's dues against what has been paid."
        actions={
          <div className="flex items-end gap-2">
            <label className="space-y-0.5 text-[11px] text-muted-foreground"><span className="block">From</span>
              <Input type="month" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" aria-label="From month" />
            </label>
            <label className="space-y-0.5 text-[11px] text-muted-foreground"><span className="block">To</span>
              <Input type="month" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" aria-label="To month" />
            </label>
          </div>
        }
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => (
          <Tabs defaultValue="dues">
            <TabsList className="max-w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto">
              <TabsTrigger value="dues">Dues &amp; Payments</TabsTrigger>
              <TabsTrigger value="pf">PF Register</TabsTrigger>
              <TabsTrigger value="esi">ESI Register</TabsTrigger>
              <TabsTrigger value="pt">PT Register</TabsTrigger>
              <TabsTrigger value="lwf">LWF Register</TabsTrigger>
              <TabsTrigger value="tds">TDS on Salary</TabsTrigger>
            </TabsList>

            <TabsContent value="dues" className="mt-4">
              {dues.length === 0 ? <Card className="p-6 text-sm text-muted-foreground">No posted payroll in these months.</Card> : (
                <Card className="overflow-hidden p-0">
                  <div className="flex items-center justify-between border-b px-4 py-2.5">
                    <p className="text-sm font-medium">Dues by month</p>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadCsv('statutory-dues.csv', [
                      ['Month', 'Dues', 'Due date', 'Due', 'Paid', 'Left to pay', 'Payments'],
                      ...dues.map((x) => [monthName(x.month), LABEL[x.component], x.dueDate ?? '', r2(x.duePaise), r2(x.paidPaise), r2(x.balancePaise),
                        x.payments.map((p) => `${p.paidOn} ₹${r2(p.amountPaise)}${p.reference ? ` ${p.reference}` : ''}`).join('; ')]),
                    ])}><Download className="size-3.5" /> Export</Button>
                  </div>
                  <table className="w-full text-sm" data-slot="statutory-dues">
                    <thead>
                      <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 text-left font-semibold">Month</th>
                        <th className="px-4 py-2 text-left font-semibold">Dues</th>
                        <th className="px-4 py-2 text-left font-semibold">Due date</th>
                        <th className="px-4 py-2 text-right font-semibold">Due</th>
                        <th className="px-4 py-2 text-right font-semibold">Paid</th>
                        <th className="px-4 py-2 text-right font-semibold">Left to pay</th>
                        <th className="px-4 py-2 text-left font-semibold">Paid on</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {dues.map((x) => {
                        const late = x.balancePaise > 0 && !!x.dueDate && x.dueDate < today;
                        return (
                          <tr key={`${x.month}-${x.component}`} className="border-b last:border-0" data-slot="statutory-due">
                            <td className="px-4 py-2">{monthName(x.month)}</td>
                            <td className="px-4 py-2 font-medium">{LABEL[x.component]}</td>
                            <td className={`px-4 py-2 ${late ? 'font-medium text-red-700' : ''}`}>{x.dueDate ? new Date(`${x.dueDate}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'As the state sets'}{late ? ' · overdue' : ''}</td>
                            <td className="px-4 py-2 text-right"><Money value={x.duePaise} /></td>
                            <td className="px-4 py-2 text-right"><Money value={x.paidPaise} /></td>
                            <td className="px-4 py-2 text-right font-medium"><Money value={x.balancePaise} /></td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">
                              {x.payments.map((p) => <span key={p.id} className="block">{p.paidOn} · ₹{(p.amountPaise / 100).toLocaleString('en-IN')} · {p.bank}{p.reference ? ` · ${p.reference}` : ''}</span>)}
                            </td>
                            <td className="px-4 py-2 text-right">
                              {canPay && x.balancePaise > 0 && <Button size="xs" className="gap-1" onClick={() => openPay(x)} data-slot="statutory-pay"><Wallet className="size-3" /> Pay</Button>}
                              {x.balancePaise <= 0 && <span className="text-xs font-medium text-emerald-700">Paid</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="pf" className="mt-4">
              <Register name="Provident Fund register" file="pf-register.csv" lines={d.lines.filter((l) => l.pfEmployeePaise || l.pfWagePaise)}
                cols={[{ label: 'UAN', value: (l) => l.uan ?? '' }, money('Gross', (l) => l.grossPaise), money('PF wages', (l) => l.pfWagePaise),
                  money('EPS wages', (l) => l.epsWagePaise), money('Employee 12%', (l) => l.pfEmployeePaise), money('Employer EPF', (l) => l.epfEmployerPaise),
                  money('Employer EPS', (l) => l.epsEmployerPaise), money('EDLI', (l) => l.edliPaise), money('Admin', (l) => l.pfAdminPaise),
                  money('Total', (l) => l.pfEmployeePaise + l.epfEmployerPaise + l.epsEmployerPaise + l.edliPaise + l.pfAdminPaise)]} />
            </TabsContent>
            <TabsContent value="esi" className="mt-4">
              <Register name="ESI register" file="esi-register.csv" lines={d.lines.filter((l) => l.esiEmployeePaise || l.esiEmployerPaise)}
                cols={[{ label: 'IP number', value: (l) => l.esiIp ?? '' }, money('Gross', (l) => l.grossPaise), money('ESI wages', (l) => l.esiWagePaise),
                  money('Employee 0.75%', (l) => l.esiEmployeePaise), money('Employer 3.25%', (l) => l.esiEmployerPaise), money('Total', (l) => l.esiEmployeePaise + l.esiEmployerPaise)]} />
            </TabsContent>
            <TabsContent value="pt" className="mt-4">
              <Register name="Professional Tax register" file="pt-register.csv" lines={d.lines.filter((l) => l.ptPaise)}
                cols={[{ label: 'PAN', value: (l) => l.pan ?? '' }, money('Gross', (l) => l.grossPaise), money('Professional Tax', (l) => l.ptPaise)]} />
            </TabsContent>
            <TabsContent value="lwf" className="mt-4">
              <Register name="Labour Welfare Fund register" file="lwf-register.csv" lines={d.lines.filter((l) => l.lwfEmployeePaise || l.lwfEmployerPaise)}
                cols={[money('Gross', (l) => l.grossPaise), money('Employee', (l) => l.lwfEmployeePaise), money('Employer', (l) => l.lwfEmployerPaise), money('Total', (l) => l.lwfEmployeePaise + l.lwfEmployerPaise)]} />
            </TabsContent>
            <TabsContent value="tds" className="mt-4">
              <Register name="TDS on salary (section 192)" file="tds-salary-register.csv" lines={d.lines.filter((l) => l.tdsPaise)}
                cols={[{ label: 'PAN', value: (l) => l.pan ?? '' }, money('Gross', (l) => l.grossPaise), money('TDS', (l) => l.tdsPaise)]} />
              <p className="mt-2 text-xs text-muted-foreground">TDS on salary is deposited with a TDS challan (GST &amp; Taxes → TDS &amp; TCS) and returned on Form 24Q from Payroll.</p>
            </TabsContent>
          </Tabs>
        )}
      </AsyncPage>

      <Dialog open={!!paying} onOpenChange={(o) => !o && setPaying(null)}>
        <DialogContent data-slot="statutory-pay-dialog">
          <DialogHeader>
            <DialogTitle>Pay {paying ? `${LABEL[paying.component]} for ${monthName(paying.month)}` : ''}</DialogTitle>
            <DialogDescription>Posts Dr {paying ? LABEL[paying.component] : ''} Payable, Cr the bank, and records the challan against the month.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" required><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
            <Field label="Paid on" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Paid from" required>
              <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {(banks.data?.accounts ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label={paying?.component === 'pf' ? 'TRRN / challan no.' : 'Challan no.'}><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)}>Cancel</Button>
            <Button onClick={() => void pay()} disabled={busy || !amount || !bankId}>Pay</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
