'use client';

// Bank statement lines in bulk, as Zoho Books' banking list works them: tick
// many lines and categorise them to one account at once, exclude or restore
// them, delete lines imported by mistake — or accept the suggested category
// for each, learnt from how lines like it were categorised before
// (lib/server/services/bank-bulk.ts). Lines that need a payment matched or a
// split still go through Match & categorise, one at a time.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Ban, CheckCheck, Loader2, RotateCcw, Sparkles, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type Status = 'unmatched' | 'excluded' | 'matched' | 'all';

interface Line {
  id: string; date: string; narration: string; reference: string | null;
  depositPaise: number; withdrawalPaise: number; status: string; bankName: string; bankAccountId: string;
}
interface Suggestion { accountId: string; code: string; name: string; confidence: number; basedOn: string; times: number }
interface LinesResponse {
  transactions: Line[];
  categorySuggestions?: Record<string, Suggestion>;
  summary: { count: number; unmatched: number; depositsPaise: number; withdrawalsPaise: number };
}
interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

/** Receivables and payables are the sum of their documents; never posted to directly. */
const CONTROL_ACCOUNTS = new Set(['1100', '2100']);
const TABS: { key: Status; label: string }[] = [
  { key: 'unmatched', label: 'Uncategorised' },
  { key: 'excluded', label: 'Excluded' },
  { key: 'matched', label: 'Categorised' },
  { key: 'all', label: 'All' },
];
const day = (d: string) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function StatementLinesPage() {
  const canEdit = usePermission('banking', 'edit');
  const [status, setStatus] = useState<Status>('unmatched');
  const [bankAccountId, setBankAccountId] = useState('');
  const [importId, setImportId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryId, setCategoryId] = useState('');
  const [contactId, setContactId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Opened from an import's "View lines", it shows that import's lines.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('import');
    if (id) {
      setImportId(id);
      setStatus('all');
    }
  }, []);

  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const state = useApi<LinesResponse>(
    () => api.get('/api/banking/transactions', { status, bankAccountId: bankAccountId || undefined, importId: importId ?? undefined, suggest: '1', limit: 500 }),
    [status, bankAccountId, importId],
  );
  useEffect(() => setSelected(new Set()), [status, bankAccountId, importId]);

  const categoryOptions = useMemo(() => (masters.data?.accounts ?? [])
    .filter((a) => ['expense', 'income', 'asset', 'liability', 'equity'].includes(a.type) && !CONTROL_ACCOUNTS.has(a.code))
    .map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` })), [masters.data]);
  const contactOptions = useMemo(() => [{ value: '', label: 'No party' }, ...(masters.data?.contacts ?? []).map((c) => ({ value: c.id, label: c.displayName }))], [masters.data]);
  const accountOptions = useMemo(() => [{ value: '', label: 'All bank accounts' }, ...(masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name }))], [masters.data]);

  const lines = state.data?.transactions ?? [];
  const suggestions = state.data?.categorySuggestions ?? {};
  const chosen = lines.filter((l) => selected.has(l.id));
  const chosenSuggested = chosen.filter((l) => l.status === 'unmatched' && suggestions[l.id]);
  const allSuggested = lines.filter((l) => l.status === 'unmatched' && suggestions[l.id]);

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const act = async (label: string, input: Record<string, unknown>, done: (r: Record<string, number>) => string) => {
    setBusy(label);
    try {
      const r = await api.post<Record<string, number>>('/api/banking/transactions', input);
      toast.success(done(r));
      setSelected(new Set());
      state.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'That did not go through');
    } finally {
      setBusy(null);
    }
  };

  const ids = chosen.map((l) => l.id);
  const accept = (from: Line[]) => act('accept', {
    action: 'accept_suggestions', picks: from.map((l) => ({ transactionId: l.id, accountId: suggestions[l.id].accountId })),
  }, (r) => `${r.categorised} line(s) categorised as suggested`);

  return (
    <>
      <PageHeader
        title="Statement lines"
        description="Categorise, exclude or delete bank lines many at a time. Suggestions come from how you categorised similar lines before."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild><Link href="/banking/imports">Import statements</Link></Button>
            <Button variant="outline" size="sm" asChild><Link href="/banking/reconcile">Match &amp; categorise</Link></Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-lg border bg-muted/40 p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={status === t.key} onClick={() => setStatus(t.key)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium', status === t.key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="w-56"><Combobox options={accountOptions} value={bankAccountId} onChange={setBankAccountId} placeholder="All bank accounts" searchPlaceholder="Search" /></div>
        {importId && (
          <Badge variant="secondary" className="gap-1">
            One import only
            <button type="button" className="ml-1 hover:text-foreground" onClick={() => { setImportId(null); window.history.replaceState(null, '', '/banking/statement-lines'); }} aria-label="Show every line">×</button>
          </Badge>
        )}
        {canEdit && status === 'unmatched' && allSuggested.length > 0 && (
          <Button size="sm" variant="outline" className="ml-auto gap-1.5" disabled={!!busy} onClick={() => void accept(allSuggested)}>
            {busy === 'accept' ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            Accept all {allSuggested.length} suggestions
          </Button>
        )}
      </div>

      {canEdit && chosen.length > 0 && (
        <Card className="sticky top-2 z-10 flex flex-wrap items-center gap-2 border-primary/40 bg-background/95 p-3 shadow-sm backdrop-blur">
          <span className="text-sm font-medium">{chosen.length} selected</span>
          <span className="text-xs text-muted-foreground">
            <Money value={chosen.reduce((t, l) => t + l.depositPaise, 0)} /> in · <Money value={chosen.reduce((t, l) => t + l.withdrawalPaise, 0)} /> out
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {(status === 'unmatched' || status === 'excluded' || status === 'all') && (
              <>
                <div className="w-52"><Combobox options={categoryOptions} value={categoryId} onChange={setCategoryId} placeholder="Categorise as…" searchPlaceholder="Search accounts" /></div>
                <div className="w-44"><Combobox options={contactOptions} value={contactId} onChange={setContactId} placeholder="Party (optional)" searchPlaceholder="Search parties" /></div>
                <Button size="sm" disabled={!categoryId || !!busy} className="gap-1.5" onClick={() => void act('categorise', {
                  action: 'bulk_categorise', transactionIds: ids, accountId: categoryId, contactId: contactId || null,
                }, (r) => `${r.categorised} line(s) categorised${r.skipped ? `; ${r.skipped} already matched were left alone` : ''}`)}>
                  {busy === 'categorise' ? <Loader2 className="size-3.5 animate-spin" /> : <Tags className="size-3.5" />} Categorise
                </Button>
              </>
            )}
            {chosenSuggested.length > 0 && (
              <Button size="sm" variant="outline" disabled={!!busy} className="gap-1.5" onClick={() => void accept(chosenSuggested)}>
                <CheckCheck className="size-3.5" /> Accept {chosenSuggested.length} suggestion{chosenSuggested.length === 1 ? '' : 's'}
              </Button>
            )}
            {status !== 'excluded' && status !== 'matched' && (
              <Button size="sm" variant="outline" disabled={!!busy} className="gap-1.5" onClick={() => void act('exclude', { action: 'exclude', transactionIds: ids }, (r) => `${r.changed} line(s) excluded`)}>
                <Ban className="size-3.5" /> Exclude
              </Button>
            )}
            {(status === 'excluded' || status === 'all') && (
              <Button size="sm" variant="outline" disabled={!!busy} className="gap-1.5" onClick={() => void act('include', { action: 'include', transactionIds: ids }, (r) => `${r.changed} line(s) restored`)}>
                <RotateCcw className="size-3.5" /> Restore
              </Button>
            )}
            {status !== 'matched' && (
              <Button size="sm" variant="ghost" disabled={!!busy} className="gap-1.5 text-destructive hover:text-destructive" onClick={() => {
                if (!window.confirm(`Delete ${chosen.length} line(s)? Only uncategorised and excluded lines are deleted.`)) return;
                void act('delete', { action: 'delete', transactionIds: ids }, (r) => `${r.deleted} line(s) deleted${r.kept ? `; ${r.kept} categorised were kept` : ''}`);
              }}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )}
          </div>
        </Card>
      )}

      <AsyncPage state={state}>
        {(d) => (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto thin-scroll">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th className="w-10 px-3 py-2">
                      {canEdit && (
                        <Checkbox
                          checked={lines.length > 0 && selected.size === lines.length}
                          onCheckedChange={(v) => setSelected(v ? new Set(lines.map((l) => l.id)) : new Set())}
                          aria-label="Select all"
                        />
                      )}
                    </th>
                    <th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-left font-semibold">Description</th>
                    <th className="px-3 py-2 text-right font-semibold">Withdrawal</th>
                    <th className="px-3 py-2 text-right font-semibold">Deposit</th>
                    <th className="px-3 py-2 text-left font-semibold">{status === 'unmatched' ? 'Suggested category' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.transactions.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      {status === 'unmatched' ? 'Nothing waiting to be categorised.' : 'No lines here.'}
                    </td></tr>
                  )}
                  {d.transactions.map((l) => {
                    const s = suggestions[l.id];
                    return (
                      <tr key={l.id} className={cn('border-b last:border-0 hover:bg-accent/40', selected.has(l.id) && 'bg-primary/5')}>
                        <td className="px-3 py-2">{canEdit && <Checkbox checked={selected.has(l.id)} onCheckedChange={() => toggle(l.id)} aria-label={`Select ${l.narration}`} />}</td>
                        <td className="whitespace-nowrap px-3 py-2">{day(l.date)}</td>
                        <td className="px-3 py-2">
                          <p className="max-w-md truncate" title={l.narration}>{l.narration}</p>
                          <p className="text-[11px] text-muted-foreground">{l.bankName}{l.reference ? ` · ${l.reference}` : ''}</p>
                        </td>
                        <td className="px-3 py-2 text-right">{l.withdrawalPaise ? <Money value={l.withdrawalPaise} /> : ''}</td>
                        <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400">{l.depositPaise ? <Money value={l.depositPaise} /> : ''}</td>
                        <td className="px-3 py-2">
                          {l.status === 'unmatched' && s ? (
                            <div className="flex items-center gap-2">
                              <div className="min-w-0" title={`Like "${s.basedOn}"${s.times > 1 ? `, and ${s.times - 1} more` : ''}`}>
                                <p className="truncate text-xs font-medium"><Sparkles className="mr-1 inline size-3 text-primary" />{s.name} <span className="font-mono text-muted-foreground">{s.code}</span></p>
                                <p className="text-[11px] text-muted-foreground">{Math.round(s.confidence * 100)}% like a past line</p>
                              </div>
                              {canEdit && (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => void accept([l])}>Accept</Button>
                              )}
                            </div>
                          ) : l.status === 'unmatched' ? (
                            <span className="text-xs text-muted-foreground">No suggestion yet</span>
                          ) : (
                            <Badge variant={l.status === 'matched' ? 'secondary' : 'outline'} className="text-[10px]">
                              {l.status === 'matched' ? 'Categorised' : l.status === 'excluded' ? 'Excluded' : l.status}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {d.summary.count > d.transactions.length && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">Showing the latest {d.transactions.length} of {d.summary.count}. Narrow it by bank account.</p>
            )}
          </Card>
        )}
      </AsyncPage>
    </>
  );
}
