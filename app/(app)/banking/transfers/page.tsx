'use client';

// Transfers between your own accounts.
//
// Moving money from the current account to petty cash changes where it sits,
// not how much you have. Both sides are assets, so the entry is Dr one bank,
// Cr the other — nothing reaches income or expense, and profit is untouched.
// Booking a withdrawal as an expense is one of the commonest ways a set of
// books ends up overstating costs.

import { useState } from 'react';
import { ArrowLeftRight, ArrowRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface TransferRow {
  id: string;
  date: string;
  fromName: string;
  toName: string;
  reference: string | null;
  amountPaise: number;
  journalEntryId: string | null;
}

interface BankAccountRow {
  id: string;
  name: string;
  kind: string;
  bankName: string | null;
  accountLast4: string | null;
  balancePaise: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function TransfersPage() {
  const canCreate = usePermission('banking', 'create');

  const state = useApi<{ transfers: TransferRow[] }>(() => api.get('/api/banking/transfers'), []);
  const accounts = useApi<{ accounts: BankAccountRow[] }>(() => api.get('/api/banking/accounts'), []);

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');

  const create = useApiAction((input: unknown) =>
    api.post<{ id: string }>('/api/banking/transfers', input),
  );

  const options = (accounts.data?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: a.accountLast4 ? `${a.bankName ?? a.kind} ····${a.accountLast4}` : a.kind,
  }));

  const save = async () => {
    if (!from || !to) { toast.error('Pick both accounts.'); return; }
    if (from === to) { toast.error('Choose two different accounts.'); return; }
    if (amount <= 0) { toast.error('Enter an amount.'); return; }

    const done = await create.run({
      fromBankAccountId: from,
      toBankAccountId: to,
      date,
      amountPaise: amount,
      reference: reference || null,
    });
    if (!done) {
      toast.error(create.error ?? 'The transfer was not recorded');
      return;
    }
    toast.success('Transfer recorded', {
      description: 'Money moved between your own accounts — no income, no expense.',
    });
    setOpen(false);
    setAmount(0);
    setReference('');
    state.refetch();
    accounts.refetch();
  };

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Moving money between your own accounts changes where it sits, not how much you have — so it never touches profit."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New transfer</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New transfer</DialogTitle>
                  <DialogDescription>Between your own bank, cash or card accounts.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="From account" required>
                    <Combobox
                      options={options}
                      value={from}
                      onChange={setFrom}
                      placeholder="Select account"
                      searchPlaceholder="Search accounts"
                    />
                  </Field>
                  <Field label="To account" required>
                    <Combobox
                      options={options}
                      value={to}
                      onChange={setTo}
                      placeholder="Select account"
                      searchPlaceholder="Search accounts"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Amount" required>
                      <MoneyInput valuePaise={amount} onChangePaise={setAmount} />
                    </Field>
                    <Field label="Date" required>
                      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Reference" hint="Cheque number, UPI reference, anything that helps reconcile it">
                    <Input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="What the transfer was for"
                    />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Recording…' : 'Record transfer'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) =>
          d.transfers.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transfers"
              description="Record cash withdrawals, deposits or inter-account movements."
            />
          ) : (
            <div className="space-y-3">
              {d.transfers.map((t) => (
                <Card key={t.id} className="flex flex-wrap items-center gap-4 p-4">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="truncate text-sm font-medium">{t.fromName}</span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{t.toName}</span>
                    {t.reference && (
                      <span className="truncate text-xs text-muted-foreground">· {t.reference}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(t.date).toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                  <Money value={t.amountPaise} className="font-medium" />
                </Card>
              ))}
            </div>
          )
        }
      </AsyncPage>
    </>
  );
}
