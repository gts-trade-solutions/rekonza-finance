'use client';

// Sales by supply: domestic and international, goods and services separately,
// and exports by their IGST — nil under the LUT, or paid.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row {
  key: string; label: string; market: 'domestic' | 'export' | 'sez'; exportIgst: 'nil_lut' | 'paid' | null; kind: 'goods' | 'service';
  invoices: number; taxablePaise: number; igstPaise: number; cgstSgstPaise: number; taxPaise: number; totalPaise: number;
}

const MARKET = { domestic: 'Domestic (within India)', export: 'International (export)', sez: 'SEZ' } as const;

export default function SalesBySupplyPage() {
  return (
    <SimpleReport<Row>
      report="sales-by-supply" title="Sales by Supply"
      description="Sales within India and exports, goods and services each on their own line, net of credit notes. Exports under a LUT carry IGST nil; the rest pay IGST and claim it back."
      empty="No sales in this period."
      columns={[
        textCol('market', 'Sales', (r) => MARKET[r.market], { strong: true }),
        textCol('igst', 'IGST on export', (r) => (r.exportIgst === 'nil_lut' ? 'Nil — under LUT' : r.exportIgst === 'paid' ? 'Paid' : '—')),
        textCol('kind', 'Goods or services', (r) => (r.kind === 'goods' ? 'Goods (HSN)' : 'Services (SAC)')),
        numCol('invoices', 'Invoices', (r) => r.invoices, { digits: 0 }),
        moneyCol('taxable', 'Taxable value', (r) => r.taxablePaise),
        moneyCol('igstAmt', 'IGST', (r) => r.igstPaise),
        moneyCol('cgstSgst', 'CGST + SGST', (r) => r.cgstSgstPaise),
        moneyCol('total', 'Total incl. tax', (r) => r.totalPaise),
      ]}
    />
  );
}
