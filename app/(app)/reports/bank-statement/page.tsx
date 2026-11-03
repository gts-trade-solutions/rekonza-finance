'use client';

// A bank account's statement as on a date: the balance in the books worked
// through to the bank's — cheques not yet presented, deposits not yet credited,
// and what the bank has that the books do not — the Bank Reconciliation
// Statement prepared at each month end (reports/bank-statement.ts).

import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Field } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { today } from '@/lib/selectors';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Item { date: string; entryId: string | null; entryNo: number | null; particulars: string; reference: string | null; amountPaise: number }
interface Statement {
  account: { id: string; name: string; kind: string }; asOf: string; reconciledFrom: string | null; statementDate: string | null;
  bookPaise: number; notPresented: Item[]; notCredited: Item[]; bankCredits: Item[]; bankDebits: Item[];
  totals: { notPresented: number; notCredited: number; bankCredits: number; bankDebits: number };
  computedPaise: number; statementPaise: number | null; differencePaise: number | null;
}

const long = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

function Section({ sign, title, hint, items, total, slot }: { sign: '+' | '−'; title: string; hint: string; items: Item[]; total: number; slot: string }) {
  return (
    <div className="border-t py-3" data-slot={slot}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium"><span className="mr-1.5 tabular text-muted-foreground">{sign === '+' ? 'Add:' : 'Less:'}</span>{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className={cn('tabular text-sm font-semibold', total === 0 && 'text-muted-foreground')}>{sign} <Money value={total} /></span>
      </div>
      {items.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <tbody>
            {items.map((i, n) => (
              <tr key={`${i.date}-${n}`} className="border-t border-dashed">
                <td className="w-28 py-1.5 tabular text-muted-foreground">{short(i.date)}</td>
                <td className="py-1.5">
                  {i.particulars}
                  {i.entryNo ? <span className="ml-1.5 text-muted-foreground">#{i.entryNo}</span> : null}
                  {i.reference ? <span className="ml-1.5 text-muted-foreground">Ref {i.reference}</span> : null}
                </td>
                <td className="w-32 py-1.5 text-right tabular"><Money value={i.amountPaise} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function BankStatementPage() {
  const accounts = useAppStore((s) => s.bankAccounts).filter((b) => b.kind === 'bank');
  const [accountId, setAccountId] = useState('');
  const [asOf, setAsOf] = useState(today());
  useEffect(() => { if (!accountId && accounts.length) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const state = useApi<Statement | null>(
    () => (accountId ? api.get('/api/bank-statement', { bankAccountId: accountId, asOf }) : Promise.resolve(null)),
    [accountId, asOf],
  );

  const exportCsv = () => {
    const d = state.data;
    if (!d) return;
    const rows = (label: string, items: Item[]) => items.map((i) => [label, i.date, i.particulars, i.reference ?? '', toRupees(i.amountPaise)]);
    downloadCsv(`${d.account.name}-bank-statement-${d.asOf}.csv`, [
      ['Section', 'Date', 'Particulars', 'Reference', 'Amount'],
      ['Balance as per books', d.asOf, '', '', toRupees(d.bookPaise)],
      ...rows('Add: payments not yet presented', d.notPresented),
      ...rows('Less: deposits not yet credited', d.notCredited),
      ...rows('Add: credited by the bank, not in the books', d.bankCredits),
      ...rows('Less: debited by the bank, not in the books', d.bankDebits),
      ['Balance as per bank (worked out)', d.asOf, '', '', toRupees(d.computedPaise)],
      ['Balance on the bank statement', d.statementDate ?? '', '', '', d.statementPaise === null ? '' : toRupees(d.statementPaise)],
    ]);
  };

  return (
    <>
      <PageHeader
        title="Bank statement as on date"
        description="The balance in your books worked through to the bank's on any day: cheques not yet presented, deposits not yet credited, and what the bank shows that the books do not."
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={!state.data}><Download className="size-3.5" /> Export</Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()} disabled={!state.data}><Printer className="size-3.5" /> Print</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Bank account">
          <Select value={accountId} onValueChange={(v) => setAccountId(String(v))}>
            <SelectTrigger className="h-9 w-64" aria-label="Bank account"><SelectValue placeholder="Choose the account" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="As on">
          <Input type="date" value={asOf} max={today()} onChange={(e) => e.target.value && setAsOf(e.target.value)} className="h-9 w-44" data-slot="as-on" />
        </Field>
      </div>

      {accounts.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">Add a bank account under Banking first.</Card>
      ) : (
        <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
          {(d) => d && (
            <Card className="max-w-4xl p-6" data-slot="bank-statement">
              <div className="mb-3 text-center">
                <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Bank reconciliation statement</p>
                <h2 className="text-base font-semibold">{d.account.name}, as on {long(d.asOf)}</h2>
                {d.reconciledFrom ? (
                  <p className="text-xs text-muted-foreground">From the statement imported from {short(d.reconciledFrom)}; anything before is in its opening balance.</p>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">No statement has been imported for this account, so only the book balance can be shown. Import one under Banking.</p>
                )}
              </div>

              <div className="flex items-baseline justify-between gap-3 py-3">
                <p className="text-sm font-semibold">Balance as per the books</p>
                <span className="tabular text-base font-semibold" data-slot="book-balance"><Money value={d.bookPaise} /></span>
              </div>
              <Section sign="+" slot="not-presented" title="Payments not yet presented" hint="Cheques issued and payments in the books that the bank has not cleared"
                items={d.notPresented} total={d.totals.notPresented} />
              <Section sign="−" slot="not-credited" title="Deposits not yet credited" hint="Money paid in, in the books, that the bank has not credited"
                items={d.notCredited} total={d.totals.notCredited} />
              <Section sign="+" slot="bank-credits" title="Credited by the bank, not in the books" hint="Interest, direct credits: still to enter"
                items={d.bankCredits} total={d.totals.bankCredits} />
              <Section sign="−" slot="bank-debits" title="Debited by the bank, not in the books" hint="Charges, direct debits: still to enter"
                items={d.bankDebits} total={d.totals.bankDebits} />

              <div className="flex items-baseline justify-between gap-3 border-t-2 border-foreground/70 py-3">
                <p className="text-sm font-semibold">Balance as per the bank</p>
                <span className="tabular text-base font-semibold" data-slot="computed-balance"><Money value={d.computedPaise} /></span>
              </div>
              {d.statementPaise !== null && (
                <div className={cn('flex flex-wrap items-baseline justify-between gap-3 rounded-md border px-3 py-2 text-sm',
                  d.differencePaise === 0 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')} data-slot="statement-check">
                  <span>
                    The bank statement shows <Money value={d.statementPaise} className="font-medium" /> on {short(d.statementDate ?? d.asOf)}
                  </span>
                  <span className={cn('font-medium', d.differencePaise === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
                    {d.differencePaise === 0 ? 'Agrees to the paisa' : <>Differs by <Money value={Math.abs(d.differencePaise ?? 0)} />: match the lines under Banking → Reconcile</>}
                  </span>
                </div>
              )}
            </Card>
          )}
        </AsyncPage>
      )}
    </>
  );
}
