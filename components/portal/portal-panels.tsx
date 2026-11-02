'use client';

// The parts of the customer and vendor portal (app/portal/[token]) beyond the
// lists: comments on a document, a reason when saying no, the shared files,
// and the contact keeping their own details up to date — as in Zoho Books'
// portal. Every call goes through the portal token, never a staff session.

import { useEffect, useRef, useState } from 'react';
import { Download, Landmark, MessageSquare, Send, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api/client';

export interface PortalComment { author: string; body: string; at: string; fromPortal: boolean }
export interface PortalDocument { id: string; filename: string; contentType: string; sizeBytes: number; fromYou: boolean; at: string }
export interface PortalProfile {
  email: string | null; phone: string | null;
  billingAddress: string | null; billingCity: string | null; billingPincode: string | null;
  shippingAddress: string | null; shippingCity: string | null; shippingPincode: string | null;
}
export interface PortalBank { bankName: string | null; accountName: string | null; accountLast4: string | null; ifsc: string | null }

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function portalPost<T = Record<string, unknown>>(token: string, body: Record<string, unknown>) {
  return api.post<T>(`/api/portal/${encodeURIComponent(token)}`, body);
}

/** The conversation under one document, and a box to add to it. */
export function CommentsButton({ token, targetType, targetId, label, business, comments, onSent }: {
  token: string; targetType: string; targetId: string; label: string; business: string;
  comments: PortalComment[] | undefined; onSent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const list = comments ?? [];
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await portalPost(token, { action: 'comment', targetType, targetId, body: text.trim() });
      setText('');
      toast.success('Comment sent', { description: `${business} will see it on ${label}.` });
      onSent();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="xs" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => setOpen(true)} aria-label={`Comments on ${label}`}>
        <MessageSquare className="size-3" />{list.length ? list.length : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Comments on {label}</DialogTitle>
            <DialogDescription>Ask a question or leave a note. {business} sees it on their copy.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {list.map((c, i) => (
              <div key={i} className={`rounded-md border p-2 text-sm ${c.fromPortal ? 'ml-6 bg-primary/5' : 'mr-6 bg-muted/40'}`}>
                <p className="text-xs text-muted-foreground">{c.fromPortal ? 'You' : c.author} · {when(c.at)}</p>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </div>
            ))}
            {!list.length && <p className="text-sm text-muted-foreground">No comments yet.</p>}
          </div>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder="Write a comment" />
          <DialogFooter>
            <Button onClick={send} disabled={busy || !text.trim()} className="gap-1.5"><Send className="size-4" /> {busy ? 'Sending…' : 'Send'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Asking for an optional reason before a yes or no goes back to the business. */
export interface NoteRequest { title: string; description: string; confirm: string; destructive?: boolean; run: (note: string) => Promise<void> }

export function NoteDialog({ request, onClose }: { request: NoteRequest | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (request) setNote(''); }, [request]);
  const go = async () => {
    if (!request) return;
    setBusy(true);
    try {
      await request.run(note.trim());
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!request} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} placeholder="A note (optional)" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={request?.destructive ? 'destructive' : 'default'} onClick={go} disabled={busy}>{busy ? 'Sending…' : request?.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Files the business shared, files the contact sent, and sending another. */
export function DocumentsPanel({ token, side, business, documents, onSent }: {
  token: string; side: 'customer' | 'vendor'; business: string; documents: PortalDocument[]; onSent: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.append('note', note);
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(token)}/upload`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Not sent');
      toast.success(side === 'vendor' ? 'Bill sent' : 'File sent', { description: side === 'vendor' ? 'It is with the accounts team to enter.' : `${business} has it.` });
      setNote('');
      onSent();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const base = `/api/portal/${encodeURIComponent(token)}/file`;
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-medium">File</th><th className="px-3 py-2 text-left font-medium">From</th><th className="px-3 py-2 text-left font-medium">Added</th><th className="px-3 py-2 text-right font-medium">Size</th></tr>
          </thead>
          <tbody>
            {documents.map((f) => (
              <tr key={f.id} className="border-t">
                <td className="px-3 py-2">
                  <a href={`${base}/${f.id}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{f.filename}</a>
                  <a href={`${base}/${f.id}?download`} className="ml-2 inline-flex text-muted-foreground hover:text-foreground" aria-label={`Download ${f.filename}`}><Download className="size-3.5" /></a>
                </td>
                <td className="px-3 py-2">{f.fromYou ? <Badge variant="outline" className="text-[10px]">Sent by you</Badge> : business}</td>
                <td className="px-3 py-2">{when(f.at)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{size(f.sizeBytes)}</td>
              </tr>
            ))}
            {!documents.length && <tr className="border-t"><td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">No files yet. Files {business} shares with you appear here.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card className="h-fit space-y-3 p-4">
        <p className="text-sm font-medium">{side === 'vendor' ? 'Send us a bill' : 'Send us a file'}</p>
        <p className="text-xs text-muted-foreground">
          {side === 'vendor' ? 'Your invoice as a PDF or a photo. It goes straight to our accounts team.' : 'A purchase order, remittance advice or anything we asked for. PDF, image, Excel or Word, up to 10 MB.'}
        </p>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={side === 'vendor' ? 'Bill number, which order it is for' : 'What it is'} />
        <input ref={fileRef} type="file" accept=".pdf,image/*,.xlsx,.docx,.csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        <Button onClick={() => fileRef.current?.click()} disabled={busy} className="w-full gap-1.5"><Upload className="size-4" /> {busy ? 'Sending…' : 'Choose a file and send'}</Button>
      </Card>
    </div>
  );
}

const PROFILE_FIELDS: { key: keyof PortalProfile; label: string; area?: boolean; max: number }[] = [
  { key: 'email', label: 'Email', max: 190 }, { key: 'phone', label: 'Phone', max: 30 },
  { key: 'billingAddress', label: 'Billing address', area: true, max: 500 }, { key: 'billingCity', label: 'City', max: 60 }, { key: 'billingPincode', label: 'PIN code', max: 6 },
  { key: 'shippingAddress', label: 'Shipping address', area: true, max: 500 }, { key: 'shippingCity', label: 'City', max: 60 }, { key: 'shippingPincode', label: 'PIN code', max: 6 },
];

/** The contact's own address, email and phone; saved straight to the business's record of them. */
export function ProfilePanel({ token, side, profile, bank, bankChangePendingSince, onSaved }: {
  token: string; side: 'customer' | 'vendor'; profile: PortalProfile; bank?: PortalBank; bankChangePendingSince?: string | null; onSaved: () => void;
}) {
  const [form, setForm] = useState<PortalProfile>(profile);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(profile), [profile]);
  const dirty = PROFILE_FIELDS.some((f) => (form[f.key] ?? '') !== (profile[f.key] ?? ''));
  const save = async () => {
    setBusy(true);
    try {
      const r = await portalPost<{ changed: string[]; emailPending: string | null }>(token, { action: 'profile', ...form });
      if (r.emailPending) toast.info(`We will confirm ${r.emailPending} before invoices and sign-in codes go there`);
      if (r.changed.length) toast.success('Your details are updated');
      else if (!r.emailPending) toast.success('Nothing had changed');
      onSaved();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (f: (typeof PROFILE_FIELDS)[number]) => (
    <div key={f.key} className={f.area ? 'space-y-1 sm:col-span-2' : 'space-y-1'}>
      <Label htmlFor={`pf-${f.key}`}>{f.label}</Label>
      {f.area ? (
        <Textarea id={`pf-${f.key}`} rows={2} maxLength={f.max} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
      ) : (
        <Input id={`pf-${f.key}`} maxLength={f.max} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
      )}
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-5">
        <div>
          <p className="font-medium">Your details</p>
          <p className="text-xs text-muted-foreground">What we put on {side === 'customer' ? 'invoices and deliveries' : 'purchase orders and payments'}. Changes reach us straight away.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">{PROFILE_FIELDS.slice(0, 2).map(field)}</div>
        <div className="grid gap-3 sm:grid-cols-2">{PROFILE_FIELDS.slice(2, 5).map(field)}</div>
        {side === 'customer' && <div className="grid gap-3 sm:grid-cols-2">{PROFILE_FIELDS.slice(5).map(field)}</div>}
        <Button onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
      </Card>
      {side === 'vendor' && bank && <BankPanel token={token} bank={bank} pendingSince={bankChangePendingSince ?? null} onSent={onSaved} />}
    </div>
  );
}

/** Where a vendor is paid. A change is a request the business approves, never applied from here. */
function BankPanel({ token, bank, pendingSince, onSent }: { token: string; bank: PortalBank; pendingSince: string | null; onSent: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ bankName: '', accountName: '', accountNo: '', confirmNo: '', ifsc: '' });
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (form.accountNo.replace(/\s/g, '') !== form.confirmNo.replace(/\s/g, '')) { toast.error('The two account numbers do not match.'); return; }
    setBusy(true);
    try {
      await portalPost(token, { action: 'bank-details', bankName: form.bankName, accountName: form.accountName, accountNo: form.accountNo, ifsc: form.ifsc });
      toast.success('Request sent', { description: 'We will confirm the new account with you before paying into it.' });
      setEditing(false);
      setForm({ bankName: '', accountName: '', accountNo: '', confirmNo: '', ifsc: '' });
      onSent();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start gap-2">
        <Landmark className="mt-0.5 size-4 text-muted-foreground" />
        <div>
          <p className="font-medium">Where we pay you</p>
          <p className="text-xs text-muted-foreground">For your safety, a new account is checked with you by phone before any payment goes to it.</p>
        </div>
      </div>
      {bank.accountLast4 ? (
        <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Bank</dt><dd>{bank.bankName || '—'}</dd>
          <dt className="text-muted-foreground">Account name</dt><dd>{bank.accountName || '—'}</dd>
          <dt className="text-muted-foreground">Account no.</dt><dd className="tabular-nums">••••{bank.accountLast4}</dd>
          <dt className="text-muted-foreground">IFSC</dt><dd>{bank.ifsc || '—'}</dd>
        </dl>
      ) : <p className="text-sm text-muted-foreground">We do not have your bank account yet.</p>}
      {pendingSince && (
        <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <ShieldCheck className="size-3.5" /> Your change of account, sent {when(pendingSince)}, is waiting for our check.
        </p>
      )}
      {editing ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="bk-name">Bank name</Label><Input id="bk-name" maxLength={100} value={form.bankName} onChange={set('bankName')} /></div>
            <div className="space-y-1"><Label htmlFor="bk-holder">Name on the account</Label><Input id="bk-holder" maxLength={150} value={form.accountName} onChange={set('accountName')} /></div>
            <div className="space-y-1"><Label htmlFor="bk-no">Account number</Label><Input id="bk-no" inputMode="numeric" autoComplete="off" maxLength={30} value={form.accountNo} onChange={set('accountNo')} /></div>
            <div className="space-y-1"><Label htmlFor="bk-no2">Account number again</Label><Input id="bk-no2" inputMode="numeric" autoComplete="off" maxLength={30} value={form.confirmNo} onChange={set('confirmNo')} onPaste={(e) => e.preventDefault()} /></div>
            <div className="space-y-1"><Label htmlFor="bk-ifsc">IFSC</Label><Input id="bk-ifsc" maxLength={11} value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })} /></div>
          </div>
          <div className="flex gap-2">
            <Button onClick={send} disabled={busy || !form.accountNo || !form.ifsc || !form.accountName}>{busy ? 'Sending…' : 'Send for approval'}</Button>
            <Button variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setEditing(true)}>{bank.accountLast4 ? 'Change bank account' : 'Give bank details'}</Button>
      )}
    </Card>
  );
}
