'use client';

// Approvals — what is waiting for a second pair of eyes, and the rules that
// decide what needs one.

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Plus, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { approvals, type ApprovalDoc, type ApprovalRule, type ApproverRole } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const DOC_LABEL: Record<ApprovalDoc, string> = { invoice: 'Invoices', bill: 'Bills', journal: 'Manual journals', payment_batch: 'Payment batches' };
const ROLES: ApproverRole[] = ['admin', 'accountant', 'sales', 'staff'];
const href = (doc: ApprovalDoc, id: string) =>
  doc === 'invoice' ? `/sales/invoices/${id}` : doc === 'bill' ? `/purchases/bills/${id}`
    : doc === 'journal' ? '/accountant/journals' : '/purchases/payment-batches';

export default function ApprovalsPage() {
  const state = useApi(() => approvals.overview(), []);
  const refresh = () => void state.refetch();

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      refresh();
    } catch (e) {
      toast.error('Could not do that', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Invoices, bills, journals and payment batches a rule holds for approval. Whoever submits one cannot approve it."
      />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => (
          <div className="space-y-6">
            {d.pending.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="Nothing waiting"
                description={d.rules.some((r) => r.isActive) ? 'Everything submitted has been dealt with.' : 'No approval rules are on, so documents post straight away.'}
              />
            ) : (
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`}>Document</th>
                    <th className={`${th} text-left`}>Party</th>
                    <th className={`${th} text-left`}>Submitted by</th>
                    <th className={`${th} text-left`}>Approver</th>
                    <th className={`${th} text-right`}>Amount</th>
                    <th className="w-56" />
                  </tr>
                </thead>
                <tbody>
                  {d.pending.map((p) => (
                    <tr key={`${p.documentType}-${p.id}`} className="border-b last:border-0">
                      <td className="px-3 py-2 text-sm">
                        <Link href={href(p.documentType, p.id)} className="font-medium hover:underline">{p.number}</Link>
                        <Badge variant="outline" className="ml-2 text-[10px]">{p.documentType.replace('_', ' ')}</Badge>
                      </td>
                      <td className="px-3 py-2 text-sm">{p.partyName}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {p.submittedBy ?? '—'}
                        {p.submittedAt && <span className="block">{new Date(p.submittedAt).toLocaleString('en-IN')}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs capitalize">{p.approverRole ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-medium"><Money value={p.totalPaise} /></td>
                      <td className="px-3 py-2">
                        {p.canApprove ? (
                          <div className="flex justify-end gap-1.5">
                            <Button size="xs" variant="outline" className="gap-1" onClick={() => {
                              const reason = window.prompt(`Send ${p.number} back? Say what needs changing.`);
                              if (reason?.trim()) void act(() => approvals.reject(p.documentType, p.id, reason.trim()), `${p.number} sent back`);
                            }}>
                              <Undo2 className="size-3" /> Send back
                            </Button>
                            <Button size="xs" className="gap-1" onClick={() => void act(() => approvals.approve(p.documentType, p.id), p.documentType === 'payment_batch' ? `${p.number} released to the bank` : `${p.number} approved and posted`)}>
                              <CheckCircle2 className="size-3" /> Approve
                            </Button>
                          </div>
                        ) : (
                          <span className="block text-right text-xs text-muted-foreground">Not yours to approve</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            )}

            <Rules rules={d.rules} canEdit={d.canEditRules} onChanged={refresh} />
          </div>
        )}
      </AsyncPage>
    </>
  );
}

function Rules({ rules, canEdit, onChanged }: { rules: ApprovalRule[]; canEdit: boolean; onChanged: () => void }) {
  const [doc, setDoc] = useState<ApprovalDoc>('bill');
  const [threshold, setThreshold] = useState(1_00_000_00);
  const [role, setRole] = useState<ApproverRole>('accountant');

  const save = async (rule: Omit<ApprovalRule, 'id'> & { id?: string | null }, done: string) => {
    try {
      await approvals.saveRule(rule);
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error('Could not save the rule', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-sm font-semibold">Rules</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A document at or above the amount is saved as a draft and needs approval by the role before it posts; a
          manual journal is held out of the books until approved.
          Where several rules apply, the one with the highest amount decides.
        </p>
      </div>
      {rules.length > 0 && (
        <ReportTable>
          <thead>
            <tr className="border-b bg-muted/50">
              <th className={`${th} text-left`}>Documents</th>
              <th className={`${th} text-right`}>From</th>
              <th className={`${th} text-left`}>Approved by</th>
              <th className={`${th} text-left`}>On</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="px-3 py-2 text-sm">{DOC_LABEL[r.documentType]}</td>
                <td className="px-3 py-2 text-right"><Money value={r.thresholdPaise} /></td>
                <td className="px-3 py-2 text-sm capitalize">{r.approverRole}</td>
                <td className="px-3 py-2">
                  <Switch checked={r.isActive} disabled={!canEdit}
                    onCheckedChange={(v) => void save({ ...r, isActive: v }, v ? 'Rule on' : 'Rule off')} />
                </td>
                <td className="px-2 py-2">
                  {canEdit && (
                    <Button size="icon" variant="ghost" className="size-7" aria-label="Delete rule"
                      onClick={() => void approvals.deleteRule(r.id).then(() => { toast.success('Rule deleted'); onChanged(); })}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ReportTable>
      )}
      {canEdit && (
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="Documents">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={doc} onChange={(e) => setDoc(e.target.value as ApprovalDoc)}>
              <option value="bill">Bills</option>
              <option value="invoice">Invoices</option>
              <option value="journal">Manual journals</option>
              <option value="payment_batch">Payment batches</option>
            </select>
          </Field>
          <Field label="From amount"><MoneyInput valuePaise={threshold} onChangePaise={setThreshold} /></Field>
          <Field label="Approved by">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm capitalize" value={role} onChange={(e) => setRole(e.target.value as ApproverRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Button className="gap-1.5" onClick={() => void save({ documentType: doc, thresholdPaise: threshold, approverRole: role, isActive: true }, 'Rule added')}>
            <Plus className="size-4" /> Add rule
          </Button>
        </div>
      )}
    </Card>
  );
}
