'use client';

// One month's payroll. While a draft, each employee's days and extras can be
// corrected and the month recomputed; posting books it; paying clears the net
// salaries from a bank account. The files for the bank, EPFO and ESIC, and the
// payslips, come from here.

import Link from 'next/link';
import { use, useState } from 'react';
import { AlertTriangle, ArrowLeft, Banknote, CheckCircle2, Download, FileText, Loader2, Mail, MessageCircle, Printer, Undo2, Upload, Users, Wallet } from 'lucide-react';
import { whatsappNumber } from '@/components/sales/send-invoice';
import Papa from 'papaparse';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { formatINRCompact } from '@/lib/money';
import { downloadWorkbook } from '@/lib/xlsx';
import { Attachments } from '@/components/shared/attachments';
import { bankTransfers, ecr, esiContributions } from '@/lib/payroll/files';

export interface RunLine {
  employeeId: string; code: string; name: string; designation: string | null; pan: string | null; uan: string | null;
  mobile?: string | null; email?: string | null;
  esiIpNumber: string | null; bankAccountName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  daysInMonth: number; lopDays: number; paidDays: number;
  basic: number; da: number; hra: number; special: number; other: number; bonus: number; arrears: number; reimbursement: number; claims: number; gross: number;
  pfWage: number; epsWage: number; pfEmployee: number; pfEmployerEpf: number; pfEmployerEps: number; pfAdmin: number; pfEdli: number;
  esiWage: number; esiEmployee: number; esiEmployer: number; pt: number; lwfEmployee: number; lwfEmployer: number;
  tds: number; advanceRecovery: number; loanRecovery: number; netPay: number; notes: string | null;
}
export interface Run {
  id: string; month: string; status: 'draft' | 'posted' | 'paid'; paidOn: string | null; journalEntryId: string | null;
  org: { name: string; pfCode: string | null; esiCode: string | null; tan: string | null };
  lines: RunLine[];
}

const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sum = (lines: RunLine[], k: keyof RunLine) => lines.reduce((t, l) => t + (l[k] as number), 0);
const saveText = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

export default function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const state = useApi<Run>(() => api.get(`/api/payroll/runs/${id}`), [id]);
  const canEdit = usePermission('payroll', 'edit');
  const canApprove = usePermission('payroll', 'approve');
  const canShare = usePermission('payroll', 'export');

  // A payslip to the employee: a link that opens their slip alone, in a
  // WhatsApp message or an email ready to go.
  const sendSlip = async (run: Run, l: RunLine, how: 'whatsapp' | 'email') => {
    try {
      const { path } = await api.post<{ path: string }>('/api/share', { payslip: { runId: run.id, employeeId: l.employeeId } });
      const url = `${window.location.origin}${path}`;
      const text = `Dear ${l.name}, your payslip for ${monthName(run.month)} is here: ${url}\n— ${run.org.name}`;
      if (how === 'whatsapp') window.open(`https://wa.me/${whatsappNumber(l.mobile)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      else window.open(`mailto:${encodeURIComponent(l.email ?? '')}?subject=${encodeURIComponent(`Payslip for ${monthName(run.month)}`)}&body=${encodeURIComponent(text)}`, '_self');
    } catch (e) {
      toast.error('Not sent', { description: err(e) });
    }
  };
  const [editing, setEditing] = useState<RunLine | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (action: string, payload: Record<string, unknown> = {}, done?: string) => {
    setBusy(action);
    try {
      await api.post(`/api/payroll/runs/${id}`, { action, ...payload });
      if (done) toast.success(done);
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not done', { description: err(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  // An attendance sheet: a column of employee codes, and one of unpaid days
  // or of days present. CSV or Excel, headings in the first row.
  const importAttendance = async (file: File) => {
    setBusy('attendance');
    try {
      let grid: unknown[][];
      if (/\.xlsx$/i.test(file.name)) {
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = (await readXlsxFile(file)) as unknown as { data: unknown[][] }[];
        grid = sheets.find((s) => s.data.length > 1)?.data ?? [];
      } else {
        grid = Papa.parse<string[]>((await file.text()).replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' }).data;
      }
      const head = (grid[0] ?? []).map((h) => String(h ?? '').toLowerCase());
      const col = (...words: string[]) => head.findIndex((h) => words.some((w) => h.includes(w)));
      const code = col('code', 'emp');
      const lop = col('lop', 'unpaid', 'without pay', 'absent');
      const present = col('present', 'worked', 'attended');
      if (code < 0 || (lop < 0 && present < 0)) throw new Error('The sheet needs an employee code column, and one of unpaid days or days present.');
      const num = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
      const rows = grid.slice(1).filter((r) => String(r[code] ?? '').trim()).map((r) => ({
        code: String(r[code]).trim(), lopDays: lop >= 0 ? num(r[lop]) : null, presentDays: present >= 0 ? num(r[present]) : null,
      }));
      if (!rows.length) throw new Error('No rows under the headings.');
      const done = await api.post<{ unmatched: string[] }>(`/api/payroll/runs/${id}`, { action: 'attendance', rows });
      toast.success(`Attendance for ${rows.length - done.unmatched.length} employee(s) applied`, done.unmatched.length
        ? { description: `Not matched: ${done.unmatched.join(', ')}`, duration: 12_000 } : undefined);
      await state.refetch();
    } catch (e) {
      toast.error('Attendance not imported', { description: err(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
      {(run) => {
        const L = run.lines;
        const employer = sum(L, 'pfEmployerEpf') + sum(L, 'pfEmployerEps') + sum(L, 'pfAdmin') + sum(L, 'pfEdli') + sum(L, 'esiEmployer') + sum(L, 'lwfEmployer');
        const deductions = sum(L, 'pfEmployee') + sum(L, 'esiEmployee') + sum(L, 'pt') + sum(L, 'lwfEmployee') + sum(L, 'tds') + sum(L, 'advanceRecovery');
        const draft = run.status === 'draft';
        const bank = bankTransfers(L, run.month);
        const pfFile = ecr(L);
        const esiFile = esiContributions(L);
        const missing = [...new Set([...bank.missing.map((m) => `${m}: no bank details`), ...pfFile.missing.map((m) => `${m}: no UAN`), ...esiFile.missing.map((m) => `${m}: no ESI number`)])];
        return (
          <div className="space-y-5">
            <PageHeader
              title={`Payroll · ${monthName(run.month)}`}
              description={draft ? 'A draft: correct days and extras, then post it.' : run.status === 'posted' ? 'Posted to the books. Pay it from a bank account.' : `Paid on ${run.paidOn}.`}
              actions={(
                <div className="flex flex-wrap items-center gap-2">
                  <Link href="/payroll/runs" className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'gap-1.5')}><ArrowLeft className="size-3.5" /> All months</Link>
                  <Badge variant="outline" className="capitalize">{run.status}</Badge>
                  {draft && canEdit && (
                    <label className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'cursor-pointer gap-1.5')} title="A sheet of employee codes with unpaid days, or days present">
                      {busy === 'attendance' ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Import attendance
                      <input type="file" accept=".csv,.xlsx" className="sr-only" disabled={!!busy} onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void importAttendance(file);
                      }} />
                    </label>
                  )}
                  {draft && canApprove && (
                    <Button size="sm" className="gap-1.5" disabled={!!busy || !L.length} onClick={() => void act('post', {}, `Payroll for ${monthName(run.month)} posted`)}>
                      {busy === 'post' ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Post
                    </Button>
                  )}
                  {run.status === 'posted' && canApprove && (
                    <>
                      <Button size="sm" className="gap-1.5" onClick={() => setPaying(true)}><Banknote className="size-3.5" /> Pay salaries</Button>
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => {
                        const reason = window.prompt('Reopen this payroll? Its entry is reversed. Give the reason.');
                        if (reason) void act('reopen', { reason }, 'Payroll reopened');
                      }}><Undo2 className="size-3.5" /> Reopen</Button>
                    </>
                  )}
                </div>
              )}
            />

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Gross pay" value={formatINRCompact(sum(L, 'gross'))} sub={`${L.length} employee${L.length === 1 ? '' : 's'}`} icon={Users} />
              <StatTile label="Deducted" value={formatINRCompact(deductions)} sub="PF, ESI, PT, LWF, TDS, advances" icon={FileText} />
              <StatTile label="Employer cost" value={formatINRCompact(sum(L, 'gross') + sum(L, 'reimbursement') + employer)} sub={`${formatINRCompact(employer)} PF, ESI and LWF on top`} icon={Wallet} />
              <StatTile label="Net pay" value={formatINRCompact(sum(L, 'netPay'))} sub={run.status === 'paid' ? `Paid ${run.paidOn}` : 'To the employees’ accounts'} icon={Banknote} tone={run.status === 'paid' ? 'positive' : 'default'} />
            </div>

            {missing.length > 0 && (
              <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Left out of the files until their details are added</p>
                  <p className="mt-1 text-xs text-muted-foreground">{missing.join(' · ')}</p>
                </div>
              </Card>
            )}

            <Card className="flex flex-wrap items-center gap-2 p-3">
              <span className="mr-auto text-sm font-medium">Files</span>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={bank.rows.length < 2}
                onClick={() => downloadWorkbook(`salary-transfers-${run.month}.xlsx`, [{ name: 'Transfers', rows: bank.rows }])}>
                <Download className="size-3.5" /> Bank transfers
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={!pfFile.text} onClick={() => saveText(`ECR-${run.month}.txt`, pfFile.text)}>
                <Download className="size-3.5" /> PF ECR
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={esiFile.rows.length < 2}
                onClick={() => downloadWorkbook(`ESI-contribution-${run.month}.xlsx`, [{ name: 'MC', rows: esiFile.rows }])}>
                <Download className="size-3.5" /> ESI upload
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => downloadWorkbook(`salary-register-${run.month}.xlsx`, [register(run)])}>
                <Download className="size-3.5" /> Salary register
              </Button>
              <Link href={`/payroll/runs/${run.id}/payslips`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'gap-1.5')}>
                <Printer className="size-3.5" /> Payslips
              </Link>
            </Card>

            <Card className="gap-0 overflow-hidden p-0">
              <ReportTable>
                <thead><tr className="border-b">
                  <th className={`${th} text-left`}>Employee</th><th className={`${th} text-right`}>Paid days</th>
                  <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>PF</th><th className={`${th} text-right`}>ESI</th>
                  <th className={`${th} text-right`}>PT · LWF</th><th className={`${th} text-right`}>TDS</th><th className={`${th} text-right`}>Other</th>
                  <th className={`${th} text-right`}>Net pay</th>
                  {!draft && canShare && <th className={th} />}
                </tr></thead>
                <tbody className="divide-y">
                  {L.map((l) => (
                    <tr key={l.employeeId} className={draft && canEdit ? 'cursor-pointer hover:bg-accent/40' : ''} onClick={() => draft && canEdit && setEditing(l)}>
                      <td className="px-3 py-2"><p className="font-medium">{l.name}</p><p className="text-xs text-muted-foreground">{l.code}{l.designation ? ` · ${l.designation}` : ''}{l.notes ? ` · ${l.notes}` : ''}</p></td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.paidDays}<span className="text-xs text-muted-foreground">/{l.daysInMonth}</span></td>
                      <td className="px-3 py-2 text-right">
                        <Money value={l.gross} />
                        {l.bonus > 0 && <p className="text-[11px] text-muted-foreground">incl. bonus <Money value={l.bonus} /></p>}
                        {l.arrears > 0 && <p className="text-[11px] text-muted-foreground">incl. arrears <Money value={l.arrears} /></p>}
                      </td>
                      <td className="px-3 py-2 text-right"><Money value={l.pfEmployee} showZero={false} /></td>
                      <td className="px-3 py-2 text-right"><Money value={l.esiEmployee} showZero={false} /></td>
                      <td className="px-3 py-2 text-right"><Money value={l.pt + l.lwfEmployee} showZero={false} /></td>
                      <td className="px-3 py-2 text-right"><Money value={l.tds} showZero={false} /></td>
                      <td className="px-3 py-2 text-right text-xs">
                        {l.reimbursement > 0 && <p title={l.claims ? 'Approved expense claims included' : undefined}>+<Money value={l.reimbursement} />{l.claims > 0 && <span className="text-muted-foreground"> claims</span>}</p>}
                        {l.advanceRecovery > 0 && <p title={l.loanRecovery ? 'Loan and advance instalments included' : undefined}>−<Money value={l.advanceRecovery} />{l.loanRecovery > 0 && <span className="text-muted-foreground"> advance</span>}</p>}
                      </td>
                      <td className="px-3 py-2 text-right font-medium"><Money value={l.netPay} /></td>
                      {!draft && canShare && (
                        <td className="px-2 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <Button size="xs" variant="ghost" title={l.mobile ? `WhatsApp to ${l.mobile}` : 'No mobile number on file'} disabled={!l.mobile}
                            onClick={() => void sendSlip(run, l, 'whatsapp')}><MessageCircle className="size-3.5" /></Button>
                          <Button size="xs" variant="ghost" title={l.email ? `Email to ${l.email}` : 'No email on file'} disabled={!l.email}
                            onClick={() => void sendSlip(run, l, 'email')}><Mail className="size-3.5" /></Button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {L.length === 0 && (
                    <tr><td colSpan={10} className="p-6 text-center text-sm text-muted-foreground">
                      Nobody to pay this month. <Link href="/payroll/employees" className="text-primary hover:underline">Add employees and their salary</Link>.
                    </td></tr>
                  )}
                </tbody>
              </ReportTable>
            </Card>
            {draft && canEdit && L.length > 0 && <p className="text-xs text-muted-foreground">Click an employee to change their unpaid days, bonus, or other reimbursement and recovery. Arrears, approved claims and advance instalments are worked out by themselves.</p>}
            <Attachments targetType="payroll_run" targetId={run.id} canEdit={canEdit} title="Attendance sheets, bank confirmation and other papers" />

            <LineDialog line={editing} onClose={() => setEditing(null)} onSave={async (input) => {
              if (await act('recompute', { inputs: { [editing!.employeeId]: input } }, `${editing!.name} recomputed`)) setEditing(null);
            }} busy={busy === 'recompute'} />
            <PayDialog open={paying} month={run.month} total={sum(L, 'netPay')} onClose={() => setPaying(false)} busy={busy === 'pay'}
              onPay={async (bankAccountId, date) => { if (await act('pay', { bankAccountId, date }, 'Salaries paid')) setPaying(false); }} />
          </div>
        );
      }}
    </AsyncPage>
  );
}

function register(run: Run) {
  const r = (p: number) => p / 100;
  return {
    name: 'Register',
    rows: [
      ['Code', 'Name', 'PAN', 'UAN', 'Days', 'Paid days', 'Basic', 'DA', 'HRA', 'Special', 'Other', 'Bonus', 'Arrears', 'Gross', 'Reimbursement', 'of which claims',
        'PF (employee)', 'ESI (employee)', 'PT', 'LWF', 'TDS', 'Advance recovery', 'Net pay', 'PF EPF (employer)', 'PF EPS (employer)', 'PF admin', 'EDLI', 'ESI (employer)', 'LWF (employer)'],
      ...run.lines.map((l) => [l.code, l.name, l.pan ?? '', l.uan ?? '', l.daysInMonth, l.paidDays, r(l.basic), r(l.da), r(l.hra), r(l.special), r(l.other),
        r(l.bonus), r(l.arrears), r(l.gross), r(l.reimbursement), r(l.claims), r(l.pfEmployee), r(l.esiEmployee), r(l.pt), r(l.lwfEmployee), r(l.tds), r(l.advanceRecovery), r(l.netPay),
        r(l.pfEmployerEpf), r(l.pfEmployerEps), r(l.pfAdmin), r(l.pfEdli), r(l.esiEmployer), r(l.lwfEmployer)]),
    ],
  };
}

function LineDialog({ line, onClose, onSave, busy }: {
  line: RunLine | null; onClose: () => void; busy: boolean;
  onSave: (input: { lopDays: number; bonusPaise: number; reimbursementPaise: number; advanceRecoveryPaise: number; notes: string | null }) => Promise<void>;
}) {
  const [f, setF] = useState({ lopDays: '0', bonus: 0, reimbursement: 0, advance: 0, notes: '' });
  const [shown, setShown] = useState<string | null>(null);
  if (line && shown !== line.employeeId) {
    setShown(line.employeeId);
    setF({ lopDays: String(line.lopDays), bonus: line.bonus, reimbursement: line.reimbursement - line.claims, advance: line.advanceRecovery - line.loanRecovery, notes: line.notes ?? '' });
  }
  if (!line && shown) setShown(null);
  return (
    <Dialog open={!!line} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{line?.name}</DialogTitle>
          <DialogDescription>The month is worked out again from these, with PF, ESI, professional tax and TDS.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Days without pay" hint={line ? `Of ${line.daysInMonth} days in the month` : undefined}>
            <Input type="number" min={0} step={0.5} value={f.lopDays} onChange={(e) => setF({ ...f, lopDays: e.target.value })} />
          </Field>
          <Field label="Bonus" hint={line?.arrears ? `Taxable; not in ESI wages. Arrears of ${formatINRCompact(line.arrears)} are added by themselves.` : 'Taxable; not in ESI wages'}>
            <MoneyInput valuePaise={f.bonus} onChangePaise={(v) => setF({ ...f, bonus: v })} />
          </Field>
          <Field label="Other reimbursement" hint={line?.claims ? `Approved claims of ${formatINRCompact(line.claims)} are added by themselves` : 'Expenses repaid; not salary'}>
            <MoneyInput valuePaise={f.reimbursement} onChangePaise={(v) => setF({ ...f, reimbursement: v })} />
          </Field>
          <Field label="Other recovery" hint={line?.loanRecovery ? `Advance instalments of ${formatINRCompact(line.loanRecovery)} are taken by themselves` : 'Anything else to recover'}>
            <MoneyInput valuePaise={f.advance} onChangePaise={(v) => setF({ ...f, advance: v })} />
          </Field>
          <Field label="Note on the payslip" className="sm:col-span-2"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} className="gap-1.5" onClick={() => void onSave({
            lopDays: Number(f.lopDays) || 0, bonusPaise: f.bonus, reimbursementPaise: f.reimbursement, advanceRecoveryPaise: f.advance, notes: f.notes || null,
          })}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Recompute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({ open, month, total, onClose, onPay, busy }: {
  open: boolean; month: string; total: number; onClose: () => void; busy: boolean; onPay: (bankAccountId: string, date: string) => Promise<void>;
}) {
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const [bankId, setBankId] = useState('');
  const [date, setDate] = useState(today());
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay salaries for {monthName(month)}</DialogTitle>
          <DialogDescription>Upload the bank transfer file to your bank first; record the payment here once the bank has made it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid from">
            <div><Select value={bankId} onValueChange={(v) => setBankId(String(v))}>
              <SelectTrigger><SelectValue placeholder="Bank account" /></SelectTrigger>
              <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select></div>
          </Field>
          <Field label="Paid on"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <p className="text-sm">Net salaries: <Money value={total} className="font-semibold" /></p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !bankId || !date} className="gap-1.5" onClick={() => void onPay(bankId, date)}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
