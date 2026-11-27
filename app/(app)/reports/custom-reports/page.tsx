'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Reports → Custom Reports: every report saved from Customize Report, with its
// period and filters — yours, and those others shared with the company. Open
// runs it; Edit renames it or shares or unshares it (and its filters are
// changed from the report itself, "Update saved report"); Delete removes it.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, FileBarChart, Lock, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { DeleteButton, EditButton, useConfirmDelete } from '@/components/shared/row-actions';
import { REPORT_PATH, REPORT_TITLE } from '@/components/reports/customize-report';
import { customReports, type SavedCustomReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const describe = (r: SavedCustomReport) => {
  const f = r.spec.filter ?? {};
  const bits = [
    r.spec.report === 'balance-sheet' || r.spec.report === 'trial-balance' ? `as of ${r.spec.to}` : `${r.spec.from} to ${r.spec.to}`,
    r.spec.reportBy && r.spec.reportBy !== 'total' ? `by ${r.spec.reportBy}` : '',
    r.spec.compareMode && r.spec.compareMode !== 'none' ? `compared with ${r.spec.compareCount ?? 1} previous ${r.spec.compareMode === 'previous_year' ? 'year(s)' : 'period(s)'}` : '',
    f.contactIds?.length ? `${f.contactIds.length} customer/vendor` : '', f.costCentreIds?.length ? `${f.costCentreIds.length} cost centre` : '',
    f.projectIds?.length ? `${f.projectIds.length} project` : '', f.tagOptionIds?.length ? `${f.tagOptionIds.length} tag value` : '',
    f.accountIds?.length ? `${f.accountIds.length} account` : '', f.accountTypes?.length ? f.accountTypes.join(', ') : '', f.branchId ? 'one branch' : '',
  ].filter(Boolean);
  return bits.join(' · ');
};

export default function CustomReportsPage() {
  const state = useApi(() => customReports.list(), []);
  const del = useConfirmDelete();
  const [editing, setEditing] = useState<SavedCustomReport | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await customReports.update(editing.id, { name: name.trim(), shared });
      toast.success(`Custom report "${name.trim()}" saved`);
      setEditing(null);
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit gap-1.5"><Link href="/reports"><ArrowLeft className="size-3.5" /> All reports</Link></Button>
      <PageHeader title="Custom Reports" description="Reports saved from Customize Report with their period and filters: yours, and those shared with the company." />
      <AsyncPage state={state}>
        {(d) => d.reports.length === 0 ? (
          <EmptyState icon={FileBarChart} title="No custom reports yet"
            description="Open the Profit and Loss, Balance Sheet, Trial Balance, General Ledger, Account Transactions or Cash Flow, click Customize Report, choose the filters, and use Save as custom report. It appears here." />
        ) : (
          <Card className="gap-0 overflow-hidden p-0">
            <table className="w-full text-sm" data-slot="custom-reports-list">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-semibold">Name</th><th className="px-4 py-2.5 font-semibold">Report</th>
                  <th className="px-4 py-2.5 font-semibold">Settings</th><th className="px-4 py-2.5 font-semibold">Who sees it</th><th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {d.reports.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40" data-slot="custom-report-row">
                    <td className="px-4 py-2.5 font-medium"><Link href={`${REPORT_PATH[r.report]}?custom=${r.id}`} className="hover:underline">{r.name}</Link></td>
                    <td className="px-4 py-2.5">{REPORT_TITLE[r.report]}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{describe(r)}</td>
                    <td className="px-4 py-2.5">
                      {r.shared ? <Badge variant="outline" className="gap-1 text-[10px]"><Users className="size-2.5" /> Shared{r.mine ? '' : ` by ${r.owner ?? 'someone'}`}</Badge>
                        : <Badge variant="outline" className="gap-1 text-[10px]"><Lock className="size-2.5" /> Only me</Badge>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button size="xs" variant="outline" asChild><Link href={`${REPORT_PATH[r.report]}?custom=${r.id}`} data-slot="custom-report-open">Open</Link></Button>
                        {r.mine && <EditButton slot="custom-report-edit" onClick={() => { setEditing(r); setName(r.name); setShared(r.shared); }} />}
                        {r.mine && <DeleteButton slot="custom-report-delete" onClick={() => del.ask({
                          title: `Delete the custom report "${r.name}"?`, description: 'Only the saved settings go; the books do not change.',
                          run: (reason) => customReports.remove(r.id, reason), done: `Deleted ${r.name}`, onDone: () => state.refetch(),
                        })} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </AsyncPage>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent data-slot="custom-report-edit-dialog">
          <DialogHeader>
            <DialogTitle>Edit custom report</DialogTitle>
            <DialogDescription>Rename it, or share it with the company. To change its filters, open it, click Edit filters, and choose Update saved report.</DialogDescription>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-slot="custom-report-name" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone in the company</label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!name.trim()} onClick={() => void saveEdit()} data-slot="custom-report-save">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {del.dialog}
    </>
  );
}
