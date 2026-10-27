'use client';

// Payment reminders waiting to go, and those sent. The scheduler fills the
// queue each night on the days set under Settings → Policies; each reminder
// goes from the user's own WhatsApp, email or messages with its words and a
// link to the invoice already in it, and is then marked sent.

import Link from 'next/link';
import { useState } from 'react';
import { BellRing, Copy, Loader2, Mail, MessageCircle, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { whatsappNumber } from '@/components/sales/send-invoice';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Reminder {
  id: string; invoiceId: string; number: string; customer: string; stageDays: number; channel: 'whatsapp' | 'email' | 'sms';
  to: string | null; subject: string | null; message: string; status: 'queued' | 'sent' | 'skipped';
  queuedOn: string; sentAt: string | null; sentBy: string | null; dueDate: string; balancePaise: number; settled: boolean;
}
type Status = Reminder['status'];

const stage = (d: number) => (d < 0 ? `${-d} day${d === -1 ? '' : 's'} before due` : d === 0 ? 'On the due day' : `${d} day${d === 1 ? '' : 's'} late`);
const dmy = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function RemindersPage() {
  const canEdit = usePermission('sales', 'edit');
  const canShare = usePermission('sales', 'export');
  const [status, setStatus] = useState<Status>('queued');
  const state = useApi(() => api.get<{ reminders: Reminder[] }>('/api/reminders', { status }), [status]);
  const policy = useApi(() => api.get<{ reminders?: { enabled: boolean; stages: number[]; channel: string } }>('/api/settings/policies'), []);
  const [busy, setBusy] = useState<string | null>(null);

  const mark = async (r: Reminder, to: 'sent' | 'skipped') => {
    await api.patch('/api/reminders', { id: r.id, status: to });
    await state.refetch();
  };
  const send = async (r: Reminder, how: 'whatsapp' | 'email' | 'sms' | 'copy') => {
    setBusy(r.id);
    try {
      const { path } = await api.post<{ path: string }>('/api/share', { invoiceId: r.invoiceId });
      const text = r.message.replace('{link}', `${window.location.origin}${path}`);
      if (how === 'copy') {
        await navigator.clipboard.writeText(text);
        toast.success('Message copied', { description: 'Paste it where you send it, then mark it sent.' });
        return;
      }
      if (how === 'whatsapp') window.open(`https://wa.me/${whatsappNumber(r.to)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      else if (how === 'sms') window.open(`sms:${(r.to ?? '').replace(/\s/g, '')}?body=${encodeURIComponent(text)}`, '_self');
      else window.open(`mailto:${encodeURIComponent(r.to ?? '')}?subject=${encodeURIComponent(r.subject ?? '')}&body=${encodeURIComponent(text)}`, '_self');
      await mark(r, 'sent');
      toast.success(`Reminder to ${r.customer} marked sent`);
    } catch (e) {
      toast.error('Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const fill = async () => {
    setBusy('fill');
    try {
      const r = await api.post<{ queued: number }>('/api/reminders', {});
      toast.success(r.queued ? `${r.queued} reminder${r.queued === 1 ? '' : 's'} queued` : 'Nothing new to remind about today');
      await state.refetch();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const on = policy.data?.reminders?.enabled;
  return (
    <>
      <PageHeader
        title="Payment reminders"
        description="Reminders for invoices still owed, before and after they fall due. Each goes from your own WhatsApp, email or messages with a link to the invoice in it."
        actions={canEdit && on ? (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy === 'fill'} onClick={() => void fill()}>
            {busy === 'fill' ? <Loader2 className="size-3.5 animate-spin" /> : <BellRing className="size-3.5" />} Check for new ones now
          </Button>
        ) : undefined}
      />
      <div className="space-y-4">
        {policy.data && !on && (
          <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <BellRing className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>Reminders are off. Switch them on, and choose the days, under <Link href="/settings?tab=policies" className="text-primary hover:underline">Settings → Policies</Link>.</p>
          </Card>
        )}
        <div className="flex w-fit rounded-md border p-0.5 text-xs">
          {(['queued', 'sent', 'skipped'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)}
              className={cn('rounded px-2.5 py-1', status === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {s === 'queued' ? 'Waiting' : s === 'sent' ? 'Sent' : 'Skipped'}
            </button>
          ))}
        </div>
        <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
          {(d) => d.reminders.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">{status === 'queued' ? 'Nothing waiting to go.' : 'None yet.'}</Card>
          ) : (
            <div className="space-y-3">
              {d.reminders.map((r) => (
                <Card key={r.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{r.customer}</span>
                    <Link href={`/sales/invoices/${r.invoiceId}`} className="font-mono text-xs text-primary hover:underline">{r.number}</Link>
                    <Badge variant="outline" className="text-[10px]">{stage(r.stageDays)}</Badge>
                    <span className="text-xs text-muted-foreground">due {dmy(r.dueDate)} · owed <Money value={r.balancePaise} /></span>
                    {r.settled && <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300">Paid since</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {r.status === 'queued' ? `Queued ${dmy(r.queuedOn)}` : `${r.status === 'sent' ? 'Sent' : 'Skipped'} ${r.sentAt ? dmy(r.sentAt) : ''}${r.sentBy ? ` by ${r.sentBy}` : ''}`}
                    </span>
                  </div>
                  <p className="whitespace-pre-line rounded-md bg-muted/40 px-3 py-2 text-sm">{r.message}</p>
                  {r.status === 'queued' && canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">{r.to ? `To ${r.to}` : 'No contact details on file'}</span>
                      {canShare && !r.settled && (
                        <>
                          {r.channel === 'whatsapp' && <Button size="xs" className="gap-1" disabled={busy === r.id} onClick={() => void send(r, 'whatsapp')}><MessageCircle className="size-3" /> WhatsApp</Button>}
                          {r.channel === 'email' && <Button size="xs" className="gap-1" disabled={busy === r.id} onClick={() => void send(r, 'email')}><Mail className="size-3" /> Email</Button>}
                          {r.channel === 'sms' && <Button size="xs" className="gap-1" disabled={busy === r.id} onClick={() => void send(r, 'sms')}><MessageSquare className="size-3" /> Message</Button>}
                          <Button size="xs" variant="outline" className="gap-1" disabled={busy === r.id} onClick={() => void send(r, 'copy')}><Copy className="size-3" /> Copy</Button>
                          <Button size="xs" variant="ghost" onClick={() => void mark(r, 'sent')}>Mark sent</Button>
                        </>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => void mark(r, 'skipped')}>Skip</Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </AsyncPage>
      </div>
    </>
  );
}
