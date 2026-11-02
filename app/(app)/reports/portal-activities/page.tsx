'use client';

// Portal Activities — what customers and vendors did on their portal, as Zoho
// Books reports it: who opened it, signed in, paid, answered a quote or a
// purchase order, commented, sent a file, changed their details or asked for a
// new bank account (services/portal.ts, migration 094).

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { ReportGrid, gridCsv, type GridColumn } from '@/components/shared/report-grid';
import { AsyncPage } from '@/components/shared/async-state';
import { reports, type PortalActivitiesReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

type Row = PortalActivitiesReport['rows'][number];

const ACTION: Record<string, string> = {
  opened: 'Opened the portal', signed_in: 'Signed in', pay_started: 'Started an online payment', commented: 'Commented',
  quote_accepted: 'Accepted a quote', quote_declined: 'Declined a quote', order_accepted: 'Accepted a purchase order', order_declined: 'Declined a purchase order',
  uploaded: 'Sent a file', profile_updated: 'Updated their details', bank_change_requested: 'Asked to change bank account',
};

const at = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const columns: GridColumn<Row>[] = [
  { key: 'at', header: 'When', cell: (r) => <span className="tabular text-xs">{at(r.at)}</span>, csv: (r) => r.at },
  {
    key: 'contact', header: 'Contact',
    cell: (r) => <Link href={r.side === 'customer' ? `/sales/customers/${r.contactId}` : `/purchases/vendors/${r.contactId}`} className="font-medium hover:underline">{r.contact}</Link>,
    csv: (r) => r.contact,
  },
  { key: 'side', header: 'As', cell: (r) => <Badge variant="outline" className="text-[10px]">{r.side === 'customer' ? 'Customer' : 'Vendor'}</Badge>, csv: (r) => r.side },
  { key: 'action', header: 'Activity', cell: (r) => ACTION[r.action] ?? r.action.replace(/_/g, ' '), csv: (r) => ACTION[r.action] ?? r.action },
  { key: 'detail', header: 'Details', cell: (r) => <span className="text-xs text-muted-foreground">{r.detail ?? ''}</span>, csv: (r) => r.detail ?? '' },
];

export default function PortalActivitiesPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<PortalActivitiesReport>(() => reports.portalActivities(range.from, range.to), [range.from, range.to]);

  return (
    <ReportShell
      title="Portal Activities"
      description="Everything customers and vendors did on their portal in the period. Openings are counted once per half hour."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        if (state.data) downloadCsv('portal-activities.csv', gridCsv(state.data.rows, columns));
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <ReportGrid rows={d.rows} columns={columns} emptyMessage="Nobody used the portal in this period. Give a customer or vendor access from the People & portal tab on their page." />
        )}
      </AsyncPage>
    </ReportShell>
  );
}
