'use client';

// A quarter's TDS / TCS return, and the challans that deposited the tax.
//
// The return is checked before it is filed, not after: every month's
// deductions against what was deposited for it and by when. A deduction with
// no challan behind it is what TRACES sends a default notice about.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { downloadCsv, ReportTable } from '@/components/shared/report-shell';
import { tdsReturns, type TdsQuarterResponse } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

const currentFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};
const currentQuarter = () => {
  const m = new Date().getMonth() + 1;
  return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4;
};
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

const STATUS = {
  paid: { label: 'Deposited', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  short: { label: 'Short', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
  unpaid: { label: 'Not deposited', tone: 'border-red-500/40 text-red-700 dark:text-red-300' },
  nothing_due: { label: 'Nothing due', tone: 'text-muted-foreground' },
} as const;

export function TdsQuarterReturn() {
  const [fy, setFy] = useState(currentFy());
  const [quarter, setQuarter] = useState(currentQuarter());
  const state = useApi<TdsQuarterResponse>(() => tdsReturns.get(fy, quarter), [fy, quarter]);
  const canCreate = usePermission('gst', 'create');
  const banks = useAppStore((s) => s.bankAccounts);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    kind: 'tds' as 'tds' | 'tcs', forMonth: '', date: '', bsrCode: '', serial: '',
    taxPaise: 0, interestPaise: 0, feePaise: 0, bankAccountId: '',
  });
  const record = useApiAction(tdsReturns.recordChallan);

  const exportForm = (d: TdsQuarterResponse, i: number) => {
    const form = d.forms[i];
    downloadCsv(`${form.form.replace(' ', '')}-FY${d.fy}-Q${d.quarter}.csv`, [
      ['Deductee', 'PAN', 'Section', 'Document', 'Date of credit', 'Amount', 'Rate %', 'Tax', 'Challan BSR', 'Challan date', 'Challan serial'],
      ...form.rows.map((r) => {
        const dep = (form.kind === 'tcs' ? d.deposits.tcs : d.deposits.tds).find((m) => m.month === r.month);
        const ch = dep?.challans[0];
        return [
          r.partyName, r.pan ?? 'PANNOTAVBL', r.sectionLabel, r.docNumber, r.date,
          toRupees(r.amountPaise), r.ratePct, toRupees(r.taxPaise),
          ch?.bsrCode ?? '', ch?.date ?? '', ch?.serial ?? '',
        ];
      }),
    ]);
    toast.success(`${form.form} rows exported`, {
      description: 'Import them into the Return Preparation Utility, or hand them to your filing service.',
    });
  };

  const save = async () => {
    const done = await record.run({ ...f, bankAccountId: f.bankAccountId });
    if (!done) return;
    toast.success('Challan recorded', { description: 'The payment is posted against the tax held.' });
    setOpen(false);
    state.refetch();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[0, 1, 2, 3].map((i) => {
              const y = currentFy() - i;
              return <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>;
            })}
          </SelectContent>
        </Select>
        <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v) as 1 | 2 | 3 | 4)}>
          <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Q1 · April–June</SelectItem>
            <SelectItem value="2">Q2 · July–September</SelectItem>
            <SelectItem value="3">Q3 · October–December</SelectItem>
            <SelectItem value="4">Q4 · January–March</SelectItem>
          </SelectContent>
        </Select>
        {canCreate && (
          <Button size="sm" className="ml-auto gap-1.5" onClick={() => { record.reset(); setOpen(true); }}>
            <Plus className="size-3.5" /> Record challan
          </Button>
        )}
      </div>

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => (
          <>
            <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
              <span>TAN <span className="font-mono font-medium">{d.tan ?? '—'}</span></span>
              <span>Return due <span className="font-medium">{fmt(d.returnDueDate)}</span></span>
              <span>
                Responsible{' '}
                <span className="font-medium">
                  {d.deductor.responsible.name
                    ? `${d.deductor.responsible.name}${d.deductor.responsible.designation ? `, ${d.deductor.responsible.designation}` : ''}`
                    : '—'}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                Certificates to deductees (Form 131, earlier 16A) are downloaded from TRACES after the return is filed.
              </span>
            </Card>

            {d.issues.map((i) => (
              <Card key={i.message} className={cn('flex items-start gap-2 p-3',
                i.level === 'error' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5')}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p className="text-sm">{i.message}</p>
              </Card>
            ))}

            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className={`${th} text-left`}>Month</th>
                  <th className={`${th} text-right`}>Deducted</th>
                  <th className={`${th} text-right`}>Deposited</th>
                  <th className={`${th} text-left`}>Due by</th>
                  <th className={`${th} text-left`}>Challans</th>
                  <th className={`${th} text-left`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.deposits.tds.map((m) => (
                  <tr key={m.month} className="border-b last:border-0">
                    <td className="px-3 py-2 text-sm">{monthName(m.month)}</td>
                    <td className="px-3 py-2 text-right"><Money value={m.deductedPaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={m.depositedPaise} /></td>
                    <td className="px-3 py-2 text-xs">{fmt(m.dueDate)}{m.daysLate > 0 && <span className="block text-amber-600">{m.daysLate} days late</span>}</td>
                    <td className="px-3 py-2 font-mono text-[10px]">
                      {m.challans.map((c) => <span key={c.id} className="block">{c.bsrCode}/{c.serial} · {fmt(c.date)}</span>)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn('text-[10px]', STATUS[m.status].tone)}>{STATUS[m.status].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>

            {d.forms.length === 0 && (
              <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4" /> Nothing was deducted or collected in this quarter, so there is no return to file.
              </Card>
            )}

            {d.forms.map((form, i) => (
              <ReportTable key={form.form}>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`} colSpan={4}>
                      {form.form} — {form.kind === 'tcs' ? 'TCS collected' : form.kind === 'non_resident' ? 'payments to non-residents' : 'payments to residents'}
                    </th>
                    <th className={`${th} text-right`} colSpan={2}>
                      <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]" onClick={() => exportForm(d, i)}>
                        <Download className="size-3" /> Export rows
                      </Button>
                    </th>
                  </tr>
                  <tr className="border-b">
                    <th className={`${th} text-left`}>Party</th>
                    <th className={`${th} text-left`}>PAN</th>
                    <th className={`${th} text-left`}>Section</th>
                    <th className={`${th} text-left`}>Date</th>
                    <th className={`${th} text-right`}>Amount</th>
                    <th className={`${th} text-right`}>Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {form.rows.map((r) => (
                    <tr key={r.docId} className="border-b last:border-0">
                      <td className="px-3 py-2 text-sm">{r.partyName}<span className="block text-[10px] text-muted-foreground">{r.docNumber}</span></td>
                      <td className="px-3 py-2 font-mono text-[10px]">{r.pan ?? <span className="text-destructive">No PAN</span>}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.sectionLabel}
                        {r.remark && (
                          <span className="block text-[10px] text-muted-foreground"
                            title={r.remark === 'A' ? 'Lower or nil deduction under a certificate' : 'Higher rate: no PAN, or PAN inoperative'}>
                            Remark {r.remark}{r.lowerCertificateNo ? ` · cert ${r.lowerCertificateNo}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">{fmt(r.date)}</td>
                      <td className="px-3 py-2 text-right"><Money value={r.amountPaise} /></td>
                      <td className="px-3 py-2 text-right"><Money value={r.taxPaise} /><span className="block text-[10px] text-muted-foreground">{r.ratePct}%</span></td>
                    </tr>
                  ))}
                  <tr className="bg-muted/30 font-semibold">
                    <td className="px-3 py-2" colSpan={5}>Total</td>
                    <td className="px-3 py-2 text-right"><Money value={form.totalTaxPaise} /></td>
                  </tr>
                </tbody>
              </ReportTable>
            ))}
          </>
        )}
      </AsyncPage>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a challan</DialogTitle>
            <DialogDescription>
              From the challan receipt (ITNS 281). The BSR code, date and serial number are what the return and TRACES match on.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tax">
              <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as 'tds' | 'tcs' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tds">TDS deducted</SelectItem>
                  <SelectItem value="tcs">TCS collected</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="For the month of" required>
              <Input type="month" value={f.forMonth} onChange={(e) => setF({ ...f, forMonth: e.target.value })} />
            </Field>
            <Field label="Paid on" required>
              <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </Field>
            <Field label="Paid from" required>
              <Select value={f.bankAccountId} onValueChange={(v) => setF({ ...f, bankAccountId: v })}>
                <SelectTrigger><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>
                  {banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="BSR code" required hint="7 digits">
              <Input value={f.bsrCode} maxLength={7} className="font-mono"
                onChange={(e) => setF({ ...f, bsrCode: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Challan serial" required hint="Up to 5 digits">
              <Input value={f.serial} maxLength={5} className="font-mono"
                onChange={(e) => setF({ ...f, serial: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Tax deposited">
              <MoneyInput valuePaise={f.taxPaise} onChangePaise={(p) => setF({ ...f, taxPaise: p })} />
            </Field>
            <Field label="Interest">
              <MoneyInput valuePaise={f.interestPaise} onChangePaise={(p) => setF({ ...f, interestPaise: p })} />
            </Field>
            <Field label="Late fee" className="sm:col-span-2">
              <MoneyInput valuePaise={f.feePaise} onChangePaise={(p) => setF({ ...f, feePaise: p })} />
            </Field>
            {record.error && <p className="text-sm text-destructive sm:col-span-2">{record.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={record.busy || !f.forMonth || !f.date || !f.bankAccountId}>
              {record.busy ? 'Saving…' : 'Record challan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
