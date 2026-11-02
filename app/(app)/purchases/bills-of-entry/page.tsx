'use client';

// Bills of entry: goods imported. The overseas supplier's invoice is an
// ordinary bill with no GST; what customs charged goes here — duty as a cost,
// IGST and cess as input credit, claimed in GSTR-3B 4(A)(1).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Ship } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useSession } from '@/components/layout/session-provider';
import { formatINRCompact } from '@/lib/money';
import { today } from '@/lib/selectors';

interface Entry {
  id: string; boeNo: string; boeDate: string; portCode: string; assessablePaise: number; customsDutyPaise: number;
  igstPaise: number; cessPaise: number; itcEligibility: string; status: string; voidReason: string | null;
  billId: string | null; billNo: string | null; vendorName: string | null; paidThrough: string;
}
interface Masters { accounts: { id: string; code: string; name: string; type: string }[]; bankAccounts: { id: string; name: string; kind: string }[] }

const BLANK = { vendorId: '', boeNo: '', boeDate: today(), portCode: '', assessable: 0, duty: 0, igst: 0, cess: 0, itc: 'eligible', dutyAccountId: '', bankId: '', notes: '' };

export default function BillsOfEntryPage() {
  const canCreate = usePermission('purchases', 'create');
  const canVoid = usePermission('purchases', 'void');
  const session = useSession();
  const state = useApi(() => api.get<{ entries: Entry[] }>('/api/bills-of-entry'), []);
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  const create = useApiAction((input: unknown) => api.post<{ id: string; totalPaise: number }>('/api/bills-of-entry', input));
  const voidIt = useApiAction((id: string, reason: string) => api.patch('/api/bills-of-entry', { action: 'void', id, reason }));

  const dutyAccounts = useMemo(() => (masters.data?.accounts ?? []).filter((a) => a.type === 'expense' || a.code === '1500' || a.type === 'asset')
    .map((a) => ({ value: a.id, label: a.name, sublabel: a.code })), [masters.data]);
  const banks = useMemo(() => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data]);

  const save = async () => {
    if (!f.boeNo || !f.portCode || !f.dutyAccountId || !f.bankId) { toast.error('Give the bill of entry number, the port, where the duty goes and what it was paid from.'); return; }
    const done = await create.run({
      branchId: session.user.branchId ?? session.branches[0]?.id, vendorId: f.vendorId || null, boeNo: f.boeNo, boeDate: f.boeDate,
      portCode: f.portCode, assessablePaise: f.assessable, customsDutyPaise: f.duty, igstPaise: f.igst, cessPaise: f.cess,
      itcEligibility: f.itc, dutyAccountId: f.dutyAccountId, paidThroughBankAccountId: f.bankId, notes: f.notes || null,
    });
    if (!done) { toast.error(create.error ?? 'Not recorded'); return; }
    toast.success(`Bill of entry ${f.boeNo} recorded`, { description: f.itc === 'ineligible' ? 'The IGST is part of the cost.' : 'The IGST is input credit in this month’s GSTR-3B, table 4(A)(1).' });
    setOpen(false);
    setF({ ...BLANK, bankId: f.bankId, dutyAccountId: f.dutyAccountId });
    state.refetch();
  };

  const columns: Column<Entry>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.boeDate, cell: (r) => new Date(r.boeDate).toLocaleDateString('en-IN') },
    { key: 'no', header: 'Bill of entry', sortValue: (r) => r.boeNo, cell: (r) => <span className="font-medium">{r.boeNo} <span className="text-xs text-muted-foreground">· {r.portCode}</span></span> },
    { key: 'vendor', header: 'Supplier', sortValue: (r) => r.vendorName ?? '', cell: (r) => (r.billId ? <Link href={`/purchases/bills/${r.billId}`} className="hover:underline">{r.vendorName} · {r.billNo}</Link> : r.vendorName ?? '—') },
    { key: 'value', header: 'Assessable value', align: 'right', sortValue: (r) => r.assessablePaise, cell: (r) => <Money value={r.assessablePaise} /> },
    { key: 'duty', header: 'Duty', align: 'right', sortValue: (r) => r.customsDutyPaise, cell: (r) => <Money value={r.customsDutyPaise} /> },
    { key: 'igst', header: 'IGST + cess', align: 'right', sortValue: (r) => r.igstPaise + r.cessPaise, cell: (r) => <Money value={r.igstPaise + r.cessPaise} /> },
    {
      key: 'status', header: 'Credit', sortValue: (r) => r.status,
      cell: (r) => r.status === 'void' ? <Badge variant="outline" className="text-[10px]">Void</Badge>
        : <Badge variant="secondary" className="text-[10px]">{r.itcEligibility === 'ineligible' ? 'In cost' : 'Claimed'}</Badge>,
    },
    {
      key: 'x', header: '', sortValue: () => 0,
      cell: (r) => (r.status !== 'void' && canVoid ? (
        <Button size="sm" variant="ghost" onClick={async () => {
          const reason = window.prompt(`Why is bill of entry ${r.boeNo} being cancelled?`);
          if (!reason) return;
          if (await voidIt.run(r.id, reason)) { toast.info('Voided; its entry is reversed.'); state.refetch(); } else toast.error(voidIt.error ?? 'Not voided');
        }}>Void</Button>
      ) : null),
    },
  ];

  return (
    <>
      <PageHeader
        title="Bills of Entry"
        description="Goods imported: the customs duty is a cost of the goods, the IGST and cess paid at customs are input credit (GSTR-3B 4(A)(1)). The supplier's own invoice is an ordinary bill, with no GST."
        actions={canCreate ? <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5"><Plus className="size-4" /> Record bill of entry</Button> : undefined}
      />
      <AsyncPage state={state}>
        {(d) => {
          const live = d.entries.filter((e) => e.status !== 'void');
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label="Assessable value" value={formatINRCompact(live.reduce((t, e) => t + e.assessablePaise, 0))} />
                <StatTile label="Customs duty" value={formatINRCompact(live.reduce((t, e) => t + e.customsDutyPaise, 0))} />
                <StatTile label="IGST credit" value={formatINRCompact(live.filter((e) => e.itcEligibility !== 'ineligible').reduce((t, e) => t + e.igstPaise + e.cessPaise, 0))} tone="positive" />
              </div>
              {d.entries.length ? <DataTable rows={d.entries} columns={columns} getRowId={(r) => r.id} searchPlaceholder="Search bill of entry or supplier…" />
                : <EmptyState icon={Ship} title="No imports recorded" description="Record a bill of entry when goods clear customs, with the duty and IGST paid on it." />}
            </>
          );
        }}
      </AsyncPage>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record a bill of entry</DialogTitle>
            <DialogDescription>From the bill of entry and the duty paid on ICEGATE. The supplier&rsquo;s invoice goes in as a bill.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bill of entry no." required><Input value={f.boeNo} onChange={(e) => setF({ ...f, boeNo: e.target.value.replace(/\D/g, '').slice(0, 8) })} placeholder="1234567" /></Field>
            <Field label="Date" required><Input type="date" value={f.boeDate} onChange={(e) => setF({ ...f, boeDate: e.target.value })} /></Field>
            <Field label="Port code" required><Input value={f.portCode} onChange={(e) => setF({ ...f, portCode: e.target.value.toUpperCase().slice(0, 6) })} placeholder="INMAA1" /></Field>
            <Field label="Supplier"><ContactPicker kind="vendor" value={f.vendorId} onChange={(v) => setF({ ...f, vendorId: v })} placeholder="Overseas supplier" /></Field>
            <Field label="Assessable value"><MoneyInput valuePaise={f.assessable} onChangePaise={(p) => setF({ ...f, assessable: p })} /></Field>
            <Field label="Customs duty" hint="Basic duty and surcharge"><MoneyInput valuePaise={f.duty} onChangePaise={(p) => setF({ ...f, duty: p })} /></Field>
            <Field label="IGST paid"><MoneyInput valuePaise={f.igst} onChangePaise={(p) => setF({ ...f, igst: p })} /></Field>
            <Field label="Cess paid"><MoneyInput valuePaise={f.cess} onChangePaise={(p) => setF({ ...f, cess: p })} /></Field>
            <Field label="Input credit">
              <Combobox options={[{ value: 'eligible', label: 'Claimable' }, { value: 'capital_goods', label: 'Capital goods' }, { value: 'ineligible', label: 'Blocked — part of the cost' }]}
                value={f.itc} onChange={(v) => setF({ ...f, itc: v })} showAvatar={false} />
            </Field>
            <Field label="Duty booked to" required><Combobox options={dutyAccounts} value={f.dutyAccountId} onChange={(v) => setF({ ...f, dutyAccountId: v })} placeholder="Purchases or Inventory" showAvatar={false} /></Field>
            <Field label="Paid from" required className="sm:col-span-2"><Combobox options={banks} value={f.bankId} onChange={(v) => setF({ ...f, bankId: v })} placeholder="Bank account" showAvatar={false} /></Field>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={create.busy}>{create.busy ? 'Recording…' : 'Record'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
