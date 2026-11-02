'use client';

// Timesheet Details — every time entry in the period: who, on what, billable or billed.

import { SimpleReport } from '@/components/reports/simple-report';
import { dateCol, numCol, textCol } from '@/components/reports/cols';

interface Row { id: string; date: string; hours: number; billable: boolean; notes: string | null; projectId: string; project: string; customer: string | null; task: string | null; user: string | null; invoice: string | null }

export default function TimesheetDetailsPage() {
  return (
    <SimpleReport<Row>
      report="timesheet-details" title="Timesheet Details"
      description="Every hour logged in the period, by person, project and task, and whether it is billable and billed."
      empty="No time logged in this period."
      columns={[
        dateCol('date', 'Date', (r) => r.date),
        textCol('user', 'Person', (r) => r.user),
        textCol('project', 'Project', (r) => r.project, { strong: true, href: (r) => `/projects/${r.projectId}` }),
        textCol('customer', 'Customer', (r) => r.customer, { muted: true }),
        textCol('task', 'Task', (r) => r.task),
        textCol('notes', 'Notes', (r) => r.notes, { muted: true }),
        textCol('billable', 'Billable', (r) => (r.billable ? (r.invoice ? `Billed (${r.invoice})` : 'Yes, not billed') : 'No')),
        numCol('hours', 'Hours', (r) => r.hours, { digits: 2, total: true }),
      ]}
    />
  );
}
