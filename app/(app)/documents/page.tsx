'use client';

// Documents, as Zoho Books lays it out: an inbox for files uploaded before
// anyone knows which transaction they belong to, every file in the book in
// one list with what it is attached to, the bank statements imports were read
// from, folders, and the business's own contracts and licences.
//
// A file in the inbox can be attached to a bill, an expense, an invoice or any
// other record, or turned into a bill; a file anywhere can be moved into a
// folder. Each file is seen only by those who may see what it is attached to.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Download, ExternalLink, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Image as ImageIcon, Inbox, Landmark,
  Library, Link2, Loader2, MoreHorizontal, Pencil, ReceiptText, Search, Trash2, Undo2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { BusinessLibrary } from '@/components/documents/business-library';
import { AttachDialog } from '@/components/documents/attach-dialog';
import { api, ApiError, files as fileApi } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type View = 'inbox' | 'all' | 'statements' | 'folder' | 'library';

interface LibraryFile {
  id: string; filename: string; contentType: string; sizeBytes: number; folder: string | null;
  uploadedBy: string | null; uploadedAt: string;
  attachedTo: { type: string; id: string; label: string; kind: string; href: string | null } | null;
}
interface LibraryResponse {
  files: LibraryFile[];
  folders: { name: string; count: number }[];
  counts: { inbox: number; all: number; statements: number };
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt';
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function DocumentsPage() {
  const canEditDocs = usePermission('accountant', 'edit');
  const canBill = usePermission('purchases', 'create');
  const canUpload = canEditDocs || canBill;
  const [view, setView] = useState<View>('inbox');
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [attachFor, setAttachFor] = useState<string[] | null>(null);
  const [folderFor, setFolderFor] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<LibraryFile | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A link like /documents?tab=library opens that section.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'library' || t === 'all' || t === 'statements') setView(t);
  }, []);

  const state = useApi<LibraryResponse>(
    () => (view === 'library' ? Promise.resolve({ files: [], folders: [], counts: { inbox: 0, all: 0, statements: 0 } }) : api.get('/api/documents/files', { view, folder: folder ?? undefined, q: search || undefined })),
    [view, folder, search],
  );
  // The sidebar's counts and folders, kept whichever section is open.
  const nav = useApi<LibraryResponse>(() => api.get('/api/documents/files', { view: 'inbox' }), []);
  useEffect(() => setSelected(new Set()), [view, folder, search]);
  const refresh = () => { void state.refetch(); void nav.refetch(); };

  const upload = async (picked: FileList | File[]) => {
    const list = [...picked];
    if (!list.length) return;
    setUploading(true);
    try {
      let done = 0;
      const failed: string[] = [];
      for (let i = 0; i < list.length; i += 10) {
        const form = new FormData();
        for (const f of list.slice(i, i + 10)) form.append('file', f);
        if (view === 'folder' && folder) form.set('folder', folder);
        const r = await api.post<{ uploaded: { id: string }[]; failed: { filename: string; message: string }[] }>('/api/documents/files', form);
        done += r.uploaded.length;
        failed.push(...r.failed.map((f) => `${f.filename}: ${f.message}`));
      }
      if (done) toast.success(`${done} file${done === 1 ? '' : 's'} uploaded`, { description: view === 'folder' && folder ? `Into ${folder}.` : 'They wait in the inbox until attached to a transaction.' });
      if (failed.length) toast.error(`${failed.length} not uploaded`, { description: failed.join(' · ') });
      if (view !== 'folder') setView('inbox');
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const patch = async (payload: Record<string, unknown>, ok: string) => {
    try {
      await api.patch('/api/documents/files', payload);
      toast.success(ok);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'That did not go through');
    }
  };

  const remove = async (ids: string[]) => {
    if (!window.confirm(`Delete ${ids.length} file${ids.length === 1 ? '' : 's'}? Each is kept in the audit trail.`)) return;
    try {
      for (const id of ids) await fileApi.remove(id);
      toast.success(`${ids.length} file${ids.length === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete');
    }
  };

  const counts = nav.data?.counts;
  const folders = nav.data?.folders ?? [];
  const NavItem = ({ v, f, icon: Icon, label, count }: { v: View; f?: string; icon: typeof Inbox; label: string; count?: number }) => (
    <button type="button" role="tab" aria-selected={view === v && (f ?? null) === folder} onClick={() => { setView(v); setFolder(f ?? null); }}
      className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm', view === v && (f ?? null) === folder ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent')}>
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
    </button>
  );

  const title = view === 'inbox' ? 'Inbox' : view === 'all' ? 'All files' : view === 'statements' ? 'Bank statements' : view === 'library' ? 'Business documents' : folder;

  return (
    <>
      <PageHeader
        title="Documents"
        description="Upload bills, receipts and papers here, then attach each to its transaction — or keep them in folders."
        actions={canUpload && view !== 'library' ? (
          <>
            <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
            <Button size="sm" className="gap-1.5" disabled={uploading} onClick={() => input.current?.click()}>
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Upload files
            </Button>
          </>
        ) : null}
      />

      <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
        <Card className="h-fit space-y-0.5 p-2" role="tablist" aria-label="Documents" aria-orientation="vertical">
          <NavItem v="inbox" icon={Inbox} label="Inbox" count={counts?.inbox} />
          <NavItem v="all" icon={FileText} label="All files" count={counts?.all} />
          <NavItem v="statements" icon={Landmark} label="Bank statements" count={counts?.statements} />
          <NavItem v="library" icon={Library} label="Business documents" />
          <div className="flex items-center justify-between px-3 pb-1 pt-3">
            <p className="micro-label">Folders</p>
            {canUpload && (
              <button type="button" className="text-muted-foreground hover:text-foreground" title="New folder" aria-label="New folder"
                onClick={() => {
                  const name = window.prompt('Name the new folder')?.trim();
                  if (name) { setView('folder'); setFolder(name.slice(0, 100)); }
                }}>
                <FolderPlus className="size-4" />
              </button>
            )}
          </div>
          {folders.length === 0 && view !== 'folder' && <p className="px-3 pb-2 text-xs text-muted-foreground">No folders yet.</p>}
          {folders.map((f) => <NavItem key={f.name} v="folder" f={f.name} icon={Folder} label={f.name} count={f.count} />)}
          {view === 'folder' && folder && !folders.some((f) => f.name === folder) && <NavItem v="folder" f={folder} icon={FolderOpen} label={folder} />}
        </Card>

        <div className="min-w-0 space-y-3">
          {view === 'library' ? <BusinessLibrary /> : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{title}</h2>
                <div className="relative ml-auto w-64">
                  <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search file names" className="h-9 pl-8" />
                </div>
              </div>

              {canUpload && (view === 'inbox' || view === 'folder') && (
                <div
                  onClick={() => input.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}
                  className="flex cursor-pointer items-center justify-center gap-3 rounded-lg border-2 border-dashed p-5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40"
                >
                  {uploading ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
                  Drop files here — PDF, images, Excel, Word or CSV, up to 10 MB each, ten at a time
                </div>
              )}

              {selected.size > 0 && (
                <Card className="flex flex-wrap items-center gap-2 border-primary/40 p-3">
                  <span className="text-sm font-medium">{selected.size} selected</span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAttachFor([...selected])}><Link2 className="size-3.5" /> Attach to transaction</Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setFolderFor([...selected])}><FolderInput className="size-3.5" /> Move to folder</Button>
                    <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => void remove([...selected])}><Trash2 className="size-3.5" /> Delete</Button>
                  </div>
                </Card>
              )}

              <AsyncPage state={state}>
                {(d) => (
                  <Card className="overflow-hidden p-0">
                    <div className="overflow-x-auto thin-scroll">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead>
                          <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                            <th className="w-10 px-3 py-2">
                              <Checkbox checked={d.files.length > 0 && selected.size === d.files.length}
                                onCheckedChange={(v) => setSelected(v ? new Set(d.files.map((f) => f.id)) : new Set())} aria-label="Select all" />
                            </th>
                            <th className="px-3 py-2 text-left font-semibold">File</th>
                            <th className="px-3 py-2 text-left font-semibold">Attached to</th>
                            <th className="px-3 py-2 text-left font-semibold">Uploaded</th>
                            <th className="px-3 py-2 text-right font-semibold">Size</th>
                            <th className="w-10 px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {d.files.length === 0 && (
                            <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                              {view === 'inbox' ? 'The inbox is empty. Upload bills, receipts or any paper to file them later.'
                                : view === 'statements' ? 'No statements yet. Files imported on Banking → Import statements are kept here.'
                                  : view === 'folder' ? 'This folder is empty. Upload here, or move files in from the other lists.'
                                    : 'No files yet.'}
                            </td></tr>
                          )}
                          {d.files.map((f) => (
                            <tr key={f.id} className={cn('border-b last:border-0 hover:bg-accent/40', selected.has(f.id) && 'bg-primary/5')}>
                              <td className="px-3 py-2">
                                <Checkbox checked={selected.has(f.id)} aria-label={`Select ${f.filename}`}
                                  onCheckedChange={() => setSelected((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  {f.contentType.startsWith('image/') ? <ImageIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                                  <div className="min-w-0">
                                    <a href={fileApi.url(f.id)} target="_blank" rel="noreferrer" className="block max-w-xs truncate font-medium hover:underline" title={f.filename}>{f.filename}</a>
                                    {f.folder && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Folder className="size-3" />{f.folder}</span>}
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                {f.attachedTo ? (
                                  <span className="text-xs">
                                    <span className="capitalize text-muted-foreground">{f.attachedTo.kind} </span>
                                    {f.attachedTo.href ? <Link href={f.attachedTo.href} className="font-medium text-primary hover:underline">{f.attachedTo.label}</Link> : <b>{f.attachedTo.label}</b>}
                                  </span>
                                ) : (
                                  <Badge variant="outline" className="text-[10px]">In inbox</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">{when(f.uploadedAt)}{f.uploadedBy ? ` · ${f.uploadedBy}` : ''}</td>
                              <td className="px-3 py-2 text-right text-xs text-muted-foreground">{size(f.sizeBytes)}</td>
                              <td className="px-3 py-2">
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${f.filename}`}><MoreHorizontal className="size-4" /></Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem asChild><a href={fileApi.url(f.id)} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 size-3.5" /> Open</a></DropdownMenuItem>
                                    <DropdownMenuItem asChild><a href={fileApi.url(f.id, true)}><Download className="mr-2 size-3.5" /> Download</a></DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setAttachFor([f.id])}><Link2 className="mr-2 size-3.5" /> {f.attachedTo ? 'Attach elsewhere…' : 'Attach to transaction…'}</DropdownMenuItem>
                                    {!f.attachedTo && canBill && (
                                      <DropdownMenuItem asChild><Link href={`/purchases/bills/new?fromFile=${f.id}`}><ReceiptText className="mr-2 size-3.5" /> Create bill from it</Link></DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => setFolderFor([f.id])}><FolderInput className="mr-2 size-3.5" /> Move to folder…</DropdownMenuItem>
                                    {f.attachedTo && f.attachedTo.type !== 'bank_import' && (
                                      <DropdownMenuItem onClick={() => void patch({ action: 'to_inbox', fileIds: [f.id] }, 'Moved back to the inbox')}><Undo2 className="mr-2 size-3.5" /> Back to inbox</DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => setRenaming(f)}><Pencil className="mr-2 size-3.5" /> Rename</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive" onClick={() => void remove([f.id])}><Trash2 className="mr-2 size-3.5" /> Delete</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </AsyncPage>
            </>
          )}
        </div>
      </div>

      {attachFor && (
        <AttachDialog ids={attachFor} onClose={() => setAttachFor(null)}
          onDone={(label) => { setAttachFor(null); setSelected(new Set()); refresh(); toast.success(`Attached to ${label}`); }} />
      )}
      {folderFor && (
        <FolderDialog folders={folders.map((f) => f.name)} count={folderFor.length} onClose={() => setFolderFor(null)}
          onPick={(name) => { const ids = folderFor; setFolderFor(null); void patch({ action: 'folder', fileIds: ids, folder: name }, name ? `Moved to ${name}` : 'Taken out of its folder'); }} />
      )}
      {renaming && (
        <RenameDialog file={renaming} onClose={() => setRenaming(null)}
          onSave={(name) => { const f = renaming; setRenaming(null); void patch({ action: 'rename', fileId: f.id, filename: name }, 'Renamed'); }} />
      )}
    </>
  );
}

function FolderDialog({ folders, count, onClose, onPick }: { folders: string[]; count: number; onClose: () => void; onPick: (name: string | null) => void }) {
  const [name, setName] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {count === 1 ? 'the file' : `${count} files`} to a folder</DialogTitle>
          <DialogDescription>Choose a folder, or name a new one.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          {folders.map((f) => (
            <button key={f} type="button" onClick={() => onPick(f)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent">
              <Folder className="size-4 text-muted-foreground" /> {f}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder name" maxLength={100} />
          <Button disabled={!name.trim()} onClick={() => onPick(name.trim())}>Move</Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onPick(null)}>Take out of folder</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ file, onClose, onSave }: { file: LibraryFile; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(file.filename);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Rename</DialogTitle></DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
