'use client';

// One invoice, from the database.
//
// The Journal tab is the point of this screen. Any package can show a document;
// showing the exact double-entry it produced is what lets an accountant trust
// the rest of the app — and it is the same rows the trial balance is built
// from, not a rendering of what they ought to be.

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Ban, ChevronDown, FileText, Loader2, MoreHorizontal, Pencil, Printer, Receipt, Sparkles, Trash2, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { Attachments } from '@/components/shared/attachments';
import { CustomFieldsPanel } from '@/components/shared/custom-fields-panel';
import { TagsPanel } from '@/components/shared/tags-panel';
import { ActivityPanel } from '@/components/shared/activity-panel';
import { ApprovalBar } from '@/components/shared/approval-bar';
import { Field } from '@/components/shared/form-bits';
import { CancelEinvoiceDialog } from '@/components/gst/cancel-einvoice-dialog';
import { EinvoicePanel } from '@/components/gst/einvoice-panel';
import { usePermission } from '@/lib/store/hooks';
import { invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';
import { VoidedNote } from '@/components/shared/voided-note';
import { InvoiceSendMenu, InvoiceShare, invoiceIsSent } from '@/components/sales/invoice-send-share';
import { InvoiceDocument, invoiceFormat, invoiceModel } from '@/components/print/invoice-print';
import { ribbonFor } from '@/components/print/zoho-sheet';
import { refreshSplitList } from '@/components/shared/record-split';
import { TemplatePreview } from '@/components/settings/template-gallery';
import { DEFAULT_TEMPLATE, INVOICE_FORMAT_LABEL, layoutForInvoice, templateInfo, templatesOf, type TemplateKey } from '@/lib/print-template';

/** A draft paid is marked as sent first (Zoho's "Invoice status will be changed to 'Sent'"); this browser can skip the warning. */
const SKIP_PAY_WARNING = 'rekonza-skip-draft-payment-warning';
const paymentHref = (inv: InvoiceDetail) => `/sales/payments/new?customer=${inv.customer.id}&invoice=${inv.id}`;

const d = (s: string) =>
  new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const canCreate = usePermission('sales', 'create');
  const router = useRouter();
  const canEdit = usePermission('sales', 'edit');
  const canVoid = usePermission('sales', 'void');
  const canFileGst = usePermission('gst', 'approve');

  const state = useApi<InvoiceDetail>(() => invoiceApi.get(params.id), [params.id]);

  const send = useApiAction(invoiceApi.send);
  const voidIt = useApiAction(invoiceApi.void);
  const [voiding, setVoiding] = useState(false);
  const [cancellingIrn, setCancellingIrn] = useState(false);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const removeIt = useApiAction(invoiceApi.remove);
  const [tab, setTab] = useState('journal');
  const [sendMode, setSendMode] = useState<null | 'now' | 'schedule'>(null);
  // Arrived from the form's Save and Send ▾: Save and Send Later opens Schedule Email, Save and Share opens Share.
  const arrived = useSearchParams();
  const openShare = arrived.get('share') === '1';
  useEffect(() => { if (arrived.get('schedule') === '1') setSendMode('schedule'); }, [arrived]);
  const [payWarning, setPayWarning] = useState(false);
  const [skipPayWarning, setSkipPayWarning] = useState(false);
  // Mark as sent: the ⋯ item, and the first step of Send, Share and paying a draft.
  const markSentFor = async (id: string) => {
    if (await send.run(id)) { await state.refetch(); return true; }
    toast.error('Not marked as sent', { description: send.error ?? undefined });
    return false;
  };
  const payDraft = async (inv: InvoiceDetail) => {
    if (await markSentFor(inv.id)) router.push(paymentHref(inv));
  };

  return (
    <AsyncPage state={state}>
      {(inv) => {
        const balanced =
          inv.journalLines.reduce((t, l) => t + l.debitPaise, 0) ===
          inv.journalLines.reduce((t, l) => t + l.creditPaise, 0);
        // A registered invoice is reversed through the portal, never around it:
        // cancel the IRN while the 24-hour window is open, a credit note after.
        const irnLive = inv.einvoice.status === 'submitted';
        const cancelUntil = inv.einvoice.cancelUntil ?? null;
        const markSent = () => markSentFor(inv.id);

        return (
          <>
            <PageHeader
              title={inv.number}
              description={`${inv.debitNote ? `Debit note${inv.debitNote.against ? ` against ${inv.debitNote.against.number}` : ''} · ` : inv.paidAtSale ? 'Sales receipt · paid at the time of sale · ' : ''}${inv.customer.name} · raised ${d(inv.date)}, due ${d(inv.dueDate)}`}
              actions={
                <>
                  {canEdit && inv.status !== 'void' && !irnLive && (
                    <Button variant="outline" size="sm" asChild className="gap-1.5">
                      <Link href={`/sales/invoices/${inv.id}/edit`} data-slot="edit-invoice"><Pencil className="size-3.5" /> Edit</Link>
                    </Button>
                  )}
                  {/* Zoho's bar: Edit · Send ▾ · Share · PDF/Print ▾ · Record Payment · ⋯ */}
                  <InvoiceSendMenu inv={inv} markSent={markSent} onChanged={() => void state.refetch()} mode={sendMode} setMode={setSendMode} />
                  <InvoiceShare inv={inv} markSent={markSent} onChanged={() => void state.refetch()} autoOpen={openShare} />
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent" data-slot="pdf-print">
                      <Printer className="size-3.5" /> PDF/Print <ChevronDown className="size-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => router.push(`/sales/invoices/${inv.id}/print?print=1`)}>PDF</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push(`/sales/invoices/${inv.id}/print?print=1`)} data-slot="print-link">Print</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push(`/sales/invoices/${inv.id}/print?as=delivery-note`)} data-slot="print-delivery-note">Print Delivery Note</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push(`/sales/invoices/${inv.id}/print?as=packing-slip`)} data-slot="print-packing-slip">Print Packing Slip</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {canCreate && inv.status !== 'void' && inv.balancePaise > 0 && (
                    invoiceIsSent(inv) ? (
                      <Button variant="outline" size="sm" asChild className="gap-1.5">
                        <Link href={paymentHref(inv)} data-slot="record-payment"><Wallet className="size-3.5" /> Record Payment</Link>
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="gap-1.5" data-slot="record-payment" onClick={() => {
                        // Zoho warns that a draft becomes Sent when it is paid; "Do not show this again" is kept in this browser.
                        if (localStorage.getItem(SKIP_PAY_WARNING) === '1') void payDraft(inv);
                        else setPayWarning(true);
                      }}><Wallet className="size-3.5" /> Record Payment</Button>
                    )
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label="More actions" data-slot="invoice-more" className="grid size-9 place-items-center rounded-[3px] border transition-colors hover:bg-accent">
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52">
                      {canEdit && !invoiceIsSent(inv) && inv.status !== 'void' && (
                        <DropdownMenuItem onClick={() => void markSent().then((ok) => { if (ok) toast.success(`${inv.number} marked as sent`); })} data-slot="mark-sent">Mark As Sent</DropdownMenuItem>
                      )}
                      {canCreate && !inv.debitNote && (
                        <DropdownMenuItem onClick={() => router.push(`/sales/recurring?invoice=${inv.id}`)} data-slot="make-recurring">Make Recurring</DropdownMenuItem>
                      )}
                      {canCreate && inv.status !== 'draft' && inv.status !== 'void' && !inv.debitNote && (
                        <DropdownMenuItem onClick={() => router.push(`/sales/credit-notes/new?invoice=${inv.id}`)} data-slot="create-credit-note">Create Credit Note</DropdownMenuItem>
                      )}
                      {canFileGst && inv.status !== 'draft' && inv.status !== 'void' && inv.supplyKind !== 'service' && (
                        <DropdownMenuItem onClick={() => router.push(`/gst/eway-bills?invoice=${inv.id}`)} data-slot="add-eway-bill">Add e-Way Bill Details</DropdownMenuItem>
                      )}
                      {canCreate && !inv.debitNote && (
                        <DropdownMenuItem onClick={() => router.push(`/sales/invoices/new?clone=${inv.id}`)} data-slot="clone-invoice">Clone</DropdownMenuItem>
                      )}
                      {canEdit && !irnLive && inv.status !== 'void' && (
                        <DropdownMenuItem onClick={() => setVoiding(true)} data-slot="void-invoice">Void</DropdownMenuItem>
                      )}
                      {inv.journalEntryId && (
                        <DropdownMenuItem onClick={() => { setTab('journal'); setTimeout(() => document.getElementById('invoice-tabs')?.scrollIntoView({ behavior: 'smooth' }), 50); }} data-slot="view-journal">View Journal</DropdownMenuItem>
                      )}
                      {canVoid && !irnLive && inv.amountPaidPaise === 0 && (
                        <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive focus:text-destructive" data-slot="delete-invoice">Delete</DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => router.push('/settings/preferences/invoices')} data-slot="invoice-preferences">Invoice Preferences</DropdownMenuItem>
                      {/* Rekonza's own, beyond Zoho's menu: the e-invoice and a bad debt. */}
                      {((irnLive && cancelUntil && canFileGst) || (canVoid && invoiceIsSent(inv) && inv.status !== 'void' && inv.balancePaise > 0)) && <DropdownMenuSeparator />}
                      {irnLive && cancelUntil && canFileGst && (
                        <DropdownMenuItem onClick={() => setCancellingIrn(true)} data-slot="cancel-einvoice-item">
                          <Ban className="mr-2 size-4" /> Cancel e-invoice
                        </DropdownMenuItem>
                      )}
                      {canVoid && invoiceIsSent(inv) && inv.status !== 'void' && inv.balancePaise > 0 && (
                        <DropdownMenuItem
                          onClick={async () => {
                            const why = window.prompt(
                              `Write off the ₹${(inv.balancePaise / 100).toLocaleString('en-IN')} still owed on ${inv.number} as a bad debt? ` +
                                'It is charged to Bad Debts Written Off and the invoice is closed. Give the reason.',
                            );
                            if (!why) return;
                            try {
                              await invoiceApi.writeOff(inv.id, why);
                              toast.success(`${inv.number} written off`);
                              await state.refetch();
                            } catch (e) {
                              toast.error('Not written off', { description: e instanceof Error ? e.message : String(e) });
                            }
                          }}
                        >
                          <Ban className="mr-2 size-4" /> Write off as bad debt
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />

            <Dialog open={payWarning} onOpenChange={setPayWarning}>
              <DialogContent className="sm:max-w-md" data-slot="draft-payment-warning">
                <DialogHeader>
                  <DialogTitle>Record Payment</DialogTitle>
                  <DialogDescription>Invoice status will be changed to &apos;Sent&apos; once the payment is recorded.</DialogDescription>
                </DialogHeader>
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked={skipPayWarning} onCheckedChange={(v) => setSkipPayWarning(v === true)} /> Do not show this again
                </label>
                <DialogFooter>
                  <Button onClick={() => { if (skipPayWarning) localStorage.setItem(SKIP_PAY_WARNING, '1'); setPayWarning(false); void payDraft(inv); }}>OK</Button>
                  <Button variant="outline" onClick={() => setPayWarning(false)}>Cancel</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <WhatsNext inv={inv} canCreate={canCreate} canEdit={canEdit} onSend={() => setSendMode('now')} onMarkSent={async () => {
              if (await send.run(inv.id)) {
                toast.success(`${inv.number} marked sent`);
                await state.refetch();
              } else if (send.error) toast.error(send.error);
            }} />

            <VoidedNote voided={inv.voided} what="invoice" />

            <EinvoicePanel inv={inv} onChanged={() => void state.refetch()} />

            <ApprovalBar
              doc="invoice" id={inv.id} number={inv.number} isDraft={inv.status === 'draft'}
              approval={inv.approval} onChanged={() => void state.refetch()}
            />

            {inv.payments.length > 0 && <PaymentsReceived inv={inv} />}

            <div className="rounded-[4px] bg-[#f6f7f9] px-2 py-6 dark:bg-muted/30 sm:px-8" data-slot="invoice-preview">
              <InvoiceDocument inv={inv} ribbon={ribbonFor(inv.status, inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'draft' && inv.balancePaise > 0 && inv.dueDate < new Date().toISOString().slice(0, 10))} />
              <TemplateLine inv={inv} canEdit={canEdit} onChanged={() => void state.refetch()} />
            </div>

            <CustomFieldsPanel entity="invoice" id={inv.id} canEdit={canEdit} />
            <TagsPanel entity="invoice" id={inv.id} canEdit={canEdit} />
            <Attachments targetType="invoice" targetId={inv.id} canEdit={canEdit} title="Signed copies, proof of delivery and other files" />

            <Tabs value={tab} onValueChange={setTab} id="invoice-tabs">
              <TabsList>
                <TabsTrigger value="journal">Journal</TabsTrigger>
                <TabsTrigger value="payments">Payments ({inv.payments.length})</TabsTrigger>
                <TabsTrigger value="activity">Comments &amp; History</TabsTrigger>
              </TabsList>

              <TabsContent value="activity" className="mt-4">
                <ActivityPanel targetType="invoice" targetId={inv.id} />
              </TabsContent>

              {/* ── The double entry behind it ─────────────────────────── */}
              <TabsContent value="journal" className="mt-4 space-y-3">
                {inv.journalEntryId ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Entry {inv.journalEntryId}. These are the rows the trial balance is built from —
                      not a rendering of what they ought to be.
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
                          {inv.journalLines.map((l) => (
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
                            <td className="px-4 py-3" colSpan={2}>{balanced ? 'Balanced' : 'OUT OF BALANCE'}</td>
                            <td className="px-4 py-3 text-right">
                              {formatINR(inv.journalLines.reduce((t, l) => t + l.debitPaise, 0))}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {formatINR(inv.journalLines.reduce((t, l) => t + l.creditPaise, 0))}
                            </td>
                          </tr>
                        </tbody>
                      </ReportTable>
                    </Card>
                  </>
                ) : (
                  <Card className="flex items-start gap-3 p-5">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Nothing has been posted. A draft is a document somebody is still writing, not a sale
                      that has happened — putting it in the ledger would overstate revenue and the GST that
                      follows from it.
                    </p>
                  </Card>
                )}
              </TabsContent>

              {/* ── Receipts against it ────────────────────────────────── */}
              <TabsContent value="payments" className="mt-4">
                {inv.payments.length === 0 ? (
                  <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
                    <Receipt className="size-4" /> Nothing received against this invoice yet.
                  </Card>
                ) : (
                  <Card className="overflow-hidden p-0">
                    <div className="divide-y">
                      {inv.payments.map((p) => (
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
                  <DialogTitle>Void {inv.number}?</DialogTitle>
                  <DialogDescription>
                    The invoice stays in the books and its journal entry is reversed rather than removed.
                    GST requires the number to remain accounted for — a gap in the series is a question at
                    assessment.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Reason" hint="Required. Kept on the invoice and in the audit trail">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raised in error" />
                </Field>
                {voidIt.error && <p className="text-sm text-destructive">{voidIt.error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setVoiding(false)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    disabled={voidIt.busy || reason.trim().length < 4}
                    onClick={async () => {
                      const ok = await voidIt.run(inv.id, reason.trim());
                      if (ok) {
                        toast.success(`${inv.number} voided`, {
                          description: 'A reversing entry has been posted.',
                        });
                        setVoiding(false);
                        await state.refetch();
                      }
                    }}
                    className="gap-1.5"
                  >
                    {voidIt.busy && <Loader2 className="size-3.5 animate-spin" />} Void invoice
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={deleting} onOpenChange={setDeleting}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete {inv.number}?</DialogTitle>
                  <DialogDescription>
                    The invoice is removed{inv.journalEntryId ? ' and its entry is reversed in the ledger' : ''}. Its number is
                    reported as cancelled in GSTR-1, and the audit trail keeps a copy of it as it was.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Reason" hint={inv.journalEntryId && inv.status !== 'void' ? 'Required. Kept with the reversing entry and the record of what was deleted' : 'Optional. Kept with the record of what was deleted'}>
                  <Input value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} placeholder="Raised in error" data-slot="delete-reason" />
                </Field>
                {removeIt.error && <p className="text-sm text-destructive" data-slot="delete-error">{removeIt.error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleting(false)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    disabled={removeIt.busy || (!!inv.journalEntryId && inv.status !== 'void' && deleteReason.trim().length < 4)}
                    data-slot="confirm-delete"
                    onClick={async () => {
                      const ok = await removeIt.run(inv.id, deleteReason.trim() || undefined);
                      if (ok) {
                        toast.success(`${inv.number} deleted`);
                        setDeleting(false);
                        refreshSplitList();
                        router.push(inv.docKind === 'debit_note' ? '/sales/debit-notes' : '/sales/invoices');
                      }
                    }}
                    className="gap-1.5"
                  >
                    {removeIt.busy && <Loader2 className="size-3.5 animate-spin" />} Delete
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <CancelEinvoiceDialog
              open={cancellingIrn}
              onOpenChange={setCancellingIrn}
              invoiceId={inv.id}
              number={inv.number}
              cancelUntil={cancelUntil}
              onCancelled={() => void state.refetch()}
            />
          </>
        );
      }}
    </AsyncPage>
  );
}

/** Zoho's "WHAT'S NEXT?" line: what to do with the invoice now. */
function WhatsNext({ inv, canCreate, canEdit, onSend, onMarkSent }: {
  inv: InvoiceDetail; canCreate: boolean; canEdit: boolean; onSend: () => void; onMarkSent: () => void;
}) {
  if (inv.status === 'void' || inv.balancePaise <= 0) return null;
  const draft = !invoiceIsSent(inv);
  const partly = !draft && inv.amountPaidPaise > 0;
  const text = draft
    ? 'Send this Invoice to your customer or mark it as Sent.'
    : partly
      ? 'Invoice has been partially paid. Record payment for it as soon as you receive the full payment.'
      : 'Invoice has been sent. Record payment for it as soon as you receive payment.';
  return (
    <Card className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-[13px]" data-slot="whats-next">
      <Sparkles className="size-4 text-primary" />
      <span className="font-semibold uppercase">What&apos;s next?</span>
      <span className="text-muted-foreground">{text}</span>
      <span className="ml-auto flex gap-2">
        {draft && canCreate && <Button size="sm" onClick={onSend} data-slot="whats-next-send">Send Invoice</Button>}
        {draft && canEdit && <Button size="sm" variant="outline" onClick={onMarkSent}>Mark As Sent</Button>}
        {!draft && canCreate && (
          <Button size="sm" asChild><Link href={`/sales/payments/new?customer=${inv.customer.id}&invoice=${inv.id}`}>Record Payment</Link></Button>
        )}
      </span>
    </Card>
  );
}

/** "Payments Received (n)", folded above the invoice as in Zoho. */
function PaymentsReceived({ inv }: { inv: InvoiceDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-0" data-slot="payments-received">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-5 py-3 text-left text-[13px] font-medium">
        <ChevronDown className={`size-4 transition-transform ${open ? '' : '-rotate-90'}`} /> Payments Received <span className="rounded-full bg-muted px-1.5 text-[11px]">{inv.payments.length}</span>
      </button>
      {open && (
        <div className="divide-y border-t text-[13px]">
          {inv.payments.map((p) => (
            <div key={p.id} className="flex items-center gap-4 px-5 py-2.5">
              <span className="w-28 text-muted-foreground">{d(p.date)}</span>
              <Link href={`/sales/payments/${p.id}`} className="text-link hover:underline">{p.number}</Link>
              <span className="uppercase text-muted-foreground">{p.mode}</span>
              <Money value={p.amountPaise} className="ml-auto font-medium" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** "PDF Template : 'Standard' Change" — the template this invoice prints in. */
function TemplateLine({ inv, canEdit, onChanged }: { inv: InvoiceDetail; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = inv.seller.template ?? DEFAULT_TEMPLATE;
  // Its format's template (goods, services or export) unless this invoice has one of its own.
  const format = invoiceFormat(inv);
  const current = layoutForInvoice(t, format, inv.printTemplate);
  const byDefault = layoutForInvoice(t, format);
  const choices = [...new Set([...templatesOf(t, 'invoice'), current])];
  const model = invoiceModel(inv, null);
  const choose = async (key: TemplateKey) => {
    setBusy(true);
    try {
      await invoiceApi.setTemplate(inv.id, key === byDefault ? null : key);
      toast.success(`${inv.number} prints in ${templateInfo(key).name}`);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error('Not changed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="mx-auto mt-3 max-w-[210mm] text-right text-[13px]" data-slot="pdf-template-line">
        <span className="text-muted-foreground" data-slot="invoice-format-name">{INVOICE_FORMAT_LABEL[format]} · </span>PDF Template : &apos;{templateInfo(current).name}&apos;{' '}
        {canEdit && <button type="button" className="text-link hover:underline" onClick={() => setOpen(true)} data-slot="pdf-template-change">Change</button>}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Choose a template for {inv.number}</DialogTitle>
            <DialogDescription>
              Only this invoice changes. The template for all invoices, and the rest of Zoho&apos;s twelve, are in{' '}
              <Link href="/settings/templates?doc=invoice" className="text-link hover:underline">Settings → PDF Templates</Link>.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[65vh] flex-wrap gap-5 overflow-y-auto">
            {choices.map((key) => (
              <button key={key} type="button" disabled={busy} onClick={() => void choose(key)}
                className={`w-[200px] border p-2 text-left transition-shadow hover:shadow-md ${key === current ? 'border-primary ring-2 ring-primary/30' : ''}`}
                data-slot={`choose-${key}`}>
                <TemplatePreview model={model} template={t} layout={key} width={182} />
                <p className="mt-1.5 text-[13px]">{templateInfo(key).name}{key === byDefault && <span className="text-muted-foreground"> · default</span>}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

