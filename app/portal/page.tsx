'use client';

// Customer-facing portal — a deliberately simpler surface. No accounting
// vocabulary at all: just "what do I owe, and how do I pay it".
//
// This is a PREVIEW, and the page says so. A real portal hands each customer a
// tokenised link, which needs mail transport the app does not have yet, and a
// payment button needs a gateway it does not have either. What exists today is
// the view itself, rendered from the real ledger, so you can pick a customer
// and see exactly what they would see.
//
// It used to run off the seeded demo store and was reachable without signing
// in — which meant a stranger could read one customer's invoice history by
// guessing the URL. It now requires a session and reads through the same API
// as every other screen, so the numbers here are the numbers in the books.

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, CreditCard, FileText, Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import {
  ApiError, auth, contacts as contactsApi, invoices as invoicesApi, salesDocuments,
  type ContactRow, type InvoiceListItem, type SalesDocRow, type SessionResponse,
} from '@/lib/api/client';
import { BRAND, LogoMark } from '@/components/brand/logo';
import { formatINRCompact } from '@/lib/money';

const shortDate = (d: string) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function PortalInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [customers, setCustomers] = useState<ContactRow[]>([]);
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [estimates, setEstimates] = useState<SalesDocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState<string | null>(null);

  // ── Who is signed in, and which customers are there to preview ────────────
  useEffect(() => {
    let cancelled = false;
    Promise.all([auth.me(), contactsApi.list({ kind: 'customer', limit: 500 })])
      .then(([me, list]) => {
        if (cancelled) return;
        setSession(me);
        setCustomers(list.contacts);
        // Default to the first customer, so the page has something to show
        // without asking a question first.
        setCustomerId((current) => current || list.contacts[0]?.id || '');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.isAuthFailure) {
          router.replace('/login');
          return;
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [router]);

  // ── That customer's documents ─────────────────────────────────────────────
  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setEstimates([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      invoicesApi.list({ customerId, limit: 100 }),
      salesDocuments.list('estimate', { customerId, limit: 20 }),
    ])
      .then(([inv, est]) => {
        if (cancelled) return;
        // Drafts and voided documents are ours, not the customer's. Showing a
        // draft in a portal is how a customer ends up paying against a number
        // that has not been issued.
        setInvoices(inv.invoices.filter((i) => i.status !== 'draft' && i.status !== 'void'));
        setEstimates(est.documents.filter((e) => e.status === 'sent' || e.status === 'draft'));
      })
      .catch(() => {
        if (cancelled) return;
        setInvoices([]);
        setEstimates([]);
      });
    return () => { cancelled = true; };
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId);
  const outstanding = useMemo(
    () => invoices.reduce((t, i) => t + i.balancePaise, 0),
    [invoices],
  );
  const today = new Date().toISOString().slice(0, 10);
  const overdue = invoices.filter((i) => i.balancePaise > 0 && i.dueDate < today);

  const pay = async (id: string) => {
    setPaying(id);
    await new Promise((r) => setTimeout(r, 1200));
    setPaying(null);
    toast.info('No payment gateway is connected', {
      description:
        'This button would open a checkout and reconcile the receipt automatically. Connecting one needs a merchant account, which is set up in Settings → Integrations.',
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/40">
      {/* Branded header */}
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-4">
          <LogoMark size={30} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{session?.org?.name ?? BRAND.display}</p>
            <p className="text-xs text-muted-foreground">Customer portal</p>
          </div>
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link href="/dashboard"><ArrowLeft className="size-3.5" /> Back to app</Link>
          </Button>
        </div>
      </header>

      {/* The preview control. Not part of the portal a customer would see —
          hence the separate band, in the app's own voice. */}
      <div className="border-b bg-background/60">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="micro-label shrink-0">Previewing as</span>
          <div className="min-w-[240px] flex-1 sm:max-w-xs">
            <Combobox
              options={customers.map((c) => ({
                value: c.id,
                label: c.displayName,
                sublabel: c.gstin ?? c.email ?? undefined,
              }))}
              value={customerId}
              onChange={setCustomerId}
              placeholder="Select a customer"
              searchPlaceholder="Search customers"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            A live portal would email each customer their own link. Nothing here is sent.
          </p>
        </div>
      </div>

      <main className="mx-auto max-w-4xl space-y-6 p-4 py-8">
        {!customer ? (
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="Add a customer and raise an invoice, and their portal view appears here."
          />
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Hello, {customer.displayName}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your invoices, statements and payments in one place.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Amount due</p>
                <p className="mt-1 text-2xl font-semibold tabular">{formatINRCompact(outstanding)}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">Open invoices</p>
                <p className="mt-1 text-2xl font-semibold tabular">
                  {invoices.filter((i) => i.balancePaise > 0).length}
                </p>
              </Card>
              <Card className={`p-4 ${overdue.length ? 'border-warning/40 bg-warning/5' : ''}`}>
                <p className="text-xs text-muted-foreground">Overdue</p>
                <p className="mt-1 text-2xl font-semibold tabular">{overdue.length}</p>
              </Card>
            </div>

            <Card className="p-0">
              <div className="border-b p-4">
                <h2 className="text-sm font-semibold">Your invoices</h2>
              </div>
              {invoices.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  Nothing has been issued to this customer yet.
                </p>
              ) : (
                <div className="divide-y">
                  {invoices.map((inv) => (
                    <div key={inv.id} className="flex flex-wrap items-center gap-4 p-4">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{inv.number}</p>
                          <StatusBadge
                            status={
                              inv.balancePaise > 0 && inv.dueDate < today ? 'overdue' : inv.status
                            }
                          />
                          {inv.einvoice.irn && (
                            <Badge variant="outline" className="border-success/40 text-[9px]">
                              Verified
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Issued {shortDate(inv.date)} · due {shortDate(inv.dueDate)}
                        </p>
                      </div>
                      <div className="text-right">
                        <Money value={inv.totalPaise} className="text-sm font-medium" />
                        {inv.balancePaise > 0 && inv.balancePaise !== inv.totalPaise && (
                          <p className="text-xs text-muted-foreground">
                            <Money value={inv.balancePaise} /> outstanding
                          </p>
                        )}
                      </div>
                      {inv.balancePaise > 0 ? (
                        <Button
                          size="sm"
                          onClick={() => void pay(inv.id)}
                          disabled={paying === inv.id}
                          className="gap-1.5"
                        >
                          {paying === inv.id
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <CreditCard className="size-3.5" />}
                          Pay now
                        </Button>
                      ) : (
                        <Badge variant="outline" className="gap-1 border-success/40">
                          <CheckCircle2 className="size-3" /> Paid
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {estimates.length > 0 && (
              <Card className="p-0">
                <div className="border-b p-4">
                  <h2 className="text-sm font-semibold">Quotes awaiting your decision</h2>
                </div>
                <div className="divide-y">
                  {estimates.map((e) => (
                    <div key={e.id} className="flex flex-wrap items-center gap-4 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{e.number}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {e.expiry ? `Valid until ${shortDate(e.expiry)}` : `Issued ${shortDate(e.date)}`}
                        </p>
                      </div>
                      <Money value={e.totalPaise} className="text-sm font-medium" />
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toast.info('A customer would decline from their own link')}
                        >
                          Decline
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => toast.info('A customer would accept from their own link')}
                        >
                          Accept
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <p className="text-center text-xs text-muted-foreground">
              Questions about an invoice? Reply to {session?.org?.email ?? 'us'}
              {session?.org?.phone ? ` or call ${session.org.phone}` : ''}.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

export default function PortalPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center bg-muted/40" />}
    >
      <PortalInner />
    </Suspense>
  );
}
