'use client';

// Risk analytics (lib/server/analytics/risk.ts): the journal searched for the
// patterns an auditor samples, each customer scored for credit risk, and when
// their money is really expected — going by how late each one usually pays.

import Link from 'next/link';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

interface Anomaly {
  kind: string; severity: 'low' | 'medium' | 'high'; title: string; detail: string;
  date: string | null; amountPaise: number | null; href: string | null;
}
interface CustomerRisk {
  id: string; name: string; owedPaise: number; overduePaise: number; oldestDaysOverdue: number;
  avgDaysLate: number | null; limitUsePct: number | null; score: number; band: 'low' | 'medium' | 'high';
}
interface Response {
  from: string; to: string; anomalies: Anomaly[]; customers: CustomerRisk[];
  expected: { next30: number; next60: number; next90: number; later: number };
}

const TONE = {
  high: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400',
  medium: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  low: 'border-border text-muted-foreground',
};

export default function RiskPage() {
  const state = useApi<Response>(() => api.get('/api/analytics/risk'), []);

  const columns: Column<CustomerRisk>[] = [
    { key: 'name', header: 'Customer', sortValue: (r) => r.name,
      cell: (r) => <Link href={`/sales/customers/${r.id}`} className="text-sm font-medium hover:underline">{r.name}</Link> },
    { key: 'score', header: 'Risk', sortValue: (r) => r.score,
      cell: (r) => <Badge variant="outline" className={cn('tabular-nums', TONE[r.band])}>{r.score} · {r.band}</Badge> },
    { key: 'owed', header: 'Owes', align: 'right', sortValue: (r) => r.owedPaise, cell: (r) => <Money value={r.owedPaise} whole /> },
    { key: 'overdue', header: 'Overdue', align: 'right', sortValue: (r) => r.overduePaise, cell: (r) => <Money value={r.overduePaise} whole /> },
    { key: 'oldest', header: 'Oldest overdue', align: 'right', sortValue: (r) => r.oldestDaysOverdue,
      cell: (r) => <span className="text-sm tabular-nums">{r.oldestDaysOverdue ? `${r.oldestDaysOverdue} days` : '—'}</span> },
    { key: 'late', header: 'Usually pays', align: 'right', sortValue: (r) => r.avgDaysLate ?? -1,
      cell: (r) => <span className="text-sm">{r.avgDaysLate === null ? 'No history' : r.avgDaysLate === 0 ? 'On time' : `${r.avgDaysLate} days late`}</span> },
    { key: 'limit', header: 'Limit used', align: 'right', sortValue: (r) => r.limitUsePct ?? -1,
      cell: (r) => <span className={cn('text-sm', (r.limitUsePct ?? 0) > 100 && 'font-medium text-red-700')}>{r.limitUsePct === null ? 'No limit' : `${r.limitUsePct}%`}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Risk & anomalies"
        description="The journal searched for what an auditor samples, each customer scored for credit risk, and collections expected from each one's own payment record."
      />
      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-6">
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Collections expected, by each customer&apos;s own lateness</h2>
              <div className="grid gap-3 sm:grid-cols-4">
                {([['Next 30 days', d.expected.next30], ['31–60 days', d.expected.next60], ['61–90 days', d.expected.next90], ['Later or at risk', d.expected.later]] as const).map(([label, v]) => (
                  <Card key={label} className="p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="text-xl font-semibold"><Money value={v} whole /></p>
                  </Card>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Each open invoice is expected on its due date plus how late that customer has paid before — not on the due date alone. One already a month past even that is counted under Later: at risk, not expected.</p>
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Anomalies, {d.from} to {d.to}</h2>
              {d.anomalies.length === 0 ? (
                <Card className="p-4 text-sm text-muted-foreground">Nothing unusual found in the period.</Card>
              ) : (
                <div className="space-y-2" data-slot="anomalies">
                  {d.anomalies.map((a, i) => (
                    <Card key={`${a.kind}-${i}`} className="flex items-start gap-3 p-3">
                      <ShieldAlert className={cn('mt-0.5 size-4 shrink-0', a.severity === 'high' ? 'text-red-600' : a.severity === 'medium' ? 'text-amber-600' : 'text-muted-foreground')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{a.title}</p>
                        <p className="text-xs text-muted-foreground">{a.detail}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant="outline" className={cn('capitalize', TONE[a.severity])}>{a.severity}</Badge>
                        {a.href && <Link href={a.href} className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">Look <ArrowUpRight className="size-3" /></Link>}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Customer risk</h2>
              <DataTable
                rows={d.customers}
                columns={columns}
                getRowId={(r) => r.id}
                initialSort={{ key: 'score', dir: 'desc' }}
                searchPlaceholder="Search customers…"
                emptyMessage="No customer owes anything."
              />
              <p className="text-xs text-muted-foreground">Out of 100: how late they are now (40), the share of what they owe that is overdue (25), how late they have paid before (20), and how much of their credit limit they use (15).</p>
            </section>
          </div>
        )}
      </AsyncPage>
    </>
  );
}
