'use client';

// The customer or vendor portal (services/portal.ts), laid out as Zoho Books'
// portal is. A customer sees a home page of what they owe, then their quotes,
// invoices (paid online when the business takes it), sales orders, retainers,
// credit notes, payments, statement and projects; a vendor sees purchase
// orders to accept or decline, bills, vendor credits, payments and statement.
// Both can comment on any of their documents, swap files with the business,
// and keep their own details up to date — a vendor's bank account only through
// an approval. Opened from a link the business sent, or by signing in with a
// code at /portal/login.

import { use, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, CreditCard, FileText, LogOut, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CommentsButton, DocumentsPanel, NoteDialog, portalPost, ProfilePanel,
  type NoteRequest, type PortalBank, type PortalComment, type PortalDocument, type PortalProfile,
} from '@/components/portal/portal-panels';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';

interface StatementLine { date: string; kind: string; number: string; detail: string | null; chargePaise: number; paymentPaise: number; balancePaise: number }
interface Base {
  side: 'customer' | 'vendor';
  business: { name: string; email: string | null; phone: string | null; gstin: string | null };
  contact: { name: string; gstin: string | null };
  statement: { from: string; to: string; openingPaise: number; closingPaise: number; lines: StatementLine[] };
  profile: PortalProfile;
  documents: PortalDocument[];
  comments: Record<string, PortalComment[]>;
}
interface CustomerPortal extends Base {
  side: 'customer';
  canPayOnline: boolean;
  invoices: { id: string; number: string; kind: string; date: string; dueDate: string; totalPaise: number; balancePaise: number; status: string; overdue: boolean }[];
  quotes: { id: string; number: string; date: string; validUntil: string; totalPaise: number; status: string }[];
  payments: { id: string; number: string; date: string; amountPaise: number; mode: string }[];
  salesOrders: { id: string; number: string; date: string; expected: string | null; totalPaise: number; invoicedPaise: number; status: string }[];
  retainers: { id: string; number: string; date: string; amountPaise: number; paidPaise: number; appliedPaise: number; status: string; description: string | null }[];
  creditNotes: { id: string; number: string; date: string; totalPaise: number; unusedPaise: number; status: string; reason: string | null }[];
  projects: { id: string; name: string; status: string; billingMethod: string; hours: number; billableHours: number; billedHours: number }[];
}
interface VendorPortal extends Base {
  side: 'vendor';
  orders: { id: string; number: string; date: string; expected: string | null; totalPaise: number; status: string; response: 'accepted' | 'declined' | null; responseNote: string | null }[];
  bills: { id: string; ourNumber: string; yourNumber: string; date: string; dueDate: string; totalPaise: number; balancePaise: number; status: string }[];
  payments: { id: string; number: string; date: string; amountPaise: number; tdsPaise: number; mode: string; reference: string | null }[];
  credits: { id: string; number: string; date: string; totalPaise: number; unusedPaise: number; status: string; reason: string | null }[];
  bank: PortalBank;
  bankChangePendingSince: string | null;
}
type Portal = CustomerPortal | VendorPortal;

const d = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const words = (s: string) => s.replace(/_/g, ' ');

function Table({ head, rows, empty = 'Nothing here yet.' }: { head: string[]; rows: React.ReactNode[][]; empty?: string }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 font-medium ${i >= head.length - 2 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className={`px-3 py-2 ${j >= r.length - 2 ? 'text-right tabular-nums' : ''}`}>{c}</td>)}</tr>)}
          {!rows.length && <tr className="border-t"><td colSpan={head.length} className="px-3 py-4 text-center text-muted-foreground">{empty}</td></tr>}
        </tbody>
      </table>
    </Card>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'bad' | 'good' }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Card>
  );
}

function Status({ s }: { s: string }) {
  return <span className="capitalize">{words(s)}</span>;
}

export default function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const state = useApi(() => api.get<Portal>(`/api/portal/${encodeURIComponent(token)}`), [token]);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<NoteRequest | null>(null);
  const [tab, setTab] = useState('home');
  const p = state.data;
  const refetch = () => state.refetch();

  const pay = async (invoiceId: string) => {
    setBusy(invoiceId);
    try {
      const r = await portalPost<{ url?: string }>(token, { action: 'pay', invoiceId });
      if (r.url) window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const accept = async (estimateId: string, number: string) => {
    setBusy(`a${estimateId}`);
    try {
      await portalPost(token, { action: 'accept', estimateId });
      toast.success(`Quote ${number} accepted. Thank you.`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // A document's number opens its printed copy, to read or save as a PDF.
  const docLink = (kind: string, id: string, number: string) => (
    <Link href={`/portal/${token}/document/${kind}/${id}`} className="font-medium text-primary hover:underline" data-slot="portal-doc-link">
      <FileText className="mr-1 inline size-3.5" />{number}
    </Link>
  );
  const comments = (type: string, id: string, label: string) => p && (
    <CommentsButton token={token} targetType={type} targetId={id} label={label} business={p.business.name} comments={p.comments[`${type}:${id}`]} onSent={refetch} />
  );

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {state.error ? (
          <Card className="space-y-3 p-6 text-sm">
            <p className="flex items-center gap-3"><AlertCircle className="size-5 text-destructive" /> {state.error}</p>
            <Link href="/portal/login" className="text-primary hover:underline">Sign in with your email instead</Link>
          </Card>
        ) : !p ? (
          <p className="text-sm text-muted-foreground">Opening your account…</p>
        ) : (
          <>
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{p.business.name}{p.business.gstin ? ` · GSTIN ${p.business.gstin}` : ''}</p>
                <h1 className="text-2xl font-semibold">{p.contact.name}</h1>
                <p className="text-sm text-muted-foreground">Your account{p.side === 'vendor' ? ' as our supplier' : ''}. Questions: {[p.business.email, p.business.phone].filter(Boolean).join(' · ') || 'reply to the email this link came in'}.</p>
              </div>
              <Link href="/portal/login" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><LogOut className="size-3.5" /> Sign out</Link>
            </header>

            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
              <div className="overflow-x-auto">
                <TabsList>
                  <TabsTrigger value="home">Home</TabsTrigger>
                  {p.side === 'customer' ? (
                    <>
                      <TabsTrigger value="quotes">Quotes ({p.quotes.length})</TabsTrigger>
                      <TabsTrigger value="invoices">Invoices ({p.invoices.length})</TabsTrigger>
                      {p.salesOrders.length > 0 && <TabsTrigger value="orders">Sales orders ({p.salesOrders.length})</TabsTrigger>}
                      {p.retainers.length > 0 && <TabsTrigger value="retainers">Service invoices ({p.retainers.length})</TabsTrigger>}
                      {p.creditNotes.length > 0 && <TabsTrigger value="credits">Credit notes ({p.creditNotes.length})</TabsTrigger>}
                    </>
                  ) : (
                    <>
                      <TabsTrigger value="orders">Purchase orders ({p.orders.length})</TabsTrigger>
                      <TabsTrigger value="bills">Bills ({p.bills.length})</TabsTrigger>
                      {p.credits.length > 0 && <TabsTrigger value="credits">Vendor credits ({p.credits.length})</TabsTrigger>}
                    </>
                  )}
                  <TabsTrigger value="payments">Payments ({p.payments.length})</TabsTrigger>
                  <TabsTrigger value="statement">Statement</TabsTrigger>
                  {p.side === 'customer' && p.projects.length > 0 && <TabsTrigger value="projects">Projects ({p.projects.length})</TabsTrigger>}
                  <TabsTrigger value="documents">Documents ({p.documents.length})</TabsTrigger>
                  <TabsTrigger value="profile">Profile</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="home" className="mt-4 space-y-4">
                {p.side === 'customer' ? <CustomerHome p={p} go={setTab} /> : <VendorHome p={p} go={setTab} />}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Recent transactions</p>
                  <Table head={['Date', 'Transaction', 'Details', 'Amount']} empty="No transactions this year yet."
                    rows={[...p.statement.lines].reverse().slice(0, 8).map((l) => [d(l.date), `${l.kind} ${l.number}`, l.detail ?? '', formatINR(l.chargePaise || l.paymentPaise)])} />
                </div>
              </TabsContent>

              {p.side === 'customer' && (
                <>
                  <TabsContent value="quotes" className="mt-4">
                    <Table head={['Quote', 'Date', 'Valid until', 'Status', 'Amount']} rows={p.quotes.map((q) => [
                      <span key="n" className="inline-flex items-center gap-1 font-medium">{docLink('estimate', q.id, q.number)}{comments('estimate', q.id, `quote ${q.number}`)}</span>, d(q.date), d(q.validUntil),
                      q.status === 'sent' ? (
                        <span key="a" className="inline-flex gap-1">
                          <Button size="xs" disabled={!!busy} onClick={() => accept(q.id, q.number)} className="gap-1"><CheckCircle2 className="size-3" /> Accept</Button>
                          <Button size="xs" variant="outline" disabled={!!busy} className="gap-1" onClick={() => setAsk({
                            title: `Decline quote ${q.number}?`, description: 'Tell us why, if you like — a price, a date, something missing — and we can send a better one.', confirm: 'Decline', destructive: true,
                            run: async (note) => { await portalPost(token, { action: 'decline', estimateId: q.id, note: note || undefined }); toast.info(`Quote ${q.number} declined.`); refetch(); },
                          })}><XCircle className="size-3" /> Decline</Button>
                        </span>
                      ) : <Status key="s" s={q.status} />,
                      formatINR(q.totalPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="invoices" className="mt-4">
                    <Table head={['Invoice', 'Date', 'Due', 'Total', 'Balance']} rows={p.invoices.map((i) => [
                      <span key="n" className="flex flex-wrap items-center gap-2">
                        <Link href={`/portal/${token}/invoice/${i.id}`} className="font-medium text-primary hover:underline"><FileText className="mr-1 inline size-3.5" />{i.number}</Link>
                        {i.kind === 'debit_note' && <Badge variant="outline" className="text-[10px]">Debit note</Badge>}
                        {i.overdue && <Badge variant="outline" className="border-destructive/50 text-[10px] text-destructive">Overdue</Badge>}
                        {p.canPayOnline && i.balancePaise > 0 && (
                          <Button size="xs" disabled={busy === i.id} onClick={() => pay(i.id)} className="gap-1"><CreditCard className="size-3" /> Pay</Button>
                        )}
                        {comments('invoice', i.id, `invoice ${i.number}`)}
                      </span>,
                      d(i.date), d(i.dueDate), formatINR(i.totalPaise), i.balancePaise > 0 ? formatINR(i.balancePaise) : 'Paid',
                    ])} />
                  </TabsContent>
                  <TabsContent value="orders" className="mt-4">
                    <Table head={['Sales order', 'Date', 'Expected', 'Status', 'Invoiced', 'Amount']} rows={p.salesOrders.map((o) => [
                      <span key="n" className="inline-flex items-center gap-1 font-medium">{docLink('sales-order', o.id, o.number)}{comments('sales_order', o.id, `sales order ${o.number}`)}</span>,
                      d(o.date), o.expected ? d(o.expected) : '—', <Status key="s" s={o.status} />, formatINR(o.invoicedPaise), formatINR(o.totalPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="retainers" className="mt-4">
                    <Table head={['Service invoice', 'Date', 'For', 'Status', 'Paid', 'Amount']} rows={p.retainers.map((r) => [
                      <span key="n">{docLink('retainer', r.id, r.number)}</span>, d(r.date), r.description ?? '—', <Status key="s" s={r.status} />, formatINR(r.paidPaise), formatINR(r.amountPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="credits" className="mt-4">
                    <Table head={['Credit note', 'Date', 'Reason', 'Status', 'Unused', 'Amount']} rows={p.creditNotes.map((n) => [
                      <span key="n" className="inline-flex items-center gap-1 font-medium">{docLink('credit-note', n.id, n.number)}{comments('credit_note', n.id, `credit note ${n.number}`)}</span>,
                      d(n.date), n.reason ?? '—', <Status key="s" s={n.status} />, formatINR(n.unusedPaise), formatINR(n.totalPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="payments" className="mt-4">
                    <Table head={['Receipt', 'Date', 'Mode', 'Amount']} rows={p.payments.map((x) => [<span key="n">{docLink('payment-received', x.id, x.number)}</span>, d(x.date), x.mode.toUpperCase(), formatINR(x.amountPaise)])} />
                  </TabsContent>
                  <TabsContent value="projects" className="mt-4">
                    <Table head={['Project', 'Status', 'Billing', 'Hours logged', 'Billable', 'Billed']} rows={p.projects.map((x) => [
                      <span key="n" className="font-medium">{x.name}</span>, <Status key="s" s={x.status} />, words(x.billingMethod), x.hours.toFixed(1), x.billableHours.toFixed(1), x.billedHours.toFixed(1),
                    ])} />
                  </TabsContent>
                </>
              )}

              {p.side === 'vendor' && (
                <>
                  <TabsContent value="orders" className="mt-4">
                    <Table head={['Order', 'Date', 'Expected', 'Status', 'Your answer', 'Amount']} rows={p.orders.map((o) => [
                      <span key="n" className="inline-flex items-center gap-1 font-medium">{docLink('purchase-order', o.id, o.number)}{comments('purchase_order', o.id, `purchase order ${o.number}`)}</span>,
                      d(o.date), o.expected ? d(o.expected) : '—', <Status key="s" s={o.status} />,
                      o.response ? (
                        <span key="r" title={o.responseNote ?? undefined} className={o.response === 'accepted' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                          {o.response === 'accepted' ? 'Accepted' : 'Declined'}{o.responseNote ? ' *' : ''}
                        </span>
                      ) : o.status === 'open' ? (
                        <span key="a" className="inline-flex gap-1">
                          <Button size="xs" disabled={!!busy} className="gap-1" onClick={() => setAsk({
                            title: `Accept purchase order ${o.number}?`, description: 'Add a note if you like — a delivery date, a part that will come later.', confirm: 'Accept',
                            run: async (note) => { await portalPost(token, { action: 'order', orderId: o.id, decision: 'accepted', note: note || undefined }); toast.success(`Order ${o.number} accepted.`); refetch(); },
                          })}><CheckCircle2 className="size-3" /> Accept</Button>
                          <Button size="xs" variant="outline" disabled={!!busy} className="gap-1" onClick={() => setAsk({
                            title: `Decline purchase order ${o.number}?`, description: 'Tell us why — out of stock, the price, the date — so we can sort it out.', confirm: 'Decline', destructive: true,
                            run: async (note) => { await portalPost(token, { action: 'order', orderId: o.id, decision: 'declined', note: note || undefined }); toast.info(`Order ${o.number} declined.`); refetch(); },
                          })}><XCircle className="size-3" /> Decline</Button>
                        </span>
                      ) : '—',
                      formatINR(o.totalPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="bills" className="mt-4">
                    <Table head={['Your bill no.', 'Our reference', 'Date', 'Due', 'Total', 'Balance']} rows={p.bills.map((b) => [
                      <span key="y" className="inline-flex items-center gap-1 font-medium">{docLink('bill', b.id, b.yourNumber)}{comments('bill', b.id, `bill ${b.yourNumber}`)}</span>, b.ourNumber, d(b.date), d(b.dueDate), formatINR(b.totalPaise), b.balancePaise > 0 ? formatINR(b.balancePaise) : 'Paid',
                    ])} />
                  </TabsContent>
                  <TabsContent value="credits" className="mt-4">
                    <Table head={['Vendor credit', 'Date', 'Reason', 'Status', 'Unused', 'Amount']} rows={p.credits.map((v) => [
                      <span key="n" className="inline-flex items-center gap-1 font-medium">{docLink('vendor-credit', v.id, v.number)}{comments('vendor_credit', v.id, `vendor credit ${v.number}`)}</span>,
                      d(v.date), v.reason ?? '—', <Status key="s" s={v.status} />, formatINR(v.unusedPaise), formatINR(v.totalPaise),
                    ])} />
                  </TabsContent>
                  <TabsContent value="payments" className="mt-4">
                    <Table head={['Payment', 'Date', 'Mode', 'Reference', 'TDS withheld', 'Amount']} rows={p.payments.map((x) => [<span key="n">{docLink('payment-made', x.id, x.number)}</span>, d(x.date), x.mode.toUpperCase(), x.reference ?? '—', x.tdsPaise ? formatINR(x.tdsPaise) : '—', formatINR(x.amountPaise)])} />
                  </TabsContent>
                </>
              )}

              <TabsContent value="statement" className="mt-4 space-y-2">
                <p className="text-sm text-muted-foreground">From {d(p.statement.from)} to {d(p.statement.to)}. Opening balance {formatINR(p.statement.openingPaise)}.</p>
                <Table head={['Date', 'Transaction', 'Details', p.side === 'customer' ? 'Invoiced' : 'Billed', p.side === 'customer' ? 'Paid' : 'Paid to you', 'Balance']}
                  rows={p.statement.lines.map((l) => [d(l.date), `${l.kind} ${l.number}`, l.detail ?? '', l.chargePaise ? formatINR(l.chargePaise) : '', l.paymentPaise ? formatINR(l.paymentPaise) : '', formatINR(l.balancePaise)])} />
              </TabsContent>

              <TabsContent value="documents" className="mt-4">
                <DocumentsPanel token={token} side={p.side} business={p.business.name} documents={p.documents} onSent={refetch} />
              </TabsContent>

              <TabsContent value="profile" className="mt-4">
                <ProfilePanel token={token} side={p.side} profile={p.profile} onSaved={refetch}
                  bank={p.side === 'vendor' ? p.bank : undefined} bankChangePendingSince={p.side === 'vendor' ? p.bankChangePendingSince : null} />
              </TabsContent>
            </Tabs>
            <NoteDialog request={ask} onClose={() => setAsk(null)} />
            <p className="text-center text-xs text-muted-foreground">This page is for {p.contact.name} only. Please do not forward the link.</p>
          </>
        )}
      </div>
    </main>
  );
}

function CustomerHome({ p, go }: { p: CustomerPortal; go: (tab: string) => void }) {
  const unpaid = p.invoices.filter((i) => i.balancePaise > 0);
  const overdue = unpaid.filter((i) => i.overdue);
  const waiting = p.quotes.filter((q) => q.status === 'sent');
  const credit = p.creditNotes.reduce((s, n) => s + Math.max(n.unusedPaise, 0), 0);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`You owe us, as of ${d(p.statement.to)}`} value={formatINR(Math.max(p.statement.closingPaise, 0))} note={p.statement.closingPaise < 0 ? `${formatINR(-p.statement.closingPaise)} in your favour` : undefined} />
        <Stat label="Overdue" value={formatINR(overdue.reduce((s, i) => s + i.balancePaise, 0))} note={`${overdue.length} invoice${overdue.length === 1 ? '' : 's'}`} tone={overdue.length ? 'bad' : undefined} />
        <Stat label="Unpaid invoices" value={String(unpaid.length)} note={formatINR(unpaid.reduce((s, i) => s + i.balancePaise, 0))} />
        <Stat label="Credit available" value={formatINR(credit)} note="From credit notes" tone={credit ? 'good' : undefined} />
      </div>
      {(waiting.length > 0 || unpaid.length > 0) && (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
          {waiting.length > 0 && <span><b>{waiting.length}</b> quote{waiting.length === 1 ? '' : 's'} waiting for your answer. <button className="text-primary hover:underline" onClick={() => go('quotes')}>See quotes</button></span>}
          {unpaid.length > 0 && <span><b>{unpaid.length}</b> invoice{unpaid.length === 1 ? '' : 's'} to pay{p.canPayOnline ? ', online if you like' : ''}. <button className="text-primary hover:underline" onClick={() => go('invoices')}>See invoices</button></span>}
        </Card>
      )}
    </>
  );
}

function VendorHome({ p, go }: { p: VendorPortal; go: (tab: string) => void }) {
  const unpaid = p.bills.filter((b) => b.balancePaise > 0);
  const waiting = p.orders.filter((o) => o.status === 'open' && !o.response);
  const last = p.payments[0];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`We owe you, as of ${d(p.statement.to)}`} value={formatINR(Math.max(p.statement.closingPaise, 0))} />
        <Stat label="Bills not yet paid" value={String(unpaid.length)} note={formatINR(unpaid.reduce((s, b) => s + b.balancePaise, 0))} />
        <Stat label="Orders to answer" value={String(waiting.length)} note={waiting.length ? formatINR(waiting.reduce((s, o) => s + o.totalPaise, 0)) : undefined} />
        <Stat label="Last payment to you" value={last ? formatINR(last.amountPaise) : '—'} note={last ? d(last.date) : undefined} />
      </div>
      {(waiting.length > 0 || p.bankChangePendingSince) && (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
          {waiting.length > 0 && <span><b>{waiting.length}</b> purchase order{waiting.length === 1 ? '' : 's'} waiting for you to accept. <button className="text-primary hover:underline" onClick={() => go('orders')}>See orders</button></span>}
          {p.bankChangePendingSince && <span>Your change of bank account is waiting for our check. <button className="text-primary hover:underline" onClick={() => go('profile')}>See details</button></span>}
        </Card>
      )}
    </>
  );
}
