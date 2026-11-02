'use client';

// Settings → Integrations → Online payments: the business's own Razorpay
// account, for payment links on invoices. The secrets are sealed on the
// server and never shown again; the webhook address is what Razorpay calls
// when an invoice is paid (event payment_link.paid).

import { useMemo, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

interface Status { connected: boolean; keyId: string | null; depositTo: string | null; test: boolean; canStore: boolean; webhookUrl: string }

export function PaymentsPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.get<Status>('/api/payment-links'), []);
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const banks = useMemo(() => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data]);
  const [f, setF] = useState({ keyId: '', keySecret: '', webhookSecret: '', depositBankAccountId: '' });
  const [editing, setEditing] = useState(false);
  const connect = useApiAction((input: typeof f) => api.post<Status>('/api/payment-links', { action: 'connect', ...input }));
  const s = state.data;

  const save = async () => {
    if (!(await connect.run(f))) { toast.error(connect.error ?? 'Not connected'); return; }
    toast.success('Razorpay connected', { description: 'Invoices can now carry a payment link.' });
    setEditing(false);
    setF({ keyId: '', keySecret: '', webhookSecret: '', depositBankAccountId: '' });
    state.refetch();
  };

  return (
    <Card className="space-y-3 p-5" data-slot="payments-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <CreditCard className="mt-0.5 size-5 text-muted-foreground" />
          <div>
            <p className="font-medium">Online payments (Razorpay)</p>
            <p className="text-sm text-muted-foreground">A payment link on each invoice; when the customer pays, the receipt records itself.</p>
          </div>
        </div>
        {s?.connected ? <Badge variant="secondary">{s.test ? 'Connected · test mode' : 'Connected'}</Badge> : <Badge variant="outline">Not connected</Badge>}
      </div>
      {s?.connected && (
        <p className="text-sm">Key {s.keyId} · settlements booked to <strong>{s.depositTo}</strong></p>
      )}
      {s && (
        <p className="break-all text-xs text-muted-foreground">
          Webhook URL for your Razorpay dashboard (event <code>payment_link.paid</code>): <code>{s.webhookUrl}</code>
        </p>
      )}
      {s && !s.canStore && (
        <p className="text-xs text-destructive">INTEGRATION_KEY is not set on this server, so the Razorpay secret cannot be stored. Set it, then connect.</p>
      )}
      {canEdit && !editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!s?.canStore}>{s?.connected ? 'Change keys' : 'Connect Razorpay'}</Button>}
      {editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Key id"><Input value={f.keyId} onChange={(e) => setF({ ...f, keyId: e.target.value })} placeholder="rzp_live_…" /></Field>
          <Field label="Key secret"><Input type="password" value={f.keySecret} onChange={(e) => setF({ ...f, keySecret: e.target.value })} /></Field>
          <Field label="Webhook secret"><Input type="password" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} /></Field>
          <Field label="Book settlements to" hint="A Razorpay clearing account, or the bank it settles into">
            <Combobox options={banks} value={f.depositBankAccountId} onChange={(v) => setF({ ...f, depositBankAccountId: v })} placeholder="Account" showAvatar={false} />
          </Field>
          {connect.error && <p className="text-sm text-destructive sm:col-span-2">{connect.error}</p>}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={connect.busy}>{connect.busy ? 'Connecting…' : 'Connect'}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
