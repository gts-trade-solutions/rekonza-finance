'use client';

// Web tabs — the websites the business uses every day, kept inside the app as
// Zoho Books keeps them (app/api/web-tabs). Some sites refuse to be shown
// inside another app; for those the tab opens them in a new browser tab.

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Globe, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Tab { id: string; name: string; url: string }

export default function WebTabsPage() {
  const state = useApi(() => api.get<{ tabs: Tab[]; canEdit: boolean }>('/api/web-tabs'), []);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tab[] | null>(null);
  const [busy, setBusy] = useState(false);
  const tabs = useMemo(() => state.data?.tabs ?? [], [state.data]);
  useEffect(() => { if (!active && tabs.length) setActive(tabs[0].id); }, [tabs, active]);
  const current = tabs.find((t) => t.id === active) ?? null;

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.put('/api/web-tabs', { tabs: editing.filter((t) => t.name.trim() || t.url.trim()) });
      toast.success('Web tabs saved');
      setEditing(null);
      state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Web tabs"
        description="The websites you use every day — the GST portal, your bank, a supplier's catalogue — one click away inside the books."
        actions={state.data?.canEdit && !editing ? <Button size="sm" variant="outline" onClick={() => setEditing(tabs.length ? tabs : [{ id: '', name: '', url: 'https://' }])}>Manage tabs</Button> : undefined}
      />
      <AsyncPage state={state}>
        {() => editing ? (
          <Card className="space-y-3 p-4" data-slot="web-tabs-editor">
            {editing.map((t, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Input aria-label={`Tab ${i + 1} name`} value={t.name} onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Name, e.g. GST portal" maxLength={40} className="w-48" />
                <Input aria-label={`Tab ${i + 1} address`} value={t.url} onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="https://" maxLength={500} className="min-w-64 flex-1" />
                <Button size="icon-sm" variant="ghost" aria-label={`Remove tab ${i + 1}`} onClick={() => setEditing(editing.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1" disabled={editing.length >= 20} onClick={() => setEditing([...editing, { id: '', name: '', url: 'https://' }])}><Plus className="size-3.5" /> Add a tab</Button>
              <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </Card>
        ) : !tabs.length ? (
          <Card className="flex items-start gap-3 p-6 text-sm">
            <Globe className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">No web tabs yet</p>
              <p className="text-muted-foreground">{state.data?.canEdit ? 'Choose Manage tabs to add the websites your team opens every day.' : 'Someone who manages settings can add the websites your team opens every day.'}</p>
            </div>
          </Card>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1 border-b" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}
                  className={`-mb-px rounded-t-md border px-3 py-1.5 text-sm ${t.id === active ? 'border-b-background bg-background font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                  {t.name}
                </button>
              ))}
            </div>
            {current && (
              <>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{current.url}</span>
                  <a href={current.url} target="_blank" rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline"><ExternalLink className="size-3.5" /> Open in a new tab</a>
                </div>
                <iframe key={current.id} src={current.url} title={current.name} className="h-[70vh] w-full rounded-md border bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" referrerPolicy="no-referrer" />
                <p className="text-xs text-muted-foreground">A blank frame means the site does not allow being shown inside other apps (most banks and the GST portal do this for safety). Use Open in a new tab.</p>
              </>
            )}
          </div>
        )}
      </AsyncPage>
    </>
  );
}
