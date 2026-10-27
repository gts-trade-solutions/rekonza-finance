'use client';

// The cash book and bank book: receipts and payments of one account, day by
// day, with the balance carried forward. On a cash account, the cash can be
// counted here and any difference posted.

import { useEffect, useState } from 'react';
import { AlertTriangle, Calculator, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { toRupees } from '@/lib/money';

interface Line { entryId: string; entryNo: number; memo: string | null; sourceType: string; party: string | null; against: string; receiptPaise: number; paymentPaise: number }
interface Day { date: string; openingPaise: number; lines: Line[]; receiptsPaise: number; paymentsPaise: number; closingPaise: number }
interface Book {
  account: { id: string; name: string; kind: string }; from: string; to: string; openingPaise: number; closingPaise: number;
  receiptsPaise: number; paymentsPaise: number; negativeDays: string[]; days: Day[];
  counts: { id: string; date: string; countedPaise: number; bookPaise: number; differencePaise: number; note: string | null; by: string | null }[];
}

const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
/** The balance after a day's i-th line. */
const running = (day: Day, i: number) => day.lines.slice(0, i + 1).reduce((b, l) => b + l.receiptPaise - l.paymentPaise, day.openingPaise);
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

export default function CashBookPage() {
  const [range, setRange] = useReportRange();
  const accounts = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'cash' || b.kind === 'bank');
  const [accountId, setAccountId] = useState('');
  useEffect(() => { if (!accountId && accounts.length) setAccountId((accounts.find((a) => a.kind === 'cash') ?? accounts[0]).id); }, [accounts, accountId]);
  const state = useApi<Book | null>(
    () => (accountId ? api.get('/api/cash-book', { bankAccountId: accountId, from: range.from, to: range.to }) : Promise.resolve(null)),
    [accountId, range.from, range.to],
  );
  const canCount = usePermission('banking', 'create');
  const [counting, setCounting] = useState(false);

  const exportCsv = () => {
    const d = state.data;
    if (!d) return;
    downloadCsv(`${d.account.name}-book-${d.from}-${d.to}.csv`, [
      ['Date', 'Entry', 'Particulars', 'Against', 'Receipt', 'Payment', 'Balance'],
      ...d.days.flatMap((day) => {
        let bal = day.openingPaise;
        return day.lines.map((l) => {
          bal += l.receiptPaise - l.paymentPaise;
          return [day.date, l.entryNo, l.party ?? l.memo ?? '', l.against, toRupees(l.receiptPaise), toRupees(l.paymentPaise), toRupees(bal)];
        });
      }),
    ]);
  };

  return (
    <ReportShell
      title="Cash & bank book"
      description="Receipts and payments of one account, day by day, with the balance carried forward."
      range={range} onRangeChange={setRange} onExport={exportCsv}
      extraActions={(
        <div className="flex items-center gap-2">
          <Select value={accountId} onValueChange={(v) => setAccountId(String(v))}>
            <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
          {canCount && state.data?.account.kind === 'cash' && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCounting(true)}><Calculator className="size-3.5" /> Count cash</Button>
          )}
        </div>
      )}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => !d ? <p className="text-sm text-muted-foreground">Add a cash or bank account first.</p> : (
          <div className="space-y-4">
            <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
              <span>Opening <Money value={d.openingPaise} className="font-medium" /></span>
              <span className="text-emerald-700 dark:text-emerald-400">Receipts <Money value={d.receiptsPaise} className="font-medium" /></span>
              <span className="text-red-700 dark:text-red-400">Payments <Money value={d.paymentsPaise} className="font-medium" /></span>
              <span className="ml-auto">Closing <Money value={d.closingPaise} className="font-semibold" /></span>
            </Card>
            {d.account.kind === 'cash' && d.negativeDays.length > 0 && (
              <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <p>Cash fell below zero on {d.negativeDays.map(fmt).join(', ')}. Cash cannot be negative: a receipt is missing or a payment was entered on the wrong account or date.</p>
              </Card>
            )}
            {d.days.length === 0 ? <Card className="p-8 text-center text-sm text-muted-foreground">Nothing in or out in these dates.</Card> : (
              <Card className="gap-0 overflow-hidden p-0">
                <ReportTable>
                  <thead><tr className="border-b">
                    <th className={`${th} text-left`}>Particulars</th><th className={`${th} text-left`}>Against</th>
                    <th className={`${th} text-right`}>Receipt</th><th className={`${th} text-right`}>Payment</th><th className={`${th} text-right`}>Balance</th>
                  </tr></thead>
                  {d.days.map((day) => (
                    <tbody key={day.date} className="divide-y border-b">
                      <tr className="bg-muted/40">
                        <td className="px-3 py-1.5 text-xs font-semibold" colSpan={4}>{fmt(day.date)}</td>
                        <td className="px-3 py-1.5 text-right text-xs text-muted-foreground"><Money value={day.openingPaise} /></td>
                      </tr>
                      {day.lines.map((l, i) => (
                        <tr key={`${l.entryId}-${i}`}>
                          <td className="px-3 py-1.5"><p>{l.party ?? l.memo ?? '—'}</p><p className="text-[11px] text-muted-foreground">#{l.entryNo} · {l.sourceType.replace(/_/g, ' ')}{l.party && l.memo ? ` · ${l.memo}` : ''}</p></td>
                          <td className="px-3 py-1.5 text-xs text-muted-foreground">{l.against}</td>
                          <td className="px-3 py-1.5 text-right"><Money value={l.receiptPaise} showZero={false} /></td>
                          <td className="px-3 py-1.5 text-right"><Money value={l.paymentPaise} showZero={false} /></td>
                          <td className="px-3 py-1.5 text-right tabular-nums"><Money value={running(day, i)} className={running(day, i) < 0 ? 'text-red-600' : ''} /></td>
                        </tr>
                      ))}
                      <tr className="text-xs font-medium">
                        <td className="px-3 py-1.5" colSpan={2}>Closing</td>
                        <td className="px-3 py-1.5 text-right"><Money value={day.receiptsPaise} /></td>
                        <td className="px-3 py-1.5 text-right"><Money value={day.paymentsPaise} /></td>
                        <td className="px-3 py-1.5 text-right"><Money value={day.closingPaise} className={day.closingPaise < 0 ? 'text-red-600' : ''} /></td>
                      </tr>
                    </tbody>
                  ))}
                </ReportTable>
              </Card>
            )}
            {d.account.kind === 'cash' && d.counts.length > 0 && (
              <Card className="gap-0 overflow-hidden p-0">
                <div className="border-b px-4 py-2.5 text-sm font-semibold">Cash counts</div>
                <ul className="divide-y text-sm">
                  {d.counts.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                      <span className="w-40 text-xs text-muted-foreground">{fmt(c.date)}</span>
                      <span>Counted <Money value={c.countedPaise} /> against <Money value={c.bookPaise} /></span>
                      <span className={c.differencePaise === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'}>
                        {c.differencePaise === 0 ? 'Agreed' : <>{c.differencePaise > 0 ? 'Excess' : 'Short'} <Money value={Math.abs(c.differencePaise)} /></>}
                      </span>
                      <span className="text-xs text-muted-foreground">{[c.by, c.note].filter(Boolean).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <CountDialog open={counting} accountId={d.account.id} accountName={d.account.name} onClose={() => setCounting(false)}
              onDone={() => { setCounting(false); void state.refetch(); }} />
          </div>
        )}
      </AsyncPage>
    </ReportShell>
  );
}

function CountDialog({ open, accountId, accountName, onClose, onDone }: { open: boolean; accountId: string; accountName: string; onClose: () => void; onDone: () => void }) {
  const [pieces, setPieces] = useState<Record<string, string>>({});
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const total = DENOMINATIONS.reduce((t, d) => t + d * (Number(pieces[d]) || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ differencePaise: number }>('/api/cash-book', {
        bankAccountId: accountId, date, note: note || null,
        pieces: Object.fromEntries(DENOMINATIONS.map((d) => [String(d), Number(pieces[d]) || 0]).filter(([, n]) => n)),
      });
      toast.success(r.differencePaise === 0 ? 'The cash agrees with the books' : `${r.differencePaise > 0 ? 'Excess' : 'Shortage'} of ₹${(Math.abs(r.differencePaise) / 100).toLocaleString('en-IN')} posted to Cash Short & Excess`);
      setPieces({});
      setNote('');
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Count {accountName}</DialogTitle>
          <DialogDescription>The number of each note and coin. A difference from the books is posted to Cash Short &amp; Excess.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {DENOMINATIONS.map((d) => (
            <Field key={d} label={`₹${d} × `}>
              <Input type="number" min={0} value={pieces[d] ?? ''} onChange={(e) => setPieces({ ...pieces, [d]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Counted on"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Counted with the cashier" /></Field>
        </div>
        <p className="text-sm">Counted: <span className="font-semibold">₹{total.toLocaleString('en-IN')}</span></p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !date} className="gap-1.5" onClick={() => void save()}>{busy && <Loader2 className="size-3.5 animate-spin" />} Save the count</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
