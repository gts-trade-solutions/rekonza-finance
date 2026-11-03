'use client';

// What a challan or order list row shows beside its number: the products on it
// and the invoices raised from it (app/api/sales-documents/route.ts, linksFor).

import Link from 'next/link';
import type { SalesDocRow } from '@/lib/api/client';

const one = (i: NonNullable<SalesDocRow['items']>[number]) => `${i.name} × ${i.qty.toLocaleString('en-IN')}${i.uqc ? ` ${i.uqc}` : ''}`;

/** "Brake pads × 10 NOS, Engine oil × 5 LTR +2 more", every product in the tooltip. */
export function ProductsCell({ items }: { items?: SalesDocRow['items'] }) {
  if (!items?.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="block max-w-[260px] truncate text-xs" title={items.map(one).join('\n')} data-slot="doc-products">
      {items.slice(0, 2).map(one).join(', ')}{items.length > 2 ? ` +${items.length - 2} more` : ''}
    </span>
  );
}

/** The invoices raised from a document, each a link to it. */
export function InvoicesCell({ invoices }: { invoices?: SalesDocRow['invoices'] }) {
  if (!invoices?.length) return <span className="text-xs text-muted-foreground">Not invoiced</span>;
  return (
    <span className="flex flex-wrap gap-1" data-slot="doc-invoices">
      {invoices.map((i) => (
        <Link key={i.id} href={`/sales/invoices/${i.id}`} className="text-xs font-medium text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}>
          {i.number}
        </Link>
      ))}
    </span>
  );
}
