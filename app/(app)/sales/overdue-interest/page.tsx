'use client';

// Interest on overdue invoices: what each customer owes for paying late, at
// the book's rate, and a draft invoice for it in one click. Interest is part
// of the value of the supply, so it is billed at the invoice's own GST rate.

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Loader2, Percent } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface Row {
  invoiceId: string; number: string; customerId: string; customerName: string; dueDate: string; balancePaise: number;
  from: string; to: string; days: number; interestPaise: number; hsnSac: string | null; gstRatePct: number;
}
interface Data { asOf: string; ratePct: number; graceDays: number; rows: Row[] }

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function OverdueInterestPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canSet = usePermission('settings', 'edit');
  const [asOf, setAsOf] = useState(today());
  const state = useApi<Data>(() => api.get('/api/overdue-interest', { asOf }), [asOf]);
  const [busy, setBusy] = useState<string | null>(null);

  const setPolicy = async (patch: Record<string, number>) => {
    try {
      await api.put('/api/settings/policies', patch);
      toast.success('Saved');
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const raise = async (customerId: string, name: string) => {
    setBusy(customerId);
    try {
      const r = await api.post<{ id: string; number: string }>('/api/overdue-interest', { customerId, asOf });
      toast.success(`Draft ${r.number} raised for ${name}`, { description: 'Check it, then approve it to send.' });
      router.push(`/sales/invoices/${r.id}`);
    } catch (e) {
      toast.error('Not raised', { description: e instanceof Error ? e.message : String(e) });
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Interest on overdue invoices" description="Simple interest on each unpaid balance from the day after its due date, billed on a draft invoice at the invoice’s GST rate." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => <Body d={d} asOf={asOf} setAsOf={setAsOf} canSet={canSet} canCreate={canCreate} busy={busy} onSet={setPolicy} onRaise={raise} />}
      </AsyncPage>
    </>
  );
}

function Body({ d, asOf, setAsOf, canSet, canCreate, busy, onSet, onRaise }: {
  d: Data; asOf: string; setAsOf: (v: string) => void; canSet: boolean; canCreate: boolean; busy: string | null;
  onSet: (p: Record<string, number>) => void; onRaise: (id: string, name: string) => void;
}) {
  const customers = useMemo(() => {
    const m = new Map<string, { name: string; rows: Row[] }>();
    for (const r of d.rows) m.set(r.customerId, { name: r.customerName, rows: [...(m.get(r.customerId)?.rows ?? []), r] });
    return [...m.entries()];
  }, [d.rows]);
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
        <Percent className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">Rate</span>
        <Input type="number" step="0.5" min={0} max={60} defaultValue={d.ratePct} disabled={!canSet} className="h-9 w-20"
          onBlur={(e) => { const v = Number(e.target.value); if (v !== d.ratePct) onSet({ overdueInterestPct: v }); }} />
        <span className="text-muted-foreground">% a year, after</span>
        <Input type="number" min={0} max={365} defaultValue={d.graceDays} disabled={!canSet} className="h-9 w-20"
          onBlur={(e) => { const v = Number(e.target.value); if (v !== d.graceDays) onSet({ overdueGraceDays: v }); }} />
        <span className="text-muted-foreground">days’ grace · to</span>
        <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-9 w-40" />
        <span className="ml-auto">Total: <Money value={d.rows.reduce((t, r) => t + r.interestPaise, 0)} className="font-semibold" /></span>
      </Card>
      {customers.length === 0 ? (
        <EmptyState icon={Percent} title="Nothing overdue" description="No invoice is past its due date and grace days, or interest is already charged to this date." />
      ) : customers.map(([id, c]) => (
        <Card key={id} className="gap-0 overflow-hidden p-0">
          <div className="flex items-center gap-3 border-b px-4 py-2.5">
            <p className="text-sm font-semibold">{c.name}</p>
            <Money value={c.rows.reduce((t, r) => t + r.interestPaise, 0)} className="text-sm" />
            {canCreate && (
              <Button size="sm" variant="outline" className="ml-auto gap-1.5" disabled={!!busy} onClick={() => onRaise(id, c.name)}>
                {busy === id && <Loader2 className="size-3.5 animate-spin" />} Raise interest invoice
              </Button>
            )}
          </div>
          <ReportTable>
            <thead><tr className="border-b">
              <th className={`${th} text-left`}>Invoice</th><th className={`${th} text-left`}>Due</th><th className={`${th} text-right`}>Overdue</th>
              <th className={`${th} text-left`}>Period</th><th className={`${th} text-right`}>Days</th><th className={`${th} text-right`}>GST</th><th className={`${th} text-right`}>Interest</th>
            </tr></thead>
            <tbody className="divide-y">
              {c.rows.map((r) => (
                <tr key={r.invoiceId}>
                  <td className="px-3 py-2 font-medium">{r.number}</td>
                  <td className="px-3 py-2 text-xs">{fmt(r.dueDate)}</td>
                  <td className="px-3 py-2 text-right"><Money value={r.balancePaise} /></td>
                  <td className="px-3 py-2 text-xs">{fmt(r.from)} – {fmt(r.to)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.days}</td>
                  <td className="px-3 py-2 text-right text-xs">{r.gstRatePct}%</td>
                  <td className="px-3 py-2 text-right font-medium"><Money value={r.interestPaise} /></td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        The rate should be the one in your terms of sale. Each charge starts the day after the last one ended, so no day is charged twice.
      </p>
    </div>
  );
}
