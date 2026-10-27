'use client';

// Stock on hand.
//
// Nothing here is stored. Each quantity is opening, plus what the bills brought
// in and credit notes took back, less what the invoices sent out, plus or minus
// adjustments — computed on the request from the documents themselves. The
// value is the same weighted-average figure the balance sheet carries as
// closing stock, so the two screens cannot disagree.
//
// Negative stock is shown rather than netted away. It means the documents
// disagree with what is on the shelf, and hiding it would hide the problem.

import { useState } from 'react';
import { AlertTriangle, Boxes, Info, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { api, inventory, type StockResponse, type StockRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useCanSeeCosts } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';

/** Each item's quantity in each godown, and what is on the road between them. */
function GodownTable() {
  const state = useApi(() => api.get<{
    asOf: string; godowns: { id: string; name: string; branchName: string | null }[];
    rows: { itemId: string; name: string; uqc: string; byGodown: Record<string, number>; inTransit: number; total: number }[];
  }>('/api/inventory', { view: 'godowns' }), []);
  return (
    <AsyncPage state={state}>
      {(d) => (
        <Card className="gap-0 overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Item</th>
                  {d.godowns.map((g) => (
                    <th key={g.id} className="px-3 py-2 text-right font-semibold">
                      {g.name}{g.branchName && <span className="block font-normal normal-case">{g.branchName}</span>}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-semibold">In transit</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.rows.length === 0 && <tr><td colSpan={d.godowns.length + 3} className="p-6 text-center text-muted-foreground">No stock anywhere.</td></tr>}
                {d.rows.map((r) => (
                  <tr key={r.itemId}>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    {d.godowns.map((g) => {
                      const q = r.byGodown[g.id] ?? 0;
                      return <td key={g.id} className={`px-3 py-2 text-right tabular-nums ${q < 0 ? 'text-destructive' : q === 0 ? 'text-muted-foreground' : ''}`}>{q === 0 ? '—' : q}</td>;
                    })}
                    <td className={`px-3 py-2 text-right tabular-nums ${r.inTransit ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{r.inTransit || "—"}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{r.total} <span className="text-xs font-normal text-muted-foreground">{r.uqc.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </AsyncPage>
  );
}

export default function StockPage() {
  const canSeeCosts = useCanSeeCosts();
  const state = useApi<StockResponse>(() => inventory.stock(), []);
  const [view, setView] = useState<'items' | 'godowns'>('items');
  const [group, setGroup] = useState('');
  const groups = useApi(() => api.get<{ groups: { id: string; name: string; parentId: string | null }[] }>('/api/stock-groups'), []);
  // A group takes in the groups inside it.
  const inGroup = new Set<string>(group ? [group] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of groups.data?.groups ?? []) if (g.parentId && inGroup.has(g.parentId) && !inGroup.has(g.id)) { inGroup.add(g.id); grew = true; }
  }

  const columns: Column<StockRow>[] = [
    {
      key: 'name', header: 'Item', sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted-foreground">{r.sku ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'movement', header: 'Movement', sortValue: (r) => r.boughtQty,
      cell: (r) => (
        <span className="text-xs text-muted-foreground tabular">
          {r.openingQty} opening + {r.boughtQty} in − {r.soldQty} out
          {r.returnedQty !== 0 && ` + ${r.returnedQty} returned`}
          {r.adjustedQty !== 0 && (r.adjustedQty > 0 ? ` + ${r.adjustedQty} adj` : ` − ${-r.adjustedQty} adj`)}
        </span>
      ),
    },
    {
      key: 'qty', header: 'On hand', align: 'right', sortValue: (r) => r.qty,
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          {r.qty < 0 ? (
            <Badge variant="outline" className="border-red-500/40 text-[9px] text-red-600 dark:text-red-400">
              Negative
            </Badge>
          ) : r.qty === 0 ? (
            <Badge variant="outline" className="border-red-500/40 text-[9px] text-red-600 dark:text-red-400">
              Out of stock
            </Badge>
          ) : r.minLevel > 0 && r.qty <= r.minLevel ? (
            <Badge variant="outline" className="border-red-500/40 text-[9px] text-red-600 dark:text-red-400">
              Below minimum
            </Badge>
          ) : r.qty <= r.reorderLevel ? (
            <Badge variant="outline" className="border-amber-500/40 text-[9px] text-amber-700 dark:text-amber-300">
              Reorder
            </Badge>
          ) : null}
          <div className="text-right">
            <span className="tabular font-medium">
              {r.qty} <span className="text-xs font-normal text-muted-foreground">{r.uqc.toLowerCase()}</span>
            </span>
            {r.altUqc && r.altFactor ? (
              <p className="text-[10px] text-muted-foreground tabular">
                = {+(r.qty / r.altFactor).toFixed(3)} {r.altUqc.toLowerCase()}
              </p>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: 'reorder', header: 'Reorder at', align: 'right', sortValue: (r) => r.reorderLevel,
      cell: (r) => (
        <span className="tabular text-muted-foreground">
          {r.reorderLevel || '—'}
          {r.minLevel > 0 && <span className="block text-[10px]">min {r.minLevel}</span>}
        </span>
      ),
    },
    ...(canSeeCosts
      ? [
          {
            key: 'cost',
            header: 'Avg. cost',
            align: 'right' as const,
            sortValue: (r: StockRow) => r.unitCostPaise,
            cell: (r: StockRow) => <Money value={r.unitCostPaise} className="text-muted-foreground" />,
          },
          {
            key: 'value',
            header: 'Stock value',
            align: 'right' as const,
            sortValue: (r: StockRow) => r.valuePaise,
            cell: (r: StockRow) => <Money value={r.valuePaise} className="font-medium" />,
          },
        ]
      : []),
    // Standard cost, where any item has one: the budget, and how far the
    // actual average cost has drifted from it across what is on hand.
    ...(canSeeCosts && state.data?.items.some((i) => i.standardCostPaise !== null)
      ? [
          {
            key: 'std',
            header: 'Std. cost',
            align: 'right' as const,
            sortValue: (r: StockRow) => r.standardCostPaise ?? 0,
            cell: (r: StockRow) => (r.standardCostPaise === null ? <span className="text-muted-foreground">—</span>
              : <Money value={r.standardCostPaise} className="text-muted-foreground" />),
          },
          {
            key: 'variance',
            header: 'Variance',
            align: 'right' as const,
            sortValue: (r: StockRow) => r.varianceValuePaise ?? 0,
            cell: (r: StockRow) => (r.varianceValuePaise === null ? <span className="text-muted-foreground">—</span>
              : <Money value={r.varianceValuePaise} className={r.varianceValuePaise > 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'} />),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Stock on hand"
        description="Live quantities derived from opening stock, purchases received and units invoiced out."
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Stock value"
                value={canSeeCosts ? formatINRCompact(d.summary.totalValuePaise) : 'Hidden'}
                sub={`${d.summary.tracked} item(s) tracked`}
                icon={Boxes}
              />
              <StatTile
                label="Below reorder level"
                value={String(d.summary.lowStock)}
                sub={d.summary.belowMinimum ? `${d.summary.belowMinimum} below minimum` : 'Time to buy'}
                tone={d.summary.lowStock ? 'warning' : 'positive'}
                icon={AlertTriangle}
              />
              <StatTile
                label="Out of stock"
                value={String(d.summary.outOfStock)}
                sub="Cannot fulfil orders"
                tone={d.summary.outOfStock ? 'danger' : 'positive'}
              />
            </div>

            {d.summary.negative > 0 && (
              <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {d.summary.negative} item(s) show negative stock.
                  </span>{' '}
                  More has been invoiced out than was ever recorded coming in — usually a bill that was never
                  entered, or an opening quantity that was never set. The figure is left as it is rather than
                  clamped to zero, because clamping it would hide the missing document.
                </p>
              </Card>
            )}

            <Card className="flex items-start gap-3 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Quantities are calculated, not stored — opening stock plus everything received on bills, minus
                everything sold on invoices, plus any adjustment. Valuation is weighted average cost, taken from
                what was actually paid on the bills rather than the catalogue price. Adjustments post to the ledger,
                so the Inventory figure on the balance sheet moves with them.
              </p>
            </Card>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex w-fit rounded-md border p-0.5 text-xs">
                {(['items', 'godowns'] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)}
                    className={`rounded px-2.5 py-1 ${view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                    {v === 'items' ? 'By item' : 'By godown'}
                  </button>
                ))}
              </div>
              {view === 'items' && (groups.data?.groups.length ?? 0) > 0 && (
                <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Stock group"
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="">Every stock group</option>
                  {groups.data!.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
            </div>

            {view === 'godowns' ? (
              <GodownTable />
            ) : d.items.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No stocked items"
                description="Only goods carry stock. Add an item under Sales → Items to see it here."
              />
            ) : (
              <DataTable
                rows={group ? d.items.filter((i) => i.stockGroupId !== null && inGroup.has(i.stockGroupId)) : d.items}
                columns={columns}
                getRowId={(r) => r.itemId}
                initialSort={{ key: 'qty', dir: 'asc' }}
                searchPlaceholder="Search item or SKU…"
              />
            )}
          </>
        )}
      </AsyncPage>
    </>
  );
}
