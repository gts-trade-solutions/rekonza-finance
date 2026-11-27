'use client';

// Import History (status review 7, item 3): every import that kept anything,
// with who ran it, when, from which file, how many rows went in, were skipped
// as already in the books, or failed — and each failed row with its field and
// reason, downloadable to fix and import again. Edit changes the note kept on
// it; Delete undoes an import of masters nothing has used since (the entry
// stays, marked undone).

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Download, History, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { RowActions } from '@/components/shared/row-actions';
import { downloadCsv } from '@/components/shared/report-shell';
import { ApiError, importHistory, type ImportBatchRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { IMPORT_MODULES, importModule } from '@/lib/imports/modules';
import { cn } from '@/lib/utils';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi(() => importHistory.get(id), [id]);
  return (
    <div className="mb-4 rounded-[6px] border bg-muted/20 p-4" data-slot="import-batch-detail">
      <AsyncPage state={state}>
        {(b) => (
          <div className="space-y-3 text-[13px]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{importModule(b.module)?.title ?? b.module} · {b.fileName ?? 'no file name'}</p>
                <p className="text-muted-foreground">{when(b.at)} by {b.by ?? 'someone'} · {b.mode === 'valid_only' ? 'valid rows imported, the rest skipped' : 'every row or none'}</p>
                <p className="mt-1">Rows in the file <b>{b.rowsTotal}</b> · imported <b data-slot="batch-imported">{b.imported}</b> · skipped as already in the books <b>{b.skipped}</b> · failed <b data-slot="batch-failed">{b.failed}</b>
                  {Object.keys(b.createdCounts).length > 0 && <> · made {Object.entries(b.createdCounts).map(([t, n]) => `${n} ${t}`).join(', ')}</>}</p>
              </div>
              <button type="button" aria-label="Close" onClick={onClose}><X className="size-4" /></button>
            </div>
            {b.errors.length > 0 ? (
              <>
                <div className="flex items-center justify-between">
                  <p className="font-medium">Rows left out, and why</p>
                  <Button size="xs" variant="outline" className="gap-1" data-slot="batch-errors-csv"
                    onClick={() => downloadCsv(`import-${b.id}-rows-left-out.csv`, [['Row', 'Field', 'Value', 'Problem'], ...b.errors.map((e) => [String(e.row), e.field ?? '', e.value ?? '', e.message])])}>
                    <Download className="size-3" /> Download
                  </Button>
                </div>
                <div className="max-h-72 overflow-auto rounded border bg-background thin-scroll">
                  <table className="w-full text-[12.5px]" data-slot="batch-errors">
                    <thead className="sticky top-0 bg-muted text-left"><tr><th className="px-2 py-1.5">Row</th><th className="px-2 py-1.5">Field</th><th className="px-2 py-1.5">Value</th><th className="px-2 py-1.5">Problem</th></tr></thead>
                    <tbody>{b.errors.map((e, i) => (
                      <tr key={i} className="border-t align-top"><td className="px-2 py-1 font-medium">{e.row}</td><td className="px-2 py-1">{e.field ?? ''}</td><td className="px-2 py-1 font-mono text-[11.5px]">{e.value ?? ''}</td><td className="px-2 py-1">{e.message}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </>
            ) : <p className="text-muted-foreground">Every row of the file went in.</p>}
          </div>
        )}
      </AsyncPage>
    </div>
  );
}

function HistoryPage() {
  const params = useSearchParams();
  const [module, setModule] = useState(params.get('module') ?? '');
  const [viewing, setViewing] = useState<string | null>(params.get('batch'));
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const state = useApi(() => importHistory.list(module || undefined), [module]);
  const canEdit = usePermission('accountant', 'edit');

  const saveNote = async () => {
    if (!editing) return;
    try { await importHistory.setNote(editing.id, editing.note); toast.success('Note saved'); setEditing(null); state.refetch(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'The note was not saved.'); }
  };
  const undo = async (b: ImportBatchRow) => {
    if (!window.confirm(`Undo this import? The ${b.imported} record${b.imported === 1 ? '' : 's'} it made will be deleted, if nothing has used them. The history entry stays, marked undone.`)) return;
    try {
      const r = await importHistory.undo(b.id);
      toast.success('Import undone', { description: Object.entries(r.deleted).map(([t, n]) => `${n} ${t} deleted`).join(', ') });
      state.refetch();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'The import was not undone.'); }
  };

  return (
    <>
      <PageHeader title="Import History" description="Every import kept: who ran it, when, the file, and what went in, was skipped or failed."
        actions={<select value={module} onChange={(e) => setModule(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" data-slot="import-history-module">
          <option value="">All imports</option>
          {IMPORT_MODULES.map((x) => <option key={x.slug} value={x.slug}>{x.title}</option>)}
        </select>} />
      {viewing && <Detail id={viewing} onClose={() => setViewing(null)} />}
      <AsyncPage state={state}>
        {(d) => d.batches.length === 0 ? (
          <EmptyState icon={History} title="No imports yet" description="Import customers, vendors, items, accounts or documents from their list's ⋯ menu, and each import shows here." />
        ) : (
          <div className="overflow-x-auto rounded-[6px] border">
            <table className="w-full text-[13px]" data-slot="import-history-table">
              <thead className="bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <tr>{['When', 'By', 'Import', 'File', 'Rows', 'Imported', 'Skipped', 'Failed', 'Status', 'Note', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {d.batches.map((b) => (
                  <tr key={b.id} className={cn('border-t', viewing === b.id && 'bg-primary/5')} data-slot="import-history-row" data-id={b.id}>
                    <td className="px-3 py-2 whitespace-nowrap"><button type="button" className="text-link hover:underline" onClick={() => setViewing(b.id)} data-slot="import-history-view">{when(b.at)}</button></td>
                    <td className="px-3 py-2">{b.by ?? ''}</td>
                    <td className="px-3 py-2">{importModule(b.module)?.title ?? b.module}</td>
                    <td className="px-3 py-2">{b.fileName}{b.fileFormat && <span className="ml-1 text-[11px] uppercase text-muted-foreground">{b.fileFormat}</span>}</td>
                    <td className="px-3 py-2 tabular">{b.rowsTotal}</td>
                    <td className="px-3 py-2 tabular font-medium text-[#1e7a46]">{b.imported}</td>
                    <td className="px-3 py-2 tabular">{b.skipped}</td>
                    <td className={cn('px-3 py-2 tabular', b.failed > 0 && 'font-medium text-[#c0392b]')}>{b.failed}</td>
                    <td className="px-3 py-2"><StatusBadge status={b.status === 'undone' ? 'void' : 'completed'} />
                      {b.status === 'undone' && <span className="block text-[11px] text-muted-foreground">Undone by {b.undoneBy}, {b.undoneAt ? when(b.undoneAt) : ''}</span>}</td>
                    <td className="px-3 py-2 text-[12.5px]">
                      {editing?.id === b.id ? (
                        <span className="flex gap-1"><Input value={editing.note} onChange={(e) => setEditing({ id: b.id, note: e.target.value })} className="h-7 w-48" data-slot="import-note-input" />
                          <Button size="xs" onClick={() => void saveNote()} data-slot="import-note-save">Save</Button></span>
                      ) : b.note}
                    </td>
                    <td className="px-3 py-2">
                      <RowActions
                        onEdit={canEdit ? () => setEditing({ id: b.id, note: b.note ?? '' }) : null}
                        onDelete={b.undoable ? () => void undo(b) : null}
                        editTitle="Edit the note kept on this import" deleteTitle="Undo this import: delete what it made, if nothing has used it">
                        <Button size="xs" variant="outline" onClick={() => setViewing(b.id)}>View</Button>
                        {importModule(b.module) && <Link href={`/import/${b.module}`} className="text-[12px] text-link hover:underline">Import again</Link>}
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncPage>
    </>
  );
}

export default function Page() {
  return <Suspense><HistoryPage /></Suspense>;
}
