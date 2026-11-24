'use client';

// Zoho Books' Send ▾ and Share on an invoice's action bar.
//
// Send ▾ → Send Email / Schedule Email: a window with To, Cc and a message,
// sent now or at the time chosen (a job on the queue, services/scheduled-email.ts).
// Share → "Share Invoice Link": a public link that opens the invoice without
// signing in, until the date chosen; Zoho shares only a sent invoice, so a
// draft is first marked as sent ("Mark the invoice as sent and share?").
// Rekonza's WhatsApp and mail-app sending live in the Share window, beside the
// link they carry.

import { useEffect, useState } from 'react';
import { CalendarClock, ChevronDown, Copy, Loader2, Mail, MessageCircle, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, type InvoiceDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { whatsappNumber } from '@/components/sales/send-invoice';

/** Sent, in Zoho's sense: gone to the customer (or marked so). */
export const invoiceIsSent = (inv: InvoiceDetail) => !['draft', 'approved', 'void'].includes(inv.status);

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const listOf = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

interface MailInfo {
  configured: boolean;
  from: string | null;
  recipients?: string[];
  scheduled?: { id: string; at: string; to: string[] }[];
}

/** Send ▾ — Send Email, Schedule Email. `markSent` issues a draft first, as Zoho's sending does. */
export function InvoiceSendMenu({ inv, markSent, onChanged, mode, setMode }: {
  inv: InvoiceDetail; markSent: () => Promise<boolean>; onChanged: () => void;
  /** Which window is open; held by the page, so "What's next? → Send Invoice" opens the same one. */
  mode: null | 'now' | 'schedule'; setMode: (m: null | 'now' | 'schedule') => void;
}) {
  const canSend = usePermission('sales', 'create');
  if (!canSend || inv.status === 'void') return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent" data-slot="send-menu">
          <Send className="size-3.5" /> Send <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onClick={() => setMode('now')} data-slot="send-email">Send Email</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode('schedule')} data-slot="schedule-email">Schedule Email</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {mode && <EmailInvoiceDialog inv={inv} schedule={mode === 'schedule'} onClose={() => setMode(null)} markSent={markSent} onChanged={onChanged} />}
    </>
  );
}

function EmailInvoiceDialog({ inv, schedule, onClose, markSent, onChanged }: {
  inv: InvoiceDetail; schedule: boolean; onClose: () => void; markSent: () => Promise<boolean>; onChanged: () => void;
}) {
  const info = useApi<MailInfo>(() => api.get('/api/email', { docType: 'invoice', docId: inv.id }), [inv.id]);
  const [to, setTo] = useState<string | null>(null);
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [at, setAt] = useState(() => {
    const d = new Date(Date.now() + 60 * 60_000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [busy, setBusy] = useState(false);
  const toValue = to ?? (info.data?.recipients ?? []).join(', ');
  const configured = info.data?.configured ?? false;

  const go = async () => {
    setBusy(true);
    try {
      // A draft is issued first: Zoho's sending marks it as sent.
      if (!invoiceIsSent(inv) && !(await markSent())) return;
      const payload = { kind: 'invoice', invoiceId: inv.id, to: listOf(toValue), cc: listOf(cc), message: message.trim() || null };
      if (schedule) {
        const r = await api.post<{ scheduled: { at: string } }>('/api/email', { ...payload, at: new Date(at).toISOString() });
        toast.success('Email scheduled', { description: `${inv.number} goes on ${when(r.scheduled.at)}.` });
      } else {
        const r = await api.post<{ to: string[] }>('/api/email', payload);
        toast.success('Emailed', { description: `To ${r.to.join(', ')}, with a link to view and pay it.` });
      }
      onChanged();
      onClose();
    } catch (e) {
      toast.error(schedule ? 'Not scheduled' : 'Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const callOff = async (id: string) => {
    try {
      await api.delete(`/api/email?scheduledId=${id}`);
      toast.success('Scheduled email called off');
      info.refetch();
    } catch (e) {
      toast.error('Not called off', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl" data-slot="email-invoice-dialog">
        <DialogHeader>
          <DialogTitle>{schedule ? 'Schedule Email' : `Email To ${inv.customer.name}`}</DialogTitle>
          <DialogDescription>
            {configured
              ? `${inv.number} for ${formatINR(inv.totalPaise)}, with a link to view${inv.balancePaise > 0 ? ' and pay' : ''} it${info.data?.from ? `, from ${info.data.from}` : ''}.`
              : 'Email is not set up on this server (Settings → Email). Use Share to send a link by WhatsApp or your own mail app instead.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="block space-y-1"><span className="text-muted-foreground">Send To</span>
            <Input value={toValue} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" data-slot="email-to" />
          </label>
          <label className="block space-y-1"><span className="text-muted-foreground">Cc</span>
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Separate several with commas" />
          </label>
          <label className="block space-y-1"><span className="text-muted-foreground">Message</span>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder="Added above the invoice's own wording (optional)" />
          </label>
          {schedule && (
            <label className="block space-y-1"><span className="text-muted-foreground">Send on</span>
              <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} data-slot="schedule-at" />
            </label>
          )}
          {!!info.data?.scheduled?.length && (
            <div className="rounded-md border bg-muted/40 p-2.5" data-slot="scheduled-emails">
              <p className="mb-1 font-medium">Scheduled</p>
              {info.data.scheduled.map((x) => (
                <div key={x.id} className="flex items-center gap-2">
                  <CalendarClock className="size-3.5 text-muted-foreground" /> {when(x.at)}{x.to.length ? ` · ${x.to.join(', ')}` : ''}
                  <button type="button" className="ml-auto text-destructive hover:underline" onClick={() => void callOff(x.id)}><X className="inline size-3.5" /> Call off</button>
                </div>
              ))}
            </div>
          )}
          {!invoiceIsSent(inv) && <p className="text-muted-foreground">The invoice is marked as sent when it goes.</p>}
        </div>
        <DialogFooter>
          <Button onClick={() => void go()} disabled={busy || !configured || !listOf(toValue).length} data-slot="email-send">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {schedule ? 'Schedule' : 'Send'}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Share — "Share Invoice Link", after marking a draft as sent. */
export function InvoiceShare({ inv, markSent, onChanged, autoOpen = false }: {
  inv: InvoiceDetail; markSent: () => Promise<boolean>; onChanged: () => void;
  /** Open at once: the form's Save and Send ▾ → Save and Share. */
  autoOpen?: boolean;
}) {
  const canShare = usePermission('sales', 'export');
  const canEdit = usePermission('sales', 'edit');
  const [step, setStep] = useState<null | 'confirm' | 'share'>(null);
  const [expires, setExpires] = useState(addDays(90));
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!autoOpen || opened || !canShare || inv.status === 'void') return;
    setOpened(true);
    setStep(invoiceIsSent(inv) ? 'share' : 'confirm');
  }, [autoOpen, opened, canShare, inv]);
  if (!canShare || inv.status === 'void') return null;

  const open = () => setStep(invoiceIsSent(inv) ? 'share' : 'confirm');
  const confirm = async () => {
    setBusy(true);
    const ok = await markSent();
    setBusy(false);
    if (ok) { onChanged(); setStep('share'); }
  };
  const days = Math.min(180, Math.max(1, Math.round((new Date(`${expires}T23:59:59`).getTime() - Date.now()) / 86_400_000)));
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ path: string; expiresAt: string }>('/api/share', { invoiceId: inv.id, days });
      setUrl(`${window.location.origin}${r.path}`);
    } catch (e) {
      toast.error('No link', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const disableAll = async () => {
    if (!window.confirm(`Stop every link to ${inv.number} working? Anyone who has one will be told to ask for a new one.`)) return;
    try {
      const r = await api.patch<{ revoked: number }>('/api/share', { invoiceId: inv.id });
      setUrl('');
      toast.success(r.revoked ? `${r.revoked} link${r.revoked === 1 ? '' : 's'} disabled` : 'There were no active links');
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const message = `Dear ${inv.customer.name}, please find invoice ${inv.number} for ${formatINR(inv.totalPaise)}: ${url}\n— ${inv.seller.name}`;

  return (
    <>
      <Button variant="outline" size="sm" onClick={open} data-slot="share-invoice">Share</Button>
      <Dialog open={step === 'confirm'} onOpenChange={(v) => !v && setStep(null)}>
        <DialogContent className="sm:max-w-md" data-slot="share-mark-sent">
          <DialogHeader>
            <DialogTitle>Mark the invoice as sent and share?</DialogTitle>
            <DialogDescription>You can share an invoice only if it is already sent or is marked as sent. You can mark this invoice as sent and share it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => void confirm()} disabled={busy || !canEdit}>Mark as Sent and Share</Button>
            <Button variant="outline" onClick={() => setStep(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={step === 'share'} onOpenChange={(v) => { if (!v) { setStep(null); setUrl(''); } }}>
        <DialogContent className="sm:max-w-lg" data-slot="share-invoice-dialog">
          <DialogHeader>
            <DialogTitle>Share Invoice Link</DialogTitle>
            <DialogDescription>
              Visibility: <b>Public</b>. Select an expiration date and generate the link to share it with your customer.
              Remember that anyone who has access to this link can view, print or download it.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1 text-[13px]"><span className="text-muted-foreground">Link Expiration Date</span>
            <Input type="date" value={expires} min={addDays(1)} max={addDays(180)} onChange={(e) => setExpires(e.target.value)} data-slot="share-expires" />
          </label>
          <p className="text-xs text-muted-foreground">By default, the link is set to expire 90 days from today; it can be kept open for up to 180 days.</p>
          {url && (
            <div className="space-y-2" data-slot="share-url">
              <div className="flex gap-2"><Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <Button variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success('Link copied'))}><Copy className="size-3.5" /> Copy Link</Button></div>
              <div className="flex flex-wrap gap-2 text-[13px]">
                <Button variant="outline" size="sm" onClick={() => window.open(`https://wa.me/${whatsappNumber(inv.customer.phone)}?text=${encodeURIComponent(message)}`, '_blank', 'noopener')}>
                  <MessageCircle className="size-3.5" /> On WhatsApp
                </Button>
                <Button variant="outline" size="sm" onClick={() => window.open(`mailto:${encodeURIComponent(inv.customer.email ?? '')}?subject=${encodeURIComponent(`Invoice ${inv.number} from ${inv.seller.name}`)}&body=${encodeURIComponent(message)}`, '_self')}>
                  <Mail className="size-3.5" /> In my mail app
                </Button>
              </div>
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            {canEdit ? <Button variant="ghost" className="text-destructive" onClick={() => void disableAll()} data-slot="share-disable">Disable All Active Links</Button> : <span />}
            <Button onClick={() => void generate()} disabled={busy} data-slot="share-generate">{busy && <Loader2 className="size-3.5 animate-spin" />} Generate Link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
