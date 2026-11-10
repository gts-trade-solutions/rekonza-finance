'use client';

// Settings → Developer → BI and planning tools: the flat tables at /api/bi/…
// for Power BI and Excel, the same tables as an OData feed at /api/odata for
// Tableau, and the trial balance in OneStream's import layout — as a file to
// load, or an address a OneStream connector rule reads. All with an API key
// made on this page.

import { useEffect, useState } from 'react';
import { BarChart3, Copy, Database, Download, Loader2, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const FEEDS = [
  { id: 'journal-lines', set: 'JournalLines', label: 'Journal lines', note: 'every posting, with account, party and cost centre' },
  { id: 'trial-balance', set: 'TrialBalance', label: 'Trial balance', note: 'as on ?to=' },
  { id: 'invoices', set: 'Invoices', label: 'Invoices', note: 'with tax, paid and balance' },
  { id: 'bills', set: 'Bills', label: 'Bills', note: 'with tax, MSME flag and balance' },
  { id: 'payments', set: 'Payments', label: 'Payments', note: 'received and made' },
  { id: 'contacts', set: 'Contacts', label: 'Customers and vendors', note: '' },
  { id: 'stock', set: 'Stock', label: 'Stock on hand', note: 'quantity and value as on ?to=' },
  { id: 'onestream', set: 'OneStream', label: 'OneStream trial balance', note: 'by month, in OneStream’s import layout' },
];

const fyStart = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return `${d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1}-04-01`;
};
const todayIso = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

function CopyRow({ label, note, url, onCopy }: { label: string; note?: string; url: string; onCopy: (u: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="font-medium">{label} {note && <span className="text-xs font-normal text-muted-foreground">{note}</span>}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{url}</p>
      </div>
      <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${label} address`} onClick={() => onCopy(url)}><Copy className="size-3.5" /></Button>
    </div>
  );
}

export function BiFeeds() {
  const [origin, setOrigin] = useState('');
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(todayIso());
  const [view, setView] = useState<'ytd' | 'periodic'>('ytd');
  const [format, setFormat] = useState<'csv' | 'txt'>('csv');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('Copied'); } catch { toast.error('Could not copy'); }
  };

  const oneStreamFile = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/bi/onestream?from=${from}&to=${to}&view=${view}&format=${format}`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `The file could not be made (${res.status}).`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `onestream-${view}-${from}-to-${to}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The file could not be made');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="bi" className="mt-4 space-y-4">
      <Card className="space-y-3 p-5" data-slot="bi-feeds">
        <div className="flex items-start gap-3">
          <BarChart3 className="mt-0.5 size-5 text-amber-500" />
          <div>
            <p className="font-medium">Power BI, Excel and other BI tools</p>
            <p className="text-sm text-muted-foreground">
              Each address below is one table, amounts in rupees. In Power BI: Get data → Web → Advanced, paste the address, and add the header
              <code className="mx-1">Authorization</code> with the value <code>Bearer</code> and an API key made above. In Excel: Data → From Web, the same.
              Add <code>?from=2026-04-01&amp;to=2027-03-31</code> for a period, or <code>&amp;format=csv</code> (or <code>txt</code>, tab-separated) for a file.
            </p>
          </div>
        </div>
        <div className="divide-y rounded-md border">
          {FEEDS.map((f) => <CopyRow key={f.id} label={f.label} note={f.note} url={`${origin}/api/bi/${f.id}`} onCopy={copy} />)}
        </div>
      </Card>

      <Card className="space-y-3 border-t-4 border-t-blue-500 p-5" data-slot="bi-tableau">
        <div className="flex items-start gap-3">
          <Database className="mt-0.5 size-5 text-blue-500" />
          <div>
            <p className="font-medium">Tableau (OData)</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>In Tableau Desktop: <em>Connect → To a Server → OData</em>.</li>
              <li>Server: one of the addresses below — a table, or the feed itself to see them all.</li>
              <li>Authentication: <em>Username and Password</em>. Username: anything, e.g. <code>rekonza</code>. Password: an API key made above (its role decides what Tableau may read).</li>
              <li>Sign in, then <em>Extract</em> and schedule a refresh on Tableau Cloud or Server to keep it up to date.</li>
            </ol>
            <p className="mt-1 text-xs text-muted-foreground">Add <code>?from=2026-04-01&amp;to=2027-03-31</code> to a table’s address for a period. Excel and Power BI’s OData feed connectors take the same addresses.</p>
          </div>
        </div>
        <div className="divide-y rounded-md border">
          <CopyRow label="The OData feed" note="every table" url={`${origin}/api/odata`} onCopy={copy} />
          {FEEDS.map((f) => <CopyRow key={f.set} label={f.label} url={`${origin}/api/odata/${f.set}`} onCopy={copy} />)}
        </div>
      </Card>

      <Card className="space-y-3 border-t-4 border-t-violet-500 p-5" data-slot="bi-onestream">
        <div className="flex items-start gap-3">
          <Layers className="mt-0.5 size-5 text-violet-500" />
          <div className="min-w-0">
            <p className="font-medium">OneStream</p>
            <p className="text-sm text-muted-foreground">
              The trial balance month by month, in the columns a OneStream data source reads:
              <code className="mx-1 break-all">Entity, Account, AccountDescription, AccountType, Time (2026M11), Scenario (Actual), View, Flow, IC, UD1 (branch), UD2 (cost centre), Amount, Currency</code>.
              Amounts are signed, debit positive. <em>YTD</em> gives balance-sheet accounts at their closing balance and income and expense from 1 April, earlier years’
              profit in retained earnings — each month adds up to nil; <em>Periodic</em> gives each month’s movement.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">From</span>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" />
          </label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">To</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" />
          </label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">View</span>
            <select value={view} onChange={(e) => setView(e.target.value as 'ytd' | 'periodic')} className="h-8 w-36 rounded-md border bg-background px-2 text-sm" data-slot="onestream-view">
              <option value="ytd">YTD</option>
              <option value="periodic">Periodic</option>
            </select>
          </label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">File</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'txt')} className="h-8 w-44 rounded-md border bg-background px-2 text-sm">
              <option value="csv">CSV (comma)</option>
              <option value="txt">Text (tab-separated)</option>
            </select>
          </label>
          <Button size="sm" className="gap-1.5" onClick={() => void oneStreamFile()} disabled={busy} data-slot="onestream-download">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Download for OneStream
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          To have OneStream pull it on its own, a connector business rule reads this address with the header <code>Authorization: Bearer</code> and an API key;
          <code className="mx-1">view=periodic</code> for movements, <code>format=csv</code> for a file:
        </p>
        <div className="rounded-md border">
          <CopyRow label="For a OneStream connector" url={`${origin}/api/bi/onestream?from=${from}&to=${to}&view=${view}`} onCopy={copy} />
        </div>
      </Card>
    </div>
  );
}
