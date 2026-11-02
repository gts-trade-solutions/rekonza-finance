'use client';

// Inventory Valuation Summary — each item's stock and its value at the date.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';
import { formatINR } from '@/lib/money';

interface Row { itemId: string; name: string; sku: string | null; uqc: string; qty: number; unitCostPaise: number; valuePaise: number; valuation: 'average' | 'fifo' }

export default function InventoryValuationPage() {
  return (
    <SimpleReport<Row>
      report="inventory-valuation" title="Inventory Valuation Summary" asOf
      description="Stock on hand at the date and what it is worth, at weighted average cost or FIFO as each item is set."
      empty="No stock on hand at this date."
      above={(d) => <p className="text-sm">Stock value at the date: <b className="tabular">{formatINR(Number(d.totalValuePaise ?? 0))}</b></p>}
      columns={[
        textCol('name', 'Item', (r) => r.name, { strong: true }),
        textCol('sku', 'SKU', (r) => r.sku, { muted: true }),
        textCol('valuation', 'Method', (r) => (r.valuation === 'fifo' ? 'FIFO' : 'Average'), { muted: true }),
        numCol('qty', 'Quantity', (r) => r.qty, { digits: 3 }),
        textCol('uqc', 'Unit', (r) => r.uqc, { muted: true }),
        moneyCol('unit', 'Unit cost', (r) => r.unitCostPaise, { total: false }),
        moneyCol('value', 'Value', (r) => r.valuePaise),
      ]}
    />
  );
}
