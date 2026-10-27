'use client';

// GSTR-9C — the reconciliation statement: the books beside the annual return.
//
// Both sides come from the same ledger here, so what does not reconcile is
// exactly what reached revenue, output tax or credit without a GST document:
// those postings are listed as the reasons, with their amounts. Lines the books
// cannot know about are marked for the preparer.

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { downloadCsv, ReportTable } from '@/components/shared/report-shell';
import { gst, type Gstr9cLine, type Gstr9cReason, type Gstr9cResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const lastFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0) - 1;
};
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

const SOURCE_TAG: Record<Gstr9cLine['source'], string | null> = {
  books: 'books', return: 'GSTR-9', preparer: 'preparer', total: null,
};

function Lines({ title, lines }: { title: string; lines: Gstr9cLine[] }) {
  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          <th className={`${th} text-left`}>{title}</th>
          <th className={`${th} w-24 text-left`}>From</th>
          <th className={`${th} w-44 text-right`}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const last = l.source === 'total';
          const off = last && /un-reconciled/i.test(l.label) && l.paise !== 0;
          return (
            <tr key={l.ref} className={`border-b last:border-0 ${last ? 'bg-muted/30 font-semibold' : ''} ${l.source === 'preparer' ? 'text-muted-foreground' : ''}`}>
              <td className="px-3 py-2 text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{l.ref}</span>{l.label}</td>
              <td className="px-3 py-2">
                {SOURCE_TAG[l.source] && <Badge variant="outline" className="text-[10px]">{SOURCE_TAG[l.source]}</Badge>}
              </td>
              <td className={`px-3 py-2 text-right ${off ? 'text-destructive' : ''}`}>
                <Money value={l.paise} showZero={l.source !== 'preparer'} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </ReportTable>
  );
}

function Reasons({ title, rows, empty }: { title: string; rows: Gstr9cReason[]; empty: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5 text-emerald-600" /> {empty}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.source} className="flex items-center justify-between gap-3">
              <span>{r.label}</span><Money value={r.paise} className="font-medium" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Gstr9cPage() {
  const [fy, setFy] = useState(lastFy());
  const state = useApi<Gstr9cResponse>(() => gst.gstr9c(fy), [fy]);
  const years = useMemo(() => Array.from({ length: 6 }, (_, i) => lastFy() + 1 - i), []);

  const exportCsv = (d: Gstr9cResponse) => {
    const line = (l: Gstr9cLine) => [l.ref, l.label, l.source, toRupees(l.paise)];
    downloadCsv(`GSTR9C-${d.fy}.csv`, [
      ['Table', 'Particulars', 'From', 'Amount'],
      ...d.table5.map(line),
      ...d.table6.map((r) => ['6', r.label, 'books', toRupees(r.paise)]),
      ...d.table7.map(line),
      ...d.table9.heads.map((h) => ['9', `${h.head}: books ${toRupees(h.booksPaise)}, GSTR-9 ${toRupees(h.returnPaise)}`, 'total', toRupees(h.unreconciledPaise)]),
      ...d.table12.map(line),
      ...d.table14.map((r) => ['14', `${r.code} ${r.name}`, 'books', toRupees(r.itcPaise)]),
    ]);
  };

  return (
    <>
      <PageHeader
        title="GSTR-9C"
        description="The reconciliation statement: turnover, tax and input credit in the books, beside the annual return."
        actions={
          <>
            <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
              <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map((y) => <SelectItem key={y} value={String(y)}>FY {fyLabel(y)}</SelectItem>)}
              </SelectContent>
            </Select>
            {state.data && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => exportCsv(state.data!)}>
                <Download className="size-3.5" /> CSV
              </Button>
            )}
          </>
        }
      />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => {
          const u = d.unreconciled;
          const clean = !u.turnoverPaise && !u.taxableTurnoverPaise && !u.taxPaise && !u.itcPaise;
          return (
            <div className="space-y-5">
              <Card className={`flex items-start gap-3 p-4 ${clean ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
                {clean ? <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" /> : <AlertTriangle className="mt-0.5 size-5 text-amber-600" />}
                <div className="grid flex-1 gap-2 text-sm sm:grid-cols-4">
                  <div><p className="text-xs text-muted-foreground">Turnover (5R)</p><Money value={u.turnoverPaise} className="font-semibold" /></div>
                  <div><p className="text-xs text-muted-foreground">Taxable turnover (7G)</p><Money value={u.taxableTurnoverPaise} className="font-semibold" /></div>
                  <div><p className="text-xs text-muted-foreground">Tax (9)</p><Money value={u.taxPaise} className="font-semibold" /></div>
                  <div><p className="text-xs text-muted-foreground">Input credit (12F)</p><Money value={u.itcPaise} className="font-semibold" /></div>
                </div>
              </Card>
              <p className="text-xs text-muted-foreground">
                FY {d.fy}{d.gstin ? ` · GSTIN ${d.gstin}` : ''}. Un-reconciled amounts above; everything below shows where they come from.
              </p>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Table 5 · Turnover</h2>
                <Lines title="Particulars" lines={d.table5} />
              </section>
              <Reasons
                title="Table 6 · Reasons: revenue in the books without a GST document"
                rows={d.table6}
                empty="All revenue came from invoices and credit notes."
              />
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Table 7 · Taxable turnover</h2>
                <Lines title="Particulars" lines={d.table7} />
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Table 9 · Tax</h2>
                <ReportTable>
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`}>Rate</th>
                      <th className={`${th} text-right`}>Taxable</th>
                      <th className={`${th} text-right`}>CGST</th>
                      <th className={`${th} text-right`}>SGST</th>
                      <th className={`${th} text-right`}>IGST</th>
                      <th className={`${th} text-right`}>Cess</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.table9.byRate.map((r) => (
                      <tr key={r.ratePct} className="border-b last:border-0">
                        <td className="px-3 py-2 text-sm">{r.ratePct}%</td>
                        <td className="px-3 py-2 text-right"><Money value={r.taxablePaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.cgstPaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.sgstPaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.igstPaise} showZero={false} /></td>
                        <td className="px-3 py-2 text-right"><Money value={r.cessPaise} showZero={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </ReportTable>
                <ReportTable>
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`}>Head</th>
                      <th className={`${th} text-right`}>As per the books</th>
                      <th className={`${th} text-right`}>Paid as per GSTR-9</th>
                      <th className={`${th} text-right`}>Un-reconciled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.table9.heads.map((h) => (
                      <tr key={h.head} className="border-b last:border-0">
                        <td className="px-3 py-2 text-sm">{h.head}</td>
                        <td className="px-3 py-2 text-right"><Money value={h.booksPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money value={h.returnPaise} /></td>
                        <td className={`px-3 py-2 text-right font-medium ${h.unreconciledPaise ? 'text-destructive' : ''}`}><Money value={h.unreconciledPaise} /></td>
                      </tr>
                    ))}
                  </tbody>
                </ReportTable>
                <Reasons
                  title="Tax posted to the output ledgers without a GST document"
                  rows={d.table9.outsideDocuments}
                  empty="Every rupee of output tax came from a document."
                />
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Table 12 · Input tax credit</h2>
                <Lines title="Particulars" lines={d.table12} />
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Table 14 · Credit by expense head</h2>
                {d.table14.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No credit taken on bills or expenses in the year.</p>
                ) : (
                  <ReportTable>
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className={`${th} text-left`}>Expense head</th>
                        <th className={`${th} text-right`}>ITC availed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.table14.map((r) => (
                        <tr key={r.accountId} className="border-b last:border-0">
                          <td className="px-3 py-2 text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{r.code}</span>{r.name}</td>
                          <td className="px-3 py-2 text-right"><Money value={r.itcPaise} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </ReportTable>
                )}
              </section>

              <Card className="space-y-1.5 p-4">
                {d.notes.map((n) => <p key={n} className="text-xs leading-relaxed text-muted-foreground">{n}</p>)}
              </Card>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
