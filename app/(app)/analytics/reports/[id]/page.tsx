'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One report: a board of charts over one dataset.
//
// Everything a reader does here happens in the browser — filtering, flipping a
// chart to its table, presenting — so it is instant, and the numbers come
// from one engine, so two tiles can never disagree about the same slice.
//
// The owner's changes save themselves a moment after they stop. Anyone else
// can filter and explore freely, and nothing they do changes the owner's
// report; "Save a copy" gives them one of their own.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Check, ChartColumnBig, Copy, Database, Ellipsis, Globe, Loader2, Lock, Pencil, Plus, Presentation as PresentIcon,
  Printer, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ChartBuilder } from '@/components/analytics/chart-builder';
import { FilterBar, describeFilters } from '@/components/analytics/filter-bar';
import { TileCard } from '@/components/analytics/tile-card';
import { newTileId } from '@/lib/analytics/starter';
import type { DatasetData, Filter, Tile, TileWidth } from '@/lib/analytics/types';
import { analytics, type DatasetFull, type ReportDetail, type Visibility } from '@/lib/api/analytics';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { printPage } from '@/lib/output-guard';

const MAX_TILES = 40;
const SAVE_DELAY_MS = 700;

export default function AnalyticsReportPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi(async () => {
    const report = await analytics.report(id);
    const dataset = await analytics.dataset(report.datasetId);
    return { report, dataset };
  }, [id]);

  return (
    <AsyncPage state={state} loading={<BoardSkeleton />}>
      {({ report, dataset }) => <Workspace key={report.id} initial={report} dataset={dataset} />}
    </AsyncPage>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-4" data-slot="loading">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-11 w-full" />
      <div className="grid grid-cols-12 gap-3">
        {[3, 3, 3, 3, 8, 4, 6, 6].map((w, i) => (
          <Skeleton key={i} className={cn('h-40', w === 3 ? 'col-span-6 lg:col-span-3' : w === 4 ? 'col-span-12 lg:col-span-4' : w === 6 ? 'col-span-12 lg:col-span-6' : 'col-span-12 lg:col-span-8')} />
        ))}
      </div>
    </div>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function Workspace({ initial, dataset }: { initial: ReportDetail; dataset: DatasetFull }) {
  const router = useRouter();
  const mayEdit = usePermission('analytics', 'edit');
  const mayCreate = usePermission('analytics', 'create');
  const mayDelete = usePermission('analytics', 'void');
  const canEdit = initial.canEdit && mayEdit;

  const data: DatasetData = useMemo(() => ({ columns: dataset.columns, rows: dataset.rows }), [dataset]);
  const [tiles, setTiles] = useState<Tile[]>(initial.layout.tiles);
  const [filters, setFilters] = useState<Filter[]>(initial.filters);
  const [name, setName] = useState(initial.name);
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility);
  const [builder, setBuilder] = useState<{ open: boolean; tile: Tile | null }>({ open: false, tile: null });
  const [presenting, setPresenting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'copy' | 'delete' | null>(null);
  const [save, setSave] = useState<SaveState>('idle');

  // ── Autosave ──
  //
  // Compared against what the server last accepted rather than "has anything
  // changed since mount", so a re-render — or React running an effect twice
  // in development — never sends a save that changes nothing.
  const saved = useRef(JSON.stringify({ tiles: initial.layout.tiles, filters: initial.filters }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const flush = useCallback(async () => {
    const body = pending.current;
    if (!body) return;
    try {
      const parsed = JSON.parse(body) as { tiles: Tile[]; filters: Filter[] };
      await analytics.updateReport(initial.id, { layout: { tiles: parsed.tiles }, filters: parsed.filters });
      saved.current = body;
      if (pending.current === body) {
        pending.current = null;
        setSave('saved');
      }
    } catch {
      setSave('error');
    }
  }, [initial.id]);

  useEffect(() => {
    if (!canEdit) return;
    const body = JSON.stringify({ tiles, filters });
    if (body === saved.current) return;
    pending.current = body;
    setSave('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [tiles, filters, canEdit, flush]);

  // Leaving mid-debounce should not lose the last change.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void flush();
    };
  }, [flush]);

  // ── Report-level changes, saved at once ──

  const rename = async (next: string) => {
    const trimmed = next.trim().slice(0, 150);
    if (!trimmed || trimmed === name) return;
    const before = name;
    setName(trimmed);
    try {
      await analytics.updateReport(initial.id, { name: trimmed });
    } catch {
      setName(before);
      toast.error('The name could not be saved.');
    }
  };

  const share = async (v: Visibility) => {
    if (v === visibility) return;
    const before = visibility;
    setVisibility(v);
    try {
      await analytics.updateReport(initial.id, { visibility: v });
      toast.success(v === 'org' ? 'Everyone in the organisation can now open this report.' : 'Only you can open this report now.');
    } catch {
      setVisibility(before);
      toast.error('Sharing could not be changed.');
    }
  };

  const copy = async () => {
    setBusy('copy');
    try {
      if (pending.current) await flush();
      const res = await analytics.copyReport(initial.id);
      toast.success('A copy is yours to change.');
      router.push(`/analytics/reports/${res.id}`);
    } catch {
      toast.error('The copy could not be made.');
      setBusy(null);
    }
  };

  const destroy = async () => {
    setBusy('delete');
    try {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      await analytics.deleteReport(initial.id);
      toast.success('Report deleted. Its dataset is still there.');
      router.push('/analytics');
    } catch {
      toast.error('The report could not be deleted.');
      setBusy(null);
    }
  };

  // ── Tiles ──

  const upsert = (t: Tile) => setTiles((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t]));
  const duplicate = (t: Tile) =>
    setTiles((ts) => {
      if (ts.length >= MAX_TILES) return ts;
      const i = ts.findIndex((x) => x.id === t.id);
      return [...ts.slice(0, i + 1), { ...t, id: newTileId(), spec: { ...t.spec } }, ...ts.slice(i + 1)];
    });
  const remove = (t: Tile) => {
    const at = tiles.findIndex((x) => x.id === t.id);
    setTiles((ts) => ts.filter((x) => x.id !== t.id));
    toast('Chart removed.', {
      action: { label: 'Undo', onClick: () => setTiles((ts) => [...ts.slice(0, at), t, ...ts.slice(at)]) },
    });
  };
  const move = (t: Tile, delta: -1 | 1) =>
    setTiles((ts) => {
      const i = ts.findIndex((x) => x.id === t.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ts.length) return ts;
      const next = [...ts];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const resize = (t: Tile, width: TileWidth) => setTiles((ts) => ts.map((x) => (x.id === t.id ? { ...x, width } : x)));

  const full = tiles.length >= MAX_TILES;

  return (
    <>
      <div className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="accent-bar min-w-0 flex-1">
          <EditableTitle value={name} editable={canEdit} onCommit={rename} />
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            <Link href={`/analytics/datasets/${dataset.id}`} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
              <Database className="size-3.5" /> {dataset.name}
            </Link>
            <span>· {dataset.rowCount.toLocaleString('en-IN')} rows</span>
            <span className="inline-flex items-center gap-1">
              · {visibility === 'org' ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />}
              {visibility === 'org' ? 'Shared with the organisation' : 'Private'}
            </span>
            {canEdit && <SaveStatus state={save} onRetry={() => void flush()} />}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 no-print">
          <Button variant="outline" size="sm" asChild>
            <Link href="/analytics">
              <ArrowLeft className="size-3.5" /> Analytics
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPresenting(true)} disabled={!tiles.length} data-slot="present">
            <PresentIcon className="size-3.5" /> Present
          </Button>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-7 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
                data-slot="share"
              >
                {visibility === 'org' ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />} Share
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Who can open this report</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={visibility} onValueChange={(v) => void share(v as Visibility)}>
                  <DropdownMenuRadioItem value="private">
                    <span>
                      Only me
                      <span className="block text-[11px] text-muted-foreground">Nobody else sees it in the list.</span>
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="org">
                    <span>
                      Everyone in the organisation
                      <span className="block text-[11px] text-muted-foreground">They can view and filter; only you can change it.</span>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canEdit && (
            <Button size="sm" onClick={() => setBuilder({ open: true, tile: null })} disabled={full} title={full ? `A report holds up to ${MAX_TILES} charts.` : undefined} data-slot="add-chart">
              <Plus className="size-3.5" /> Add chart
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="More actions" className="grid size-7 place-items-center rounded-[3px] border transition-colors hover:bg-accent">
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {mayCreate && (
                <DropdownMenuItem onClick={() => void copy()} disabled={busy !== null}>
                  <Copy /> Save a copy
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPresenting(true)} disabled={!tiles.length}>
                <Printer /> Print or save as PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/analytics/datasets/${dataset.id}`)}>
                <Database /> Open the dataset
              </DropdownMenuItem>
              {canEdit && mayDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete report
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!canEdit && (
        <div className="flex flex-wrap items-center gap-3 rounded-[3px] border border-primary/20 bg-primary/5 px-3 py-2 text-xs no-print">
          <span className="min-w-0 flex-1">
            {initial.createdBy ? `${initial.createdBy} owns this report.` : 'This report belongs to someone else.'} You can filter and explore it;
            your changes are not saved to it.
          </span>
          {mayCreate && (
            <Button size="sm" variant="outline" onClick={() => void copy()} disabled={busy !== null}>
              {busy === 'copy' ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />} Save a copy
            </Button>
          )}
        </div>
      )}

      <FilterBar data={data} filters={filters} onChange={setFilters} note={canEdit ? undefined : 'not saved'} />

      {tiles.length ? (
        <div className="grid grid-cols-12 gap-3" data-slot="board">
          {tiles.map((t, i) => (
            <TileCard
              key={t.id}
              tile={t}
              data={data}
              filters={filters}
              editable={canEdit}
              index={i}
              count={tiles.length}
              onEdit={() => setBuilder({ open: true, tile: t })}
              onDuplicate={() => duplicate(t)}
              onRemove={() => remove(t)}
              onMove={(d) => move(t, d)}
              onResize={(w) => resize(t, w)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={ChartColumnBig}
          title="No charts on this report"
          description={canEdit ? 'Add a chart to start. Pick the fields and the chart suggests itself.' : 'The owner has not added any charts yet.'}
          action={
            canEdit && (
              <Button onClick={() => setBuilder({ open: true, tile: null })}>
                <Plus className="size-4" /> Add chart
              </Button>
            )
          }
        />
      )}

      {canEdit && (
        <ChartBuilder
          open={builder.open}
          onOpenChange={(open) => setBuilder((b) => ({ ...b, open }))}
          data={data}
          filters={filters}
          initial={builder.tile}
          onSave={upsert}
        />
      )}

      {presenting && (
        <Presentation name={name} datasetName={dataset.name} tiles={tiles} data={data} filters={filters} onClose={() => setPresenting(false)} />
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>
              The report and its {tiles.length} {tiles.length === 1 ? 'chart' : 'charts'} are removed
              {visibility === 'org' ? ' for everyone it was shared with' : ''}. The dataset “{dataset.name}” is not touched, and other reports built on it keep working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void destroy()} disabled={busy === 'delete'}>
              {busy === 'delete' && <Loader2 className="size-4 animate-spin" />}
              Delete report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'idle') return null;
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1" data-slot="save-status" data-state="saving">
        · <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1" data-slot="save-status" data-state="saved">
        · <Check className="size-3.5" /> Saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-destructive" data-slot="save-status" data-state="error">
      · <TriangleAlert className="size-3.5" /> Not saved
      <button type="button" onClick={onRetry} className="font-medium underline">
        Try again
      </button>
    </span>
  );
}

function EditableTitle({ value, editable, onCommit }: { value: string; editable: boolean; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (!editable) return <h1 className="display-xl truncate">{value}</h1>;
  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={150}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="h-10 max-w-xl text-lg font-semibold"
        aria-label="Report name"
      />
    );
  }
  return (
    <h1 className="display-xl group flex min-w-0 items-center gap-2">
      <button type="button" onClick={() => setEditing(true)} className="min-w-0 truncate text-left hover:underline hover:decoration-dotted" title="Rename">
        {value}
      </button>
      <Pencil className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
    </h1>
  );
}

// ── Presenting and printing ──────────────────────────────────────────────────

function Presentation({
  name, datasetName, tiles, data, filters, onClose,
}: { name: string; datasetName: string; tiles: Tile[]; data: DatasetData; filters: Filter[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // Paper is white. A dark-theme board printed as-is comes out as pale text on
  // white, so the light palette is swapped in for the print and back after.
  useEffect(() => {
    const root = document.documentElement;
    let wasDark = false;
    const before = () => {
      wasDark = root.classList.contains('dark');
      if (wasDark) root.classList.remove('dark');
    };
    const after = () => {
      if (wasDark) root.classList.add('dark');
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      after();
    };
  }, []);

  const printed = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  return createPortal(
    <div
      className="print-root fixed inset-0 z-[60] overflow-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}, presented`}
      data-slot="presentation"
    >
      {/* The width of an A4 landscape page, so the screen shows what will print. */}
      <div className="mx-auto max-w-[1040px] px-4 py-6">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4 border-b pb-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {datasetName} · {describeFilters(data, filters)} · {printed}
            </p>
          </div>
          <div className="flex gap-2 no-print">
            <Button variant="outline" size="sm" onClick={() => printPage()}>
              <Printer className="size-3.5" /> Print or save as PDF
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close the presentation">
              <X className="size-3.5" /> Close
            </Button>
          </div>
        </header>
        <div className="grid grid-cols-12 gap-3">
          {tiles.map((t, i) => (
            <TileCard key={t.id} tile={t} data={data} filters={filters} editable={false} index={i} count={tiles.length} large />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
