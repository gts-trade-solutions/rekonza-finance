'use client';

// Portal access on a customer's or vendor's page: give them a link to their
// own account (copied, or emailed when mail is set up), see when it was last
// opened, and withdraw it (services/portal.ts). Below it, what the portal adds
// as Zoho's does: files shared with them and sent by them, what they did on
// it, and a vendor's request for a new bank account, to approve or turn down.

import { useRef, useState } from 'react';
import { Copy, Globe, Landmark, ShieldAlert, Unlink, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Link { id: string; side: string; email: string | null; createdAt: string; expiresAt: string; live: boolean; opens: number; lastOpenedAt: string | null }
interface Request { id: string; status: 'pending' | 'applied' | 'rejected'; bankName: string; accountName: string; accountNoMasked: string; ifsc: string; at: string; decidedAt: string | null; decidedBy: string | null }
interface SharedFile { id: string; filename: string; sizeBytes: number; shared: boolean; at: string }
interface Activity { action: string; detail: string | null; at: string }
interface Comment { id: string; targetType: string; targetId: string; label: string; number: string; author: string; body: string; at: string; fromPortal: boolean }
interface State { links: Link[]; mail: boolean; requests: Request[]; files: SharedFile[]; activity: Activity[]; comments: Comment[] }

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PortalAccess({ contactId, side, defaultEmail, canEdit }: { contactId: string; side: 'customer' | 'vendor'; defaultEmail: string | null; canEdit: boolean }) {
  const state = useApi(() => api.get<State>('/api/portal-access', { contactId, side }), [contactId, side]);
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const live = (state.data?.links ?? []).filter((l) => l.live);
  const pending = (state.data?.requests ?? []).filter((r) => r.status === 'pending');
  const files = state.data?.files ?? [];
  const activity = state.data?.activity ?? [];
  const comments = state.data?.comments ?? [];
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  const give = async (send: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ url: string; expiresAt: string; emailed: boolean }>('/api/portal-access', { action: 'create', contactId, side, emailTo: send ? email : null });
      await navigator.clipboard.writeText(r.url).catch(() => {});
      toast.success(r.emailed ? `Portal link emailed to ${email}` : 'Portal link copied', { description: `${r.url} — works until ${r.expiresAt.slice(0, 10)}.` });
      state.refetch();
    } catch (e) {
      toast.error('No link', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const post = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post('/api/portal-access', { contactId, side, ...body });
      toast.success(done);
      state.refetch();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!window.confirm('Stop every portal link for this contact working?')) return;
    try {
      const r = await api.post<{ revoked: number }>('/api/portal-access', { action: 'revoke', contactId, side });
      toast.success(r.revoked ? 'Portal access withdrawn' : 'There were no live links');
      state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const share = async (file: File) => {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.append('contactId', contactId);
    form.append('side', side);
    try {
      const res = await fetch('/api/portal-access', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Not shared');
      toast.success('Shared on the portal', { description: `${file.name} is on their Documents tab.` });
      state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5" data-slot="portal-access">
      <div className="flex items-start gap-3">
        <Globe className="mt-0.5 size-5 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">{side === 'customer' ? 'Customer portal' : 'Vendor portal'}</p>
          <p className="text-muted-foreground">
            {side === 'customer'
              ? 'Their own page: invoices to view and pay, quotes to accept, sales orders, credit notes, statement, files, and comments on any of them.'
              : 'Their own page: purchase orders to accept, bills, payments, vendor credits, statement, files, and their bank details (changes need your approval).'}
            {' '}They open it from the link, or sign in at <span className="font-mono text-xs">/portal/login</span> with a code sent to their email.
          </p>
        </div>
      </div>

      {pending.map((r) => (
        <div key={r.id} className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-slot="bank-change-request">
          <p className="flex items-center gap-1.5 font-medium"><Landmark className="size-4" /> They asked to be paid into a new bank account</p>
          <dl className="grid grid-cols-[110px_1fr] gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Bank</dt><dd>{r.bankName || '—'}</dd>
            <dt className="text-muted-foreground">Account name</dt><dd>{r.accountName}</dd>
            <dt className="text-muted-foreground">Account no.</dt><dd className="tabular-nums">{r.accountNoMasked}</dd>
            <dt className="text-muted-foreground">IFSC</dt><dd>{r.ifsc}</dd>
            <dt className="text-muted-foreground">Asked</dt><dd>{when(r.at)}</dd>
          </dl>
          <p className="flex items-start gap-1.5 text-xs"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Before approving, ring the vendor on a number you already had — not one sent with this request — and read the account back to them. A changed account is the commonest way a supplier&apos;s payment is stolen.</p>
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => { if (window.confirm('Have you confirmed the new account with the vendor by phone?')) void post({ action: 'decide', requestId: r.id, decision: 'applied' }, 'New bank account approved and saved'); }}>Approve</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ action: 'decide', requestId: r.id, decision: 'rejected' }, 'Request turned down')}>Turn down</Button>
            </div>
          )}
        </div>
      ))}

      {live.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {live.length} live link{live.length === 1 ? '' : 's'}; opened {live.reduce((t, l) => t + l.opens, 0)} time(s)
          {live.find((l) => l.lastOpenedAt) ? `, last ${new Date(live.find((l) => l.lastOpenedAt)!.lastOpenedAt!).toLocaleString('en-IN')}` : ''}.
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {state.data?.mail && <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email to send it to" className="h-8 max-w-xs text-sm" />}
          {state.data?.mail && <Button size="sm" disabled={busy || !email} onClick={() => give(true)}>Email the link</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => give(false)} className="gap-1.5"><Copy className="size-3.5" /> Copy a link</Button>
          {live.length > 0 && <Button size="sm" variant="ghost" onClick={withdraw} className="gap-1.5"><Unlink className="size-3.5" /> Withdraw</Button>}
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">Files on the portal</p>
          {canEdit && (
            <>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void share(f); e.target.value = ''; }} />
              <Button size="xs" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} className="gap-1"><Upload className="size-3" /> Share a file</Button>
            </>
          )}
        </div>
        {files.length ? (
          <ul className="space-y-1 text-sm">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">{f.filename}</a>
                <Badge variant="outline" className="shrink-0 text-[10px]">{f.shared ? 'Shared by you' : 'Sent by them'}</Badge>
                <span className="text-xs text-muted-foreground">{when(f.at)}</span>
                {canEdit && f.shared && <button className="ml-auto text-xs text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => post({ action: 'unshare', fileId: f.id }, 'Taken off the portal')}>Take off</button>}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">None yet. Files they send from the portal land here too.</p>}
      </div>

      {comments.length > 0 && (
        <div className="space-y-2 border-t pt-3" data-slot="portal-conversation">
          <p className="text-xs font-medium text-muted-foreground">Portal conversation</p>
          <ul className="space-y-2 text-sm">
            {comments.slice(0, 10).map((m) => (
              <li key={m.id} className={`rounded-md border p-2 ${m.fromPortal ? 'bg-primary/5' : 'bg-muted/30'}`}>
                <p className="text-xs text-muted-foreground">{m.author} on {m.label} {m.number} · {when(m.at)}</p>
                <p className="whitespace-pre-wrap">{m.body}</p>
                {canEdit && m.fromPortal && (replyTo === m.id ? (
                  <div className="mt-2 flex gap-2">
                    <Input value={reply} onChange={(e) => setReply(e.target.value)} maxLength={2000} placeholder="Your reply, shown on their portal" className="h-8 text-sm" />
                    <Button size="sm" disabled={busy || !reply.trim()} onClick={async () => { if (await post({ action: 'reply', targetType: m.targetType, targetId: m.targetId, body: reply }, 'Reply sent')) { setReply(''); setReplyTo(null); } }}>Send</Button>
                  </div>
                ) : <button className="mt-1 text-xs text-primary hover:underline" onClick={() => { setReplyTo(m.id); setReply(''); }}>Reply</button>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {activity.length > 0 && (
        <div className="space-y-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Lately on the portal</p>
          <ul className="space-y-0.5 text-xs">
            {activity.map((a, i) => <li key={i}><span className="text-muted-foreground">{when(a.at)}</span> · {a.detail || a.action.replace(/_/g, ' ')}</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
