'use client';

// System Mails — every email the books sent: invoices, reminders, statements,
// portal links and codes — to whom, by whom, and whether it went.

import { Badge } from '@/components/ui/badge';
import { SimpleReport } from '@/components/reports/simple-report';
import { textCol } from '@/components/reports/cols';
import type { GridColumn } from '@/components/shared/report-grid';

interface Row { id: string; at: string; to: string; cc: string | null; subject: string; status: string; error: string | null; docType: string | null; docId: string | null; sentBy: string | null }

const at = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const columns: GridColumn<Row>[] = [
  { key: 'at', header: 'Sent', cell: (r) => <span className="tabular text-xs">{at(r.at)}</span>, csv: (r) => r.at },
  textCol('to', 'To', (r) => r.to),
  textCol('subject', 'Subject', (r) => r.subject, { strong: true }),
  textCol('what', 'About', (r) => r.docType?.replace(/_/g, ' ') ?? null, { muted: true }),
  textCol('by', 'By', (r) => r.sentBy ?? 'The system', { muted: true }),
  {
    key: 'status', header: 'Status',
    cell: (r) => <Badge variant="outline" className={r.status === 'sent' ? 'text-emerald-700 dark:text-emerald-300' : 'border-destructive/40 text-destructive'} title={r.error ?? undefined}>{r.status}</Badge>,
    csv: (r) => (r.error ? `${r.status}: ${r.error}` : r.status),
  },
];

export default function SystemMailsPage() {
  return (
    <SimpleReport<Row>
      report="system-mails" title="System Mails"
      description="Every email sent from the books in the period, and whether it went. A failed one shows why when you point at it."
      empty="No emails were sent in this period. Emails go out once a mail server is set up in Settings."
      columns={columns}
    />
  );
}
