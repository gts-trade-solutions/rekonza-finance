'use client';

// Serial numbers: every numbered piece on hand, and a search that answers the
// warranty question — when one number came in, from whom, and who it was sold
// to. Pieces already on hand when tracking began are entered as an adjustment.

import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface InStock { serialId: string; itemId: string; itemName: string; serialNo: string }
interface Move { docType: string; docId: string; number: string; date: string; party: string | null; direction: 1 | -1; live: boolean }
interface Match { serialId: string; itemName: string; serialNo: string; inStock: boolean; moves: Move[] }

const DOC: Record<string, { label: string; href?: (id: string) => string }> = {
  bill: { label: 'Bill', href: (id) => `/purchases/bills/${id}` },
  goods_receipt: { label: 'Goods receipt', href: () => '/purchases/goods-receipts' },
  invoice: { label: 'Invoice', href: (id) => `/sales/invoices/${id}` },
  credit_note: { label: 'Credit note', href: () => '/sales/credit-notes' },
  adjustment: { label: 'Adjustment', href: () => '/inventory/adjustments' },
};
const fmt = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function SerialsPage() {
  const state = useApi<{ serials: InStock[] }>(() => api.get('/api/serials'), []);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; matches: Match[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const look = async (term = q) => {
    if (!term.trim()) return;
    setBusy(true);
    try {
      const r = await api.get<{ matches: Match[] }>('/api/serials', { q: term.trim() });
      setFound({ q: term.trim(), matches: r.matches });
    } finally {
      setBusy(false);
    }
  };

  const cols: Column<InStock>[] = [
    { key: 'item', header: 'Item', sortValue: (r) => r.itemName, cell: (r) => <span className="font-medium">{r.itemName}</span> },
    {
      key: 'serial', header: 'Serial number', sortValue: (r) => r.serialNo,
      cell: (r) => (
        <button type="button" className="font-mono text-xs text-primary hover:underline" onClick={() => { setQ(r.serialNo); void look(r.serialNo); }}>
          {r.serialNo}
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Serial numbers" description="Every numbered piece on hand. Search a number to see when it came in, from whom, and who it was sold to." />
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void look(); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Serial number" className="max-w-sm font-mono placeholder:font-sans" aria-label="Serial number" />
            <Button type="submit" size="sm" className="gap-1.5" disabled={busy || !q.trim()}><Search className="size-3.5" /> Look up</Button>
          </form>
          {found && (found.matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No piece is numbered {found.q}.</p>
          ) : found.matches.map((m) => (
            <div key={m.serialId} className="rounded-md border">
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{m.itemName}</span>
                <span className="font-mono text-xs">{m.serialNo}</span>
                <Badge variant="outline" className={cn('ml-auto text-[10px]', m.inStock ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>
                  {m.inStock ? 'In stock' : 'Not in stock'}
                </Badge>
              </div>
              <ul className="divide-y text-sm">
                {m.moves.map((mv, i) => {
                  const d = DOC[mv.docType] ?? { label: mv.docType };
                  return (
                    <li key={i} className={cn('flex flex-wrap items-center gap-3 px-3 py-2', !mv.live && 'text-muted-foreground line-through')}>
                      <span className="w-24 text-xs tabular-nums">{fmt(mv.date)}</span>
                      <span className={cn('w-10 text-xs font-medium', mv.direction > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}>
                        {mv.direction > 0 ? 'In' : 'Out'}
                      </span>
                      <span className="text-xs text-muted-foreground">{d.label}</span>
                      {d.href ? <Link href={d.href(mv.docId)} className="font-mono text-xs text-primary hover:underline">{mv.number}</Link> : <span className="font-mono text-xs">{mv.number}</span>}
                      {mv.party && <span className="text-xs">{mv.party}</span>}
                      {!mv.live && <span className="text-[10px] no-underline">(void or draft)</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )))}
        </Card>
        <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
          {(d) => d.serials.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">
              No numbered pieces on hand. Switch on “Track serial numbers” on an item, then name each piece on the bill or receipt it arrives on.
            </Card>
          ) : (
            <DataTable rows={d.serials} columns={cols} getRowId={(r) => r.serialId} searchPlaceholder="Search item or number…" emptyMessage="No numbers match." />
          )}
        </AsyncPage>
      </div>
    </>
  );
}
