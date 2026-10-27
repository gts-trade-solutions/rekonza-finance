'use client';

// One bill, from the database.
//
// The Journal tab matters more here than on an invoice, because the buy side's
// entry is where input credit either becomes an asset or disappears into cost,
// and where reverse charge shows both halves. Seeing it is the only way to
// check that a blocked credit was actually blocked.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Ban, FileText, Loader2, MoreHorizontal, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReportTable } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { Attachments } from '@/components/shared/attachments';
import { ApprovalBar } from '@/components/shared/approval-bar';
import { Field } from '@/components/shared/form-bits';
import { usePermission } from '@/lib/store/hooks';
import { bills as billApi, orderFlow, type BillDetail } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { today } from '@/lib/selectors';
import { formatINR } from '@/lib/money';
import { stateTaxLabel } from '@/lib/tax/gst';
import { VoidedNote } from '@/components/shared/voided-note';

const d = (s: string) =>
  new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const ITC_LABEL: Record<string, string> = {
  eligible: 'Credit claimed',
  ineligible: 'Blocked — in cost',
  capital_goods: 'Capital goods',
};

/** How the bill compares with its order and receipt, and the way past a mismatch. */
function MatchCard({ bill, onAccepted }: { bill: BillDetail; onAccepted: () => void }) {
  const canApprove = usePermission('purchases', 'approve');
  const [busy, setBusy] = useState(false);
  const m = bill.match;
  if (m.status === 'not_required') return null;

  const accept = async () => {
    const reason = window.prompt('Why is this bill being accepted as it is? The reason stays on the bill.');
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await orderFlow.acceptBill(bill.id, reason.trim());
      toast.success('Accepted. The bill can now be paid.');
      onAccepted();
    } catch (e) {
      toast.error('Could not accept it', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const tone = m.status === 'exception' ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/30 bg-emerald-500/5';
  return (
    <Card className={`flex flex-wrap items-start gap-3 p-4 ${tone}`} data-slot="bill-match">
      {m.status === 'exception'
        ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        : <FileText className="mt-0.5 size-4 shrink-0 text-emerald-600" />}
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {m.status === 'exception' ? 'Held from payment: it does not match its order or receipt'
            : m.status === 'accepted' ? 'Accepted although it does not match'
            : m.grnId ? 'Matches its order and goods receipt' : 'Matches its order'}
        </p>
        {m.note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.note}</p>}
      </div>
      {m.status === 'exception' && canApprove && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void accept()}>Accept and allow payment</Button>
      )}
    </Card>
  );
}

export default function BillDetailPage() {
  const params = useParams<{ id: string }>();
  const canEdit = usePermission('purchases', 'edit');

  const state = useApi<BillDetail>(() => billApi.get(params.id), [params.id]);
  const voidIt = useApiAction(billApi.void);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <AsyncPage state={state}>
      {(bill) => {
        const dr = bill.journalLines.reduce((t, l) => t + l.debitPaise, 0);
        const cr = bill.journalLines.reduce((t, l) => t + l.creditPaise, 0);

        // Section 43B(h): an unpaid MSME supplier past 45 days makes the whole
        // expense disallowable, so this is a tax exposure, not a late payment.
        const age = Math.floor(
          (new Date(today()).getTime() - new Date(bill.date).getTime()) / 86_400_000,
        );
        const msmeRisk = bill.vendor.isMsme && bill.balancePaise > 0 && age >= 38;

        return (
          <>
            <PageHeader
              title={bill.internalNo}
              description={`${bill.vendor.name} · their invoice ${bill.vendorInvoiceNo} · dated ${d(bill.date)}`}
              actions={
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/purchases/bills"><ArrowLeft className="mr-1.5 size-3.5" /> Bills</Link>
                  </Button>
                  {canEdit && bill.status !== 'void' && (
                    <DropdownMenu>
                      <DropdownMenuTrigger aria-label="More actions" className="grid size-9 place-items-center rounded-[3px] border transition-colors hover:bg-accent">
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setVoiding(true)}>
                          <Ban className="mr-2 size-4" /> Void bill
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </>
              }
            />

            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={bill.status as never} />
              {bill.vendor.isMsme && <Badge variant="outline" className="text-[10px]">MSME supplier</Badge>}
              {bill.isRcm && <Badge variant="secondary" className="text-[10px]">Reverse charge</Badge>}
              {bill.tdsPaise > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  TDS {bill.tdsSection} · {formatINR(bill.tdsPaise)}
                </Badge>
              )}
              {bill.balancePaise > 0 && (
                <span className="text-sm text-muted-foreground">
                  <Money value={bill.balancePaise} className="font-medium text-foreground" /> outstanding
                </span>
              )}
            </div>

            <VoidedNote voided={bill.voided} what="bill" />

            {msmeRisk && (
              <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
                <div className="text-sm">
                  <p className="font-medium">
                    {age >= 45 ? 'Past the 45-day MSME limit' : `${45 - age} days left to pay this MSME supplier`}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Section 43B(h) (section 37(2)(g) of the Income-tax Act, 2025 from April 2026) disallows the
                    expense entirely if a registered micro or small supplier is not paid within 45 days. That is
                    not interest on a late payment — the deduction is lost for the year.
                  </p>
                </div>
              </Card>
            )}

            <MatchCard bill={bill} onAccepted={() => void state.refetch()} />

            <ApprovalBar
              doc="bill" id={bill.id} number={bill.internalNo} isDraft={bill.status === 'draft'}
              approval={bill.approval} onChanged={() => void state.refetch()}
            />

            <Tabs defaultValue="document">
              <TabsList>
                <TabsTrigger value="document">Document</TabsTrigger>
                <TabsTrigger value="journal">Journal</TabsTrigger>
                <TabsTrigger value="payments">Payments ({bill.payments.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="document" className="mt-4 space-y-4">
                <Card className="p-5">
                  <div className="grid gap-6 sm:grid-cols-2">
                    <div>
                      <p className="micro-label">Billed by</p>
                      <p className="mt-1 font-medium">{bill.vendor.name}</p>
                      {bill.vendor.address && (
                        <p className="mt-0.5 text-sm text-muted-foreground">{bill.vendor.address}</p>
                      )}
                      {bill.vendor.gstin && (
                        <p className="mt-1 font-mono text-xs text-muted-foreground">GSTIN {bill.vendor.gstin}</p>
                      )}
                    </div>
                    <div className="sm:text-right">
                      <p className="micro-label">Received at</p>
                      <p className="mt-1 font-medium">{bill.branch.name}</p>
                      {bill.branch.gstin && (
                        <p className="mt-1 font-mono text-xs text-muted-foreground">GSTIN {bill.branch.gstin}</p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">Due {d(bill.dueDate)}</p>
                    </div>
                  </div>
                </Card>

                <Card className="overflow-hidden p-0">
                  <ReportTable>
                    <thead>
                      <tr className="border-b bg-muted/50 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        <th className="px-4 py-2.5 text-left">Item</th>
                        <th className="px-4 py-2.5 text-left">HSN/SAC</th>
                        <th className="px-4 py-2.5 text-right">Qty</th>
                        <th className="px-4 py-2.5 text-right">Rate</th>
                        <th className="px-4 py-2.5 text-right">Taxable</th>
                        <th className="px-4 py-2.5 text-left">Input credit</th>
                        <th className="px-4 py-2.5 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bill.lines.map((l) => (
                        <tr key={l.id} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            {l.description ?? '—'}
                            {l.accountName && (
                              <span className="ml-2 text-xs text-muted-foreground">{l.accountName}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{l.hsnSac ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular">{l.qty} {l.uqc}</td>
                          <td className="px-4 py-2.5 text-right"><Money value={l.ratePaise} /></td>
                          <td className="px-4 py-2.5 text-right"><Money value={l.taxablePaise} /></td>
                          <td className="px-4 py-2.5">
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${l.itcEligibility === 'ineligible' ? 'border-amber-500/40 text-amber-600 dark:text-amber-400' : ''}`}
                            >
                              {ITC_LABEL[l.itcEligibility] ?? l.itcEligibility}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium"><Money value={l.totalPaise} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </ReportTable>
                </Card>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Card className="p-5">
                    {bill.notes ? (
                      <>
                        <p className="micro-label">Notes</p>
                        <p className="mt-1 text-sm text-muted-foreground">{bill.notes}</p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">No notes on this bill.</p>
                    )}
                    {bill.isRcm && (
                      <p className="mt-4 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
                        Under reverse charge the supplier does not charge GST — we owe it directly, in cash. The entry
                        posts the liability, and the credit against it where the purchase is eligible for credit.
                        {bill.selfInvoiceNo && (
                          <> Our self-invoice for it is{' '}
                            <Link href={`/purchases/bills/${bill.id}/self-invoice`} className="font-medium text-primary hover:underline">{bill.selfInvoiceNo}</Link>.
                          </>
                        )}
                      </p>
                    )}
                  </Card>

                  <Card className="p-5">
                    <dl className="space-y-2 text-sm">
                      {[
                        ['Taxable value', bill.subtotalPaise],
                        ...(bill.tax.cgstPaise ? [['CGST', bill.tax.cgstPaise] as const] : []),
                        ...(bill.tax.sgstPaise ? [[stateTaxLabel(bill.placeOfSupply), bill.tax.sgstPaise] as const] : []),
                        ...(bill.tax.igstPaise ? [['IGST', bill.tax.igstPaise] as const] : []),
                      ].map(([label, value]) => (
                        <div key={String(label)} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd><Money value={value as number} /></dd>
                        </div>
                      ))}
                      {bill.tdsPaise > 0 && (
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Less TDS {bill.tdsSection && `(${bill.tdsSection})`}
                          </dt>
                          <dd className="text-muted-foreground">− <Money value={bill.tdsPaise} /></dd>
                        </div>
                      )}
                      <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
                        <dt>Payable to vendor</dt>
                        <dd><Money value={bill.totalPaise} /></dd>
                      </div>
                      {bill.amountPaidPaise > 0 && (
                        <>
                          <div className="flex justify-between gap-4">
                            <dt className="text-muted-foreground">Paid</dt>
                            <dd className="text-emerald-600 dark:text-emerald-400">
                              <Money value={bill.amountPaidPaise} />
                            </dd>
                          </div>
                          <div className="flex justify-between gap-4 font-medium">
                            <dt>Balance due</dt>
                            <dd><Money value={bill.balancePaise} /></dd>
                          </div>
                        </>
                      )}
                    </dl>
                  </Card>
                </div>

                <Attachments targetType="bill" targetId={bill.id} canEdit={canEdit} title="Supplier's bill and other files" />
              </TabsContent>

              <TabsContent value="journal" className="mt-4 space-y-3">
                {bill.journalEntryId ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Entry {bill.journalEntryId}. Input credit appears as an asset only where it is
                      claimable — a blocked credit is folded into the cost instead, and you can see which
                      happened here.
                    </p>
                    <Card className="overflow-hidden p-0">
                      <ReportTable>
                        <thead>
                          <tr className="border-b bg-muted/50 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            <th className="px-4 py-2.5 text-left">Account</th>
                            <th className="px-4 py-2.5 text-left">Description</th>
                            <th className="px-4 py-2.5 text-right">Debit</th>
                            <th className="px-4 py-2.5 text-right">Credit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bill.journalLines.map((l) => (
                            <tr key={l.lineNo} className="border-b last:border-0">
                              <td className="px-4 py-2.5">
                                <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span>{' '}
                                {l.accountName}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground">{l.description ?? '—'}</td>
                              <td className="px-4 py-2.5 text-right"><Money value={l.debitPaise} showZero={false} /></td>
                              <td className="px-4 py-2.5 text-right"><Money value={l.creditPaise} showZero={false} /></td>
                            </tr>
                          ))}
                          <tr className="border-t-2 bg-muted/40 font-semibold">
                            <td className="px-4 py-3" colSpan={2}>{dr === cr ? 'Balanced' : 'OUT OF BALANCE'}</td>
                            <td className="px-4 py-3 text-right">{formatINR(dr)}</td>
                            <td className="px-4 py-3 text-right">{formatINR(cr)}</td>
                          </tr>
                        </tbody>
                      </ReportTable>
                    </Card>
                  </>
                ) : (
                  <Card className="flex items-start gap-3 p-5">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Nothing posted — this bill is still a draft.</p>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="payments" className="mt-4">
                {bill.payments.length === 0 ? (
                  <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
                    <Receipt className="size-4" /> Nothing paid against this bill yet.
                  </Card>
                ) : (
                  <Card className="overflow-hidden p-0">
                    <div className="divide-y">
                      {bill.payments.map((p) => (
                        <div key={p.id} className="flex items-center gap-4 p-4">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium">{p.number}</p>
                            <p className="text-xs text-muted-foreground">
                              {d(p.date)} · <span className="uppercase">{p.mode}</span>
                            </p>
                          </div>
                          <Money value={p.amountPaise} className="font-medium" />
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </TabsContent>
            </Tabs>

            <Dialog open={voiding} onOpenChange={setVoiding}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Void {bill.internalNo}?</DialogTitle>
                  <DialogDescription>
                    The bill stays in the books and its journal entry is reversed rather than removed, so any
                    input credit already claimed is reversed with it.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Reason" hint="Required. Kept on the bill and in the audit trail">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate entry" />
                </Field>
                {voidIt.error && <p className="text-sm text-destructive">{voidIt.error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setVoiding(false)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    disabled={voidIt.busy || reason.trim().length < 4}
                    onClick={async () => {
                      if (await voidIt.run(bill.id, reason.trim())) {
                        toast.success(`${bill.internalNo} voided`, {
                          description: 'A reversing entry has been posted.',
                        });
                        setVoiding(false);
                        await state.refetch();
                      }
                    }}
                    className="gap-1.5"
                  >
                    {voidIt.busy && <Loader2 className="size-3.5 animate-spin" />} Void bill
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        );
      }}
    </AsyncPage>
  );
}
