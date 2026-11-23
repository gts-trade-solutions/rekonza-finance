'use client';

// Zoho Books' "Add Transaction ▾" on a bank account: a transaction recorded
// straight from the account, before (or without) a statement line. The menu
// is Zoho's MONEY OUT and MONEY IN lists; the form asks what the entry needs,
// from the same categories a statement line is categorised by
// (lib/bank-categories.ts), and posts through the same engine
// (services/bank-match.ts addAccountTransaction). When the statement comes,
// its line is matched to what was entered here.
//
// A customer's or vendor's payment against invoices or bills opens the full
// Record Payment form on this account, where the documents are picked.

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { FormErrors } from '@/components/shared/form-layout';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { BANK_CATEGORIES, type BankCategory } from '@/lib/bank-categories';
import { formatINR } from '@/lib/money';
import { today } from '@/lib/selectors';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export type AddKind = BankCategory['key'] | 'credit_note_refund' | 'retainer_payment';

interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind?: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

/** Zoho's menu, in its order: what it shows first, then the rest of the categories. */
const MONEY_OUT: AddKind[] = ['expense', 'transfer_to', 'credit_note_refund', 'payment_refund', 'vendor_payment', 'vendor_advance', 'card_payment',
  'owner_drawings', 'employee_reimbursement', 'deposit_to_other'];
const MONEY_IN: AddKind[] = ['customer_payment', 'retainer_payment', 'transfer_from', 'expense_refund', 'deposit_from_other', 'customer_advance',
  'sales_without_invoice', 'interest_income', 'other_income', 'owner_contribution', 'vendor_refund'];

const EXTRA: Record<'credit_note_refund' | 'retainer_payment', { label: string; side: 'in' | 'out'; hint: string }> = {
  credit_note_refund: { label: 'Credit Note Refund', side: 'out', hint: 'Money returned to a customer out of a credit note: its balance comes down.' },
  retainer_payment: { label: 'Retainer Payment', side: 'in', hint: 'A customer paid a retainer invoice.' },
};
export const addKindLabel = (k: AddKind) =>
  k === 'credit_note_refund' || k === 'retainer_payment' ? EXTRA[k].label : BANK_CATEGORIES.find((c) => c.key === k)?.label ?? k;

const RATES = [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }));

/** The blue "Add Transaction ▾" with Zoho's MONEY OUT and MONEY IN lists. */
export function AddTransactionMenu({ onPick, kind }: { onPick: (k: AddKind) => void; kind: string }) {
  // A card's money out is spending on it; what pays a card off is money in from a bank.
  const outs = kind === 'card' ? MONEY_OUT.filter((k) => k !== 'card_payment') : MONEY_OUT;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-1" data-slot="add-transaction">Add Transaction <ChevronDown className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase text-muted-foreground">Money Out</DropdownMenuLabel>
        {outs.map((k) => <DropdownMenuItem key={k} onClick={() => onPick(k)} data-slot="add-kind" data-kind={k}>{addKindLabel(k)}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase text-muted-foreground">Money In</DropdownMenuLabel>
        {MONEY_IN.map((k) => <DropdownMenuItem key={k} onClick={() => onPick(k)} data-slot="add-kind" data-kind={k}>{addKindLabel(k)}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The form for one entry, in Zoho's side panel. */
export function AddTransactionSheet({ kind, account, onClose, onDone, preset }: {
  kind: AddKind | null;
  account: { id: string; name: string; kind: string };
  onClose: () => void;
  onDone: () => void;
  /** Record Deposit: the other account to start on (the payment clearing account). */
  preset?: { otherBankAccountId?: string };
}) {
  const router = useRouter();
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const cat = kind && kind !== 'credit_note_refund' && kind !== 'retainer_payment' ? BANK_CATEGORIES.find((c) => c.key === kind) ?? null : null;
  const side = kind ? (cat?.side ?? EXTRA[kind as 'credit_note_refund'].side) : 'in';
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState(0);
  const [contactId, setContactId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [otherId, setOtherId] = useState(preset?.otherBankAccountId ?? '');
  const [rate, setRate] = useState('0');
  const [docId, setDocId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // A new entry starts clean.
  useEffect(() => {
    setDate(today()); setAmount(0); setContactId(''); setAccountId(''); setOtherId(preset?.otherBankAccountId ?? ''); setRate('0');
    setDocId(''); setReference(''); setNotes(''); setErrors([]);
  }, [kind, preset?.otherBankAccountId]);

  // A customer's or vendor's payment against documents is the full Record Payment form, on this account.
  useEffect(() => {
    if (kind === 'customer_payment') { onClose(); router.push(`/sales/payments/new?bank=${account.id}`); }
    if (kind === 'vendor_payment') { onClose(); router.push(`/purchases/payments/new?bank=${account.id}`); }
  }, [kind, account.id, onClose, router]);

  const contactKind = kind === 'credit_note_refund' || kind === 'retainer_payment' ? 'customer' : cat?.contact ?? null;
  const contactOptions = useMemo(() => (masters.data?.contacts ?? [])
    .filter((c) => !contactKind || contactKind === 'any' || c.kind === contactKind || c.kind === 'both')
    .map((c) => ({ value: c.id, label: c.displayName })), [masters.data, contactKind]);
  const accountOptions = useMemo(() => (masters.data?.accounts ?? [])
    .filter((a) => !cat?.accountTypes || cat.accountTypes.includes(a.type as never))
    // Receivables and payables come from invoices and bills, never from a bank entry.
    .filter((a) => a.code !== '1100' && a.code !== '2100')
    .map((a) => ({ value: a.id, label: a.name, sublabel: a.code })), [masters.data, cat]);
  const otherOptions = useMemo(() => (masters.data?.bankAccounts ?? [])
    .filter((b) => b.id !== account.id && (cat?.otherAccount !== 'card' || b.kind === 'card'))
    .map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data, account.id, cat]);
  // The account a journal category starts on (Zoho's default), once the chart is in.
  useEffect(() => {
    if (accountId || !cat?.defaultCode || !masters.data) return;
    const d = masters.data.accounts.find((a) => a.code === cat.defaultCode);
    if (d) setAccountId(d.id);
  }, [cat, masters.data, accountId]);

  // What a refund, a credit note refund or a retainer payment is set against.
  const docs = useApi<{ value: string; label: string; sublabel: string; leftPaise: number }[]>(async () => {
    if (!contactId) return [];
    if (kind === 'payment_refund' || kind === 'vendor_refund') {
      const r = await api.get<{ payments: { id: string; number: string; date: string; unappliedPaise: number; status: string }[] }>('/api/payments', { kind: kind === 'payment_refund' ? 'received' : 'made', contactId, limit: 200 });
      return r.payments.filter((p) => p.unappliedPaise > 0 && p.status !== 'void').map((p) => ({ value: p.id, label: p.number, sublabel: `${formatINR(p.unappliedPaise)} unused`, leftPaise: p.unappliedPaise }));
    }
    if (kind === 'credit_note_refund' || kind === 'retainer_payment') {
      const r = await api.get<{ documents: { id: string; number: string; status: string; totalPaise: number; appliedPaise: number | null; paidPaise: number | null }[] }>(
        '/api/sales-documents', { kind: kind === 'credit_note_refund' ? 'credit-note' : 'retainer', customerId: contactId, limit: 200 });
      return r.documents
        .map((d) => ({ d, left: d.totalPaise - (kind === 'credit_note_refund' ? d.appliedPaise ?? 0 : d.paidPaise ?? 0) }))
        .filter(({ d, left }) => left > 0 && d.status !== 'void' && d.status !== 'draft')
        .map(({ d, left }) => ({ value: d.id, label: d.number, sublabel: `${formatINR(left)} ${kind === 'credit_note_refund' ? 'balance' : 'unpaid'}`, leftPaise: left }));
    }
    return [];
  }, [kind, contactId]);
  const needsDoc = kind === 'payment_refund' || kind === 'vendor_refund' || kind === 'credit_note_refund' || kind === 'retainer_payment';
  useEffect(() => {
    const d = (docs.data ?? []).find((x) => x.value === docId);
    if (d && !amount) setAmount(d.leftPaise);
  }, [docId, docs.data, amount]);

  const save = async () => {
    if (!kind) return;
    const problems: string[] = [];
    if (!date) problems.push('Enter the date.');
    if (!(amount > 0)) problems.push('Enter an amount above zero.');
    if ((cat?.contactRequired || kind === 'credit_note_refund' || kind === 'retainer_payment') && !contactId) problems.push(`Choose the ${contactKind === 'vendor' ? 'vendor' : 'customer'}.`);
    if (cat?.engine === 'transfer' && !otherId) problems.push('Choose the account.');
    if ((cat?.engine === 'journal' || cat?.engine === 'expense') && !accountId) problems.push('Choose the account.');
    if (needsDoc && !docId) problems.push(kind === 'credit_note_refund' ? 'Choose the credit note.' : kind === 'retainer_payment' ? 'Choose the retainer invoice.' : 'Choose the payment.');
    if (problems.length) { setErrors(problems); return; }
    setSaving(true); setErrors([]);
    try {
      const r = await api.post<{ created: string | null }>(`/api/banking/accounts/${account.id}/transactions`, {
        kind, date, amountPaise: amount, reference: reference.trim() || null, notes: notes.trim() || null,
        contactId: contactId || null, accountId: accountId || null, otherBankAccountId: otherId || null,
        gstRatePct: cat?.tax ? Number(rate) : null,
        paymentId: kind === 'payment_refund' || kind === 'vendor_refund' ? docId : null,
        creditNoteId: kind === 'credit_note_refund' ? docId : null,
        retainerId: kind === 'retainer_payment' ? docId : null,
      });
      toast.success(`${addKindLabel(kind)} recorded`, { description: r.created ? `${r.created} · ${account.name}` : account.name });
      onDone();
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : 'The transaction was not recorded.']);
    } finally {
      setSaving(false);
    }
  };

  const open = !!kind && kind !== 'customer_payment' && kind !== 'vendor_payment';
  const hint = kind ? (cat?.hint ?? EXTRA[kind as 'credit_note_refund']?.hint) : '';
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[520px]" data-slot="add-transaction-sheet">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2 text-[18px] font-normal">
            {side === 'in' ? <ArrowDownLeft className="size-4 text-success" /> : <ArrowUpRight className="size-4 text-destructive" />}
            {kind ? addKindLabel(kind) : ''}
          </SheetTitle>
          <SheetDescription className="text-[12px]">{account.name} · {hint}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
          <FormErrors errors={errors} onClose={() => setErrors([])} />
          {contactKind && (
            <Field label={contactKind === 'vendor' ? 'Vendor' : contactKind === 'customer' ? 'Customer' : 'Contact'} required={!!cat?.contactRequired || needsDoc}>
              <Combobox options={contactOptions} value={contactId} onChange={(v) => { setContactId(v); setDocId(''); }} placeholder="Select or search" clearable />
            </Field>
          )}
          {needsDoc && (
            <Field label={kind === 'credit_note_refund' ? 'Credit Note' : kind === 'retainer_payment' ? 'Retainer Invoice' : 'Payment'} required>
              <Combobox options={docs.data ?? []} value={docId} onChange={setDocId} showAvatar={false}
                placeholder={contactId ? ((docs.data ?? []).length ? 'Select' : 'Nothing open for them') : 'Choose the customer first'} />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="add-date" /></Field>
            <Field label="Amount" required><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
          </div>
          {cat?.engine === 'transfer' && (
            <Field label={side === 'in' ? 'From Account' : 'To Account'} required>
              <Combobox options={otherOptions} value={otherId} onChange={setOtherId} showAvatar={false} placeholder="Select an account" />
            </Field>
          )}
          {(cat?.engine === 'journal' || cat?.engine === 'expense') && (
            <Field label={cat.engine === 'expense' ? 'Expense Account' : 'Account'} required>
              <Combobox options={accountOptions} value={accountId} onChange={setAccountId} showAvatar={false} placeholder="Select an account" />
            </Field>
          )}
          {cat?.tax && (
            <Field label="GST" hint="The amount includes the tax">
              <Combobox options={RATES} value={rate} onChange={(v) => setRate(v || '0')} showAvatar={false} />
            </Field>
          )}
          <Field label="Reference#"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
          <Field label="Description"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={500} placeholder="Max. 500 characters" /></Field>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button onClick={() => void save()} disabled={saving} data-slot="add-transaction-save">{saving ? 'Saving…' : 'Save'}</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
