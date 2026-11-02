'use client';

// Profit and loss cut by a reporting tag: income, expense and profit under
// each of the tag's values, and what carries no value of it.

import { useState } from 'react';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

interface Row { option: string; incomePaise: number; expensePaise: number; profitPaise: number }

export default function ProfitByTagPage() {
  const [range, setRange] = useReportRange();
  const tags = useApi(() => api.get<{ tags: { id: string; name: string; isActive: boolean }[] }>('/api/reporting-tags'), []);
  const [tagId, setTagId] = useState('');
  const pick = tagId || tags.data?.tags[0]?.id || '';
  const state = useApi<{ tag: string; rows: Row[] } | null>(
    () => (pick ? api.get('/api/reporting-tags', { report: 'profit', tagId: pick, from: range.from, to: range.to }) : Promise.resolve(null)),
    [pick, range.from, range.to],
  );
  return (
    <ReportShell
      title="Profit by Reporting Tag"
      description="Income, expense and profit under each value of a tag. Lines on documents that carry no value of it are counted as Untagged, so the columns add up to the profit and loss."
      range={range}
      onRangeChange={setRange}
      extraActions={
        <select value={pick} onChange={(e) => setTagId(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="Tag">
          {(tags.data?.tags ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      }
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv(`profit-by-${d.tag}.csv`, [[d.tag, 'Income', 'Expense', 'Profit'], ...d.rows.map((r) => [r.option, toRupees(r.incomePaise), toRupees(r.expensePaise), toRupees(r.profitPaise)])]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => !d ? <p className="text-sm text-muted-foreground">No reporting tags yet. Add them under Settings → Reporting tags.</p> : (
          <ReportTable>
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr><th className="px-3 py-2 text-left font-medium">{d.tag}</th><th className="px-3 py-2 text-right font-medium">Income</th><th className="px-3 py-2 text-right font-medium">Expense</th><th className="px-3 py-2 text-right font-medium">Profit</th></tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.option} className="border-t">
                  <td className={`px-3 py-2 ${r.option === 'Untagged' ? 'text-muted-foreground' : 'font-medium'}`}>{r.option}</td>
                  <td className="px-3 py-2 text-right"><Money value={r.incomePaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.expensePaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={r.profitPaise} className={r.profitPaise < 0 ? 'text-destructive' : undefined} /></td>
                </tr>
              ))}
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right"><Money value={d.rows.reduce((t, r) => t + r.incomePaise, 0)} /></td>
                <td className="px-3 py-2 text-right"><Money value={d.rows.reduce((t, r) => t + r.expensePaise, 0)} /></td>
                <td className="px-3 py-2 text-right"><Money value={d.rows.reduce((t, r) => t + r.profitPaise, 0)} /></td>
              </tr>
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
