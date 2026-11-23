'use client';

// One quote, sales order, delivery challan or credit note, beside its list in
// Zoho Books' split view (recorded from Zoho's demo on 2026-11-23):
//
// - the action bar: Edit · Mails/Send Email/Email · Share · PDF/Print ▾ ·
//   Convert ▾ (a quote) · ⋯ with Zoho's own items for each, and Rekonza's own
//   steps where Zoho has none (an order's proforma and stages, a challan's
//   return, a credit note's refund and apply);
// - "WHAT'S NEXT?" with the buttons Zoho offers at that status;
// - "<Noun> Details | Activity", and the Details/PDF switch: the details grid,
//   the customer, the items and the totals, or the printed copy itself.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  ArrowRightLeft, ChevronDown, Copy, FileText, Loader2, Mail, MoreHorizontal, Pencil, Printer, Share2, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { Attachments } from '@/components/shared/attachments';
import { ActivityPanel } from '@/components/shared/activity-panel';
import { Field } from '@/components/shared/form-bits';
import { LinePickDialog } from '@/components/shared/line-pick-dialog';
import { DeleteDocumentDialog, useDocumentActions } from '@/components/shared/document-menu';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { DocumentSheet } from '@/components/print/document-print';
import { ribbonFor } from '@/components/print/zoho-sheet';
import { ApplyDialog, RefundDialog, VoidCreditNoteDialog, type CreditNoteRef } from './credit-note-dialogs';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { localDay } from '@/lib/selectors';
import { useApi } from '@/lib/api/use-api';
import { api, journal, orderFlow, salesDocuments, type AttachableType, type EditableSalesDoc } from '@/lib/api/client';
import { GST_STATES } from '@/lib/tax/gst';
import { formatINR } from '@/lib/money';
import type { PrintDoc } from '@/lib/print-doc';
import { ATTACH_TARGET, SALES_DOC, challanTypeLabel, zohoDay, zohoStatus, type SalesDocKindZ } from './sales-docs';

const today = () => localDay(new Date());
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
const STAGE_LABEL: Record<string, string> = { order: 'Order received', proforma: 'Proforma sent', in_process: 'Work in process', ready: 'Ready for delivery' };

/** The bar's buttons, laid flat as Zoho's are. */
const barButton = 'inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent disabled:opacity-50';

export function SalesDocRecordView({ kind }: { kind: SalesDocKindZ }) {
  const { id } = useParams<{ id: string }>();
  const state = useApi<EditableSalesDoc>(() => salesDocuments.getOne(kind, id), [kind, id]);
  const print = useApi<PrintDoc>(() => api.get<PrintDoc>(`/api/print/${kind}/${id}`), [kind, id]);
  const reload = () => { void state.refetch(); void print.refetch(); refreshSplitList(); };
  useSplitRecordRefresh(reload);
  return (
    <AsyncPage state={state}>
      {(doc) => <Record kind={kind} doc={doc} printDoc={print.data ?? null} reload={reload} />}
    </AsyncPage>
  );
}

function Record({ kind, doc, printDoc, reload }: { kind: SalesDocKindZ; doc: EditableSalesDoc; printDoc: PrintDoc | null; reload: () => void }) {
  const info = SALES_DOC[kind];
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  const canVoid = usePermission('sales', 'void');
  const send = useDocumentActions(kind, doc.id, reload);
  const z = zohoStatus(kind, doc);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'details' | 'pdf'>(kind === 'estimate' ? 'details' : 'pdf');
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [viewingJournal, setViewingJournal] = useState(false);
  const [step, setStep] = useState<null | 'so-invoice' | 'so-challan' | 'challan-invoice'>(null);
  const [readying, setReadying] = useState(false);
  const [cnDialog, setCnDialog] = useState<null | 'apply' | 'refund' | 'void'>(null);
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState(plusDays(30));

  const run = async (what: () => Promise<unknown>, ok: string, then?: (r: never) => void) => {
    setBusy(true);
    try {
      const r = await what();
      toast.success(ok);
      if (then) then(r as never); else reload();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (to: string, word: string) => run(() => salesDocuments.setStatus(kind, doc.id, to), `${doc.number} ${word}`);

  // A quote becomes a draft invoice (to check and send) or a sales order.
  const toInvoice = () => run(
    () => salesDocuments.convert('estimate', doc.id, today(), plusDays(30), 'draft'),
    `Draft invoice made from ${doc.number}`,
    (r: { invoiceId: string }) => router.push(`/sales/invoices/${r.invoiceId}`),
  );
  const toOrder = () => run(
    () => salesDocuments.toOrder(doc.id, today()),
    `Sales order made from ${doc.number}`,
    (r: { salesOrderId: string }) => router.push(`/sales/sales-orders/${r.salesOrderId}`),
  );
  const stage = (s: 'proforma' | 'in_process' | 'ready', on = today()) => run(
    () => orderFlow.stage(doc.id, s, on),
    s === 'proforma' ? 'Proforma invoice raised' : s === 'in_process' ? `${doc.number}: work in process` : `${doc.number} is ready for delivery`,
    (r: { invoice?: { id: string } | null }) => {
      setReadying(false);
      if (s === 'proforma') router.push(`/print/sales-order/${doc.id}?as=proforma`);
      else if (r.invoice) router.push(`/sales/invoices/${r.invoice.id}`);
      else reload();
    },
  );

  const editable = canEdit && (
    kind === 'estimate' ? doc.status !== 'converted'
    : kind === 'sales-order' ? doc.status !== 'cancelled' && !(doc.invoices?.length)
    : kind === 'challan' ? (doc.status === 'draft' || doc.status === 'open') && !(doc.invoices?.length)
    : doc.status !== 'void');
  const clonable = canCreate;
  const deletable = canVoid;
  const cn: CreditNoteRef = {
    id: doc.id, number: doc.number, customerId: doc.customerId, customerName: doc.customerName ?? '',
    totalPaise: doc.totalPaise ?? 0, appliedPaise: doc.appliedPaise ?? 0,
  };
  const cnLeft = (doc.balancePaise ?? 0) > 0 && doc.status !== 'void';

  const sendLabel = kind === 'estimate' ? 'Mails' : kind === 'credit-note' ? 'Email' : 'Send Email';
  const emailNow = () => (send.mailReady ? send.emailNow() : send.mailApp());

  const actions = (
    <>
      {editable && (
        <Link href={`${info.base}/${doc.id}/edit`} className={barButton} data-slot="doc-edit"><Pencil className="size-3.5" /> Edit</Link>
      )}
      {kind !== 'challan' && send.canEmail && (
        kind === 'estimate' ? (
          <DropdownMenu onOpenChange={(o) => { if (o) send.checkMail(); }}>
            <DropdownMenuTrigger className={barButton} data-slot="doc-mails"><Mail className="size-3.5" /> {sendLabel} <ChevronDown className="size-3" /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void emailNow()} data-slot="doc-send-email">Send Email</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button type="button" className={barButton} disabled={send.busy} onClick={() => { send.checkMail(); void emailNow(); }} data-slot="doc-send-email">
            {send.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} {sendLabel}
          </button>
        )
      )}
      {kind === 'estimate' && send.canShare && (
        <button type="button" className={barButton} onClick={() => setSharing(true)} data-slot="doc-share"><Share2 className="size-3.5" /> Share</button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-slot="doc-pdf-print"><Printer className="size-3.5" /> PDF/Print <ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => router.push(`/print/${kind}/${doc.id}`)} data-slot="doc-pdf">PDF</DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/print/${kind}/${doc.id}?print=1`)} data-slot="doc-print">Print</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {kind === 'estimate' && canCreate && doc.status !== 'converted' && doc.status !== 'declined' && (
        <DropdownMenu>
          <DropdownMenuTrigger className={barButton} disabled={busy} data-slot="doc-convert"><ArrowRightLeft className="size-3.5" /> Convert <ChevronDown className="size-3" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void toInvoice()} data-slot="convert-invoice">Convert to Invoice</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void toOrder()} data-slot="convert-order">Convert to Sales Order</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More actions" className="grid size-8 place-items-center rounded-[3px] border transition-colors hover:bg-accent" disabled={busy} data-slot="doc-more">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {kind === 'estimate' && canEdit && (
            <>
              {doc.status === 'draft' && <DropdownMenuItem onClick={() => void setStatus('sent', 'marked as sent')} data-slot="mark-sent">Mark as Sent</DropdownMenuItem>}
              {doc.status !== 'converted' && doc.status !== 'accepted' && <DropdownMenuItem onClick={() => void setStatus('accepted', 'marked as accepted')} data-slot="mark-accepted">Mark as Accepted</DropdownMenuItem>}
              {doc.status !== 'converted' && doc.status !== 'declined' && <DropdownMenuItem onClick={() => void setStatus('declined', 'marked as declined')} data-slot="mark-declined">Mark as Declined</DropdownMenuItem>}
            </>
          )}
          {kind === 'sales-order' && canEdit && doc.status === 'draft' && (
            <DropdownMenuItem onClick={() => void setStatus('open', 'confirmed')} data-slot="mark-confirmed">Mark as Confirmed</DropdownMenuItem>
          )}
          {kind === 'sales-order' && canCreate && (doc.status === 'open' || doc.status === 'partially_invoiced') && (
            <>
              <DropdownMenuItem onClick={() => { setDate(today()); setDueDate(plusDays(30)); setStep('so-invoice'); }} data-slot="so-invoice">Convert to Invoice</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setDate(today()); setStep('so-challan'); }} data-slot="so-challan">Create Delivery Challan</DropdownMenuItem>
              <DropdownMenuSeparator />
              {(doc.stage ?? 'order') === 'order' && <DropdownMenuItem onClick={() => void stage('proforma')} data-slot="so-proforma">Raise Proforma Invoice</DropdownMenuItem>}
              {doc.stage !== 'in_process' && doc.stage !== 'ready' && <DropdownMenuItem onClick={() => void stage('in_process')} data-slot="so-in-process">Mark as Work in Process</DropdownMenuItem>}
              {doc.stage !== 'ready' && <DropdownMenuItem onClick={() => { setDate(today()); setReadying(true); }} data-slot="so-ready">Mark as Ready for Delivery</DropdownMenuItem>}
            </>
          )}
          {kind === 'challan' && canEdit && doc.status === 'draft' && (
            <DropdownMenuItem onClick={() => void setStatus('open', 'marked as open')} data-slot="mark-open">Mark as Open</DropdownMenuItem>
          )}
          {kind === 'challan' && canCreate && doc.challanType !== 'job_work' && (doc.status === 'open' || doc.status === 'partially_invoiced') && (
            <DropdownMenuItem onClick={() => { setDate(today()); setDueDate(plusDays(30)); setStep('challan-invoice'); }} data-slot="challan-invoice">Convert to Invoice</DropdownMenuItem>
          )}
          {kind === 'challan' && canEdit && doc.status === 'open' && (
            <DropdownMenuItem onClick={() => void setStatus('returned', 'marked as returned')} data-slot="mark-returned">Mark as Returned</DropdownMenuItem>
          )}
          {kind === 'credit-note' && canCreate && cnLeft && (
            <>
              <DropdownMenuItem onClick={() => setCnDialog('apply')} data-slot="cn-apply">Apply to Invoices</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCnDialog('refund')} data-slot="cn-refund">Refund</DropdownMenuItem>
            </>
          )}
          {clonable && <DropdownMenuItem onClick={() => router.push(`${info.base}/new?clone=${doc.id}`)} data-slot="doc-clone"><Copy className="mr-2 size-4" /> Clone</DropdownMenuItem>}
          {kind === 'credit-note' && doc.journalEntryId && (
            <DropdownMenuItem onClick={() => setViewingJournal(true)} data-slot="cn-journal"><FileText className="mr-2 size-4" /> View Journal</DropdownMenuItem>
          )}
          {kind === 'sales-order' && canVoid && doc.status !== 'cancelled' && doc.status !== 'invoiced' && (
            <DropdownMenuItem onClick={() => { if (window.confirm(`Void ${doc.number}? Nothing more is delivered or invoiced against it.`)) void setStatus('cancelled', 'voided'); }} data-slot="so-void">Void</DropdownMenuItem>
          )}
          {kind === 'credit-note' && canVoid && doc.status !== 'void' && doc.status !== 'refunded' && (
            <DropdownMenuItem onClick={() => setCnDialog('void')} data-slot="cn-void">Void</DropdownMenuItem>
          )}
          {deletable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive focus:text-destructive" data-slot="doc-delete">Delete</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <PageHeader title={doc.number} actions={actions} />

      {kind !== 'estimate' && doc.createdByName && (
        <p className="text-[13px] text-muted-foreground" data-slot="submitted-by">
          Submitted by: <span className="rounded-full border px-2 py-0.5 text-foreground">{doc.createdByName}</span>
        </p>
      )}

      <WhatsNext kind={kind} doc={doc} z={z} busy={busy} canCreate={canCreate} canEdit={canEdit}
        onSend={() => { send.checkMail(); void emailNow(); }} onMarkSent={() => void setStatus('sent', 'marked as sent')}
        onToInvoice={() => void toInvoice()} onToOrder={() => void toOrder()}
        onConfirm={() => void setStatus('open', 'confirmed')} onOpen={() => void setStatus('open', 'marked as open')}
        onSoInvoice={() => { setDate(today()); setDueDate(plusDays(30)); setStep('so-invoice'); }}
        onSoChallan={() => { setDate(today()); setStep('so-challan'); }}
        onChallanInvoice={() => { setDate(today()); setDueDate(plusDays(30)); setStep('challan-invoice'); }}
        onApply={() => setCnDialog('apply')} onRefund={() => setCnDialog('refund')}
      />

      <Card className="p-0" data-slot="doc-body">
        <Tabs defaultValue="details">
          <div className="flex items-center justify-between border-b px-6">
            <TabsList className="h-12 bg-transparent p-0">
              <TabsTrigger value="details" data-slot="tab-details">{info.noun} Details</TabsTrigger>
              <TabsTrigger value="activity" data-slot="tab-activity">Activity</TabsTrigger>
            </TabsList>
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-[12px]" role="group" aria-label="Details or PDF" data-slot="details-pdf">
              {(['details', 'pdf'] as const).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} data-slot={`view-${v}`}
                  className={`rounded px-3 py-1 ${view === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}>
                  {v === 'details' ? 'Details' : 'PDF'}
                </button>
              ))}
            </div>
          </div>
          <TabsContent value="details" className="p-6">
            {view === 'pdf' ? (
              <div className="rounded-[4px] bg-[#f6f7f9] px-2 py-6 dark:bg-muted/30 sm:px-8" data-slot="doc-pdf-view">
                {printDoc ? <DocumentSheet doc={printDoc} copyLabel={null} last ribbon={ribbonFor(printDoc.status)} /> : <p className="text-sm text-muted-foreground">Loading the PDF…</p>}
              </div>
            ) : (
              <Details kind={kind} doc={doc} z={z} />
            )}
          </TabsContent>
          <TabsContent value="activity" className="p-6">
            <ActivityPanel targetType={info.comments} targetId={doc.id} />
          </TabsContent>
        </Tabs>
      </Card>

      <Attachments targetType={ATTACH_TARGET[kind] as AttachableType} targetId={doc.id} canEdit={canEdit} title={`Files attached to ${doc.number}`} />

      <DeleteDocumentDialog kind={kind} id={doc.id} number={doc.number} open={deleting} onOpenChange={setDeleting}
        onDeleted={() => { refreshSplitList(); router.push(info.base); }} />
      {sharing && <ShareDialog kind={kind} doc={doc} onClose={() => setSharing(false)} />}
      {viewingJournal && doc.journalEntryId && <JournalDialog entryId={doc.journalEntryId} number={doc.number} onClose={() => setViewingJournal(false)} />}
      {cnDialog === 'apply' && <ApplyDialog cn={cn} onClose={() => setCnDialog(null)} onDone={() => { setCnDialog(null); reload(); }} />}
      {cnDialog === 'refund' && <RefundDialog cn={cn} onClose={() => setCnDialog(null)} onDone={() => { setCnDialog(null); reload(); }} />}
      {cnDialog === 'void' && <VoidCreditNoteDialog cn={cn} onClose={() => setCnDialog(null)} onDone={() => { setCnDialog(null); reload(); }} />}

      <Dialog open={readying} onOpenChange={setReadying}>
        <DialogContent data-slot="ready-dialog">
          <DialogHeader>
            <DialogTitle>{doc.number} is ready for delivery</DialogTitle>
            <DialogDescription>
              This raises the tax invoice for everything still to invoice on the order, at its prices and discounts, and a delivery challan for the goods on it.
            </DialogDescription>
          </DialogHeader>
          <Field label="Invoice date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadying(false)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void stage('ready', date)} data-slot="ready-confirm">{busy ? 'Raising…' : 'Raise invoice and challan'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LinePickDialog
        open={!!step}
        onClose={() => setStep(null)}
        doc={step === 'challan-invoice' ? 'challan' : 'sales_order'}
        docId={step ? doc.id : null}
        use={step === 'so-challan' ? 'move' : 'invoice'}
        title={step === 'so-challan' ? `Deliver against ${doc.number}` : `Invoice ${doc.number}`}
        description={step === 'so-challan'
          ? 'A delivery challan moves the goods; the sale is invoiced from the challan later.'
          : step === 'challan-invoice' ? 'Invoice the goods the customer has kept. Anything not invoiced stays on the challan.'
          : 'Invoice what is left, or part of it. The rest stays on the order.'}
        submitLabel={step === 'so-challan' ? 'Create challan' : 'Create invoice'}
        header={
          <>
            <Field label={step === 'so-challan' ? 'Challan date' : 'Invoice date'}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            {step !== 'so-challan' && <Field label="Due date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>}
          </>
        }
        onSubmit={async (lines) => {
          if (step === 'so-challan') {
            const done = await orderFlow.deliver(doc.id, { date, lines });
            toast.success(`Challan ${done.number} created`);
            router.push(`/sales/challans/${done.challanId}`);
            return;
          }
          const done = step === 'challan-invoice'
            ? await orderFlow.invoiceChallan(doc.id, { date, dueDate, lines })
            : await orderFlow.invoiceSalesOrder(doc.id, { date, dueDate, lines });
          if (done.heldForApproval) toast.info(`Invoice ${done.number} saved for approval`);
          else toast.success(`Invoice ${done.number} created`, { description: 'Posted to the ledger.' });
          router.push(`/sales/invoices/${done.invoiceId}`);
        }}
      />
    </>
  );
}

/** Zoho's "WHAT'S NEXT?" line, with the buttons it offers at that status. */
function WhatsNext(p: {
  kind: SalesDocKindZ; doc: EditableSalesDoc; z: string; busy: boolean; canCreate: boolean; canEdit: boolean;
  onSend: () => void; onMarkSent: () => void; onToInvoice: () => void; onToOrder: () => void; onConfirm: () => void; onOpen: () => void;
  onSoInvoice: () => void; onSoChallan: () => void; onChallanInvoice: () => void; onApply: () => void; onRefund: () => void;
}) {
  const { kind, doc } = p;
  let text: string | null = null;
  let buttons: React.ReactNode = null;
  if (kind === 'estimate') {
    if (doc.status === 'draft') {
      text = 'Go ahead and email this quote to your customer or simply mark it as sent.';
      buttons = <>{p.canCreate && <Button size="sm" onClick={p.onSend} disabled={p.busy}>Send Quote</Button>}{p.canEdit && <Button size="sm" variant="outline" onClick={p.onMarkSent} disabled={p.busy}>Mark As Sent</Button>}</>;
    } else if (doc.status !== 'converted' && doc.status !== 'declined') {
      text = 'Convert this quote to an invoice or a sales order.';
      buttons = p.canCreate && <><Button size="sm" onClick={p.onToInvoice} disabled={p.busy}>Convert to Invoice</Button><Button size="sm" variant="outline" onClick={p.onToOrder} disabled={p.busy}>Convert to Sales Order</Button></>;
    }
  } else if (kind === 'sales-order') {
    if (doc.status === 'draft') {
      text = 'Confirm this sales order to deliver and invoice against it.';
      buttons = p.canEdit && <Button size="sm" onClick={p.onConfirm} disabled={p.busy}>Mark as Confirmed</Button>;
    } else if (doc.status === 'open' || doc.status === 'partially_invoiced') {
      text = 'Convert the sales order into packages, shipments or invoices.';
      buttons = p.canCreate && <><Button size="sm" onClick={p.onSoInvoice} disabled={p.busy}>Convert to Invoice</Button><Button size="sm" variant="outline" onClick={p.onSoChallan} disabled={p.busy}>Create Delivery Challan</Button></>;
    }
  } else if (kind === 'challan') {
    if (doc.status === 'draft') {
      text = 'Mark this delivery challan as open once the goods leave.';
      buttons = p.canEdit && <Button size="sm" onClick={p.onOpen} disabled={p.busy}>Mark as Open</Button>;
    } else if ((doc.status === 'open' || doc.status === 'partially_invoiced') && doc.challanType !== 'job_work') {
      text = 'Convert this delivery challan to an invoice once the customer keeps the goods.';
      buttons = p.canCreate && <Button size="sm" onClick={p.onChallanInvoice} disabled={p.busy}>Convert to Invoice</Button>;
    }
  } else if (kind === 'credit-note' && (doc.balancePaise ?? 0) > 0 && doc.status !== 'void') {
    text = `Credits remaining: ${formatINR(doc.balancePaise ?? 0)}. Apply them to the customer’s invoices or refund them.`;
    buttons = p.canCreate && <><Button size="sm" onClick={p.onApply} disabled={p.busy}>Apply to Invoices</Button><Button size="sm" variant="outline" onClick={p.onRefund} disabled={p.busy}>Refund</Button></>;
  }
  if (!text) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-[13px]" data-slot="whats-next">
      <Sparkles className="size-4 text-primary" />
      <span className="font-semibold uppercase">What&apos;s next?</span>
      <span className="text-muted-foreground">{text}</span>
      <span className="ml-auto flex gap-2">{buttons}</span>
    </Card>
  );
}

/** The Details side of the switch: Zoho's grid, the customer, the items and the totals. */
function Details({ kind, doc, z }: { kind: SalesDocKindZ; doc: EditableSalesDoc; z: string }) {
  const info = SALES_DOC[kind];
  const contact = useAppStore((s) => s.contacts.find((c) => c.id === doc.customerId));
  const address = (a?: { line1: string; city: string; pincode: string; stateCode: string }) =>
    a && (a.line1 || a.city) ? [a.line1, [a.city, a.pincode].filter(Boolean).join(' '), GST_STATES[a.stateCode]].filter(Boolean).join(', ') : '-';
  const facts = useMemo(() => {
    const f: [string, React.ReactNode][] = [[`${info.noun} Number`, doc.number], [info.dateLabel.replace(/^Delivery Challan Date$/, 'Challan Date'), zohoDay(doc.date)]];
    f.push(['Creation Date', doc.createdAt ? zohoDay(doc.createdAt) : '-']);
    if (kind !== 'challan') f.push(['Salesperson', doc.salespersonName ?? '-']);
    if (kind === 'estimate') f.push(['Expiry Date', zohoDay(doc.expiryDate)]);
    if (kind === 'sales-order') {
      f.push(['Expected Shipment Date', zohoDay(doc.expectedShipDate)]);
      f.push(['Payment Terms', doc.paymentTerms ? doc.paymentTerms.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-']);
      f.push(['Delivery Method', doc.deliveryMethod ?? '-']);
      f.push(['Stage', STAGE_LABEL[doc.stage ?? 'order'] ?? '-']);
    }
    if (kind === 'challan') f.push(['Challan Type', challanTypeLabel(doc.challanType)]);
    if (kind === 'credit-note') {
      f.push(['Reason', doc.reason ?? '-']);
      f.push(['Invoice#', doc.againstInvoice ? <Link key="inv" href={`/sales/invoices/${doc.againstInvoice.id}`} className="text-link hover:underline">{doc.againstInvoice.number}</Link> : '-']);
    }
    f.push(['Reference Number', doc.referenceNumber ?? '-']);
    if (kind === 'estimate' && doc.projectName) f.push(['Project Name', doc.projectName]);
    if (doc.placeOfSupply) f.push(['Place of Supply', GST_STATES[doc.placeOfSupply] ?? doc.placeOfSupply]);
    return f;
  }, [kind, doc, info]);
  const links: { label: string; items: { id: string; number: string; href: string }[] }[] = [
    ...(doc.convertedTo ? [{ label: doc.convertedTo.type === 'sales_order' ? 'Sales Order' : 'Invoice', items: [{ ...doc.convertedTo, href: doc.convertedTo.type === 'sales_order' ? `/sales/sales-orders/${doc.convertedTo.id}` : `/sales/invoices/${doc.convertedTo.id}` }] }] : []),
    ...(doc.sourceEstimate ? [{ label: 'Quote', items: [{ ...doc.sourceEstimate, href: `/sales/estimates/${doc.sourceEstimate.id}` }] }] : []),
    ...(doc.salesOrder ? [{ label: 'Sales Order', items: [{ ...doc.salesOrder, href: `/sales/sales-orders/${doc.salesOrder.id}` }] }] : []),
    ...(doc.invoices?.length ? [{ label: 'Invoices', items: doc.invoices.map((i) => ({ ...i, href: `/sales/invoices/${i.id}` })) }] : []),
    ...(doc.challans?.length ? [{ label: 'Delivery Challans', items: doc.challans.map((c) => ({ ...c, href: `/sales/challans/${c.id}` })) }] : []),
  ];
  const taxRows: [string, number][] = [
    ['CGST', doc.cgstPaise ?? 0], ['SGST', doc.sgstPaise ?? 0], ['IGST', doc.igstPaise ?? 0], ['Cess', doc.cessPaise ?? 0],
  ].filter(([, v]) => (v as number) > 0) as [string, number][];
  return (
    <div className="space-y-7 text-[13px]" data-slot="doc-details">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[20px] font-semibold">{doc.number}</span>
            <StatusBadge status={z} />
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">Total : <Money value={doc.totalPaise ?? 0} /></p>
        </div>
      </div>

      <dl className="grid gap-x-10 gap-y-3 sm:grid-cols-2" data-slot="doc-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[150px_1fr] gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>

      {links.length > 0 && (
        <div className="space-y-1" data-slot="doc-links">
          {links.map((l) => (
            <p key={l.label}><span className="text-muted-foreground">{l.label}: </span>
              {l.items.map((i, n) => <span key={i.id}>{n > 0 && ', '}<Link href={i.href} className="text-link hover:underline">{i.number}</Link></span>)}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-[16px] font-medium">Customer Details</h3>
        <dl className="grid gap-x-10 gap-y-3 sm:grid-cols-2">
          <div className="grid grid-cols-[150px_1fr] gap-3"><dt className="text-muted-foreground">Name</dt>
            <dd><Link href={`/sales/customers/${doc.customerId}`} className="text-link hover:underline">{doc.customerName}</Link></dd></div>
          <div />
          <div className="grid grid-cols-[150px_1fr] gap-3"><dt className="text-muted-foreground">Billing Address</dt><dd>{address(contact?.billingAddress)}</dd></div>
          <div className="grid grid-cols-[150px_1fr] gap-3"><dt className="text-muted-foreground">Shipping Address</dt><dd>{address(contact?.shippingAddress ?? contact?.billingAddress)}</dd></div>
        </dl>
      </div>

      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-[16px] font-medium">Items <span className="rounded-full bg-muted px-1.5 text-[11px]">{doc.lines.length}</span></h3>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-[13px]" data-slot="doc-items">
            <thead className="bg-muted/50 text-[11px] font-semibold uppercase text-muted-foreground">
              <tr><th className="px-3 py-2 text-left">S.No</th><th className="px-3 py-2 text-left">Item</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-right">Amount</th></tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-3 py-2">{i + 1}</td>
                  <td className="px-3 py-2">
                    {l.itemId ? <Link href={`/sales/items/${l.itemId}`} className="text-link hover:underline">{l.itemName ?? l.description}</Link> : <span>{l.description}</span>}
                    {l.itemId && l.description && l.description !== l.itemName && <p className="text-[12px] text-muted-foreground">{l.description}</p>}
                  </td>
                  <td className="px-3 py-2 text-right tabular">{l.qty}<p className="text-[11px] text-muted-foreground">{l.uqc}</p></td>
                  <td className="px-3 py-2 text-right tabular"><Money value={l.ratePaise} /></td>
                  <td className="px-3 py-2 text-right tabular"><Money value={l.amountPaise ?? Math.round(l.ratePaise * l.qty)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto w-full max-w-xs space-y-1.5" data-slot="doc-totals">
          {kind !== 'challan' && <div className="flex justify-between"><dt className="text-muted-foreground">Sub Total</dt><dd className="tabular"><Money value={doc.subtotalPaise ?? 0} /></dd></div>}
          {taxRows.map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd className="tabular"><Money value={v} /></dd></div>)}
          <div className="flex justify-between border-t pt-1.5 font-semibold"><dt>Total</dt><dd className="tabular"><Money value={doc.totalPaise ?? 0} /></dd></div>
          {kind === 'sales-order' && (doc.invoicedPaise ?? 0) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Invoiced</dt><dd className="tabular"><Money value={doc.invoicedPaise ?? 0} /></dd></div>}
          {kind === 'credit-note' && (
            <>
              <div className="flex justify-between"><dt className="text-muted-foreground">Credits Used</dt><dd className="tabular"><Money value={doc.appliedPaise ?? 0} /></dd></div>
              <div className="flex justify-between font-medium"><dt>Credits Remaining</dt><dd className="tabular"><Money value={doc.balancePaise ?? 0} /></dd></div>
            </>
          )}
        </dl>
      </div>

      {(doc.notes || doc.terms) && (
        <div className="grid gap-6 sm:grid-cols-2">
          {doc.notes && <div><p className="text-muted-foreground">Customer Notes</p><p className="whitespace-pre-line">{doc.notes}</p></div>}
          {doc.terms && <div><p className="text-muted-foreground">Terms &amp; Conditions</p><p className="whitespace-pre-line">{doc.terms}</p></div>}
        </div>
      )}
    </div>
  );
}

/** Zoho's "Share <Noun> Link": a public link until a date, and Disable All Active Links. */
function ShareDialog({ kind, doc, onClose }: { kind: SalesDocKindZ; doc: EditableSalesDoc; onClose: () => void }) {
  const info = SALES_DOC[kind];
  // By default, 90 days after the quote's expiry date; never more than 180 days from today.
  const max = plusDays(180);
  const base = doc.expiryDate ? (() => { const d = new Date(`${doc.expiryDate}T00:00:00`); d.setDate(d.getDate() + 90); return localDay(d); })() : plusDays(90);
  const [until, setUntil] = useState(base > max ? max : base < today() ? plusDays(30) : base);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const days = Math.max(1, Math.min(180, Math.round((new Date(`${until}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 86_400_000)));
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ path: string }>('/api/share', { document: { kind, id: doc.id }, days });
      setUrl(`${window.location.origin}${r.path}`);
    } catch (e) {
      toast.error('No link made', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  const disableAll = async () => {
    setBusy(true);
    try {
      const r = await api.patch<{ revoked: number }>('/api/share', { document: { kind, id: doc.id } });
      setUrl(null);
      toast.success(r.revoked ? `${r.revoked} link${r.revoked === 1 ? '' : 's'} disabled` : 'There were no active links');
    } catch (e) {
      toast.error('Not disabled', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-slot="share-dialog">
        <DialogHeader>
          <DialogTitle>Share {info.noun} Link</DialogTitle>
          <DialogDescription>
            Visibility: <b>Public</b>. Select an expiration date and generate the link to share it with your customer. Remember that anyone who has access to this link can view, print or download it.
          </DialogDescription>
        </DialogHeader>
        <Field label="Link Expiration Date" hint={doc.expiryDate ? `By default, the link is set to expire 90 days from the ${info.lower} expiry date.` : 'A link can stay open for up to 180 days.'}>
          <Input type="date" value={until} min={plusDays(1)} max={max} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        {url && (
          <div className="flex items-center gap-2" data-slot="share-url">
            <Input value={url} readOnly className="font-mono text-xs" />
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(url).catch(() => {}); toast.success('Link copied'); }}>Copy</Button>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" className="text-destructive" onClick={() => void disableAll()} disabled={busy} data-slot="share-disable">Disable All Active Links</Button>
          <Button onClick={() => void generate()} disabled={busy} data-slot="share-generate">{busy ? <Loader2 className="size-4 animate-spin" /> : null} Generate Link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's View Journal on a credit note: the entry it posted. */
function JournalDialog({ entryId, number, onClose }: { entryId: string; number: string; onClose: () => void }) {
  const state = useApi(() => journal.list({ entryId }), [entryId]);
  const entry = state.data?.entries[0];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl sm:max-w-2xl" data-slot="journal-dialog">
        <DialogHeader>
          <DialogTitle>Journal for {number}</DialogTitle>
          <DialogDescription>{entry ? `Entry ${entry.entryNo} · ${zohoDay(entry.date)}` : 'Loading…'}</DialogDescription>
        </DialogHeader>
        {entry && (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/50 text-[11px] uppercase text-muted-foreground"><tr><th className="px-3 py-2 text-left">Account</th><th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th></tr></thead>
            <tbody>
              {entry.lines.map((l) => (
                <tr key={l.lineNo} className="border-t">
                  <td className="px-3 py-2">{l.accountName}</td>
                  <td className="px-3 py-2 text-right tabular">{l.debitPaise ? formatINR(l.debitPaise) : ''}</td>
                  <td className="px-3 py-2 text-right tabular">{l.creditPaise ? formatINR(l.creditPaise) : ''}</td>
                </tr>
              ))}
              <tr className="border-t font-medium"><td className="px-3 py-2">Total</td><td className="px-3 py-2 text-right tabular">{formatINR(entry.totalDebitPaise)}</td><td className="px-3 py-2 text-right tabular">{formatINR(entry.totalCreditPaise)}</td></tr>
            </tbody>
          </table>
        )}
      </DialogContent>
    </Dialog>
  );
}
