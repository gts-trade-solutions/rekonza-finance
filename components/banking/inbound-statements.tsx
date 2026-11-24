'use client';

// Zoho Books' "Auto-upload bank statements from email" (Banking → More) and the
// account page's "Bank Statements From Inbox" strip: each account's own
// address, who may send to it, and what has arrived
// (services/inbound-statements.ts, /api/banking/inbound).

import { useEffect, useState } from 'react';
import { Copy, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Inbound {
  configured: boolean;
  domain: string | null;
  enabled: boolean;
  senders: string[];
  accounts: { id: string; name: string; kind: string; address: string | null }[];
  recent: { id: string; at: string; sender: string | null; filename: string | null; status: 'imported' | 'refused' | 'failed'; imported: number; duplicates: number; reason: string | null; account: string | null }[];
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success('Address copied'));

/** Why a server cannot receive statements yet, in words an owner can pass to whoever runs it. */
function NotSetUp() {
  return (
    <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[12px]" data-slot="inbound-not-set-up">
      Email cannot be received on this server yet. Whoever runs it sets <b>INBOUND_EMAIL_DOMAIN</b> and <b>INBOUND_WEBHOOK_SECRET</b>, and
      points an inbound-mail service (Mailgun, SendGrid or Postmark) at <code>/api/inbound/statements</code>. The addresses below then work at once.
    </p>
  );
}

export function InboundStatementsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const canEdit = usePermission('banking', 'edit');
  const state = useApi<Inbound | null>(() => (open ? api.get('/api/banking/inbound') : Promise.resolve(null)), [open]);
  const [enabled, setEnabled] = useState(true);
  const [senders, setSenders] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!state.data) return;
    setEnabled(state.data.enabled);
    setSenders(state.data.senders.join('\n'));
  }, [state.data]);
  const d = state.data;

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/banking/preferences', { inboundEnabled: enabled, inboundSenders: senders.split(/[\s,;]+/).filter(Boolean) });
      toast.success('Saved');
      state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-slot="inbound-dialog">
        <DialogHeader>
          <DialogTitle>Auto-upload bank statements from email</DialogTitle>
          <DialogDescription>
            Forward the statement your bank emails you to the account&apos;s own address below, or have the bank send it there.
            It is imported into that account as Import Statement would: lines already in the books are kept out, and your rules run.
          </DialogDescription>
        </DialogHeader>
        {!d ? <p className="text-[13px] text-muted-foreground">Loading…</p> : (
          <div className="space-y-4 text-[13px]">
            {!d.configured && <NotSetUp />}
            <div className="divide-y rounded-md border" data-slot="inbound-addresses">
              {d.accounts.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-3 py-2">
                  <Mail className="size-4 text-muted-foreground" />
                  <span className="w-44 shrink-0 font-medium">{a.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" data-slot="inbound-address">{a.address ?? 'appears once inbound email is set up'}</span>
                  {a.address && <Button variant="outline" size="sm" onClick={() => copy(a.address!)}><Copy className="size-3.5" /> Copy</Button>}
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} disabled={!canEdit} data-slot="inbound-enabled" /> Accept statements sent to these addresses
            </label>
            <label className="block space-y-1">
              <span className="text-muted-foreground">Who may send, besides the people who sign in to this company (an address, or @bankdomain.com, one a line)</span>
              <Textarea rows={3} value={senders} onChange={(e) => setSenders(e.target.value)} disabled={!canEdit} placeholder="estatements@icicibank.com&#10;@hdfcbank.net" data-slot="inbound-senders" />
            </label>
            {!!d.recent.length && (
              <div data-slot="inbound-recent">
                <p className="mb-1 font-medium">Bank Statements From Inbox</p>
                <div className="max-h-48 divide-y overflow-y-auto rounded-md border">
                  {d.recent.map((r) => (
                    <div key={r.id} className="flex items-start gap-3 px-3 py-1.5 text-[12px]">
                      <span className="w-24 shrink-0 text-muted-foreground">{when(r.at)}</span>
                      <span className="w-32 shrink-0 truncate">{r.account ?? '—'}</span>
                      <span className="min-w-0 flex-1">
                        <span className={r.status === 'imported' ? 'text-success' : 'text-destructive'}>{r.status === 'imported' ? 'Imported' : r.status === 'failed' ? 'Could not be read' : 'Refused'}</span>
                        {' · '}{r.filename ?? 'no file'}{r.sender ? ` · from ${r.sender}` : ''}
                        {r.status === 'imported' ? ` · ${r.imported} new, ${r.duplicates} already in` : r.reason ? ` · ${r.reason}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {canEdit && <Button onClick={() => void save()} disabled={busy || !d} data-slot="inbound-save">Save</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The account page's strip (Zoho's "Bank Statements From Inbox"). */
export function InboxStrip({ accountId }: { accountId: string }) {
  const state = useApi<Inbound>(() => api.get('/api/banking/inbound', { accountId }), [accountId]);
  const [open, setOpen] = useState(false);
  const d = state.data;
  if (!d) return null;
  const address = d.accounts[0]?.address ?? null;
  const last = d.recent[0];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b bg-[#f6f9ff] px-5 py-2 text-[12.5px]" data-slot="inbox-strip">
        <Mail className="size-4 text-primary" />
        <span className="font-medium">Bank Statements From Inbox</span>
        {address ? (
          <>
            <span className="text-muted-foreground">Forward bank statements to</span>
            <span className="font-mono" data-slot="inbox-address">{address}</span>
            <button type="button" className="inline-flex items-center gap-1 text-link hover:underline" onClick={() => copy(address)}><Copy className="size-3.5" /> Copy</button>
          </>
        ) : <span className="text-muted-foreground">Statements can be emailed in once inbound email is set up on this server.</span>}
        <span className="ml-auto text-muted-foreground">
          {last ? (last.status === 'imported' ? `Last statement ${when(last.at)}: ${last.imported} new lines` : `Last email ${when(last.at)} was not imported`) : "Looks like you've added all your bank statements!"}
        </span>
        <button type="button" className="text-link hover:underline" onClick={() => setOpen(true)} data-slot="inbox-settings">Settings</button>
      </div>
      <InboundStatementsDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) state.refetch(); }} />
    </>
  );
}
