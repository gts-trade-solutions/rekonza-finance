'use client';

// ABC Classification — items ranked by sales: the few that make 70% of sales are A,
// the next 20% B, the long tail C. Where counting and reordering care pays most.

import { Badge } from '@/components/ui/badge';
import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';
import type { GridColumn } from '@/components/shared/report-grid';

interface Row { itemId: string; name: string; qty: number; amountPaise: number; sharePct: number; cumulativePct: number; klass: 'A' | 'B' | 'C' }

const klass: GridColumn<Row> = {
  key: 'class', header: 'Class',
  cell: (r) => <Badge variant={r.klass === 'A' ? 'default' : r.klass === 'B' ? 'secondary' : 'outline'}>{r.klass}</Badge>,
  csv: (r) => r.klass,
};

export default function AbcClassificationPage() {
  return (
    <SimpleReport<Row>
      report="abc-classification" title="ABC Classification"
      description="Items by sales in the period. A: the items that make the first 70% of sales. B: the next 20%. C: the last 10%."
      empty="No item sales in this period."
      above={(d) => {
        const rows = d.rows;
        const count = (k: Row['klass']) => rows.filter((r) => r.klass === k).length;
        return rows.length ? <p className="text-sm text-muted-foreground">{count('A')} A items, {count('B')} B items, {count('C')} C items out of {rows.length} sold.</p> : null;
      }}
      columns={[
        klass,
        textCol('name', 'Item', (r) => r.name, { strong: true }),
        numCol('qty', 'Quantity sold', (r) => r.qty, { digits: 3 }),
        moneyCol('amount', 'Sales', (r) => r.amountPaise),
        numCol('share', 'Share', (r) => r.sharePct, { digits: 1, suffix: '%' }),
        numCol('cumulative', 'Running share', (r) => r.cumulativePct, { digits: 1, suffix: '%' }),
      ]}
    />
  );
}
