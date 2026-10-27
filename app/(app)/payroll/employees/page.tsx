'use client';

// Employees: who is on the payroll, what they are paid, and which statutory
// schemes apply to them. Salaries are confidential; this page and its API are
// open only to roles with payroll rights.

import { useState } from 'react';
import { UserPlus, Users, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { EmployeeDialog, type EmployeeRow } from '@/components/payroll/employee-dialog';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { formatINRCompact } from '@/lib/money';

const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function EmployeesPage() {
  const state = useApi<{ employees: EmployeeRow[] }>(() => api.get('/api/payroll/employees'), []);
  const canEdit = usePermission('payroll', 'edit');
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [adding, setAdding] = useState(false);

  const cols: Column<EmployeeRow>[] = [
    { key: 'code', header: 'Code', sortValue: (r) => r.code, cell: (r) => <span className="font-mono text-xs">{r.code}</span> },
    {
      key: 'name', header: 'Employee', sortValue: (r) => r.name,
      cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{[r.designation, r.department].filter(Boolean).join(' · ') || '—'}</p></div>,
    },
    { key: 'branch', header: 'Works at', sortValue: (r) => r.branchName, cell: (r) => <span className="text-xs">{r.branchName}</span> },
    { key: 'joined', header: 'Joined', sortValue: (r) => r.dateOfJoining, cell: (r) => <span className="text-xs">{fmt(r.dateOfJoining)}</span> },
    {
      key: 'schemes', header: 'Schemes', cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.pfMember && <Badge variant="outline" className="text-[10px]">PF</Badge>}
          {r.monthlyGrossPaise > 0 && r.monthlyGrossPaise <= (r.disabled ? 25_000_00 : 21_000_00) && <Badge variant="outline" className="text-[10px]">ESI</Badge>}
          <Badge variant="secondary" className="text-[10px]">{r.taxRegime === 'new' ? 'New regime' : 'Old regime'}</Badge>
          {!r.pan && <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">No PAN</Badge>}
          {!r.bankAccountNo && <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">No bank</Badge>}
        </div>
      ),
    },
    {
      key: 'status', header: 'Status', sortValue: (r) => (r.dateOfLeaving && r.dateOfLeaving < today() ? 1 : 0),
      cell: (r) => (r.dateOfLeaving && r.dateOfLeaving < today()
        ? <span className="text-xs text-muted-foreground">Left {fmt(r.dateOfLeaving)}</span>
        : <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300">Active</Badge>),
    },
    { key: 'gross', header: 'Monthly gross', align: 'right', sortValue: (r) => r.monthlyGrossPaise, cell: (r) => <Money value={r.monthlyGrossPaise} /> },
  ];

  return (
    <>
      <PageHeader
        title="Employees"
        description="Who is on the payroll, their salary structure, and how PF, ESI, professional tax and TDS apply to them."
        actions={canEdit && <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><UserPlus className="size-4" /> Add employee</Button>}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const active = d.employees.filter((e) => !e.dateOfLeaving || e.dateOfLeaving >= today());
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label="On the payroll" value={String(active.length)} sub={`${d.employees.length - active.length} left`} icon={Users} />
                <StatTile label="Monthly gross" value={formatINRCompact(active.reduce((t, e) => t + e.monthlyGrossPaise, 0))} sub="At current salaries" icon={Wallet} />
                <StatTile label="Missing details" value={String(active.filter((e) => !e.pan || !e.bankAccountNo || (e.pfMember && !e.uan)).length)}
                  sub="PAN, UAN or bank account" tone={active.some((e) => !e.pan || !e.bankAccountNo) ? 'warning' : 'default'} />
              </div>
              <DataTable rows={d.employees} columns={cols} getRowId={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r) : undefined}
                searchPlaceholder="Search name, code, designation…" emptyMessage="No employees yet. Add the first to run payroll." />
            </>
          );
        }}
      </AsyncPage>
      <EmployeeDialog open={adding || !!editing} employee={editing} onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); void state.refetch(); }} />
    </>
  );
}
