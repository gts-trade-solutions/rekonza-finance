'use client';

import { useRouter } from 'next/navigation';
// Opening balances — where the books start.
//
// A business does not begin the day it starts using accounting software. What
// it already had on day one is carried forward against Opening Balance Equity:
// that account is not real equity, it is a holding bucket that, once every
// opening figure is in, holds the opening stock and nothing else.
//
// Ledger accounts take one figure each. Customers and vendors take their
// unpaid bills one by one, so each ages from its own due date and can be paid
// off like any other. Stock is the quantity and rate on each item.

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CheckCircle2, FileCheck2, Loader2, Plus, Save, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { ModuleMenu } from '@/components/shared/module-menu';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Money } from '@/components/shared/money';
import { JournalEntryTable } from '@/components/shared/journal-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { ContactPicker } from '@/components/forms/quick-create';
import { ConfirmDelete, DeleteButton, RowActions } from '@/components/shared/row-actions';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type OpeningDocumentRow } from '@/lib/api/client';
import { journal, openingBalances, type JournalResponse, type OpeningSummaryResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const d = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_LABEL: Record<string, string> = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses',
};

export default function OpeningBalancesPage() {
  const state = useApi<OpeningSummaryResponse>(() => openingBalances.summary(), []);
  const entries = useApi<JournalResponse>(() => journal.list({ sourceType: 'opening', limit: 50 }), []);
  const refresh = () => { void state.refetch(); void entries.refetch(); };
  const router = useRouter();

  return (
    <>
      <PageHeader
        title="Opening balances"
        description="Where the books start: everything the business already owned and owed on day one."
        actions={
          <ModuleMenu slug="opening-balances" onRefresh={refresh}>
            <DropdownMenuItem onClick={() => router.push('/import/opening-bills')}>Import Unpaid Opening Invoices and Bills</DropdownMenuItem>
          </ModuleMenu>
        }
      />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(s) => (
          <>
            <Overview s={s} onChanged={refresh} />
            <Tabs defaultValue="ledger">
              <TabsList>
                <TabsTrigger value="ledger">Ledger accounts</TabsTrigger>
                <TabsTrigger value="parties">Customers &amp; vendors ({s.documents.filter((x) => x.status !== 'void').length})</TabsTrigger>
                <TabsTrigger value="stock">Stock</TabsTrigger>
                <TabsTrigger value="entries">Entries posted</TabsTrigger>
              </TabsList>
              <TabsContent value="ledger" className="mt-4"><LedgerOpenings s={s} onChanged={refresh} /></TabsContent>
              <TabsContent value="parties" className="mt-4 space-y-4"><PartyOpenings s={s} onChanged={refresh} /></TabsContent>
              <TabsContent value="stock" className="mt-4">
                <Card className="flex flex-wrap items-center gap-4 p-5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Opening stock: <Money value={s.stockPaise} /></p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      The quantity and rate entered on each item as at {d(s.startDate)}. It is not posted to a
                      ledger; the profit and loss and balance sheet value it, the same way they value closing stock.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild><Link href="/sales/items">Open items</Link></Button>
                </Card>
              </TabsContent>
              <TabsContent value="entries" className="mt-4 space-y-3">
                <AsyncPage state={entries}>
                  {(e) => e.entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing posted yet.</p>
                  ) : (
                    <>
                      {e.entries.map((x) => (
                        <Card key={x.id} className="space-y-3 p-5">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-semibold">{x.memo}</h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">Journal entry #{x.entryNo} · {d(String(x.date).slice(0, 10))}</p>
                            </div>
                            <Money value={x.totalDebitPaise} className="text-lg font-semibold" />
                          </div>
                          <JournalEntryTable entry={x} />
                        </Card>
                      ))}
                    </>
                  )}
                </AsyncPage>
              </TabsContent>
            </Tabs>
          </>
        )}
      </AsyncPage>
    </>
  );
}

function Overview({ s, onChanged }: { s: OpeningSummaryResponse; onChanged: () => void }) {
  const canEdit = usePermission('accountant', 'edit');
  const [date, setDate] = useState(s.startDate);
  const [saving, setSaving] = useState(false);
  const agrees = s.differencePaise === 0;
  const anyPosted = s.accounts.some((a) => a.netPaise !== 0);

  const saveDate = async () => {
    setSaving(true);
    try {
      await openingBalances.setStartDate(date);
      toast.success(`The books start on ${d(date)}`);
      onChanged();
    } catch (e) {
      toast.error('Could not change it', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_1fr]">
      <Card className="space-y-3 p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Books start on</p>
        {canEdit && !anyPosted ? (
          <div className="flex gap-2">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9" />
            <Button size="sm" onClick={() => void saveDate()} disabled={saving || date === s.startDate}>Set</Button>
          </div>
        ) : (
          <p className="text-lg font-semibold">{d(s.startDate)}</p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {anyPosted
            ? 'Every opening figure is posted on this day. It can no longer move.'
            : s.startDateSet ? 'Set before any opening balance is entered.' : 'Not set yet: this is the start of the current financial year.'}
        </p>
      </Card>
      <Card className={`flex items-start gap-3 p-5 ${agrees ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
        {agrees ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : <Scale className="mt-0.5 size-5 shrink-0 text-amber-600" />}
        <div className="text-sm">
          <p className="font-medium">
            {agrees ? 'The opening balances agree.' : <>Difference in opening balances: <Money value={Math.abs(s.differencePaise)} /> {s.differencePaise < 0 ? 'more debit than credit' : 'more credit than debit'}</>}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Customers owe <Money value={s.receivablesPaise} />, vendors are owed <Money value={s.payablesPaise} />, and stock is
            worth <Money value={s.stockPaise} />. Opening Balance Equity should end up holding exactly the stock; anything else
            means a figure is missing or wrong — often capital or reserves not yet entered.
          </p>
        </div>
      </Card>
    </div>
  );
}

function LedgerOpenings({ s, onChanged }: { s: OpeningSummaryResponse; onChanged: () => void }) {
  const canEdit = usePermission('accountant', 'edit');
  // Typed figures by account: debit positive, credit negative.
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // An account's opening figure cleared to nothing (Delete on its row): posts the difference, as any change does.
  const [clearing, setClearing] = useState<{ accountId: string; code: string; name: string } | null>(null);

  const groups = useMemo(() => {
    const rows = s.accounts.filter((a) => showAll || a.netPaise !== 0 || draft[a.accountId] != null || a.lockedReason === null);
    return TYPE_ORDER.map((t) => ({ type: t, rows: rows.filter((r) => r.type === t) })).filter((g) => g.rows.length);
  }, [s.accounts, showAll, draft]);

  const value = (id: string, net: number) => draft[id] ?? net;
  const changed = Object.entries(draft).filter(([id, v]) => v !== (s.accounts.find((a) => a.accountId === id)?.netPaise ?? 0));

  const save = async () => {
    setSaving(true);
    try {
      const r = await openingBalances.setAccounts(changed.map(([accountId, netPaise]) => ({ accountId, netPaise })));
      toast.success(r.changed ? `${r.changed} opening balance(s) posted` : 'Nothing changed');
      setDraft({});
      onChanged();
    } catch (e) {
      toast.error('Could not post them', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Enter each balance as at {d(s.startDate)}. A change posts the difference, so the trail keeps what was there before.
        </p>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show accounts set elsewhere
        </label>
      </div>
      <ReportTable>
        <thead>
          <tr className="border-b bg-muted/50">
            <th className={`${th} text-left`}>Account</th>
            <th className={`${th} w-40 text-right`}>Debit</th>
            <th className={`${th} w-40 text-right`}>Credit</th>
            {canEdit && <th className={`${th} w-24 text-right`}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.type} label={TYPE_LABEL[g.type] ?? g.type}>
              {g.rows.map((a) => {
                const v = value(a.accountId, a.netPaise);
                const editable = canEdit && !a.lockedReason;
                return (
                  <tr key={a.accountId} className="border-b last:border-0" title={a.lockedReason ?? undefined}>
                    <td className="px-3 py-1.5 text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{a.code}</span> {a.name}
                      {a.lockedReason && <span className="block text-[11px] text-muted-foreground">{a.lockedReason}</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable
                        ? <MoneyInput valuePaise={v > 0 ? v : 0} onChangePaise={(p) => setDraft((x) => ({ ...x, [a.accountId]: p }))} className="h-8" />
                        : <span className="block text-right"><Money value={v > 0 ? v : 0} showZero={false} /></span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable
                        ? <MoneyInput valuePaise={v < 0 ? -v : 0} onChangePaise={(p) => setDraft((x) => ({ ...x, [a.accountId]: -p }))} className="h-8" />
                        : <span className="block text-right"><Money value={v < 0 ? -v : 0} showZero={false} /></span>}
                    </td>
                    {canEdit && (
                      <td className="px-2 py-1.5 text-right">
                        {editable && a.netPaise !== 0 && (
                          <DeleteButton title={`Clear the opening balance of ${a.code} ${a.name}`} onClick={() => setClearing({ accountId: a.accountId, code: a.code, name: a.name })} />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </GroupRows>
          ))}
        </tbody>
      </ReportTable>
      <ConfirmDelete
        open={!!clearing}
        onClose={() => setClearing(null)}
        title={`Delete the opening balance of ${clearing?.code ?? ''} ${clearing?.name ?? ''}?`}
        description="Its opening figure becomes nothing. The change is posted against Opening Balance Equity on the start date, so the trail keeps what was there before."
        withReasonField={false}
        onConfirm={async () => {
          const r = await openingBalances.setAccounts([{ accountId: clearing!.accountId, netPaise: 0 }]);
          setDraft((x) => { const n = { ...x }; delete n[clearing!.accountId]; return n; });
          onChanged();
          return r;
        }}
        done="Opening balance deleted"
      />
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={saving || changed.length === 0} className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Post {changed.length ? `${changed.length} change(s)` : 'changes'}
          </Button>
        </div>
      )}
    </div>
  );
}

function GroupRows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <tr className="bg-muted/30"><td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">{label}</td></tr>
      {children}
    </>
  );
}

function PartyOpenings({ s, onChanged }: { s: OpeningSummaryResponse; onChanged: () => void }) {
  const canEdit = usePermission('accountant', 'edit');
  const [kind, setKind] = useState<'receivable' | 'payable'>('receivable');
  const [contactId, setContactId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [docDate, setDocDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState(0);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!contactId || !refNo || !docDate || !dueDate || amount <= 0) {
      toast.error('Fill in the party, bill number, both dates and the amount still owed.');
      return;
    }
    setSaving(true);
    try {
      await openingBalances.addDocument({ contactId, kind, refNo, docDate, dueDate, amountPaise: amount });
      toast.success(`Opening bill ${refNo} posted`);
      setRefNo(''); setAmount(0);
      onChanged();
    } catch (e) {
      toast.error('Could not add it', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const canDelete = usePermission('accountant', 'void');
  const [editing, setEditing] = useState<OpeningDocumentRow | null>(null);

  const docs = s.documents;
  return (
    <>
      {canEdit && (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Add a bill unpaid on {d(s.startDate)}</h3>
            <div className="flex rounded-md border p-0.5 text-xs">
              {(['receivable', 'payable'] as const).map((k) => (
                <button key={k} type="button" onClick={() => { setKind(k); setContactId(''); }}
                  className={`rounded px-2.5 py-1 ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {k === 'receivable' ? 'Customer owes us' : 'We owe a vendor'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={kind === 'receivable' ? 'Customer' : 'Vendor'} required className="lg:col-span-2">
              <ContactPicker kind={kind === 'receivable' ? 'customer' : 'vendor'} value={contactId} onChange={setContactId} />
            </Field>
            <Field label="Bill number" required><Input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></Field>
            <Field label="Bill date" required><Input type="date" value={docDate} max={s.startDate} onChange={(e) => setDocDate(e.target.value)} /></Field>
            <Field label="Due date" required><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
            <Field label="Still unpaid" required hint="What was owed on the start date, not the bill's original total.">
              <MoneyInput valuePaise={amount} onChangePaise={setAmount} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void add()} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add opening bill
            </Button>
          </div>
        </Card>
      )}

      {docs.length === 0 ? (
        <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <FileCheck2 className="size-4" /> No customer or vendor openings yet.
        </Card>
      ) : (
        <ReportTable>
          <thead>
            <tr className="border-b bg-muted/50">
              <th className={`${th} text-left`}>Party</th>
              <th className={`${th} text-left`}>Bill</th>
              <th className={`${th} text-left`}>Due</th>
              <th className={`${th} text-right`}>Opening</th>
              <th className={`${th} text-right`}>Still owed</th>
              <th className={`${th} w-[150px] text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((x) => (
              <tr key={x.id} className={`border-b last:border-0 ${x.status === 'void' ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 text-sm">
                  {x.contactName}
                  <Badge variant="outline" className="ml-2 text-[10px]">{x.kind === 'receivable' ? 'owes us' : 'we owe'}</Badge>
                </td>
                <td className="px-3 py-2 text-sm">
                  <span className="font-medium">{x.refNo}</span>
                  <span className="block text-xs text-muted-foreground">{d(x.docDate)}</span>
                </td>
                <td className="px-3 py-2 text-xs">{d(x.dueDate)}</td>
                <td className="px-3 py-2 text-right"><Money value={x.amountPaise} /></td>
                <td className="px-3 py-2 text-right font-medium">
                  {x.status === 'void' ? <span className="text-xs text-muted-foreground">Withdrawn</span> : <Money value={x.balancePaise} />}
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  {x.status !== 'void' && (
                    <RowActions
                      label={`opening bill ${x.refNo}`}
                      canEdit={canEdit}
                      // Paid against: what was paid rests on it; undo those payments first.
                      canDelete={canDelete && x.amountPaidPaise === 0}
                      onEdit={() => setEditing(x)}
                      onDelete={async (reason) => { await openingBalances.voidDocument(x.id, reason || undefined); onChanged(); }}
                      done={`${x.refNo} deleted (withdrawn)`}
                      deleteTitle={`Delete opening bill ${x.refNo}?`}
                      deleteDescription="Its entry is reversed on the start date, so the party's balance and Opening Balance Equity go back; the bill stays listed as withdrawn, for the audit trail."
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ReportTable>
      )}
      {editing && <EditOpeningBill doc={editing} startDate={s.startDate} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </>
  );
}

/** Edit an opening bill: party, number, dates, amount still unpaid. A posted change reverses and reposts its entry. */
function EditOpeningBill({ doc, startDate, onClose, onSaved }: { doc: OpeningDocumentRow; startDate: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: doc.kind, contactId: doc.contactId, refNo: doc.refNo, docDate: doc.docDate, dueDate: doc.dueDate, amount: doc.amountPaise });
  const [busy, setBusy] = useState(false);
  const paid = doc.amountPaidPaise > 0;
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/opening-balances', { action: 'edit-document', id: doc.id, contactId: f.contactId, kind: f.kind, refNo: f.refNo, docDate: f.docDate, dueDate: f.dueDate, amountPaise: f.amount });
      toast.success(`Opening bill ${f.refNo} saved`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-xl" data-slot="opening-bill-edit">
        <DialogHeader>
          <DialogTitle>Edit opening bill {doc.refNo}</DialogTitle>
          <DialogDescription>
            {paid
              ? 'Something has been paid against it, so only its dates can change here; undo those payments to change the party or the amount.'
              : 'A change to the party, number or amount reverses its entry on the start date and posts the corrected one.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind" className="sm:col-span-2">
            <div className="flex w-fit rounded-md border p-0.5 text-xs">
              {(['receivable', 'payable'] as const).map((k) => (
                <button key={k} type="button" disabled={paid} onClick={() => setF({ ...f, kind: k, contactId: '' })}
                  className={`rounded px-2.5 py-1 ${f.kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {k === 'receivable' ? 'Customer owes us' : 'We owe a vendor'}
                </button>
              ))}
            </div>
          </Field>
          <Field label={f.kind === 'receivable' ? 'Customer' : 'Vendor'} required className="sm:col-span-2">
            {paid
              ? <p className="text-sm">{doc.contactName}</p>
              : <ContactPicker kind={f.kind === 'receivable' ? 'customer' : 'vendor'} value={f.contactId} onChange={(v) => setF({ ...f, contactId: v })} />}
          </Field>
          <Field label="Bill number" required><Input value={f.refNo} disabled={paid} onChange={(e) => setF({ ...f, refNo: e.target.value })} /></Field>
          <Field label="Still unpaid" required>
            {paid ? <Money value={f.amount} className="block pt-2 text-sm" /> : <MoneyInput valuePaise={f.amount} onChangePaise={(p) => setF({ ...f, amount: p })} />}
          </Field>
          <Field label="Bill date" required><Input type="date" value={f.docDate} max={startDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></Field>
          <Field label="Due date" required><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.contactId || !f.refNo || f.amount <= 0} data-slot="opening-bill-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
