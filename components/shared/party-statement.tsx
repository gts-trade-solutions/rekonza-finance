'use client';

// The Statement tab on a customer's or vendor's page: a period, what was owed
// at its start, every document and payment in it, and what is owed at its end.
// Printing opens the same figures as a sheet to send (components/print/statement-print.tsx).

import Link from 'next/link';
import { useState } from 'react';
import { FileSpreadsheet, Mail, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { StatTile } from '@/components/shared/stat-tile';
import { Money } from '@/components/shared/money';
import { api, contacts, type PartyStatement } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINRCompact } from '@/lib/money';
import { sourceHref } from '@/lib/source-links';
import { downloadWorkbook } from '@/lib/xlsx';
import { fromPreset } from '@/lib/date-range';
import { today } from '@/lib/selectors';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

/** Words for the two columns, from the party's side of the account. */
export const statementWords = (side: 'customer' | 'vendor') => side === 'customer'
  ? { charges: 'Invoiced', payments: 'Received', due: 'Balance due', title: 'Statement of account' }
  : { charges: 'Billed', payments: 'Paid', due: 'Balance payable', title: 'Vendor statement' };

export function statementSheet(s: PartyStatement) {
  const w = statementWords(s.side);
  const r = (p: number) => p / 100;
  return {
    name: 'Statement',
    rows: [
      [`${w.title}: ${s.party.name}`],
      [`${s.from} to ${s.to}`],
      [],
      ['Date', 'Transaction', 'Number', 'Details', w.charges, w.payments, 'Balance'],
      [s.from, 'Opening balance', '', '', '', '', r(s.openingPaise)],
      ...s.lines.map((l) => [l.date, l.kind, l.number, l.detail ?? '', l.chargePaise ? r(l.chargePaise) : '', l.paymentPaise ? r(l.paymentPaise) : '', r(l.balancePaise)]),
      [s.to, w.due, '', '', r(s.chargesPaise), r(s.paymentsPaise), r(s.closingPaise)],
    ],
  };
}

export function PartyStatementPanel({ contactId, side }: { contactId: string; side: 'customer' | 'vendor' }) {
  const [range, setRange] = useReportRange();
  const state = useApi<PartyStatement>(
    () => contacts.statement(contactId, { side, from: range.from, to: range.to }),
    [contactId, side, range.from, range.to],
  );
  const w = statementWords(side);
  const mail = useApi(() => api.get<{ configured: boolean }>('/api/email', { docType: 'statement', docId: contactId }), [contactId]);
  const [sending, setSending] = useState(false);
  const email = async () => {
    setSending(true);
    try {
      const r = await api.post<{ to: string[] }>('/api/email', { kind: 'statement', contactId, side, from: range.from, to: range.to });
      toast.success('Statement emailed', { description: `To ${r.to.join(', ')}, with the statement as a spreadsheet.` });
    } catch (e) {
      toast.error('Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };
  const base = side === 'customer' ? `/sales/customers/${contactId}` : `/purchases/vendors/${contactId}`;

  return (
    <div className="space-y-4" data-slot="party-statement">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <DateRangePicker value={range} onChange={setRange} label="Period" align="start" />
        <div className="flex gap-2">
          {mail.data?.configured && (
            <Button variant="outline" size="sm" disabled={!state.data || sending} onClick={email} data-slot="email-statement">
              <Mail className="size-3.5" /> {sending ? 'Sending…' : 'Email'}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!state.data}
            onClick={() => state.data && downloadWorkbook(`statement-${state.data.party.name}-${range.from}-${range.to}`, [statementSheet(state.data)])}>
            <FileSpreadsheet className="size-3.5" /> Excel
          </Button>
          <Button size="sm" asChild>
            <Link href={`${base}/statement?from=${range.from}&to=${range.to}`}><Printer className="size-3.5" /> Print or PDF</Link>
          </Button>
        </div>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(s) => (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <StatTile label="Opening balance" value={formatINRCompact(s.openingPaise)} />
              <StatTile label={w.charges} value={formatINRCompact(s.chargesPaise)} />
              <StatTile label={w.payments} value={formatINRCompact(s.paymentsPaise)} tone="positive" />
              <StatTile label={w.due} value={formatINRCompact(s.closingPaise)} tone={s.closingPaise > 0 ? 'warning' : 'positive'} />
            </div>
            <ReportTable>
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Transaction</th>
                  <th className="px-3 py-2 text-left font-medium">Details</th>
                  <th className="px-3 py-2 text-right font-medium">{w.charges}</th>
                  <th className="px-3 py-2 text-right font-medium">{w.payments}</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-3 py-2 tabular-nums">{short(s.from)}</td>
                  <td className="px-3 py-2 font-medium" colSpan={2}>Opening balance</td>
                  <td /><td />
                  <td className="px-3 py-2 text-right"><Money value={s.openingPaise} /></td>
                </tr>
                {s.lines.map((l, i) => {
                  const href = sourceHref(l.sourceType, l.sourceId);
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 tabular-nums">{short(l.date)}</td>
                      <td className="px-3 py-2">
                        {l.kind}{' '}
                        {href ? <Link href={href} className="font-medium text-primary hover:underline">{l.number}</Link> : <span className="font-medium">{l.number}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.detail}</td>
                      <td className="px-3 py-2 text-right"><Money value={l.chargePaise} showZero={false} /></td>
                      <td className="px-3 py-2 text-right"><Money value={l.paymentPaise} showZero={false} /></td>
                      <td className="px-3 py-2 text-right"><Money value={l.balancePaise} /></td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-3 py-2 tabular-nums">{short(s.to)}</td>
                  <td className="px-3 py-2" colSpan={2}>{w.due}</td>
                  <td className="px-3 py-2 text-right"><Money value={s.chargesPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={s.paymentsPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={s.closingPaise} /></td>
                </tr>
              </tbody>
            </ReportTable>
            {!s.lines.length && <p className="text-sm text-muted-foreground">Nothing moved on this account in the period.</p>}
          </>
        )}
      </AsyncPage>
    </div>
  );
}

/** The period a print link asks for, or this financial year. */
export function statementPeriod(params: URLSearchParams) {
  const fy = fromPreset('this_fy', today());
  const ok = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { from: ok(params.get('from')) ?? fy.from, to: ok(params.get('to')) ?? fy.to };
}
