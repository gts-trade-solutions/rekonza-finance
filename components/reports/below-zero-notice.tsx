'use client';

// Stock or cash below nothing, said at the top of the profit and loss and the
// balance sheet (lib/server/reports/below-zero.ts): a negative closing stock or
// a negative Cash in Hand is an error in the books, and the statements must not
// carry it silently. Each item and account is named, with its figure, and the
// screen where it is put right.

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';

export interface BelowZeroData {
  asOf: string;
  stock: { itemId: string; name: string; qty: number; uqc: string; valuePaise: number }[];
  stockValuePaise: number;
  cash: { bankAccountId: string; name: string; balancePaise: number }[];
}

export function BelowZeroNotice({ data }: { data?: BelowZeroData | null }) {
  if (!data || (!data.stock.length && !data.cash.length)) return null;
  const day = new Date(`${data.asOf}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <Card className="gap-2 border-amber-500/50 bg-amber-500/5 p-4" data-slot="below-zero-notice">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="font-medium">
            {data.stock.length > 0 && data.cash.length > 0 ? 'Stock and cash below zero' : data.stock.length > 0 ? 'Stock below zero' : 'Cash below zero'} on {day}: these figures are wrong until it is put right
          </p>
          {data.stock.length > 0 && (
            <div data-slot="below-zero-stock">
              <p className="text-xs text-muted-foreground">
                More has gone out than came in, so closing stock includes <Money value={data.stockValuePaise} className="font-medium text-destructive" /> for goods that are not there.
                Record the purchase (or the opening stock) they came from, or correct the sale or write-off.
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {data.stock.slice(0, 8).map((s) => (
                  <li key={s.itemId} className="flex flex-wrap gap-x-2">
                    <Link href={`/sales/items/${s.itemId}`} className="font-medium text-link hover:underline">{s.name}</Link>
                    <span className="tabular text-destructive">{s.qty} {s.uqc.toLowerCase()}</span>
                    <span className="text-muted-foreground">valued at <Money value={s.valuePaise} /></span>
                  </li>
                ))}
                {data.stock.length > 8 && <li className="text-muted-foreground">and {data.stock.length - 8} more (Inventory → Stock on hand, filtered to negative).</li>}
              </ul>
            </div>
          )}
          {data.cash.length > 0 && (
            <div data-slot="below-zero-cash">
              <p className="text-xs text-muted-foreground">
                Cash in hand cannot be less than nothing: a receipt or a withdrawal from the bank has not been recorded, or a payment was not made from cash.
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {data.cash.map((c) => (
                  <li key={c.bankAccountId} className="flex flex-wrap gap-x-2">
                    <Link href={`/banking/${c.bankAccountId}`} className="font-medium text-link hover:underline">{c.name}</Link>
                    <Money value={c.balancePaise} className="text-destructive" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
