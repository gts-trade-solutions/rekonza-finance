'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Analytics home: the reports people have built, and the data behind them.
//
// Two nouns, kept apart the way Tableau keeps data sources apart from
// workbooks. A dataset is imported once and can feed any number of reports;
// a report is a layout of charts over one dataset. Deleting a report never
// touches its data, and a dataset cannot be deleted from under a report.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  BookOpen, ChartColumnBig, Database, Globe, Loader2, Lock, Plus, Search, Sparkles, Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadFailed, LoadingRows } from '@/components/shared/async-state';
import { SOURCE_LABELS, analytics, type DatasetSummary, type ReportSummary } from '@/lib/api/analytics';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const when = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function AnalyticsPage() {
  const router = useRouter();
  const canCreate = usePermission('analytics', 'create');
  const reports = useApi(() => analytics.reports(), []);
  const datasets = useApi(() => analytics.datasets(), []);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<string>('reports');

  const quick = useApiAction(async (source: 'books' | 'sample') => analytics.createDataset({ source, createReport: true }));
  const fromDataset = useApiAction(async (d: DatasetSummary) =>
    analytics.createReport({ datasetId: d.id, name: `${d.name} — report` }),
  );

  const start = async (source: 'books' | 'sample') => {
    // Opening the sample twice should open it twice, not import it twice. A
    // books snapshot that already has a report is refreshed from its dataset
    // page instead of duplicated here.
    const existing = datasets.data?.datasets.find((d) => d.source === source);
    const report = existing && reports.data?.reports.find((r) => r.datasetId === existing.id);
    if (report) {
      router.push(`/analytics/reports/${report.id}`);
      return;
    }
    const res = await quick.run(source);
    if (res?.reportId) router.push(`/analytics/reports/${res.reportId}`);
  };

  const newFrom = async (d: DatasetSummary) => {
    const res = await fromDataset.run(d);
    if (res) router.push(`/analytics/reports/${res.id}`);
  };

  const filteredReports = useMemo(() => {
    const list = reports.data?.reports ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((r) => r.name.toLowerCase().includes(s) || r.datasetName.toLowerCase().includes(s)) : list;
  }, [reports.data, q]);

  const filteredDatasets = useMemo(() => {
    const list = datasets.data?.datasets ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((d) => d.name.toLowerCase().includes(s)) : list;
  }, [datasets.data, q]);

  const nothingYet = reports.data && datasets.data && !reports.data.reports.length && !datasets.data.datasets.length;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Turn a spreadsheet, or your own books, into charts and dashboards. Bring the data in and a first dashboard is laid out for you — then change any chart, add your own, and share it."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/analytics/new">
                <Plus className="size-4" /> New report
              </Link>
            </Button>
          )
        }
      />

      {canCreate && (
        <section className="grid gap-3 md:grid-cols-3" aria-label="Start a report">
          <QuickStart
            icon={Upload}
            title="Upload a spreadsheet"
            body="CSV or Excel, up to 50,000 rows. Columns, dates and amounts are recognised for you."
            href="/analytics/new"
          />
          <QuickStart
            icon={BookOpen}
            title="Analyse your sales"
            body="Every invoice line in your books — customer, item, state, tax — ready to slice."
            busy={quick.busy}
            onClick={() => start('books')}
          />
          <QuickStart
            icon={Sparkles}
            title="Explore the sample"
            body="Two years of regional sales against budget, to see what a finished dashboard looks like."
            busy={quick.busy}
            onClick={() => start('sample')}
          />
        </section>
      )}
      {quick.error && <p className="text-sm text-destructive">{quick.error}</p>}

      {nothingYet ? (
        <EmptyState
          icon={ChartColumnBig}
          title="No reports yet"
          description={
            canCreate
              ? 'Start with one of the options above. Your first dashboard is built the moment the data is in.'
              : 'Nobody has shared a report with the team yet.'
          }
        />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="reports" data-slot="tab-reports">
                Reports {reports.data ? `· ${reports.data.reports.length}` : ''}
              </TabsTrigger>
              <TabsTrigger value="datasets" data-slot="tab-datasets">
                Datasets {datasets.data ? `· ${datasets.data.datasets.length}` : ''}
              </TabsTrigger>
            </TabsList>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'reports' ? 'Search reports' : 'Search datasets'} className="pl-8" />
            </div>
          </div>

          <TabsContent value="reports">
            {reports.error ? (
              <LoadFailed message={reports.error} onRetry={reports.refetch} />
            ) : !reports.data ? (
              <LoadingRows rows={3} />
            ) : filteredReports.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredReports.map((r) => (
                  <ReportCard key={r.id} r={r} />
                ))}
              </div>
            ) : (
              <Card className="p-10 text-center text-sm text-muted-foreground">
                {q ? `No report matches “${q}”.` : 'No reports yet. Build one from a dataset, or start from the options above.'}
              </Card>
            )}
          </TabsContent>

          <TabsContent value="datasets">
            {datasets.error ? (
              <LoadFailed message={datasets.error} onRetry={datasets.refetch} />
            ) : !datasets.data ? (
              <LoadingRows rows={3} />
            ) : filteredDatasets.length ? (
              <Card className="overflow-hidden p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Dataset</th>
                        <th className="px-4 py-2.5 font-medium">Source</th>
                        <th className="px-4 py-2.5 text-right font-medium">Rows</th>
                        <th className="px-4 py-2.5 text-right font-medium">Columns</th>
                        <th className="px-4 py-2.5 text-right font-medium">Reports</th>
                        <th className="px-4 py-2.5 font-medium">Updated</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDatasets.map((d) => (
                        <tr key={d.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2.5">
                            <Link href={`/analytics/datasets/${d.id}`} className="font-medium text-primary hover:underline">
                              {d.name}
                            </Link>
                            {d.sourceName && <p className="text-[11px] text-muted-foreground">{d.sourceName}</p>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{SOURCE_LABELS[d.source]}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{d.rowCount.toLocaleString('en-IN')}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{d.columnCount}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{d.reportCount}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">
                            {when(d.refreshedAt ?? d.updatedAt)} · {size(d.sizeBytes)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {canCreate && (
                              <Button variant="outline" size="sm" disabled={fromDataset.busy} onClick={() => newFrom(d)}>
                                {fromDataset.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                                New report
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : (
              <Card className="p-10 text-center text-sm text-muted-foreground">
                {q ? `No dataset matches “${q}”.` : 'No datasets yet.'}
              </Card>
            )}
            {fromDataset.error && <p className="mt-2 text-sm text-destructive">{fromDataset.error}</p>}
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

function QuickStart({
  icon: Icon, title, body, href, onClick, busy,
}: { icon: typeof Upload; title: string; body: string; href?: string; onClick?: () => void; busy?: boolean }) {
  const inner = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-[3px] bg-primary/10 text-primary">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{body}</span>
      </span>
    </>
  );
  const cls =
    'flex h-full w-full items-start gap-3 rounded-[3px] border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30 disabled:opacity-60';
  return href ? (
    <Link href={href} className={cls} data-slot="quick-start">
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} disabled={busy} className={cls} data-slot="quick-start">
      {inner}
    </button>
  );
}

function ReportCard({ r }: { r: ReportSummary }) {
  return (
    <Link
      href={`/analytics/reports/${r.id}`}
      className="group flex h-full flex-col rounded-[3px] border bg-card p-4 transition-colors hover:border-primary/40"
      data-slot="report-card"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[3px] bg-muted text-muted-foreground group-hover:text-primary">
          <ChartColumnBig className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{r.name}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Database className="size-3 shrink-0" /> {r.datasetName}
          </p>
        </div>
        {r.visibility === 'org' ? (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Globe /> Shared
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Lock /> Private
          </Badge>
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        {r.tileCount} {r.tileCount === 1 ? 'chart' : 'charts'} · updated {when(r.updatedAt)}
        {!r.isOwner && r.createdBy ? ` · by ${r.createdBy}` : ''}
      </p>
    </Link>
  );
}
