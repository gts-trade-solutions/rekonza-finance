'use client';

// Stock by batch, with what has expired and what is about to. Expired stock is
// written off with an adjustment of the reason "expiry", batch by batch.

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { downloadWorkbook } from '@/lib/xlsx';

interface Batch { batchId: string; itemId: string; itemName: string; batchNo: string; mfgDate: string | null; expiryDate: string | null; qty: number }

const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const daysTo = (iso: string, from: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export default function BatchesPage() {
  const state = useApi<{ asOf: string; batches: Batch[] }>(() => api.get('/api/batches'), []);
  const [show, setShow] = useState<'all' | 'expired' | '30' | '90'>('all');
  return (
    <>
      <PageHeader title="Batches & expiry" description="Stock by batch, earliest to expire first. Write off expired stock with an adjustment of the reason “expiry”." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const status = (b: Batch) => {
            if (!b.expiryDate) return { key: 'none', label: 'No expiry', tone: 'text-muted-foreground', days: Infinity };
            const n = daysTo(b.expiryDate, d.asOf);
            if (n < 0) return { key: 'expired', label: `Expired ${-n} day${n === -1 ? '' : 's'} ago`, tone: 'border-red-500/40 text-red-700 dark:text-red-300', days: n };
            if (n <= 30) return { key: '30', label: `${n} day${n === 1 ? '' : 's'} left`, tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300', days: n };
            if (n <= 90) return { key: '90', label: `${n} days left`, tone: 'border-yellow-500/40 text-yellow-700 dark:text-yellow-300', days: n };
            return { key: 'ok', label: `${n} days left`, tone: 'text-muted-foreground', days: n };
          };
          const rows = d.batches.filter((b) => {
            const s = status(b);
            return show === 'all' || (show === 'expired' && s.key === 'expired') || (show === '30' && s.days <= 30) || (show === '90' && s.days <= 90);
          });
          const count = (k: (b: Batch) => boolean) => d.batches.filter(k).length;
          const cols: Column<Batch>[] = [
            { key: 'item', header: 'Item', sortValue: (r) => r.itemName, cell: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'batch', header: 'Batch', sortValue: (r) => r.batchNo, cell: (r) => <span className="font-mono text-xs">{r.batchNo}</span> },
            { key: 'mfg', header: 'Made', sortValue: (r) => r.mfgDate ?? '', cell: (r) => <span className="text-xs">{fmt(r.mfgDate)}</span> },
            { key: 'exp', header: 'Expires', sortValue: (r) => r.expiryDate ?? '9999', cell: (r) => <span className="text-xs">{fmt(r.expiryDate)}</span> },
            { key: 'status', header: '', cell: (r) => { const s = status(r); return <Badge variant="outline" className={`text-[10px] ${s.tone}`}>{s.label}</Badge>; } },
            { key: 'qty', header: 'In stock', align: 'right', sortValue: (r) => r.qty, cell: (r) => <span className="tabular-nums">{r.qty}</span> },
          ];
          return (
            <div className="space-y-4">
              <Card className="flex flex-wrap items-center gap-2 p-3">
                {([['all', `All (${d.batches.length})`], ['expired', `Expired (${count((b) => status(b).key === 'expired')})`],
                  ['30', `Within 30 days (${count((b) => status(b).days <= 30)})`], ['90', `Within 90 days (${count((b) => status(b).days <= 90)})`]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setShow(k)}
                    className={`rounded px-2.5 py-1 text-xs ${show === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{label}</button>
                ))}
                <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => downloadWorkbook(`batches-${d.asOf}.xlsx`, [{
                  name: 'Batches', rows: [['Item', 'Batch', 'Made', 'Expires', 'In stock'], ...rows.map((b) => [b.itemName, b.batchNo, b.mfgDate ?? '', b.expiryDate ?? '', b.qty])],
                }])}><Download className="size-3.5" /> Excel</Button>
              </Card>
              <DataTable rows={rows} columns={cols} getRowId={(r) => r.batchId} searchPlaceholder="Search item or batch…"
                emptyMessage="No batch stock. Turn on batch tracking for an item, then name the batch on each purchase." />
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
