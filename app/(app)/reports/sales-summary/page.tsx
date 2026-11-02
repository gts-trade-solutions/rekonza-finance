'use client';

// Sales Summary — sales month by month: invoices, credit notes, net sales and the tax on them.

import { SimpleReport } from '@/components/reports/simple-report';
import { moneyCol, numCol, textCol } from '@/components/reports/cols';

interface Row { month: string; invoices: number; taxablePaise: number; taxPaise: number; totalPaise: number; creditNotes: number; creditTaxablePaise: number; netSalesPaise: number }

const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export default function SalesSummaryPage() {
  return (
    <SimpleReport<Row>
      report="sales-summary" title="Sales Summary"
      description="Each month's invoices and credit notes, the net sales before tax, and the GST charged."
      empty="No sales in this period."
      columns={[
        textCol('month', 'Month', (r) => monthName(r.month), { strong: true }),
        numCol('invoices', 'Invoices', (r) => r.invoices, { digits: 0, total: true }),
        moneyCol('taxable', 'Sales', (r) => r.taxablePaise),
        numCol('credits', 'Credit notes', (r) => r.creditNotes, { digits: 0, total: true }),
        moneyCol('creditTaxable', 'Credited', (r) => r.creditTaxablePaise),
        moneyCol('net', 'Net sales', (r) => r.netSalesPaise),
        moneyCol('tax', 'GST charged', (r) => r.taxPaise),
        moneyCol('total', 'Invoiced incl. tax', (r) => r.totalPaise),
      ]}
    />
  );
}
