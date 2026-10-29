'use client';

// The document library: contracts, agreements, certificates, licences and
// policies that belong to the business rather than to one voucher, with their
// files and expiry dates. One running out within 30 days is raised as an
// exception for someone to renew.

import { useState } from 'react';
import { Archive, FolderOpen, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Attachments } from '@/components/shared/attachments';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type Category = 'contract' | 'agreement' | 'certificate' | 'licence' | 'policy' | 'statutory' | 'other';
interface Doc {
  id: string; title: string; category: Category; reference: string | null; notes: string | null;
  issuedOn: string | null; expiresOn: string | null; contactId: string | null; party: string | null;
  files: number; createdAt: string; archived: boolean;
}
const CATEGORIES: Category[] = ['contract', 'agreement', 'certificate', 'licence', 'policy', 'statutory', 'other'];
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const daysTo = (d: string) => Math.round((Date.parse(d) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000);

const EMPTY = { title: '', category: 'contract' as Category, reference: '', issuedOn: '', expiresOn: '', notes: '' };

export default function DocumentsPage() {
  const [tab, setTab] = useState<'all' | Category>('all');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const canEdit = usePermission('accountant', 'create');
  const state = useApi<{ documents: Doc[] }>(() => api.get('/api/documents'), []);

  const create = async () => {
    try {
      const r = await api.post<{ id: string }>('/api/documents', { ...form });
      toast.success('Added to the library', { description: 'Attach the file to it now.' });
      setCreating(false);
      setForm(EMPTY);
      await state.refetch();
      const doc = (await api.get<{ documents: Doc[] }>('/api/documents')).documents.find((d) => d.id === r.id);
      if (doc) setOpenDoc(doc);
    } catch (e) {
      toast.error('Not added', { description: e instanceof ApiError ? e.message : String(e) });
    }
  };

  const archive = async (d: Doc) => {
    try {
      await api.patch(`/api/documents/${d.id}`, { archived: true });
      toast.success('Archived', { description: 'It leaves the list; its files are kept.' });
      setOpenDoc(null);
      await state.refetch();
    } catch (e) {
      toast.error('Not archived', { description: e instanceof ApiError ? e.message : String(e) });
    }
  };

  const columns: Column<Doc>[] = [
    { key: 'title', header: 'Document', sortValue: (r) => r.title, className: 'whitespace-normal max-w-md',
      cell: (r) => (
        <div>
          <p className="text-sm font-medium">{r.title}</p>
          <p className="text-xs text-muted-foreground">{[r.reference, r.party].filter(Boolean).join(' · ') || '—'}</p>
        </div>
      ) },
    { key: 'category', header: 'Kind', sortValue: (r) => r.category, cell: (r) => <Badge variant="outline" className="capitalize">{r.category}</Badge> },
    { key: 'issued', header: 'Issued', sortValue: (r) => r.issuedOn ?? '', cell: (r) => <span className="text-sm">{day(r.issuedOn)}</span> },
    { key: 'expires', header: 'Expires', sortValue: (r) => r.expiresOn ?? '9999',
      cell: (r) => {
        if (!r.expiresOn) return <span className="text-sm text-muted-foreground">No expiry</span>;
        const left = daysTo(r.expiresOn);
        return (
          <span className={cn('text-sm', left < 0 ? 'font-medium text-red-700 dark:text-red-400' : left <= 30 ? 'font-medium text-amber-700 dark:text-amber-400' : '')}>
            {day(r.expiresOn)}{left < 0 ? ' · expired' : left <= 30 ? ` · ${left} days` : ''}
          </span>
        );
      } },
    { key: 'files', header: 'Files', align: 'right', sortValue: (r) => r.files,
      cell: (r) => <span className={cn('text-sm', !r.files && 'text-amber-700')}>{r.files || 'None yet'}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Documents"
        description="Contracts, agreements, certificates and licences, with their files and expiry dates. One running out within 30 days becomes an exception for someone to renew."
        actions={canEdit ? <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-3.5" /> Add document</Button> : null}
      />
      <AsyncPage state={state}>
        {(d) => {
          const rows = tab === 'all' ? d.documents : d.documents.filter((x) => x.category === tab);
          return (
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => setOpenDoc(r)}
              tabs={[{ value: 'all', label: 'All', count: d.documents.length },
                ...CATEGORIES.filter((c) => d.documents.some((x) => x.category === c))
                  .map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1), count: d.documents.filter((x) => x.category === c).length }))]}
              activeTab={tab}
              onTabChange={(v) => setTab(v as typeof tab)}
              searchPlaceholder="Search title, reference or party…"
              emptyMessage="Nothing in the library yet. Add the business's contracts, licences and certificates."
            />
          );
        }}
      </AsyncPage>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>The details first; attach the file once it is added.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="doc-title">Title</Label>
              <Input id="doc-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Warehouse lease, Chennai" /></div>
            <div className="space-y-1.5"><Label htmlFor="doc-cat">Kind</Label>
              <select id="doc-cat" className="h-9 w-full rounded-md border bg-background px-2 text-sm capitalize" value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div className="space-y-1.5"><Label htmlFor="doc-ref">Reference</Label>
              <Input id="doc-ref" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Agreement or licence no." /></div>
            <div className="space-y-1.5"><Label htmlFor="doc-issued">Issued on</Label>
              <Input id="doc-issued" type="date" value={form.issuedOn} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="doc-expires">Expires on</Label>
              <Input id="doc-expires" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="doc-notes">Notes</Label>
              <Textarea id="doc-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} disabled={form.title.trim().length < 2}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!openDoc} onOpenChange={(o) => { if (!o) setOpenDoc(null); }}>
        <DialogContent className="max-w-2xl">
          {openDoc && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><FolderOpen className="size-5 text-muted-foreground" /> {openDoc.title}</DialogTitle>
                <DialogDescription className="capitalize">
                  {openDoc.category}{openDoc.reference ? ` · ${openDoc.reference}` : ''} · issued {day(openDoc.issuedOn)} · expires {day(openDoc.expiresOn)}
                </DialogDescription>
              </DialogHeader>
              {openDoc.notes && <p className="text-sm text-muted-foreground">{openDoc.notes}</p>}
              <Attachments targetType="document" targetId={openDoc.id} canEdit={canEdit} title="Files" />
              {canEdit && (
                <DialogFooter>
                  <Button variant="outline" className="gap-1.5" onClick={() => archive(openDoc)}><Archive className="size-3.5" /> Archive</Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
