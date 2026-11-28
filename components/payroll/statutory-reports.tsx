'use client';

// Payroll → Statutory Reports, report by report (status review 7, item 10).
// Each report shows its register, its government file where one exists, and a
// tie box: the register's total against what the pay runs posted to the
// payable in the ledger, and what was paid against what left the ledger.

import { useState } from 'react';
import { CheckCircle2, Download, FileText, Link2, Plus, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { downloadCsv } from '@/components/shared/report-shell';
import { RowActions, reasonQuery, useConfirmDelete } from '@/components/shared/row-actions';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { api, payrollStatutory, type Form24QData, type SalaryChallanRow, type StatTie } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook } from '@/lib/xlsx';
import { useAppStore } from '@/lib/store';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const r2 = (p: number) => (p / 100).toFixed(2);
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-1.5';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const saveText = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** The register against the ledger: what the pay runs posted to the payable, and what was paid out of it. */
export function TieBox({ tie, payable, paidLabel = 'Paid' }: { tie: StatTie; payable: string; paidLabel?: string }) {
  return (
    <div className={`rounded-md border p-3 text-xs ${tie.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'}`} data-slot="stat-tie">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        {tie.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-destructive" />}
        {tie.ok ? `Reconciles with the pay runs and ${payable} in the ledger` : `Differs from ${payable} in the ledger`}
      </p>
      <div className="mt-2 grid max-w-2xl grid-cols-[1fr_auto_auto] gap-x-6 gap-y-1">
        <span />
        <span className="text-[10px] uppercase text-muted-foreground">Register</span>
        <span className="text-[10px] uppercase text-muted-foreground">Ledger</span>
        <span>Deducted and contributed (posted by the pay runs{tie.importedPaise ? ' and imported registers' : ''})</span><Money value={tie.registerPaise} /><Money value={tie.ledgerPostedPaise} />
        <span>{paidLabel}</span><Money value={tie.paidPaise} /><Money value={tie.ledgerPaidPaise} />
        <span className="font-medium">Left to pay</span><Money value={tie.registerPaise - tie.paidPaise} className="font-medium" /><Money value={tie.ledgerPostedPaise - tie.ledgerPaidPaise} className="font-medium" />
      </div>
    </div>
  );
}

function Empty({ what }: { what: string }) {
  return <Card className="p-6 text-sm text-muted-foreground" data-slot="stat-empty">No posted payroll with {what} in these months. Post a month&apos;s payroll (Payroll → Payroll), and it shows here.</Card>;
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
      <p className="text-sm font-medium">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

// ── PF ──────────────────────────────────────────────────────────────────────

export function PfTab({ from, to }: { from: string; to: string }) {
  const state = useApi(() => payrollStatutory.pf(from, to), [from, to]);
  const d = state.data;
  if (!d) return <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card>;
  if (!d.rows.length) return <Empty what="PF" />;
  const cols = ['UAN', 'Gross wages', 'EPF wages', 'EPS wages', 'EDLI wages', 'EPF (EE) 12%', 'EPS (ER) 8.33%', 'EPF–EPS diff (ER)', 'Admin', 'EDLI', 'NCP days', 'Total'];
  const exportIt = () => downloadCsv(`pf-register-${from}-${to}.csv`, [
    ['Month', 'Code', 'Member', ...cols],
    ...d.rows.map((r) => [monthName(r.month), r.code, r.name, r.uan ?? '', r2(r.grossPaise), r2(r.epfWagesPaise), r2(r.epsWagesPaise), r2(r.edliWagesPaise), r2(r.eePaise), r2(r.epsPaise), r2(r.erDiffPaise), r2(r.adminPaise), r2(r.edliPaise), r.ncpDays, r2(r.totalPaise)]),
    ['Total', '', '', '', '', '', '', '', r2(d.rows.reduce((t, r) => t + r.eePaise, 0)), r2(d.rows.reduce((t, r) => t + r.epsPaise, 0)), r2(d.rows.reduce((t, r) => t + r.erDiffPaise, 0)), r2(d.rows.reduce((t, r) => t + r.adminPaise, 0)), r2(d.rows.reduce((t, r) => t + r.edliPaise, 0)), '', r2(d.totalPaise)],
  ]);
  return (
    <div className="space-y-4" data-slot="pf-report">
      <Card className="overflow-hidden p-0">
        <Head title="PF register by employee (EPF & MP Act, 1952)"><Button size="sm" variant="outline" className="gap-1.5" onClick={exportIt} data-slot="pf-export"><Download className="size-3.5" /> Export</Button></Head>
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Member</th>{cols.map((c) => <th key={c} className={`${th} ${c === 'UAN' ? 'text-left' : 'text-right'}`}>{c}</th>)}</tr></thead>
            <tbody>
              {[...new Set(d.rows.map((r) => r.month))].map((m) => {
                const mine = d.rows.filter((r) => r.month === m);
                return [
                  <tr key={`h${m}`} className="bg-muted/30"><td colSpan={cols.length + 1} className="px-3 py-1.5 font-semibold">{monthName(m)}</td></tr>,
                  ...mine.map((r) => (
                    <tr key={`${m}-${r.employeeId}`} className="border-b" data-slot="pf-row">
                      <td className={`${td} whitespace-nowrap`}><span className="font-mono text-muted-foreground">{r.code}</span> {r.name}</td>
                      <td className={`${td} font-mono`}>{r.uan ?? '—'}</td>
                      {[r.grossPaise, r.epfWagesPaise, r.epsWagesPaise, r.edliWagesPaise, r.eePaise, r.epsPaise, r.erDiffPaise, r.adminPaise, r.edliPaise].map((v, i) => <td key={i} className={`${td} text-right`}><Money value={v} /></td>)}
                      <td className={`${td} text-right`}>{r.ncpDays}</td>
                      <td className={`${td} text-right font-medium`}><Money value={r.totalPaise} /></td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="overflow-hidden p-0" data-slot="pf-ecr">
        <Head title="ECR 2.0 upload, month by month (EPFO unified portal)" />
        <table className="w-full text-xs">
          <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-right`}>Members</th><th className={`${th} text-right`}>A/c 1 (EE + ER diff)</th><th className={`${th} text-right`}>A/c 2 admin</th><th className={`${th} text-right`}>A/c 10 EPS</th><th className={`${th} text-right`}>A/c 21 EDLI</th><th className={th} /></tr></thead>
          <tbody>
            {d.ecr.map((e) => (
              <tr key={e.month} className="border-b last:border-0">
                <td className={td}>{monthName(e.month)}{e.missing.length > 0 && <span className="block text-[11px] text-amber-700">No UAN, left out: {e.missing.join(', ')}</span>}</td>
                <td className={`${td} text-right`}>{e.members}</td>
                <td className={`${td} text-right`}><Money value={e.challan.ac1Paise} /></td>
                <td className={`${td} text-right`}><Money value={e.challan.ac2Paise} /></td>
                <td className={`${td} text-right`}><Money value={e.challan.ac10Paise} /></td>
                <td className={`${td} text-right`}><Money value={e.challan.ac21Paise} /></td>
                <td className={`${td} text-right`}><Button size="xs" variant="outline" className="gap-1" disabled={!e.text} onClick={() => saveText(`ECR-${e.month}.txt`, e.text)} data-slot="pf-ecr-download"><Download className="size-3" /> ECR text</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-2 text-[11px] text-muted-foreground">One member a line, fields joined by #~#: UAN, name, gross wages, EPF wages, EPS wages, EDLI wages, EPF contribution (EE), EPS contribution, EPF–EPS difference (ER), NCP days, refund of advances — whole rupees, as the portal&apos;s ECR 2.0 takes it.</p>
      </Card>
      <TieBox tie={d.tie} payable="PF Payable" />
    </div>
  );
}

// ── ESI ─────────────────────────────────────────────────────────────────────

export function EsiTab({ from, to }: { from: string; to: string }) {
  const state = useApi(() => payrollStatutory.esi(from, to), [from, to]);
  const d = state.data;
  if (!d) return <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card>;
  if (!d.rows.length) return <Empty what="ESI" />;
  const REASON: Record<number, string> = { 0: '—', 1: '1 On leave', 2: '2 Left service' };
  return (
    <div className="space-y-4" data-slot="esi-report">
      <Card className="overflow-hidden p-0">
        <Head title="ESI register (employee 0.75%, employer 3.25%)">
          <Button size="sm" variant="outline" className="gap-1.5" data-slot="esi-export" onClick={() => downloadCsv(`esi-register-${from}-${to}.csv`, [
            ['Month', 'Code', 'IP name', 'IP number', 'Days paid', 'Wages', 'Employee 0.75%', 'Employer 3.25%', 'Total', 'Reason code', 'Last working day'],
            ...d.rows.map((r) => [monthName(r.month), r.code, r.name, r.ipNumber ?? '', r.paidDays, r2(r.wagesPaise), r2(r.eePaise), r2(r.erPaise), r2(r.eePaise + r.erPaise), r.reasonCode, r.lastWorkingDay]),
            ['Total', '', '', '', '', r2(d.rows.reduce((t, r) => t + r.wagesPaise, 0)), r2(d.rows.reduce((t, r) => t + r.eePaise, 0)), r2(d.rows.reduce((t, r) => t + r.erPaise, 0)), r2(d.totalPaise), '', ''],
          ])}><Download className="size-3.5" /> Export</Button>
        </Head>
        <table className="w-full text-xs">
          <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>Insured person</th><th className={`${th} text-left`}>IP number</th><th className={`${th} text-right`}>Days</th><th className={`${th} text-right`}>Wages</th><th className={`${th} text-right`}>Employee</th><th className={`${th} text-right`}>Employer</th><th className={`${th} text-left`}>Reason</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={`${r.month}-${r.employeeId}`} className="border-b last:border-0" data-slot="esi-row">
                <td className={td}>{monthName(r.month)}</td><td className={td}><span className="font-mono text-muted-foreground">{r.code}</span> {r.name}</td><td className={`${td} font-mono`}>{r.ipNumber ?? '—'}</td>
                <td className={`${td} text-right`}>{r.paidDays}</td><td className={`${td} text-right`}><Money value={r.wagesPaise} /></td>
                <td className={`${td} text-right`}><Money value={r.eePaise} /></td><td className={`${td} text-right`}><Money value={r.erPaise} /></td>
                <td className={td}>{REASON[r.reasonCode] ?? r.reasonCode}{r.lastWorkingDay ? ` · ${r.lastWorkingDay}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="overflow-hidden p-0" data-slot="esi-uploads">
        <Head title="ESIC monthly contribution upload (Excel)" />
        <ul className="divide-y text-xs">
          {d.uploads.map((u) => (
            <li key={u.month} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span>{monthName(u.month)} · {u.rows.length - 1} insured person(s){u.missing.length > 0 && <span className="ml-2 text-amber-700">No IP number, left out: {u.missing.join(', ')}</span>}</span>
              <Button size="xs" variant="outline" className="gap-1" onClick={() => downloadWorkbook(`ESIC-MC-${u.month}.xlsx`, [{ name: 'Sheet1', rows: u.rows }])} data-slot="esi-upload-download"><Download className="size-3" /> Upload file</Button>
            </li>
          ))}
        </ul>
        <p className="px-4 py-2 text-[11px] text-muted-foreground">IP number, IP name, days paid, total monthly wages, reason code for zero days (0 none, 1 on leave, 2 left service) and last working day — the columns of ESIC&apos;s monthly contribution template.</p>
      </Card>
      <TieBox tie={d.tie} payable="ESI Payable" />
    </div>
  );
}

// ── PT ──────────────────────────────────────────────────────────────────────

export function PtTab({ from, to }: { from: string; to: string }) {
  const state = useApi(() => payrollStatutory.pt(from, to), [from, to]);
  const d = state.data;
  if (!d) return <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card>;
  if (!d.rows.length) return <Empty what="Professional Tax" />;
  return (
    <div className="space-y-4" data-slot="pt-report">
      {d.byState.map((s) => (
        <Card key={s.stateCode} className="overflow-hidden p-0" data-slot="pt-state">
          <Head title={`${s.state} — Professional Tax${s.basis === 'half_yearly' ? ' (half-yearly slabs, a sixth a month)' : s.hasRule ? ' (monthly slabs)' : ' (no slabs on file: nothing deducted)'}`}>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadCsv(`pt-${s.state.replace(/\s/g, '-')}-${from}-${to}.csv`, [
              ['Monthly return', s.state], ['Month', 'Slab (₹ a month)', 'Employees', 'Gross wages', 'Tax'],
              ...s.months.flatMap((m) => m.slabs.map((x) => [monthName(m.month), r2(x.ratePaise), x.count, r2(x.grossPaise), r2(x.ratePaise * x.count)])),
              [], ['Annual return', s.state], ['Code', 'Employee', 'Months', 'Gross', 'Tax'],
              ...s.employees.map((e) => [e.code, e.name, e.months, r2(e.grossPaise), r2(e.ptPaise)]),
              ['Total', '', '', '', r2(s.ptPaise)],
            ])}><Download className="size-3.5" /> Export return</Button>
          </Head>
          <div className="grid gap-0 lg:grid-cols-2">
            <table className="w-full text-xs">
              <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-right`}>Slab</th><th className={`${th} text-right`}>Employees</th><th className={`${th} text-right`}>Tax</th></tr></thead>
              <tbody>
                {s.months.map((m) => m.slabs.map((x, i) => (
                  <tr key={`${m.month}-${x.ratePaise}`} className="border-b">
                    <td className={td}>{i === 0 ? monthName(m.month) : ''}</td><td className={`${td} text-right`}><Money value={x.ratePaise} /></td>
                    <td className={`${td} text-right`}>{x.count}</td><td className={`${td} text-right`}><Money value={x.ratePaise * x.count} /></td>
                  </tr>
                )))}
              </tbody>
            </table>
            <table className="w-full border-l text-xs">
              <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Employee (the year)</th><th className={`${th} text-right`}>Months</th><th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>PT</th></tr></thead>
              <tbody>
                {s.employees.map((e) => (
                  <tr key={e.employeeId} className="border-b"><td className={td}><span className="font-mono text-muted-foreground">{e.code}</span> {e.name}</td><td className={`${td} text-right`}>{e.months}</td><td className={`${td} text-right`}><Money value={e.grossPaise} /></td><td className={`${td} text-right`}><Money value={e.ptPaise} /></td></tr>
                ))}
                <tr className="font-semibold"><td className={td} colSpan={3}>Total {s.state}</td><td className={`${td} text-right`}><Money value={s.ptPaise} /></td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <TieBox tie={d.tie} payable="Professional Tax Payable" />
    </div>
  );
}

// ── LWF ─────────────────────────────────────────────────────────────────────

export function LwfTab({ from, to }: { from: string; to: string }) {
  const state = useApi(() => payrollStatutory.lwf(from, to), [from, to]);
  const d = state.data;
  if (!d) return <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card>;
  if (!d.rows.length) return <Card className="p-6 text-sm text-muted-foreground" data-slot="stat-empty">No Labour Welfare Fund fell due in these months. States collect it in June and December (or December only); widen the months to include one.</Card>;
  return (
    <div className="space-y-4" data-slot="lwf-report">
      <Card className="overflow-hidden p-0">
        <Head title="Labour Welfare Fund by state and period">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadCsv(`lwf-${from}-${to}.csv`, [
            ['State', 'Period', 'Deducted in', 'Employees', 'Employee share', 'Employer share', 'Total'],
            ...d.periods.map((x) => [x.state, x.period, monthName(x.month), x.employees, r2(x.eePaise), r2(x.erPaise), r2(x.eePaise + x.erPaise)]),
            [], ['Month', 'Code', 'Employee', 'State', 'Employee share', 'Employer share'],
            ...d.rows.map((r) => [monthName(r.month), r.code, r.name, r.state, r2(r.eePaise), r2(r.erPaise)]),
          ])}><Download className="size-3.5" /> Export</Button>
        </Head>
        <table className="w-full text-xs">
          <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>State</th><th className={`${th} text-left`}>Period</th><th className={`${th} text-right`}>Employees</th><th className={`${th} text-right`}>Employee</th><th className={`${th} text-right`}>Employer</th><th className={`${th} text-right`}>Total</th></tr></thead>
          <tbody>
            {d.periods.map((x) => (
              <tr key={`${x.stateCode}-${x.month}`} className="border-b last:border-0" data-slot="lwf-row"><td className={td}>{x.state}</td><td className={td}>{x.period}</td><td className={`${td} text-right`}>{x.employees}</td><td className={`${td} text-right`}><Money value={x.eePaise} /></td><td className={`${td} text-right`}><Money value={x.erPaise} /></td><td className={`${td} text-right font-medium`}><Money value={x.eePaise + x.erPaise} /></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
      <TieBox tie={d.tie} payable="Labour Welfare Fund Payable" />
    </div>
  );
}

// ── TDS on salary ───────────────────────────────────────────────────────────

export function TdsTab({ from, to }: { from: string; to: string }) {
  const state = useApi(() => payrollStatutory.tds(from, to), [from, to]);
  const canApprove = usePermission('payroll', 'approve');
  const canBank = usePermission('banking', 'create');
  const canBankVoid = usePermission('banking', 'void');
  const canPayrollVoid = usePermission('payroll', 'void');
  const canPay = canApprove && canBank;
  const canDelete = canBankVoid && canPayrollVoid;
  const del = useConfirmDelete();
  const [editing, setEditing] = useState<{ month: string; challan: SalaryChallanRow | null; amount: number } | null>(null);
  const [journal, setJournal] = useState<string | null>(null);
  const d = state.data;
  if (!d) return <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card>;
  const relink = async (id: string) => {
    try { await api.post('/api/payroll/salary-tds', { action: 'relink', id }); toast.success('Deductions linked again'); void state.refetch(); } catch (e) { toast.error('Not done', { description: err(e) }); }
  };
  return (
    <div className="space-y-4" data-slot="tds-report">
      <Card className="overflow-hidden p-0">
        <Head title="Deposits by month (section 192, challan ITNS 281, nature of payment 92B)" />
        {d.months.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No tax deducted from salary in these months.</p> : (
          <table className="w-full text-xs" data-slot="tds-months">
            <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>Due by</th><th className={`${th} text-right`}>Deducted</th><th className={`${th} text-right`}>Deposited</th><th className={`${th} text-right`}>Linked</th><th className={`${th} text-left`}>Challans</th><th className={th} /></tr></thead>
            <tbody>
              {d.months.map((m) => (
                <tr key={m.month} className="border-b last:border-0" data-slot="tds-month">
                  <td className={td}>{monthName(m.month)}</td>
                  <td className={td}>{m.dueDate}{m.late && <span className="ml-1 text-amber-700">· late</span>}</td>
                  <td className={`${td} text-right`}><Money value={m.deductedPaise} /></td>
                  <td className={`${td} text-right`}><Money value={m.depositedPaise} /></td>
                  <td className={`${td} text-right`}><Money value={m.linkedPaise} /></td>
                  <td className={td}>
                    {m.challans.map((c) => (
                      <span key={c.id} className="flex flex-wrap items-center gap-1.5 py-0.5" data-slot="tds-challan">
                        <span className="font-mono">{c.bsrCode} · {c.date} · {c.serial}</span> <Money value={c.taxPaise + c.surchargePaise + c.cessPaise} />
                        {c.entryId && <button type="button" className="text-primary hover:underline" onClick={() => setJournal(c.entryId)}>entry</button>}
                        <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={() => void relink(c.id)}><Link2 className="size-3" /> link again</button>
                        <RowActions
                          onEdit={canPay && (() => setEditing({ month: m.month, challan: c, amount: c.taxPaise }))}
                          onDelete={canDelete && (() => del.ask({
                            title: `Delete challan ${c.bsrCode}/${c.serial}?`, description: 'Its entry is reversed in the ledger (never erased) and the deductions it paid are unlinked: they show as not deposited in Form 24Q.',
                            reason: true, run: (reason) => api.delete(`/api/payroll/salary-tds?id=${c.id}${reasonQuery(reason, false)}`), done: 'Challan deleted', onDone: () => void state.refetch(),
                          }))}
                        />
                      </span>
                    ))}
                  </td>
                  <td className={`${td} text-right`}>
                    {m.balancePaise > 0 && canPay && <Button size="xs" className="gap-1" onClick={() => setEditing({ month: m.month, challan: null, amount: m.balancePaise })} data-slot="tds-record-challan"><Plus className="size-3" /> Record challan</Button>}
                    {m.balancePaise <= 0 && <span className="text-xs font-medium text-emerald-700">Deposited</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="overflow-hidden p-0">
        <Head title="Monthly deduction register">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!d.rows.length} onClick={() => downloadCsv(`tds-salary-register-${from}-${to}.csv`, [
            ['Month', 'Code', 'Employee', 'Salary paid', 'TDS deducted', 'TDS deposited (linked)', 'Challans'],
            ...d.rows.map((r) => [monthName(r.month), r.code, r.name, r2(r.grossPaise), r2(r.tdsPaise), r2(r.depositedPaise), r.challans.join('; ')]),
            ['Total', '', '', r2(d.rows.reduce((t, r) => t + r.grossPaise, 0)), r2(d.totalPaise), r2(d.rows.reduce((t, r) => t + r.depositedPaise, 0)), ''],
          ])} data-slot="tds-export"><Download className="size-3.5" /> Export</Button>
        </Head>
        {d.rows.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No tax deducted from salary in these months.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-muted/50"><th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>Employee</th><th className={`${th} text-right`}>Salary</th><th className={`${th} text-right`}>TDS</th><th className={`${th} text-right`}>Deposited</th><th className={`${th} text-left`}>Challan</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.month}-${r.employeeId}`} className="border-b last:border-0" data-slot="tds-row">
                  <td className={td}>{monthName(r.month)}</td><td className={td}><span className="font-mono text-muted-foreground">{r.code}</span> {r.name}</td>
                  <td className={`${td} text-right`}><Money value={r.grossPaise} /></td><td className={`${td} text-right`}><Money value={r.tdsPaise} /></td>
                  <td className={`${td} text-right ${r.depositedPaise < r.tdsPaise ? 'text-destructive' : ''}`}><Money value={r.depositedPaise} /></td>
                  <td className={`${td} font-mono text-[11px]`}>{r.challans.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <TieBox tie={d.tie} payable="TDS Payable (salary)" paidLabel="Deposited by challan" />
      <ChallanDialog value={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void state.refetch(); }} />
      {journal && <JournalDialog entryId={journal} number="the TDS challan" onClose={() => setJournal(null)} />}
      {del.dialog}
    </div>
  );
}

function ChallanDialog({ value, onClose, onDone }: { value: { month: string; challan: SalaryChallanRow | null; amount: number } | null; onClose: () => void; onDone: () => void }) {
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), bsr: '', serial: '', tax: 0, interest: 0, fee: 0, bankId: '' });
  const [shown, setShown] = useState<string | null>(null);
  const key = value ? `${value.month}-${value.challan?.id ?? 'new'}` : null;
  if (value && shown !== key) {
    setShown(key);
    const c = value.challan;
    setF(c ? { date: c.date, bsr: c.bsrCode, serial: c.serial, tax: c.taxPaise, interest: c.interestPaise, fee: c.feePaise, bankId: c.bankAccountId }
      : { date: new Date().toISOString().slice(0, 10), bsr: '', serial: '', tax: value.amount, interest: 0, fee: 0, bankId: banks[0]?.id ?? '' });
  }
  if (!value && shown) setShown(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!value) return;
    setBusy(true);
    try {
      const body = { forMonth: value.month, date: f.date, bsrCode: f.bsr, serial: f.serial, taxPaise: f.tax, interestPaise: f.interest, feePaise: f.fee, bankAccountId: f.bankId };
      if (value.challan) await api.put('/api/payroll/salary-tds', { ...body, id: value.challan.id });
      else {
        const r = await api.post<{ linked: number; unallocatedPaise: number }>('/api/payroll/salary-tds', { action: 'challan', ...body });
        toast.success(`Challan recorded; ${r.linked} deduction(s) linked`, { description: r.unallocatedPaise ? `${rupees(r.unallocatedPaise)} of it has no deduction to link to.` : 'TDS Payable is cleared against the bank.' });
      }
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-slot="tds-challan-dialog">
        <DialogHeader>
          <DialogTitle>{value?.challan ? 'Edit the challan for' : 'Record the challan for'} {value ? monthName(value.month) : ''}</DialogTitle>
          <DialogDescription>Challan ITNS 281, nature of payment 92B (TDS on salary). Posts Dr TDS Payable, Dr Interest &amp; Fees, Cr the bank, and links the month&apos;s deductions to it for Form 24Q.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="BSR code" required hint="The bank branch's 7 digits"><Input value={f.bsr} maxLength={7} onChange={(e) => setF({ ...f, bsr: e.target.value.replace(/\D/g, '') })} className="font-mono" data-slot="tds-bsr" /></Field>
          <Field label="Challan serial no." required><Input value={f.serial} maxLength={5} onChange={(e) => setF({ ...f, serial: e.target.value.replace(/\D/g, '') })} className="font-mono" data-slot="tds-serial" /></Field>
          <Field label="Date deposited" required><Input type="date" max={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-slot="tds-date" /></Field>
          <Field label="Paid from" required>
            <Select value={f.bankId} onValueChange={(v) => setF({ ...f, bankId: String(v) })}>
              <SelectTrigger data-slot="tds-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
              <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Tax (TDS)" required><MoneyInput valuePaise={f.tax} onChangePaise={(v) => setF({ ...f, tax: v })} /></Field>
          <Field label="Interest (s.201(1A))"><MoneyInput valuePaise={f.interest} onChangePaise={(v) => setF({ ...f, interest: v })} /></Field>
          <Field label="Late fee (s.234E)"><MoneyInput valuePaise={f.fee} onChangePaise={(v) => setF({ ...f, fee: v })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || f.bsr.length !== 7 || !f.serial || !f.tax || !f.bankId} data-slot="tds-challan-save">{value?.challan ? 'Save' : 'Record'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Form 24Q ────────────────────────────────────────────────────────────────

const SECTION_VIA: Record<string, string> = { '80C': '80C', '80CCD1B': '80CCD(1B)', '80D': '80D', '80E': '80E', '80G': '80G', '80TTA': '80TTA', '24B': '24(b)', other: 'Other VI-A' };

/** The workbook laid out for the RPU's grids: deductor, challans, Annexure I (deductees), Annexure II (salary). */
function rpuWorkbook(q: Form24QData) {
  // Not paid yet: left blank, and the return's issues say to record the salary payment first.
  const d = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
  const sheets = [
    { name: 'Deductor', rows: [
      ['Form', q.form], ['Financial year', `${q.fy}-${String(q.fy + 1).slice(2)}`], ['Quarter', `Q${q.quarter}`], ['TAN', q.deductor.tan ?? ''], ['PAN', q.deductor.pan ?? ''],
      ['Name', q.deductor.name], ['Address', q.deductor.address ?? ''], ['Deductor type', q.deductor.type ?? ''],
      ['Responsible person', q.deductor.responsible.name ?? ''], ['Designation', q.deductor.responsible.designation ?? ''], ['PAN of responsible person', q.deductor.responsible.pan ?? ''],
      ['Mobile', q.deductor.responsible.mobile ?? ''], ['Email', q.deductor.responsible.email ?? ''], ['Return due', q.returnDueDate],
    ] },
    { name: 'Challan', rows: [
      ['Sr. No.', 'Section code', 'TDS', 'Surcharge', 'Education cess', 'Interest', 'Fee', 'Others', 'Total tax deposited', 'BSR code', 'Date on which tax deposited', 'Challan serial no.', 'Mode (challan / book entry)', 'Month'],
      ...q.challans.map((c, i) => [i + 1, '92B', r2(c.taxPaise), r2(c.surchargePaise), r2(c.cessPaise), r2(c.interestPaise), r2(c.feePaise), '0.00', r2(c.totalPaise), c.bsrCode, d(c.date), c.serial, 'Challan', c.forMonth]),
    ] },
    { name: 'Annexure I', rows: [
      ['Sr. No.', 'Challan Sr. No.', 'Employee ref. no.', 'PAN of the employee', 'Name of the employee', 'Section code', 'Date of payment / credit', 'Amount paid / credited', 'TDS', 'Surcharge', 'Education cess', 'Total tax deducted', 'Total tax deposited', 'Date of deduction', 'Reason for non-deduction / lower deduction'],
      ...q.challans.flatMap((c, ci) => c.deductees.map((x) => [ci + 1, x.code, x.pan ?? 'PANNOTAVBL', x.name, '192', d(x.paymentDate), r2(x.amountPaidPaise), r2(x.tdsPaise), '0.00', '0.00', r2(x.tdsPaise), r2(x.depositedPaise), d(x.deductedOn), ''])).map((r, i) => [i + 1, ...r]),
    ] },
  ];
  if (q.annexureII) {
    sheets.push({ name: 'Annexure II', rows: [
      ['Sr. No.', 'PAN', 'Name', 'Category', 'Period from', 'Period to', 'Opting out of 115BAC (old regime)', 'Gross salary u/s 17(1)', 'Perquisites 17(2)', 'Profits in lieu 17(3)', 'Total gross salary',
        'HRA exemption u/s 10(13A)', 'Other exemptions u/s 10', 'Total exemption u/s 10', 'Standard deduction 16(ia)', 'Entertainment allowance 16(ii)', 'Professional tax 16(iii)', 'Income chargeable under Salaries',
        'Income from house property', 'Income from other sources', 'Gross total income', ...Object.values(SECTION_VIA), 'Total Chapter VI-A', 'Total taxable income', 'Tax on total income', 'Rebate u/s 87A', 'Surcharge',
        'Health and education cess', 'Relief u/s 89', 'Net tax payable', 'TDS by this employer', 'TDS by previous employer', 'Total TDS', 'Shortfall (excess)'],
      ...q.annexureII.map((e, i) => [i + 1, e.employee.pan ?? 'PANNOTAVBL', e.employee.name, 'O', d(e.employee.from), d(e.employee.to), e.employee.regime === 'old' ? 'Yes' : 'No',
        r2(e.grossPaise), '0.00', '0.00', r2(e.grossPaise), r2(e.hraExemptPaise), '0.00', r2(e.hraExemptPaise), r2(e.standardDeductionPaise), '0.00', r2(e.professionalTaxPaise), r2(e.incomeFromSalaryPaise),
        '0.00', '0.00', r2(e.incomeFromSalaryPaise), ...Object.keys(SECTION_VIA).map((k) => r2(e.chapterVIA.find((c) => c.section === k)?.amountPaise ?? 0)), r2(e.chapterVIAPaise), r2(e.taxablePaise),
        r2(e.slabTaxPaise), r2(e.rebatePaise), r2(e.surchargePaise), r2(e.cessPaise), '0.00', r2(e.taxPaise), r2(e.deductedPaise), '0.00', r2(e.deductedPaise), r2(e.balancePaise)]),
    ] });
  }
  downloadWorkbook(`24Q-FY${q.fy}-${String(q.fy + 1).slice(2)}-Q${q.quarter}-RPU.xlsx`, sheets);
}

export function Form24QTab() {
  const thisFy = (() => { const d = new Date(); return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear(); })();
  const [fy, setFy] = useState(thisFy);
  const [quarter, setQuarter] = useState(1);
  const state = useApi(() => payrollStatutory.form24q(fy, quarter), [fy, quarter]);
  const canEdit = usePermission('payroll', 'edit');
  const [receipt, setReceipt] = useState({ no: '', on: '' });
  const q = state.data;
  const saveReceipt = async () => {
    try {
      await api.post('/api/payroll/salary-tds', { action: 'receipt', fy, quarter, receiptNo: receipt.no, filedOn: receipt.on || null });
      toast.success('Receipt number saved', { description: 'Form 16 Part A quotes it.' });
      setReceipt({ no: '', on: '' });
      void state.refetch();
    } catch (e) { toast.error('Not saved', { description: err(e) }); }
  };
  return (
    <div className="space-y-4" data-slot="form-24q">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-36" data-slot="24q-fy"><SelectValue /></SelectTrigger>
          <SelectContent>{[0, 1, 2].map((i) => thisFy - i).map((y) => <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v))}>
          <SelectTrigger className="h-9 w-48" data-slot="24q-quarter"><SelectValue /></SelectTrigger>
          <SelectContent>{[1, 2, 3, 4].map((n) => <SelectItem key={n} value={String(n)}>Q{n} · {['Apr–Jun', 'Jul–Sep', 'Oct–Dec', 'Jan–Mar'][n - 1]}</SelectItem>)}</SelectContent>
        </Select>
        {q && <span className="text-xs text-muted-foreground">{q.form} · due {q.returnDueDate}{q.receipt ? ` · filed, receipt ${q.receipt.receiptNo}` : ''}</span>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!q} onClick={() => q && rpuWorkbook(q)} data-slot="24q-rpu"><FileText className="size-3.5" /> Export for the RPU (Excel)</Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!q} onClick={() => q && downloadCsv(`24Q-FY${fy}-Q${quarter}-annexure-I.csv`, [
            ['Challan BSR', 'Challan date', 'Challan serial', 'Employee', 'PAN', 'Month', 'Date of payment', 'Amount paid', 'TDS', 'Deposited'],
            ...q.challans.flatMap((c) => c.deductees.map((x) => [c.bsrCode, c.date, c.serial, x.name, x.pan ?? '', x.month, x.paymentDate ?? 'not paid yet', r2(x.amountPaidPaise), r2(x.tdsPaise), r2(x.depositedPaise)])),
          ])}><Download className="size-3.5" /> Annexure I CSV</Button>
        </div>
      </div>
      {!q ? <Card className="p-6 text-sm text-muted-foreground">{state.error ?? 'Loading…'}</Card> : (
        <>
          {q.issues.length > 0 && (
            <Card className="space-y-1 border-amber-500/40 p-3 text-xs" data-slot="24q-issues">
              {q.issues.map((i, k) => <p key={k} className={i.level === 'error' ? 'text-destructive' : 'text-amber-800 dark:text-amber-200'}>{i.level === 'error' ? 'Fix before filing: ' : 'Check: '}{i.message}</p>)}
            </Card>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            {[['Salary paid', q.totals.paidPaise], ['Tax deducted', q.totals.deductedPaise], ['Deposited by challan', q.totals.depositedPaise], ['Linked to challans', q.totals.linkedPaise]].map(([l, v]) => (
              <Card key={l as string} className="p-3"><p className="text-xs text-muted-foreground">{l}</p><Money value={v as number} className="text-base font-semibold" /></Card>
            ))}
          </div>
          <Card className="overflow-hidden p-0" data-slot="24q-annexure-1">
            <Head title="Annexure I — deductions by challan" />
            {q.challans.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No challan recorded for this quarter&apos;s months yet. Record them under TDS on salary.</p> : q.challans.map((c) => (
              <div key={c.id} className="border-b last:border-0">
                <p className="bg-muted/30 px-4 py-1.5 text-xs font-semibold">Challan {c.bsrCode} · {c.date} · serial {c.serial} · {monthName(c.forMonth)} · <Money value={c.taxPaise + c.surchargePaise + c.cessPaise} /></p>
                <table className="w-full text-xs">
                  <thead><tr className="border-b"><th className={`${th} text-left`}>Employee</th><th className={`${th} text-left`}>PAN</th><th className={`${th} text-left`}>Paid on</th><th className={`${th} text-right`}>Amount paid</th><th className={`${th} text-right`}>TDS</th><th className={`${th} text-right`}>Deposited</th></tr></thead>
                  <tbody>
                    {c.deductees.map((x) => (
                      <tr key={`${x.employeeId}-${x.month}`} className="border-b last:border-0" data-slot="24q-deductee"><td className={td}>{x.name}</td><td className={`${td} font-mono`}>{x.pan ?? 'PANNOTAVBL'}</td><td className={td}>{x.paymentDate ?? <span className="text-amber-700" data-slot="24q-not-paid">Salary not paid yet</span>}</td><td className={`${td} text-right`}><Money value={x.amountPaidPaise} /></td><td className={`${td} text-right`}><Money value={x.tdsPaise} /></td><td className={`${td} text-right`}><Money value={x.depositedPaise} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </Card>
          {q.annexureII && (
            <Card className="overflow-x-auto p-0" data-slot="24q-annexure-2">
              <Head title="Annexure II — salary for the year (fourth quarter)" />
              <table className="w-full text-xs">
                <thead><tr className="border-b bg-muted/50">{['Employee', 'Regime', 'Gross salary', 'Exempt u/s 10', 'Std. deduction', 'PT', 'Chapter VI-A', 'Taxable', 'Tax computed', 'TDS', 'Shortfall (excess)'].map((h) => <th key={h} className={`${th} ${h === 'Employee' || h === 'Regime' ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {q.annexureII.map((e) => (
                    <tr key={e.employee.id} className="border-b last:border-0" data-slot="24q-salary">
                      <td className={td}>{e.employee.name}<span className="block font-mono text-[10px] text-muted-foreground">{e.employee.pan ?? 'PANNOTAVBL'}</span></td>
                      <td className={td}>{e.employee.regime === 'old' ? 'Old' : 'New (115BAC)'}</td>
                      {[e.grossPaise, e.hraExemptPaise, e.standardDeductionPaise, e.professionalTaxPaise, e.chapterVIAPaise, e.taxablePaise, e.taxPaise, e.deductedPaise, e.balancePaise].map((v, i) => <td key={i} className={`${td} text-right`}><Money value={v} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {canEdit && (
            <Card className="flex flex-wrap items-end gap-3 p-4" data-slot="24q-receipt">
              <Field label="Provisional receipt number (from TRACES on filing)"><Input value={receipt.no} onChange={(e) => setReceipt({ ...receipt, no: e.target.value })} placeholder={q.receipt?.receiptNo ?? '15 characters'} className="w-56 font-mono" /></Field>
              <Field label="Filed on"><Input type="date" value={receipt.on} onChange={(e) => setReceipt({ ...receipt, on: e.target.value })} className="w-40" /></Field>
              <Button size="sm" variant="outline" onClick={() => void saveReceipt()} disabled={receipt.no.trim().length < 8}>Save</Button>
              <p className="basis-full text-[11px] text-muted-foreground">
                The export is laid out for the government&apos;s Return Preparation Utility (RPU): its Challan, Annexure I and Annexure II grids. The RPU writes the return&apos;s text file;
                the File Validation Utility (FVU) then checks it against the challan status (CSI) file you download from the e-filing portal with your TAN login, and makes the .fvu
                file you upload. Those two steps need your login and the government&apos;s utilities, so they are done there.
              </p>
            </Card>
          )}
          <Badge variant="outline" className="text-[10px]">Form 16 for each employee: Payroll → Form 16 / 130 (Part A from these same links)</Badge>
        </>
      )}
    </div>
  );
}
