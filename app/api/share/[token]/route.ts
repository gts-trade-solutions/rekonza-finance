import { db } from '@/lib/server/db';
import { route, notFound } from '@/lib/server/http';
import { openShareLink } from '@/lib/server/services/sharing';
import { invoiceDetail } from '@/lib/server/services/invoice-detail';
import { runDetail } from '@/lib/server/payroll/payroll';

// A shared invoice, for whoever holds the link: what is printed on it and no
// more. The ledger entry, the payments and the approval trail stay inside.

export const GET = route(
  async ({ params }) => {
    const opened = await openShareLink(db, params.token ?? '');
    if (!opened) throw notFound('This link has expired or been withdrawn. Ask the sender for a new one.');
    // A payslip: that one employee's line, and nothing about anyone else.
    if (opened.docType === 'payslip') {
      const run = await runDetail(db, opened.orgId, opened.docId);
      const line = run.lines.find((l) => l.employeeId === String(opened.subId));
      if (!line || run.status === 'draft') throw notFound('This payslip is no longer available.');
      return { kind: 'payslip', run: { ...run, lines: [{ ...line, bankAccountNo: line.bankAccountNo ? `XXXX${line.bankAccountNo.slice(-4)}` : null }] } };
    }
    const inv = await invoiceDetail(opened.orgId, opened.docId);
    if (inv.status === 'draft' || inv.status === 'void') throw notFound('This invoice is no longer available.');
    const shown: Partial<typeof inv> = { ...inv };
    for (const inside of ['journalLines', 'journalEntryId', 'payments', 'approval'] as const) delete shown[inside];
    return { kind: 'invoice', ...shown };
  },
  { public: true },
);
