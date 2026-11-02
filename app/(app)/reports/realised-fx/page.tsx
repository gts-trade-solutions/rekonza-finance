'use client';

// Realised Gain or Loss — exchange differences booked when foreign-currency
// invoices and bills were settled. Restatements at a period end are not here:
// they are reversed the next day, so they are the unrealised report's.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, moneyCol, textCol } from '@/components/reports/cols';

interface Row { entryId: string; date: string; source: string | null; memo: string | null; party: string | null; gainPaise: number }

export default function RealisedFxPage() {
  return (
    <SimpleReport<Row>
      report="realised-fx" title="Realised Exchange Gain or Loss"
      description="The gain or loss on foreign-currency documents settled in the period. A loss shows as minus."
      empty="No foreign-currency settlements in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('party', 'Party', (r) => r.party),
        textCol('memo', 'Details', (r) => r.memo, { muted: true }),
        textCol('source', 'From', (r) => r.source?.replace(/_/g, ' ') ?? null, { muted: true }),
        moneyCol('gain', 'Gain / (loss)', (r) => r.gainPaise, { colored: true }),
      ]}
    />
  );
}
