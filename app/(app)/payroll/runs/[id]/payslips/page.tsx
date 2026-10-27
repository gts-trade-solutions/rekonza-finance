'use client';

// Payslips for a month, one to a printed page: earnings, deductions, the
// employer's own contributions, and the net pay in words.

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';
import type { Run } from '../page';
import { Payslip, monthName } from '@/components/payroll/payslip';
import { printPage } from '@/lib/output-guard';

export default function PayslipsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const state = useApi<Run>(() => api.get(`/api/payroll/runs/${id}`), [id]);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
      {(run) => (
        <div className="space-y-4">
          <div className="flex items-center gap-2 no-print">
            <Link href={`/payroll/runs/${run.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'gap-1.5')}><ArrowLeft className="size-3.5" /> Back</Link>
            <span className="text-sm text-muted-foreground">{run.lines.length} payslip(s) for {monthName(run.month)}{run.status === 'draft' ? ' · draft, not final' : ''}</span>
            <Button size="sm" className="ml-auto gap-1.5" onClick={() => printPage()}><Printer className="size-3.5" /> Print</Button>
          </div>
          {run.lines.map((l, i) => <Payslip key={l.employeeId} run={run} l={l} last={i === run.lines.length - 1} />)}
        </div>
      )}
    </AsyncPage>
  );
}
