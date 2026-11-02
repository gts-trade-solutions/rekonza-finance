'use client';

// Settings → Developer → Power BI and Excel: the flat tables at /api/bi/…,
// read with an API key from this page (app/api/bi/[dataset]).

import { useEffect, useState } from 'react';
import { BarChart3, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const FEEDS = [
  { id: 'journal-lines', label: 'Journal lines', note: 'every posting, with account, party and cost centre' },
  { id: 'trial-balance', label: 'Trial balance', note: 'as on ?to=' },
  { id: 'invoices', label: 'Invoices', note: 'with tax, paid and balance' },
  { id: 'bills', label: 'Bills', note: 'with tax, MSME flag and balance' },
  { id: 'payments', label: 'Payments', note: 'received and made' },
  { id: 'contacts', label: 'Customers and vendors', note: '' },
  { id: 'stock', label: 'Stock on hand', note: 'quantity and value as on ?to=' },
];

export function BiFeeds() {
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('Copied'); } catch { toast.error('Could not copy'); }
  };
  return (
    <Card className="mt-4 space-y-3 p-5" data-slot="bi-feeds">
      <div className="flex items-start gap-3">
        <BarChart3 className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <p className="font-medium">Power BI, Excel and other BI tools</p>
          <p className="text-sm text-muted-foreground">
            Each address below is one table, amounts in rupees. In Power BI: Get data → Web → Advanced, paste the address, and add the header
            <code className="mx-1">Authorization</code> with the value <code>Bearer</code> and an API key made above. In Excel: Data → From Web, the same.
            Add <code>?from=2026-04-01&amp;to=2027-03-31</code> for a period, or <code>&amp;format=csv</code> for CSV.
          </p>
        </div>
      </div>
      <div className="divide-y rounded-md border">
        {FEEDS.map((f) => {
          const url = `${origin}/api/bi/${f.id}`;
          return (
            <div key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{f.label} <span className="text-xs font-normal text-muted-foreground">{f.note}</span></p>
                <p className="truncate font-mono text-xs text-muted-foreground">{url}</p>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${f.label} address`} onClick={() => copy(url)}><Copy className="size-3.5" /></Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
