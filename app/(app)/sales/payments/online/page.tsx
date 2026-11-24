'use client';

// Zoho Books' Payments Received ⋯ → Online Payments: the payments customers
// made through an invoice's payment link (Razorpay, services/payment-links.ts),
// and the links still waiting. With no gateway connected, Zoho's empty state
// points to where it is connected.

import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface OnlineLink {
  id: string; invoiceId: string; invoiceNumber: string; customerName: string; amountPaise: number;
  status: 'created' | 'paid' | 'expired' | 'cancelled'; url: string; createdAt: string; paidAt: string | null;
  paymentId: string | null; paymentNumber: string | null; providerPaymentId: string | null;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const STATUS: Record<OnlineLink['status'], string> = { created: 'Awaiting payment', paid: 'Paid', expired: 'Expired', cancelled: 'Cancelled' };

export default function OnlinePaymentsPage() {
  const state = useApi<{ connected: boolean; links: OnlineLink[] }>(() => api.get('/api/payment-links', { list: '1' }), []);
  const columns: Column<OnlineLink>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.paidAt ?? r.createdAt, cell: (r) => day(r.paidAt ?? r.createdAt) },
    { key: 'invoice', header: 'Invoice#', sortValue: (r) => r.invoiceNumber, cell: (r) => <Link href={`/sales/invoices/${r.invoiceId}`} className="text-link hover:underline">{r.invoiceNumber}</Link> },
    { key: 'customer', header: 'Customer Name', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <span className={r.status === 'paid' ? 'text-success' : r.status === 'created' ? 'text-warning' : 'text-muted-foreground'}>{STATUS[r.status]}</span> },
    { key: 'payment', header: 'Payment #', sortValue: (r) => r.paymentNumber ?? '', cell: (r) => (r.paymentId ? <Link href={`/sales/payments/${r.paymentId}`} className="text-link hover:underline">{r.paymentNumber}</Link> : '') },
    { key: 'ref', header: 'Gateway Reference', sortValue: (r) => r.providerPaymentId ?? '', cell: (r) => r.providerPaymentId ?? '' },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise, cell: (r) => <Money value={r.amountPaise} className="font-medium" /> },
  ];
  return (
    <>
      <PageHeader title="Online Payments" actions={<Button variant="outline" size="sm" asChild><Link href="/sales/payments">Payments Received</Link></Button>} />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => !d.connected && d.links.length === 0 ? (
          <EmptyState icon={CreditCard} title="Collect payments online"
            description="Connect a payment gateway and every invoice you send can carry a link your customer pays from; the payment records itself here."
            action={<Button asChild><Link href="/settings?tab=integrations" data-slot="online-connect">Set up Payment Gateway</Link></Button>} />
        ) : d.links.length === 0 ? (
          <EmptyState icon={CreditCard} title="No online payments yet" description="Payment links made from invoices, and the payments customers make through them, show here." />
        ) : (
          <DataTable rows={d.links} columns={columns} getRowId={(r) => r.id} initialSort={{ key: 'date', dir: 'desc' }} searchPlaceholder="Search invoice or customer" />
        )}
      </AsyncPage>
    </>
  );
}
