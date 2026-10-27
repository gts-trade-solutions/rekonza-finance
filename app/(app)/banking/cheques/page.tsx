'use client';

// The cheque register — paper in a drawer, not a ledger.
//
// A post-dated cheque changes no balance until it clears. The money is neither
// yours nor theirs while it waits to mature, and booking it early would show
// cash you cannot spend. Marking one cleared here does not post anything: the
// money arriving is a payment, recorded against the invoice or bill it settles,
// or the receipt would exist twice. The two are linked by the cheque number.
//
// A return is the one move that posts. The linked payment is reversed on the
// return date, so what it settled is owed again, and the bank's charge goes to
// bank charges or to the customer.
//
// What this screen answers is the question the ledger cannot: what is due to
// land next week, and what has bounced.

import { useMemo, useState } from 'react';
import { FileClock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';

interface ChequeRow {
  id: string;
  kind: 'issued' | 'received';
  chequeNo: string;
  bankName: string | null;
  contactId: string;
  contactName: string;
  amountPaise: number;
  isPdc: boolean;
  maturityDate: string;
  status: string;
  notes: string | null;
  paymentId: string | null;
  paymentNumber: string | null;
  paymentVoid: boolean;
  clearedOn: string | null;
  returnedOn: string | null;
  returnReason: string | null;
  returnChargesPaise: number;
  chargesToParty: boolean;
  noticeBy: string | null;
}

/** The bank return memo's usual reasons; anything else can be typed. */
const RETURN_REASONS = [
  'Funds insufficient',
  'Exceeds arrangement',
  'Payment stopped by drawer',
  'Drawer’s signature differs',
  'Account closed',
  'Amount in words and figures differ',
  'Cheque stale or post-dated',
  'Alterations need the drawer’s authentication',
];

interface ChequesResponse {
  cheques: ChequeRow[];
  summary: {
    pdcInPaise: number; pdcInCount: number;
    pdcOutPaise: number; pdcOutCount: number;
    bouncedPaise: number; bouncedCount: number;
  };
}

const today = () => new Date().toISOString().slice(0, 10);

const BLANK = {
  kind: 'received' as 'received' | 'issued',
  contactId: '', chequeNo: '', bankName: '', amount: 0, maturityDate: today(), notes: '',
};

export default function ChequesPage() {
  const canEdit = usePermission('banking', 'edit');

  const state = useApi<ChequesResponse>(() => api.get('/api/banking/cheques'), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);

  const create = useApiAction((input: unknown) =>
    api.post<{ id: string; chequeNo: string; isPdc: boolean }>('/api/banking/cheques', input),
  );
  const setStatus = useApiAction((input: unknown) =>
    api.patch<{ id: string; status: string }>('/api/banking/cheques', input),
  );

  const save = async () => {
    if (!f.contactId || !f.chequeNo.trim() || f.amount <= 0) {
      toast.error('Pick a party, and enter a cheque number and amount.');
      return;
    }
    const done = await create.run({
      kind: f.kind,
      contactId: f.contactId,
      chequeNo: f.chequeNo.trim(),
      bankName: f.bankName || null,
      amountPaise: f.amount,
      maturityDate: f.maturityDate,
      notes: f.notes || null,
    });
    if (!done) {
      toast.error(create.error ?? 'The cheque was not recorded');
      return;
    }
    toast.success(`Cheque ${done.chequeNo} recorded`, {
      description: done.isPdc
        ? 'Post-dated — nothing posts until it matures and clears.'
        : 'Nothing posts until it clears; record the payment then.',
    });
    setOpen(false);
    setF(BLANK);
    state.refetch();
  };

  const [returning, setReturning] = useState<ChequeRow | null>(null);

  const mark = async (r: ChequeRow, status: 'cleared' | 'deposited' | 'cancelled') => {
    if (status === 'cancelled' && !window.confirm(`Cancel cheque ${r.chequeNo}? It stays in the register, marked cancelled.`)) return;
    const done = await setStatus.run({ id: r.id, status }) as { paymentNumber?: string | null } | null;
    if (!done) {
      toast.error(setStatus.error ?? 'That could not be changed');
      return;
    }
    if (status === 'cleared') {
      toast.success(`Cheque ${r.chequeNo} cleared`, {
        description: done.paymentNumber
          ? `Linked to ${done.paymentNumber}.`
          : `No ${r.kind === 'received' ? 'receipt' : 'payment'} with this cheque number was found. Record it with ` +
            `${r.chequeNo} as the reference and it links itself, so a later return can reverse it.`,
      });
    } else {
      toast.success(`Cheque ${r.chequeNo} marked ${status}`);
    }
    state.refetch();
  };

  const cols = (kind: 'received' | 'issued'): Column<ChequeRow>[] => [
    {
      key: 'no', header: 'Cheque no.', sortValue: (r) => r.chequeNo,
      cell: (r) => <span className="font-mono font-medium">{r.chequeNo}</span>,
    },
    {
      key: 'party', header: kind === 'received' ? 'From' : 'To',
      sortValue: (r) => r.contactName, cell: (r) => r.contactName,
    },
    {
      key: 'bank', header: 'Bank', sortValue: (r) => r.bankName ?? '',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.bankName ?? '—'}</span>,
    },
    {
      key: 'maturity', header: 'Maturity', sortValue: (r) => r.maturityDate,
      cell: (r) => {
        const future = r.maturityDate > today();
        return (
          <div className="flex items-center gap-2">
            <span className={future ? 'text-muted-foreground' : undefined}>
              {new Date(r.maturityDate).toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: '2-digit',
              })}
            </span>
            {r.isPdc && <Badge variant="outline" className="border-amber-500/40 text-[10px]">PDC</Badge>}
          </div>
        );
      },
    },
    {
      key: 'status', header: 'Status', sortValue: (r) => r.status,
      cell: (r) => (
        <div className="space-y-0.5">
          <StatusBadge status={r.status} />
          {r.status === 'bounced' && r.returnReason && (
            <p className="max-w-48 text-[11px] leading-snug text-muted-foreground">{r.returnReason}</p>
          )}
          {r.noticeBy && (
            <p className={`text-[11px] leading-snug ${r.noticeBy < today() ? 'text-muted-foreground' : 'text-destructive'}`}
              title="Section 138(b), Negotiable Instruments Act: a demand notice must reach the drawer within 30 days of the return memo.">
              {r.noticeBy < today() ? 'Notice window closed ' : 'Legal notice by '}
              {new Date(`${r.noticeBy}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'payment', header: kind === 'received' ? 'Receipt' : 'Payment', sortValue: (r) => r.paymentNumber ?? '',
      cell: (r) => r.paymentNumber
        ? <span className={`text-xs ${r.paymentVoid ? 'text-muted-foreground line-through' : ''}`}>{r.paymentNumber}</span>
        : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise,
      cell: (r) => (
        <div>
          <Money value={r.amountPaise} className="font-medium" />
          {r.returnChargesPaise > 0 && (
            <p className="text-[11px] text-muted-foreground">
              + <Money value={r.returnChargesPaise} /> charges{r.chargesToParty ? ', to customer' : ''}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) =>
        !canEdit || r.status === 'bounced' || r.status === 'cancelled' ? null : (
          <div className="flex justify-end gap-1.5">
            {r.status === 'in_hand' && (
              <Button size="xs" variant="ghost" disabled={setStatus.busy} onClick={() => void mark(r, 'deposited')}>
                Deposited
              </Button>
            )}
            {r.status !== 'cleared' && (
              <Button size="xs" variant="outline" disabled={setStatus.busy} onClick={() => void mark(r, 'cleared')}>
                Cleared
              </Button>
            )}
            <Button size="xs" variant="outline" disabled={setStatus.busy} onClick={() => setReturning(r)}>
              Returned
            </Button>
            {r.status === 'in_hand' && !r.paymentNumber && (
              <Button size="xs" variant="ghost" disabled={setStatus.busy} onClick={() => void mark(r, 'cancelled')}>
                Cancel
              </Button>
            )}
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Cheques & post-dated cheques"
        description="A register for cheques in hand, PDCs waiting to mature, and any that bounced."
        actions={
          canEdit && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> Record cheque</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Record a cheque</DialogTitle>
                  <DialogDescription>
                    Nothing posts to the ledger here. Record the payment against the invoice or bill it settles,
                    with this cheque number as the reference, and the two link — so a return can reverse it.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Direction" required>
                    <Combobox
                      options={[
                        { value: 'received', label: 'Received from a customer' },
                        { value: 'issued', label: 'Issued to a supplier' },
                      ]}
                      value={f.kind}
                      onChange={(v) => setF({ ...f, kind: v as 'received' | 'issued', contactId: '' })}
                      showAvatar={false}
                    />
                  </Field>
                  <Field label={f.kind === 'received' ? 'From' : 'To'} required>
                    <ContactPicker
                      kind={f.kind === 'received' ? 'customer' : 'vendor'}
                      value={f.contactId}
                      onChange={(v) => setF({ ...f, contactId: v })}
                      placeholder="Select a party"
                      canCreate={canEdit}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Cheque number" required error={create.fieldErrors.chequeNo}>
                      <Input
                        value={f.chequeNo}
                        onChange={(e) => setF({ ...f, chequeNo: e.target.value })}
                        placeholder="000001"
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Drawn on" hint="The party's bank">
                      <Input
                        value={f.bankName}
                        onChange={(e) => setF({ ...f, bankName: e.target.value })}
                        placeholder="Bank name"
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Amount" required>
                      <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />
                    </Field>
                    <Field label="Date on the cheque" required hint="A future date makes it post-dated">
                      <Input
                        type="date"
                        value={f.maturityDate}
                        onChange={(e) => setF({ ...f, maturityDate: e.target.value })}
                      />
                    </Field>
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Record cheque'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) => {
          const received = d.cheques.filter((c) => c.kind === 'received');
          const issued = d.cheques.filter((c) => c.kind === 'issued');
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="PDCs to receive"
                  value={formatINRCompact(d.summary.pdcInPaise)}
                  sub={`${d.summary.pdcInCount} cheque(s) maturing`}
                  tone="positive"
                />
                <StatTile
                  label="PDCs issued"
                  value={formatINRCompact(d.summary.pdcOutPaise)}
                  sub={`${d.summary.pdcOutCount} cheque(s) to honour`}
                  tone="warning"
                />
                <StatTile
                  label="Bounced"
                  value={formatINRCompact(d.summary.bouncedPaise)}
                  sub={`${d.summary.bouncedCount} cheque(s) returned`}
                  tone={d.summary.bouncedCount ? 'danger' : 'default'}
                />
              </div>

              {d.cheques.length === 0 ? (
                <EmptyState
                  icon={FileClock}
                  title="No cheques recorded"
                  description="Track cheques in hand and post-dated cheques here."
                />
              ) : (
                <Tabs defaultValue="received">
                  <TabsList>
                    <TabsTrigger value="received">Received ({received.length})</TabsTrigger>
                    <TabsTrigger value="issued">Issued ({issued.length})</TabsTrigger>
                  </TabsList>
                  <TabsContent value="received" className="mt-4">
                    <DataTable
                      rows={received}
                      columns={cols('received')}
                      getRowId={(r) => r.id}
                      searchable={false}
                      dateFilter={{ getDate: (r) => r.maturityDate }}
                      emptyMessage="No cheques received."
                    />
                  </TabsContent>
                  <TabsContent value="issued" className="mt-4">
                    <DataTable
                      rows={issued}
                      columns={cols('issued')}
                      getRowId={(r) => r.id}
                      searchable={false}
                      dateFilter={{ getDate: (r) => r.maturityDate }}
                      emptyMessage="No cheques issued."
                    />
                  </TabsContent>
                </Tabs>
              )}
            </>
          );
        }}
      </AsyncPage>

      <ReturnDialog cheque={returning} onClose={() => setReturning(null)} onDone={() => { setReturning(null); state.refetch(); }} />
    </>
  );
}

function ReturnDialog({ cheque, onClose, onDone }: { cheque: ChequeRow | null; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState(RETURN_REASONS[0]);
  const [charges, setCharges] = useState(0);
  const [toParty, setToParty] = useState(false);
  const [bankAccountId, setBankAccountId] = useState('');
  const send = useApiAction((input: unknown) =>
    api.patch<{ reversedPayment: string | null }>('/api/banking/cheques', input),
  );
  // Needed only when the charge cannot be placed by the payment's own account.
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const bankOptions = useMemo(
    () => (masters.data?.bankAccounts ?? []).filter((b) => b.kind !== 'cash').map((b) => ({ value: b.id, label: b.name })),
    [masters.data],
  );
  const live = cheque && cheque.paymentNumber && !cheque.paymentVoid;
  const needsBank = !!cheque && charges > 0 && !live;

  const submit = async () => {
    if (!cheque) return;
    if (needsBank && !bankAccountId) {
      toast.error('Pick the bank account the charge came out of.');
      return;
    }
    const done = await send.run({
      id: cheque.id, status: 'bounced', date, reason, chargesPaise: charges,
      chargeToParty: cheque.kind === 'received' && toParty, bankAccountId: needsBank ? bankAccountId : null,
    });
    if (!done) {
      toast.error(send.error ?? 'The return was not recorded');
      return;
    }
    toast.success(`Cheque ${cheque.chequeNo} recorded as returned`, {
      description: done.reversedPayment
        ? `${done.reversedPayment} reversed on ${date}; what it settled is owed again.`
        : 'No payment was linked to it, so there was nothing in the books to reverse.',
    });
    setCharges(0); setToParty(false);
    onDone();
  };

  return (
    <Dialog open={!!cheque} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {cheque && (
          <>
            <DialogHeader>
              <DialogTitle>Cheque {cheque.chequeNo} returned</DialogTitle>
              <DialogDescription>
                {live
                  ? <>It paid {cheque.paymentNumber}. That {cheque.kind === 'received' ? 'receipt' : 'payment'} is reversed on the return date, and whatever it settled is owed again.</>
                  : <>No live {cheque.kind === 'received' ? 'receipt' : 'payment'} is linked to it, so only the status and any charge are recorded.</>}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Returned on" required hint="The date on the bank's return memo">
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field label="Return charges" hint="What the bank took for it">
                  <MoneyInput valuePaise={charges} onChangePaise={setCharges} />
                </Field>
              </div>
              <Field label="Bank's reason" required>
                <Input list="cheque-return-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
                <datalist id="cheque-return-reasons">
                  {RETURN_REASONS.map((r) => <option key={r} value={r} />)}
                </datalist>
              </Field>
              {cheque.kind === 'received' && charges > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={toParty} onChange={(e) => setToParty(e.target.checked)} />
                  <span>
                    Recover the charge from {cheque.contactName}
                    <span className="block text-xs text-muted-foreground">
                      Debited to their account instead of bank charges. No GST is added: charges for a dishonoured
                      cheque are not a supply (circular 178/10/2022-GST).
                    </span>
                  </span>
                </label>
              )}
              {needsBank && (
                <Field label="Charged to account" required>
                  <Combobox options={bankOptions} value={bankAccountId} onChange={setBankAccountId} showAvatar={false} placeholder="Select a bank account" />
                </Field>
              )}
              {cheque.kind === 'received' && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  To keep the right to a complaint under section 138 of the Negotiable Instruments Act, a written demand
                  must reach the drawer within 30 days of the return memo.
                </p>
              )}
              {send.error && <p className="text-sm text-destructive">{send.error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button variant="destructive" onClick={() => void submit()} disabled={send.busy || reason.trim().length < 3}>
                {send.busy ? 'Recording…' : 'Record return'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
