'use client';

// One account, in order, with a running balance.
//
// This is the drill-down behind every other report: a figure on the trial
// balance or the profit and loss is a total of exactly these rows, and this is
// where you go when one of them looks wrong. The profit and loss, balance
// sheet and trial balance link here with the account and range in the URL.

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api, reports, type GeneralLedgerReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { sourceHref } from '@/lib/source-links';

export default function GeneralLedgerPage() {
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <GeneralLedger />
    </Suspense>
  );
}

function GeneralLedger() {
  const params = useSearchParams();
  const [range, setRange] = useReportRange({ from: params.get('from'), to: params.get('to') });
  const [accountId, setAccountId] = useState(params.get('account') ?? '');

  const masters = useApi<{ accounts: { id: string; code: string; name: string; type: string }[] }>(
    () => api.get('/api/masters'),
    [],
  );

  const options = useMemo(
    () =>
      (masters.data?.accounts ?? []).map((a) => ({
        value: a.id,
        label: a.name,
        sublabel: `${a.code} · ${a.type}`,
      })),
    [masters.data],
  );

  // Open on Accounts Receivable — the account people check most often.
  useEffect(() => {
    if (accountId || !masters.data) return;
    const ar = masters.data.accounts.find((a) => a.code === '1100');
    setAccountId(ar?.id ?? masters.data.accounts[0]?.id ?? '');
  }, [accountId, masters.data]);

  const state = useApi<GeneralLedgerReport | null>(
    () => (accountId ? reports.generalLedger(accountId, range.from, range.to) : Promise.resolve(null)),
    [accountId, range.from, range.to],
  );

  return (
    <ReportShell
      title="General Ledger"
      description="Every movement through a single account, in order, with a running balance. This is the drill-down behind every other report."
      range={range}
      onRangeChange={setRange}
      extraActions={
        <div className="w-64 space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Account</label>
          <Combobox
            options={options}
            value={accountId}
            onChange={setAccountId}
            placeholder="Select an account"
            searchPlaceholder="Search by name or code"
            showAvatar={false}
          />
        </div>
      }
      onExport={() => {
        const gl = state.data;
        if (!gl) return;
        downloadCsv(`general-ledger-${gl.account.code}.csv`, [
          ['Date', 'Entry', 'Source', 'Description', 'Contact', 'Debit', 'Credit', 'Balance'],
          ['', '', '', 'Opening balance', '', '', '', toRupees(gl.openingPaise)],
          ...gl.lines.map((l) => [
            l.date, l.entryNo, l.sourceType, l.description ?? l.memo ?? '', l.contactName ?? '',
            toRupees(l.debitPaise), toRupees(l.creditPaise), toRupees(l.runningPaise),
          ]),
          ['', '', '', 'Closing balance', '', '', '', toRupees(gl.closingPaise)],
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(gl) =>
          !gl ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Choose an account to see its ledger.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">Opening balance</p>
                  <Money value={gl.openingPaise} className="mt-1 block text-xl font-semibold" />
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">Movements</p>
                  <p className="mt-1 tabular text-xl font-semibold">{gl.lines.length}</p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">Closing balance</p>
                  <Money value={gl.closingPaise} className="mt-1 block text-xl font-semibold" />
                </div>
              </div>

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Date</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Entry</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Description</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Contact</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Debit</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Credit</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b bg-muted/20">
                    <td className="px-4 py-2 text-sm text-muted-foreground" colSpan={6}>
                      Opening balance at {new Date(gl.from).toLocaleDateString('en-IN')}
                    </td>
                    <td className="px-4 py-2 text-right font-medium"><Money value={gl.openingPaise} /></td>
                  </tr>

                  {gl.lines.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Nothing moved through this account in the period.
                      </td>
                    </tr>
                  ) : (
                    gl.lines.map((l, i) => {
                      const route = sourceHref(l.sourceType, l.sourceId);
                      return (
                        <tr key={`${l.entryId}-${i}`} className="border-b last:border-0 hover:bg-accent/40">
                          <td className="px-4 py-2 tabular text-xs">
                            {new Date(l.date).toLocaleDateString('en-IN', {
                              day: '2-digit', month: 'short', year: '2-digit',
                            })}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">#{l.entryNo}</td>
                          <td className="px-4 py-2">
                            {l.description ?? l.memo ?? '—'}
                            <span className="ml-2 text-xs capitalize text-muted-foreground">
                              {route ? (
                                <Link href={route} className="underline underline-offset-2">
                                  {l.sourceType.replace('_', ' ')}
                                </Link>
                              ) : (
                                l.sourceType.replace('_', ' ')
                              )}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{l.contactName ?? '—'}</td>
                          <td className="px-4 py-2 text-right"><Money value={l.debitPaise} showZero={false} /></td>
                          <td className="px-4 py-2 text-right"><Money value={l.creditPaise} showZero={false} /></td>
                          <td className="px-4 py-2 text-right font-medium"><Money value={l.runningPaise} /></td>
                        </tr>
                      );
                    })
                  )}

                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-4 py-3" colSpan={6}>
                      Closing balance at {new Date(gl.to).toLocaleDateString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right"><Money value={gl.closingPaise} /></td>
                  </tr>
                </tbody>
              </ReportTable>
            </>
          )
        }
      </AsyncPage>
    </ReportShell>
  );
}
