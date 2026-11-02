'use client';

// Sending an invoice to the customer: a link that opens it without signing
// in, copied, or put in a WhatsApp message or an email ready to go from the
// user's own phone or mail. With a mail server set up (lib/server/mail), it
// can also be emailed straight from here, to the people at the customer
// marked to receive documents. Links can be withdrawn.

import { useState } from 'react';
import { Copy, CreditCard, Loader2, Mail, MessageCircle, Send, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, invoices as invoiceApi, type InvoiceDetail } from '@/lib/api/client';
import { formatINR } from '@/lib/money';
import { usePermission } from '@/lib/store/hooks';
import { useApi } from '@/lib/api/use-api';

/** A WhatsApp number from what was typed: digits only, with India's 91 when it is a ten-digit mobile. */
export const whatsappNumber = (phone: string | null | undefined) => {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d.replace(/^0+/, '');
};

export function SendInvoice({ inv, onSent }: { inv: InvoiceDetail; onSent: () => void }) {
  const canShare = usePermission('sales', 'export');
  const canEdit = usePermission('sales', 'edit');
  const [busy, setBusy] = useState(false);
  const mail = useApi(() => api.get<{ configured: boolean; sent: { to: string; status: string; at: string }[] }>('/api/email', { docType: 'invoice', docId: inv.id }), [inv.id]);
  const gateway = useApi(() => api.get<{ connected: boolean }>('/api/payment-links'), []);
  if (!canShare) return null;

  const payLink = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ url: string; amountPaise: number; reused: boolean }>('/api/payment-links', { action: 'link', invoiceId: inv.id });
      await navigator.clipboard.writeText(r.url).catch(() => {});
      toast.success(r.reused ? 'Payment link copied' : 'Payment link made and copied', {
        description: `${r.url} asks for ${formatINR(r.amountPaise)}. It also shows as a Pay button on the shared invoice; the receipt records itself when it is paid.`,
      });
    } catch (e) {
      toast.error('No link', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const lastSent = mail.data?.sent.find((x) => x.status === 'sent');

  const emailNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ to: string[] }>('/api/email', { kind: 'invoice', invoiceId: inv.id });
      toast.success('Emailed', { description: `To ${r.to.join(', ')}, with a link to view and pay it.` });
      mail.refetch();
      onSent();
    } catch (e) {
      toast.error('Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const link = async () => {
    const r = await api.post<{ path: string; expiresAt: string }>('/api/share', { invoiceId: inv.id });
    return `${window.location.origin}${r.path}`;
  };
  const message = (url: string) =>
    `Dear ${inv.customer.name}, please find invoice ${inv.number} for ${formatINR(inv.totalPaise)}` +
    `${inv.balancePaise > 0 ? `, due on ${new Date(`${inv.dueDate}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}: ${url}\n— ${inv.seller.name}`;
  // An approved invoice that has gone to the customer is a sent one.
  const markSent = async () => {
    if (canEdit && inv.status === 'approved') {
      try { await invoiceApi.send(inv.id); } catch { /* already moved on */ }
    }
    onSent();
  };
  const go = async (how: 'copy' | 'whatsapp' | 'email') => {
    setBusy(true);
    try {
      const url = await link();
      if (how === 'copy') {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied', { description: 'It opens the invoice for thirty days, without signing in.' });
        return;
      }
      if (how === 'whatsapp') {
        const to = whatsappNumber(inv.customer.phone);
        window.open(`https://wa.me/${to}?text=${encodeURIComponent(message(url))}`, '_blank', 'noopener');
      } else {
        const subject = `Invoice ${inv.number} from ${inv.seller.name}`;
        window.open(`mailto:${encodeURIComponent(inv.customer.email ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(url))}`, '_self');
      }
      await markSent();
    } catch (e) {
      toast.error('Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!window.confirm(`Stop every link to ${inv.number} working? Anyone who has one will be told to ask for a new one.`)) return;
    try {
      const r = await api.patch<{ revoked: number }>('/api/share', { invoiceId: inv.id });
      toast.success(r.revoked ? `${r.revoked} link${r.revoked === 1 ? '' : 's'} withdrawn` : 'There were no live links');
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-sm transition-colors hover:bg-accent" disabled={busy}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => void go('whatsapp')}>
          <MessageCircle className="mr-2 size-4" /> On WhatsApp{inv.customer.phone ? '' : ' (no number on file)'}
        </DropdownMenuItem>
        {mail.data?.configured && (
          <DropdownMenuItem onClick={() => void emailNow()} data-slot="email-now">
            <Mail className="mr-2 size-4" /> Email now{lastSent ? ' (again)' : ''}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void go('email')}>
          <Mail className="mr-2 size-4" /> In my mail app{inv.customer.email ? '' : ' (no address on file)'}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void go('copy')}>
          <Copy className="mr-2 size-4" /> Copy a link
        </DropdownMenuItem>
        {gateway.data?.connected && inv.balancePaise > 0 && (
          <DropdownMenuItem onClick={() => void payLink()} data-slot="payment-link">
            <CreditCard className="mr-2 size-4" /> Payment link (Razorpay)
          </DropdownMenuItem>
        )}
        {canEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void withdraw()}>
              <Unlink className="mr-2 size-4" /> Withdraw links
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

