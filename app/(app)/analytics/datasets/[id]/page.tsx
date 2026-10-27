'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One dataset: what its columns are, what is in it, and what is built on it.
//
// Renaming a column here renames it on every chart that uses it — charts refer
// to columns by a key that never changes, not by their name. Types are fixed
// once imported, because changing what a column holds would mean re-reading
// the file; roles are not, because "add this up" is a judgement, not a fact.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft, ChartColumnBig, Loader2, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { OptionSelect } from '@/components/analytics/option-select';
import { MONTHS } from '@/lib/analytics/dates';
import { TYPE_LABELS, formatValue } from '@/lib/analytics/format';
import type { Cell, ColumnRole, ColumnSchema, ColumnType } from '@/lib/analytics/types';
import { SOURCE_LABELS, analytics, type DatasetFull, type ReportSummary } from '@/lib/api/analytics';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const numeric = (t: ColumnType) => t === 'number' || t === 'currency' || t === 'percent';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function show(v: Cell, type: ColumnType): string {
  if (v === null) return '—';
  if (type === 'date' && typeof v === 'string') {
    const [y, m, d] = v.split('-').map(Number);
    return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  }
  if (typeof v === 'number') return formatValue(v, type === 'currency' ? 'inr' : type === 'percent' ? 'percent' : 'decimal').replace(/\.00$/, '');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

function range(c: ColumnSchema): string {
  const p = c.profile;
  if (!p || p.min === undefined || p.max === undefined) return '';
  if (c.type === 'date') return `${show(String(p.min), 'date')} to ${show(String(p.max), 'date')}`;
  if (typeof p.min === 'number' && typeof p.max === 'number') return `${show(p.min, c.type)} to ${show(p.max, c.type)}`;
  return '';
}

export default function DatasetPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(async () => {
    const [dataset, reports] = await Promise.all([analytics.dataset(id), analytics.reports()]);
    return { dataset, reports: reports.reports.filter((r) => r.datasetId === dataset.id) };
  }, [id]);

  return (
    <AsyncPage state={state}>
      {({ dataset, reports }) => <DatasetView key={dataset.updatedAt} dataset={dataset} reports={reports} onChanged={state.refetch} />}
    </AsyncPage>
  );
}

function DatasetView({ dataset, reports, onChanged }: { dataset: DatasetFull; reports: ReportSummary[]; onChanged: () => void }) {
  const router = useRouter();
  const canEdit = usePermission('analytics', 'edit');
  const canCreate = usePermission('analytics', 'create');
  const canDelete = usePermission('analytics', 'void');

  const [name, setName] = useState(dataset.name);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useApiAction(analytics.updateDataset);
  const refresh = useApiAction(analytics.refreshDataset);
  const remove = useApiAction(analytics.deleteDataset);
  const newReport = useApiAction(analytics.createReport);

  const changes = useMemo(
    () =>
      dataset.columns
        .map((c) => {
          const label = labels[c.key]?.trim();
          const role = roles[c.key];
          const patch: { key: string; label?: string; role?: ColumnRole } = { key: c.key };
          if (label && label !== c.label) patch.label = label;
          if (role && role !== c.role) patch.role = role;
          return patch.label || patch.role ? patch : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [dataset.columns, labels, roles],
  );
  const renamed = name.trim() && name.trim() !== dataset.name;
  const dirty = changes.length > 0 || !!renamed;

  const onSave = async () => {
    const res = await save.run(dataset.id, { ...(renamed ? { name: name.trim() } : {}), ...(changes.length ? { columns: changes } : {}) });
    if (res) {
      toast.success('Saved. Every chart on this data uses the new names.');
      onChanged();
    }
  };

  const onRefresh = async () => {
    const res = await refresh.run(dataset.id);
    if (res) {
      toast.success(`Refreshed — ${res.rowCount.toLocaleString('en-IN')} rows from the books.`);
      onChanged();
    }
  };

  const onDelete = async () => {
    const res = await remove.run(dataset.id);
    if (res) {
      toast.success('Dataset deleted.');
      router.push('/analytics');
    }
  };

  const onNewReport = async () => {
    const res = await newReport.run({ datasetId: dataset.id, name: `${dataset.name} — report` });
    if (res) router.push(`/analytics/reports/${res.id}`);
  };

  return (
    <>
      <PageHeader
        title={dataset.name}
        description={`${SOURCE_LABELS[dataset.source]}${dataset.sourceName ? ` · ${dataset.sourceName}` : ''} · ${dataset.rowCount.toLocaleString('en-IN')} rows · ${dataset.columnCount} columns · ${dataset.refreshedAt ? `refreshed ${when(dataset.refreshedAt)}` : `imported ${when(dataset.createdAt)}`}`}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/analytics">
                <ArrowLeft className="size-3.5" /> Analytics
              </Link>
            </Button>
            {canEdit && dataset.source === 'books' && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={refresh.busy} data-slot="refresh-dataset">
                {refresh.busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh from the books
              </Button>
            )}
            {canCreate && (
              <Button size="sm" onClick={onNewReport} disabled={newReport.busy}>
                {newReport.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} New report
              </Button>
            )}
          </>
        }
      />

      {(refresh.error || newReport.error) && (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <TriangleAlert className="size-4" /> {refresh.error ?? newReport.error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Columns</p>
              <p className="text-xs text-muted-foreground">
                “Group by” columns split the data; “Add up” columns are the numbers charts total.
              </p>
            </div>
            {canEdit && (
              <label className="w-full space-y-1 text-[11px] text-muted-foreground sm:w-72">
                Dataset name
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} className="h-8 text-xs" />
              </label>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-slot="dataset-columns">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Holds</th>
                  <th className="px-4 py-2 font-medium">Use it to</th>
                  <th className="px-4 py-2 font-medium">What is in it</th>
                </tr>
              </thead>
              <tbody>
                {dataset.columns.map((c) => (
                  <tr key={c.key} className="border-b align-top last:border-0">
                    <td className="min-w-48 px-4 py-2">
                      {canEdit ? (
                        <Input
                          value={labels[c.key] ?? c.label}
                          onChange={(e) => setLabels((l) => ({ ...l, [c.key]: e.target.value }))}
                          maxLength={80}
                          className="h-8 text-xs"
                          aria-label={`Name of ${c.label}`}
                        />
                      ) : (
                        <span className="font-medium">{c.label}</span>
                      )}
                      {c.notes?.map((n) => (
                        <p key={n} className="mt-1 max-w-80 text-[11px] leading-snug text-muted-foreground">
                          {n}
                        </p>
                      ))}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{TYPE_LABELS[c.type]}</td>
                    <td className="min-w-32 px-4 py-2">
                      {canEdit ? (
                        <OptionSelect<ColumnRole>
                          value={roles[c.key] ?? c.role}
                          onChange={(r) => setRoles((x) => ({ ...x, [c.key]: r }))}
                          options={[
                            { value: 'dimension', label: 'Group by' },
                            { value: 'measure', label: 'Add up', disabled: !numeric(c.type) },
                          ]}
                          className="h-8 text-xs"
                          label={`How to use ${c.label}`}
                        />
                      ) : (
                        <span className="text-xs">{c.role === 'measure' ? 'Add up' : 'Group by'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {c.profile ? (
                        <>
                          {c.profile.distinct.toLocaleString('en-IN')} different
                          {c.profile.nulls ? ` · ${c.profile.nulls.toLocaleString('en-IN')} empty` : ''}
                          {range(c) && <span className="block">{range(c)}</span>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t px-4 py-3">
              {save.error && <p className="mr-auto text-xs text-destructive">{save.error}</p>}
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty || save.busy}
                onClick={() => {
                  setLabels({});
                  setRoles({});
                  setName(dataset.name);
                }}
              >
                Undo changes
              </Button>
              <Button size="sm" disabled={!dirty || save.busy} onClick={onSave} data-slot="save-dataset">
                {save.busy && <Loader2 className="size-3.5 animate-spin" />} Save changes
              </Button>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-sm font-semibold">Reports on this data</p>
            {reports.length ? (
              <ul className="mt-2 space-y-1.5">
                {reports.map((r) => (
                  <li key={r.id}>
                    <Link href={`/analytics/reports/${r.id}`} className="flex items-center gap-2 text-sm text-primary hover:underline">
                      <ChartColumnBig className="size-3.5 shrink-0" />
                      <span className="truncate">{r.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">None that you can see yet.</p>
            )}
            {dataset.reportCount > reports.length && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {dataset.reportCount - reports.length} more {dataset.reportCount - reports.length === 1 ? 'is' : 'are'} private to{' '}
                {dataset.reportCount - reports.length === 1 ? 'its owner' : 'their owners'}.
              </p>
            )}
          </Card>

          {canDelete && (
            <Card className="p-4">
              <p className="text-sm font-semibold">Delete this dataset</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {dataset.reportCount
                  ? `${dataset.reportCount} ${dataset.reportCount === 1 ? 'report is' : 'reports are'} built on it. Delete ${dataset.reportCount === 1 ? 'that report' : 'those reports'} first.`
                  : 'No report uses it, so it can go.'}
              </p>
              <Button variant="destructive" size="sm" className="mt-3" disabled={dataset.reportCount > 0} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" /> Delete dataset
              </Button>
            </Card>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-semibold">The first {Math.min(50, dataset.rows.length)} rows</p>
        </div>
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs" data-slot="dataset-preview">
            <thead className="sticky top-0 border-b bg-card text-left text-muted-foreground">
              <tr>
                {dataset.columns.map((c) => (
                  <th key={c.key} className={cn('whitespace-nowrap px-3 py-2 font-medium', numeric(c.type) && 'text-right')}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataset.rows.slice(0, 50).map((r, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0">
                  {dataset.columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn('max-w-60 truncate whitespace-nowrap px-3 py-1.5', numeric(c.type) && 'text-right tabular-nums', r[c.index] === null && 'text-muted-foreground')}
                    >
                      {show(r[c.index], c.type)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{dataset.name}”?</DialogTitle>
            <DialogDescription>
              Its {dataset.rowCount.toLocaleString('en-IN')} rows are removed from Analytics. Your books are not touched — this is only the imported copy.
            </DialogDescription>
          </DialogHeader>
          {remove.error && <p className="text-sm text-destructive">{remove.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDelete} disabled={remove.busy}>
              {remove.busy && <Loader2 className="size-4 animate-spin" />} Delete dataset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
