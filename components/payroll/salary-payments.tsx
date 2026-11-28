'use client';

// A posted month's salary payments, employee by employee (status review 7,
// item 10): who is paid and who is not, paying the chosen ones or everyone
// left, the bank's bulk-transfer file, and taking one payment back with a
// reason. Salaries Payable clears person by person (salary-payments.ts).

import { useState } from 'react';
import { Banknote, Download, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { useConfirmDelete } from '@/components/shared/row-actions';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { payrollStatutory } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook } from '@/lib/xlsx';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SalaryPaymentsCard({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const state = useApi(() => payrollStatutory.payments(runId), [runId]);
  const canApprove = usePermission('payroll', 'approve');
  const canBank = usePermission('banking', 'create');
  const canPay = canApprove && canBank;
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const confirm = useConfirmDelete();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState<string[] | null | false>(false);
  const [f, setF] = useState({ bankId: '', date: new Date().toISOString().slice(0, 10), reference: '' });
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);
  const d = state.data;
  if (!d) return null;
  const refresh = () => { void state.refetch(); onChanged(); };
  const unpaid = d.rows.filter((r) => r.unpaidPaise > 0);
  const pay = async () => {
    if (paying === false) return;
    setBusy(true);
    try {
      const r = await payrollStatutory.pay(runId, { bankAccountId: f.bankId, date: f.date, employeeIds: paying, reference: f.reference || null });
      toast.success(`Paid ${r.employees} employee${r.employees === 1 ? '' : 's'}: ₹${(r.paidPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, { description: r.fullyPaid ? 'Everyone is paid; Salaries Payable for the month is clear.' : 'The rest are still unpaid.' });
      setPaying(false);
      setChosen(new Set());
      refresh();
    } catch (e) {
      toast.error('Not paid', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };
  const bankFile = async () => {
    try {
      const b = await payrollStatutory.bankFile(runId, f.bankId || banks[0]?.id || '', f.date);
      if (!b.rows.length) { toast.error('Nobody unpaid has bank details', { description: b.missing.join(', ') || undefined }); return; }
      downloadWorkbook(`salary-transfers-${d.month}.xlsx`, [{ name: 'Transfers', rows: [b.columns, ...b.rows] }]);
      if (b.missing.length) toast.warning('Left out of the file: no bank details', { description: b.missing.join(', ') });
    } catch (e) {
      toast.error('No file', { description: err(e) });
    }
  };
  const takeBack = (paymentId: string, name: string) => confirm.ask({
    title: `Take back the salary payment to ${name}?`,
    description: 'Its amount goes back to Salaries Payable and out of the bank in the ledger (a reversing entry, never an erasure); they show as unpaid until paid again. Refused while it is matched to the bank statement.',
    reasonRequired: true, tone: 'default', confirmLabel: 'Take back', failTitle: 'Not taken back',
    run: (reason) => payrollStatutory.reversePayment(runId, paymentId, reason),
    done: 'Payment taken back', onDone: refresh,
  });
  return (
    <Card className="gap-0 overflow-hidden p-0" data-slot="salary-payments">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <p className="text-sm font-medium">Salary payments, employee by employee</p>
          <p className="text-xs text-muted-foreground">Paid <Money value={d.paidPaise} /> of <Money value={d.netPaise} />; {unpaid.length ? `${unpaid.length} still unpaid` : 'everyone is paid'}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!unpaid.length} onClick={() => void bankFile()} data-slot="salary-bank-file"><Download className="size-3.5" /> Bank transfer file</Button>
          {canPay && <Button size="sm" variant="outline" className="gap-1.5" disabled={!chosen.size} onClick={() => { setF((x) => ({ ...x, bankId: x.bankId || banks[0]?.id || '' })); setPaying([...chosen]); }} data-slot="salary-pay-selected"><Banknote className="size-3.5" /> Pay selected ({chosen.size})</Button>}
          {canPay && <Button size="sm" className="gap-1.5" disabled={!unpaid.length} onClick={() => { setF((x) => ({ ...x, bankId: x.bankId || banks[0]?.id || '' })); setPaying(null); }} data-slot="salary-pay-all"><Banknote className="size-3.5" /> Pay everyone unpaid</Button>}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-muted/40"><th className="w-8" /><th className={`${th} text-left`}>Employee</th><th className={`${th} text-left`}>Bank</th><th className={`${th} text-right`}>Net pay</th><th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>Unpaid</th><th className={`${th} text-left`}>Payments</th></tr></thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.employeeId} className="border-b last:border-0" data-slot="salary-payment-row">
              <td className="px-2 py-2 text-center">
                {r.unpaidPaise > 0 && <input type="checkbox" aria-label={`Choose ${r.name}`} checked={chosen.has(r.employeeId)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(r.employeeId); else n.delete(r.employeeId); return n; })} />}
              </td>
              <td className="px-3 py-2"><span className="font-mono text-xs text-muted-foreground">{r.code}</span> {r.name}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.bankAccountNo ? `${r.bankIfsc} · ••${r.bankAccountNo.slice(-4)}` : <span className="text-amber-700">No bank details</span>}</td>
              <td className="px-3 py-2 text-right"><Money value={r.netPaise} /></td>
              <td className="px-3 py-2 text-right"><Money value={r.paidPaise} showZero={false} /></td>
              <td className="px-3 py-2 text-right">{r.unpaidPaise > 0 ? <Money value={r.unpaidPaise} className="font-medium text-amber-700" /> : <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700">Paid</Badge>}</td>
              <td className="px-3 py-2 text-xs">
                {r.payments.map((x) => (
                  <span key={x.id} className={`flex flex-wrap items-center gap-1.5 py-0.5 ${x.reversed ? 'text-muted-foreground line-through' : ''}`} data-slot="salary-payment">
                    <span>{x.paidOn} · ₹{(x.amountPaise / 100).toLocaleString('en-IN')} · {x.bank}{x.reference ? ` · ${x.reference}` : ''}</span>
                    <button type="button" className="text-primary hover:underline" onClick={() => setJournal(x.entryId)}>entry</button>
                    {x.reversed && <span className="no-underline">taken back{x.reverseReason ? `: ${x.reverseReason}` : ''}</span>}
                    {!x.reversed && canPay && <Button size="xs" variant="ghost" className="h-6 gap-1 px-1.5" onClick={() => takeBack(x.id, r.name)} data-slot="salary-take-back"><Undo2 className="size-3" /> Take back</Button>}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Dialog open={paying !== false} onOpenChange={(o) => !o && setPaying(false)}>
        <DialogContent data-slot="salary-pay-dialog">
          <DialogHeader>
            <DialogTitle>{paying ? `Pay ${paying.length} employee${paying.length === 1 ? '' : 's'}` : `Pay everyone unpaid (${unpaid.length})`}</DialogTitle>
            <DialogDescription>One bank entry with a line for each employee: Dr Salaries Payable, Cr the bank. Upload the transfer file to the bank first; record it here once the bank has paid.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid from" required>
              <Select value={f.bankId} onValueChange={(v) => setF({ ...f, bankId: String(v) })}>
                <SelectTrigger data-slot="salary-pay-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Paid on" required><Input type="date" max={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-slot="salary-pay-date" /></Field>
            <Field label="Bank reference (UTR / batch)" className="sm:col-span-2"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={60} /></Field>
          </div>
          <p className="text-sm">Amount: <Money value={(paying ? d.rows.filter((r) => paying.includes(r.employeeId)) : unpaid).reduce((t, r) => t + r.unpaidPaise, 0)} className="font-semibold" /></p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(false)}>Cancel</Button>
            <Button disabled={busy || !f.bankId || !f.date} className="gap-1.5" onClick={() => void pay()} data-slot="salary-pay-confirm">{busy && <Loader2 className="size-3.5 animate-spin" />} Record payment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {journal && <JournalDialog entryId={journal} number="the salary payment" onClose={() => setJournal(null)} />}
      {confirm.dialog}
    </Card>
  );
}
