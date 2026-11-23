'use client';

// Zoho Books' "Add Bank or Credit Card" (and its Edit): the account type, the
// account's name and code, its currency, the bank's details for a bank (a card
// has no account number or IFSC), who may see it, a description, and whether
// it is the primary account. Saved, it opens on its own account page.
//
// The ledger account is made with it (services/banking.ts createBankAccount):
// a bank account the books cannot see is money nobody can reconcile. An
// opening balance is not asked here, as in Zoho: it goes in through
// Accountant → Opening Balances, dated the day before the books start.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { FormErrors, FormRow } from '@/components/shared/form-layout';
import { useAppStore } from '@/lib/store';
import { userOptions } from '@/lib/options';
import { api, ApiError } from '@/lib/api/client';

export const BANK_CURRENCIES = ['AED', 'AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'INR', 'SAR', 'USD', 'ZAR', 'JPY'];

export interface BankAccountRecord {
  id: string;
  kind: 'bank' | 'card' | 'cash' | 'wallet' | 'clearing';
  name: string;
  code: string | null;
  currency: string;
  accountNumber: string | null;
  bankName: string | null;
  ifsc: string | null;
  description: string | null;
  userIds: string[];
  isPrimary: boolean;
}

export function BankAccountForm({ editing }: { editing?: BankAccountRecord }) {
  const router = useRouter();
  const s = useAppStore();
  const [kind, setKind] = useState<'bank' | 'card'>(editing?.kind === 'card' ? 'card' : 'bank');
  const [name, setName] = useState(editing?.name ?? '');
  const [code, setCode] = useState(editing?.code ?? '');
  const [currency, setCurrency] = useState(editing?.currency ?? 'INR');
  const [number, setNumber] = useState(editing?.accountNumber ?? '');
  const [bankName, setBankName] = useState(editing?.bankName ?? '');
  const [ifsc, setIfsc] = useState(editing?.ifsc ?? '');
  const [userIds, setUserIds] = useState<string[]>(editing?.userIds ?? []);
  const [description, setDescription] = useState(editing?.description ?? '');
  const [primary, setPrimary] = useState(editing?.isPrimary ?? false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const users = useMemo(() => userOptions(s), [s]);
  const card = kind === 'card';
  // Cash and wallets have no bank of their own: their form keeps only what applies.
  const inHouse = editing?.kind === 'cash' || editing?.kind === 'wallet' || editing?.kind === 'clearing';

  const save = async () => {
    // Zoho's own words for an empty name.
    if (!name.trim()) { setErrors(['Please enter a valid account name.']); return; }
    setErrors([]);
    setSaving(true);
    const payload = {
      name: name.trim(), accountCode: code.trim() || null, currency,
      accountNumber: card || inHouse ? null : number.trim() || null, bankName: bankName.trim() || null,
      ifsc: card || inHouse ? null : ifsc.trim() || null, description: description.trim() || null,
      userIds, isPrimary: !card && primary,
    };
    try {
      if (editing) {
        await api.put(`/api/banking/accounts/${editing.id}`, payload);
        toast.success(`${payload.name} saved`);
        router.push(`/banking/transactions?account_id=${editing.id}`);
      } else {
        const r = await api.post<{ id: string }>('/api/banking/accounts', { kind, ...payload });
        toast.success(`${payload.name} added`, { description: 'A matching ledger account was created, so the books can see it.' });
        router.push(`/banking/transactions?account_id=${r.id}`);
      }
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : 'The account was not saved.']);
    } finally {
      setSaving(false);
    }
  };

  const title = editing ? (card ? 'Edit Credit Card' : 'Edit Bank Account') : 'Add Bank or Credit Card';
  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-3rem)] flex-col bg-surface" data-slot="bank-account-form">
      <div className="flex h-[65px] shrink-0 items-center border-b px-5">
        <h1 className="flex-1 truncate text-[22px] font-normal leading-tight">{title}</h1>
      </div>
      <div className="space-y-4 px-5 py-7">
        <div className="max-w-[640px]"><FormErrors errors={errors} onClose={() => setErrors([])} /></div>
        {!inHouse && (
          <FormRow label="Select Account Type" required>
            <div className="flex h-9 items-center gap-6 text-[13px]" role="radiogroup" aria-label="Select Account Type" data-slot="account-type">
              {(['bank', 'card'] as const).map((k) => (
                <label key={k} className="inline-flex cursor-pointer items-center gap-2">
                  <input type="radio" name="account-type" value={k} checked={kind === k} disabled={!!editing}
                    onChange={() => setKind(k)} className="size-3.5 accent-primary" />
                  {k === 'bank' ? 'Bank' : 'Credit Card'}
                </label>
              ))}
            </div>
          </FormRow>
        )}
        <FormRow label="Account Name" required htmlFor="bank-account-name" help="A name you will know it by, such as HDFC Current. It is the ledger account's name too.">
          <Input id="bank-account-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} autoFocus={!editing} />
        </FormRow>
        <FormRow label="Account Code" htmlFor="bank-account-code" help="Your own code for the account, if you number your chart.">
          <Input id="bank-account-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} />
        </FormRow>
        <FormRow label="Currency" required>
          <Combobox options={BANK_CURRENCIES.map((c) => ({ value: c, label: c }))} value={currency} onChange={(v) => setCurrency(v || 'INR')} showAvatar={false} />
        </FormRow>
        {!card && !inHouse && (
          <FormRow label="Account Number" htmlFor="bank-account-number" help="The number the bank gave the account. Only its last four digits show in lists.">
            <Input id="bank-account-number" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^0-9A-Za-z-]/g, '').slice(0, 34))} inputMode="numeric" />
          </FormRow>
        )}
        {!inHouse && (
          <FormRow label="Bank Name" htmlFor="bank-name">
            <Input id="bank-name" value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={150} />
          </FormRow>
        )}
        {!card && !inHouse && (
          <FormRow label="IFSC" htmlFor="bank-ifsc" help="The branch's 11-character code, printed on the cheque book.">
            <Input id="bank-ifsc" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))} className="uppercase" />
          </FormRow>
        )}
        <FormRow label="Users" hint={<><b className="font-semibold">Note:</b> Only users associated with this bank can access this bank account.</>}>
          <MultiCombobox options={users} value={userIds} onChange={setUserIds} placeholder="Select Users" searchPlaceholder="Search users" />
        </FormRow>
        <FormRow label="Description" htmlFor="bank-description">
          <Textarea id="bank-description" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} placeholder="Max. 500 characters" rows={3} />
        </FormRow>
        {!card && !inHouse && (
          <FormRow label="">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]" data-slot="make-primary">
              <Checkbox checked={primary} onCheckedChange={(v) => setPrimary(!!v)} /> Make this primary
            </label>
          </FormRow>
        )}
        <div className="max-w-[1290px] border-t pt-4">
          <div className="flex gap-3">
            <Button onClick={() => void save()} disabled={saving} data-slot="bank-account-save">{saving ? 'Saving…' : 'Save'}</Button>
            <Button variant="outline" asChild><Link href={editing ? `/banking/transactions?account_id=${editing.id}` : '/banking'}>Cancel</Link></Button>
          </div>
        </div>
      </div>
    </div>
  );
}
