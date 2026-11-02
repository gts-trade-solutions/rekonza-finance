'use client';

// Purchases by Item — what was bought in the period, item by item, from the bills.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row { itemId: string | null; name: string; uqc: string | null; qty: number; amountPaise: number; averagePaise: number; bills: number }

export default function PurchasesByItemPage() {
  return (
    <SimpleReport<Row>
      report="purchases-by-item" title="Purchases by Item"
      description="Every item bought in the period: the quantity, the amount before tax, and the average price paid."
      empty="No bills in this period."
      columns={[
        textCol('name', 'Item', (r) => r.name, { strong: true }),
        textCol('uqc', 'Unit', (r) => r.uqc, { muted: true }),
        numCol('bills', 'Bills', (r) => r.bills, { digits: 0 }),
        numCol('qty', 'Quantity bought', (r) => r.qty, { digits: 3 }),
        moneyCol('average', 'Average price', (r) => r.averagePaise, { total: false }),
        moneyCol('amount', 'Amount', (r) => r.amountPaise),
      ]}
    />
  );
}
