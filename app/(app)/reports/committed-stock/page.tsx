'use client';

// Committed Stock Details — stock promised on open sales orders and not yet
// invoiced or delivered, against what is on hand.

import { SimpleReport } from '@/components/reports/simple-report';
import { numCol, textCol } from '@/components/reports/cols';
import type { GridColumn } from '@/components/shared/report-grid';

interface Row { itemId: string; name: string; uqc: string | null; onHandQty: number; committedQty: number; availableQty: number; orders: number }

const available: GridColumn<Row> = {
  key: 'available', header: 'Available', align: 'right',
  cell: (r) => <span className={`tabular ${r.availableQty < 0 ? 'font-medium text-destructive' : ''}`}>{r.availableQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</span>,
  csv: (r) => r.availableQty,
};

export default function CommittedStockPage() {
  return (
    <SimpleReport<Row>
      report="committed-stock" title="Committed Stock Details" asOf
      description="What open sales orders have promised and not yet delivered or invoiced, against stock on hand. A minus in Available means more is promised than is there."
      empty="Nothing is committed on open sales orders."
      columns={[
        textCol('name', 'Item', (r) => r.name, { strong: true }),
        textCol('uqc', 'Unit', (r) => r.uqc, { muted: true }),
        numCol('orders', 'Open orders', (r) => r.orders, { digits: 0 }),
        numCol('onHand', 'On hand', (r) => r.onHandQty, { digits: 3 }),
        numCol('committed', 'Committed', (r) => r.committedQty, { digits: 3 }),
        available,
      ]}
    />
  );
}
