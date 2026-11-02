'use client';

// Bulk update — Zoho Books' Accountant tool for moving many lines from one
// account to another at once (services/accountant-tools.ts). Find the lines
// on an account in a period, tick the ones booked to the wrong place, choose
// where they belong, and one reclassification journal moves them. What was
// posted is never rewritten, so the move can be seen, and reversed, like any
// other entry.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { accounts as accountsApi, api, type AccountRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Line { id: string; entryId: string; entryNo: number; date: string; sourceType: string; memo: string | null; description: string | null; party: string | null; debitPaise: number; creditPaise: number }
interface Recent { id: string; entryNo: number; date: string; memo: string | null; amountPaise: number; reversed: boolean }

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const fyStart = () => { const t = today(); return `${Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0)}-04-01`; };
// Accounts other ledgers hang off: not offered (the server refuses them too).
const FIXED = new Set(['receivable', 'payable', 'bank', 'cash', 'bank_od', 'credit_card', 'tax', 'stock', 'branch', 'advance']);

export default function BulkUpdatePage() {
  const canCreate = usePermission('accountant', 'create');
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);
  const [filter, setFilter] = useState({ fromAccountId: '', from: fyStart(), to: today(), search: '' });
  const [query, setQuery] = useState<typeof filter | null>(null);
  const state = useApi(
    () => api.get<{ lines: Line[]; recent: Recent[] }>('/api/bulk-update', query?.fromAccountId ? { fromAccountId: query.fromAccountId, from: query.from, to: query.to, search: query.search || undefined } : {}),
    [query],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toAccountId, setToAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);

  const movable = (chart.data?.accounts ?? []).filter((a) => a.isActive && !FIXED.has(a.subtype ?? ''));
  const choices = movable.map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` }));
  const lines = useMemo(() => state.data?.lines ?? [], [state.data]);
  const chosen = lines.filter((l) => picked.has(l.id));
  const net = chosen.reduce((t, l) => t + l.debitPaise - l.creditPaise, 0);
  const fromName = chart.data?.accounts.find((a) => a.id === query?.fromAccountId)?.name;
  const toName = chart.data?.accounts.find((a) => a.id === toAccountId)?.name;

  const find = () => { setPicked(new Set()); setQuery({ ...filter }); };
  const move = async () => {
    if (!query) return;
    if (!window.confirm(`Move ${chosen.length} line(s) from ${fromName} to ${toName}, dated ${date}? One journal entry does it; it can be reversed.`)) return;
    setBusy(true);
    try {
      const r = await api.post<{ entries: { id: string; entryNo: number }[]; lines: number; movedPaise: number }>('/api/bulk-update', {
        fromAccountId: query.fromAccountId, toAccountId, lineIds: [...picked], date,
      });
      toast.success(`${r.lines} line(s) moved`, { description: `Journal ${r.entries.map((e) => `#${e.entryNo}`).join(', ')} posted to ${toName}.` });
      setPicked(new Set());
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
        title="Bulk update"
        description="Move many lines from one account to another at once — expenses booked to the wrong head all year, say. One reclassification journal does it; nothing posted is rewritten."
      />

      <Card className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_2fr_auto] md:items-end">
          <Field label="Lines now on account" required>
            <Combobox options={choices} value={filter.fromAccountId} onChange={(v) => setFilter({ ...filter, fromAccountId: v })} placeholder="Choose the account" searchPlaceholder="Search accounts" showAvatar={false} />
          </Field>
          <Field label="From"><Input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></Field>
          <Field label="Narration, description or party contains">
            <Input value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="e.g. diesel" onKeyDown={(e) => { if (e.key === 'Enter' && filter.fromAccountId) find(); }} />
          </Field>
          <Button onClick={find} disabled={!filter.fromAccountId} className="gap-1.5"><Search className="size-4" /> Find lines</Button>
        </div>
        <p className="text-xs text-muted-foreground">Receivables, payables, bank and cash, GST and stock accounts are not listed: their own ledgers would stop agreeing. Correct those documents instead.</p>
      </Card>

      {query?.fromAccountId && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <Checkbox aria-label="Choose every line" checked={lines.length > 0 && picked.size === lines.length}
                    onCheckedChange={(v) => setPicked(v ? new Set(lines.map((l) => l.id)) : new Set())} />
                </th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Entry</th>
                <th className="px-3 py-2 text-left font-medium">Narration</th>
                <th className="px-3 py-2 text-left font-medium">Party</th>
                <th className="px-3 py-2 text-right font-medium">Debit</th>
                <th className="px-3 py-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {state.loading && <tr><td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">Finding lines…</td></tr>}
              {state.error && <tr><td colSpan={7} className="px-3 py-4 text-center text-destructive">{state.error}</td></tr>}
              {!state.loading && !state.error && lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="px-3 py-2">
                    <Checkbox aria-label={`Choose entry ${l.entryNo}`} checked={picked.has(l.id)}
                      onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v) n.add(l.id); else n.delete(l.id); return n; })} />
                  </td>
                  <td className="px-3 py-2 tabular-nums text-xs">{new Date(`${l.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-2 font-mono text-xs">#{l.entryNo} <Badge variant="outline" className="ml-1 text-[9px]">{l.sourceType.replace(/_/g, ' ')}</Badge></td>
                  <td className="px-3 py-2">{l.description || l.memo}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{l.party ?? ''}</td>
                  <td className="px-3 py-2 text-right">{l.debitPaise ? <Money value={l.debitPaise} /> : ''}</td>
                  <td className="px-3 py-2 text-right">{l.creditPaise ? <Money value={l.creditPaise} /> : ''}</td>
                </tr>
              ))}
              {!state.loading && !state.error && !lines.length && <tr><td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">No lines on that account in the period, or all of them have been moved already.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      {query?.fromAccountId && lines.length > 0 && (
        <Card className="grid gap-3 p-4 md:grid-cols-[1fr_2fr_1fr_auto] md:items-end" data-slot="bulk-move">
          <div className="text-sm">
            <p className="text-xs text-muted-foreground">Chosen</p>
            <p><b>{chosen.length}</b> line(s), net <Money value={Math.abs(net)} className="font-medium" /> {net < 0 ? 'credit' : 'debit'}</p>
          </div>
          <Field label={`Move from ${fromName ?? 'the account'} to`} required>
            <Combobox options={choices.filter((c) => c.value !== query.fromAccountId)} value={toAccountId} onChange={setToAccountId} placeholder="Choose where they belong" searchPlaceholder="Search accounts" showAvatar={false} />
          </Field>
          <Field label="Date of the move"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Button onClick={move} disabled={!canCreate || busy || !chosen.length || !toAccountId} className="gap-1.5"><Shuffle className="size-4" /> {busy ? 'Moving…' : `Move ${chosen.length || ''} line(s)`}</Button>
        </Card>
      )}

      {(state.data?.recent.length ?? 0) > 0 && (
        <Card className="space-y-2 p-4">
          <p className="text-sm font-medium">Earlier bulk updates</p>
          <ul className="space-y-1 text-sm">
            {state.data!.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Link href="/accountant/journals" className="font-mono text-xs text-primary hover:underline">#{r.entryNo}</Link>
                <span className="text-xs text-muted-foreground">{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-IN')}</span>
                <span className="flex-1">{r.memo}</span>
                <Money value={r.amountPaise} />
                {r.reversed && <Badge variant="outline" className="text-[10px]">Reversed</Badge>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">To undo one, reverse its entry from Manual journals; its lines can then be moved again.</p>
        </Card>
      )}
    </>
  );
}
