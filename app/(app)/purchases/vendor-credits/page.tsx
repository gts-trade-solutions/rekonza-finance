'use client';

// Vendor credits — a supplier's credit note to us.
//
// It works the opposite way from ours: what we owe goes down, the cost that was
// booked comes back out, and the input credit claimed on that cost has to be
// given back too. That last part is the one people forget. If the supplier
// reverses the supply, they reverse it in their GSTR-1 as well, and the credit
// disappears from our GSTR-2B — holding on to it produces a mismatch the
// department asks about, with interest.

import { FoldNav } from '@/components/layout/nav-state';
import { useEffect, useState } from 'react';
import { FileMinus, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { BulkPrintButton, DeleteDocumentDialog, documentMenuColumn } from '@/components/shared/document-menu';
import { RowActions } from '@/components/shared/row-actions';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Input } from '@/components/ui/input';
import {
  ApiError, bills as billsApi, items as itemsApi, purchaseDocuments, vendorCredits,
  type BillDetail, type PurchaseDocListResponse, type PurchaseDocRow, type VendorCreditForEdit,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';

const REASONS = [
  'Short supply — goods not received',
  'Goods returned — damaged',
  'Rate correction agreed after delivery',
  'Over-billed on the original invoice',
  'Order cancelled after billing',
];

const RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A line of goods going back: from a bill line (its item, rate and tax), or
 * an item picked by hand. Sent as the credit's lines (migration 131), so the
 * goods leave stock and their FIFO layer, and on a perpetual book Inventory.
 */
interface GoodsLine { key: string; itemId: string; billLineId: string | null; name: string; cameIn: number | null; qty: number; ratePaise: number; gstRatePct: number }
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function VendorCreditsPage() {
  const canCreate = usePermission('purchases', 'create');
  const canEdit = usePermission('purchases', 'edit');
  const canDelete = usePermission('purchases', 'void');
  const [deleting, setDeleting] = useState<PurchaseDocRow | null>(null);
  const branchId = useAppStore((s) => s.activeBranchId);
  const bankAccounts = useAppStore((s) => s.bankAccounts);

  const state = useApi<PurchaseDocListResponse>(() => purchaseDocuments.list('vendor-credit'), []);

  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [billId, setBillId] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [amount, setAmount] = useState(0);
  const [gstRate, setGstRate] = useState(18);
  const [itcClaimed, setItcClaimed] = useState(true);
  const [date, setDate] = useState(today());
  // Zoho's Edit: the same window, filled with the credit as entered (PUT /api/vendor-credits/[id]).
  const [editing, setEditing] = useState<VendorCreditForEdit | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  // Zoho's vendor credit has item lines: goods sent back go out of stock with it.
  const [mode, setMode] = useState<'amount' | 'goods'>('amount');
  const [goods, setGoods] = useState<GoodsLine[]>([]);
  const [pickItem, setPickItem] = useState('');

  const startNew = () => {
    setEditing(null); setVendorId(''); setBillId(''); setReason(REASONS[0]); setAmount(0); setGstRate(18); setItcClaimed(true); setDate(today());
    setMode('amount'); setGoods([]); setPickItem('');
  };
  const startEdit = async (id: string) => {
    setLoadingEdit(true);
    try {
      const vc = await vendorCredits.get(id);
      setEditing(vc);
      setVendorId(vc.vendorId); setBillId(vc.againstBillId ?? ''); setReason(vc.reason); setAmount(vc.amountPaise);
      setGstRate(vc.gstRatePct); setItcClaimed(vc.itcClaimed); setDate(vc.date);
      const ls = vc.lines ?? [];
      setMode(ls.length ? 'goods' : 'amount');
      setGoods(ls.map((l, i) => ({ key: `e${i}`, itemId: l.itemId ?? '', billLineId: l.billLineId, name: l.itemName ?? l.description ?? 'Item', cameIn: null, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct })));
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'That vendor credit could not be opened.');
    } finally { setLoadingEdit(false); }
  };

  // Only this vendor's open bills — a credit can only reduce something owed.
  // Goods can go back on a bill already paid too: what the bill cannot take stays on account.
  const vendorBills = useApi(
    async () => (vendorId ? billsApi.list({ vendorId, limit: 100 }) : { bills: [] as never[] }),
    [vendorId],
  );
  // The bill's own lines, to send goods back out of.
  const bill = useApi<BillDetail | null>(async () => (billId ? billsApi.get(billId) : null), [billId]);
  const stockItems = useApi(async () => (mode === 'goods' ? itemsApi.list({ kind: 'goods', limit: 500 }) : { items: [] as never[] }), [mode]);
  useEffect(() => {
    // Choosing a bill in goods mode lists its item lines, each at nothing to return yet.
    if (mode !== 'goods' || !bill.data || editing) return;
    setGoods(bill.data.lines.filter((l) => l.itemId).map((l) => ({
      key: `b${l.id}`, itemId: String(l.itemId), billLineId: l.id,
      // A line entered by item has no description of its own: the item's name stands for it.
      name: l.description?.trim() || '', cameIn: l.qty, qty: 0, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct,
    })));
  }, [bill.data, mode, editing]);
  const goodsTaxable = goods.reduce((t, g) => t + Math.round(g.qty * g.ratePaise), 0);
  const goodsTax = goods.reduce((t, g) => t + Math.round((Math.round(g.qty * g.ratePaise) * g.gstRatePct) / 100), 0);

  // ?edit=<id> (the General Ledger's ⋯, say): open that credit's Edit window.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && canEdit) void startEdit(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = useApiAction(purchaseDocuments.create);
  const update = useApiAction(vendorCredits.update);
  const saving = create.busy || update.busy;
  const saveError = editing ? update.error : create.error;
  const refund = useApiAction(purchaseDocuments.refundVendorCredit);

  const save = async () => {
    const sent = goods.filter((g) => g.qty > 0);
    if (!vendorId || (mode === 'amount' ? amount <= 0 : !sent.length)) {
      toast.error(mode === 'amount' ? 'Pick a vendor and enter an amount.' : 'Pick a vendor and give the quantity going back on at least one line.');
      return;
    }
    const input = {
      vendorId, date, reason, againstBillId: billId || null, amountPaise: mode === 'amount' ? amount : 0, gstRatePct: gstRate, itcClaimed,
      lines: mode === 'goods'
        ? sent.map((g) => ({ itemId: g.itemId, billLineId: g.billLineId, qty: g.qty, ratePaise: g.ratePaise, gstRatePct: g.gstRatePct }))
        : [],
    };
    const result = editing
      ? await update.run(editing.id, { ...input, branchId: editing.branchId })
      : await create.run({ kind: 'vendor-credit', branchId, ...input });
    if (!result) return;
    toast.success(editing ? `${result.number} saved` : `${result.number} recorded`, {
      description: editing
        ? 'The entry as it was is reversed and the credit posted again.'
        : itcClaimed
          ? 'Payable reduced, cost reversed, and the input credit given back.'
          : 'Payable reduced and the cost reversed.',
    });
    setOpen(false);
    startNew();
    state.refetch();
  };

  const doRefund = async (r: PurchaseDocRow) => {
    const bank = bankAccounts.find((b) => b.kind === 'bank');
    if (!bank) {
      toast.error('No bank account is set up to receive the refund.');
      return;
    }
    const done = await refund.run(r.id, bank.id, today(), undefined, `Refund on ${r.number}`);
    if (!done) {
      toast.error(refund.error ?? 'Could not record that refund');
      return;
    }
    toast.success(`${formatINR(done.refundedPaise)} received`, {
      description: 'Cash back in the bank rather than set off against a future bill.',
    });
    state.refetch();
  };

  const columns: Column<PurchaseDocRow>[] = [
    { key: 'number', header: 'Credit #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    {
      key: 'reason', header: 'Reason', sortValue: (r) => r.reason ?? '',
      cell: (r) => <span className="text-xs text-muted-foreground">{r.reason}</span>,
    },
    {
      key: 'against', header: 'Against bill', sortValue: (r) => r.linkedId ?? '',
      cell: (r) => <span className="text-xs">{r.linkedId ? `Bill #${r.linkedId}` : 'Standalone'}</span>,
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'unapplied', header: 'On account', align: 'right',
      sortValue: (r) => r.totalPaise - r.appliedPaise,
      cell: (r) => <Money value={r.totalPaise - r.appliedPaise} showZero={false} />,
    },
    { key: 'total', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        const unapplied = r.totalPaise - r.appliedPaise;
        // Edit and Delete as buttons on the row, beside the ⋯: the client looks for the words.
        return (
          <RowActions
            onEdit={canEdit && r.status !== 'void' && r.status !== 'refunded' ? () => { if (!loadingEdit) void startEdit(r.id); } : null}
            onDelete={canDelete && r.status !== 'refunded' ? () => setDeleting(r) : null}
            editTitle={`Edit ${r.number}`} deleteTitle={`Delete ${r.number}`}>
            {r.status === 'void' ? <span className="text-xs text-muted-foreground">Void</span>
              : r.status === 'refunded' ? <span className="text-xs text-muted-foreground">Refunded</span>
              : unapplied > 0 && canCreate ? (
                <Button variant="outline" size="xs" className="gap-1" disabled={refund.busy} onClick={() => void doRefund(r)}>
                  <Undo2 className="size-3" /> Refund received
                </Button>
              ) : null}
          </RowActions>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Vendor Credits"
        description="Money a supplier owes you back — returns, shortfalls, or over-billing."
        actions={
          (canCreate || canEdit) && (
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) startNew(); }}>
              {canCreate && (
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5" onClick={startNew}><Plus className="size-4" /> New vendor credit</Button>
                </DialogTrigger>
              )}
              <DialogContent data-slot="vendor-credit-dialog">
                <DialogHeader>
                  <DialogTitle>{editing ? `Edit vendor credit ${editing.number}` : 'New vendor credit'}</DialogTitle>
                  <FoldNav />
                  <DialogDescription>
                    {editing
                      ? 'Its entry is reversed and it is posted again under the same number; set against a bill, it is set against it again.'
                      : <>Leave the bill blank to keep the credit on the supplier&apos;s account for next time.</>}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Date" required>
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="vendor-credit-date" />
                  </Field>
                  <Field label="Vendor" required>
                    <ContactPicker
                      kind="vendor"
                      value={vendorId}
                      onChange={(v) => { setVendorId(v); setBillId(''); }}
                      canCreate={canCreate}
                    />
                  </Field>
                  <Field
                    label="Against bill"
                    hint={vendorId ? 'Only bills with a balance can be credited' : 'Pick a vendor first'}
                  >
                    <Combobox
                      options={[
                        // The bill it is set against, which may now show no balance.
                        ...(editing?.againstBillId && editing.vendorId === vendorId && !(vendorBills.data?.bills ?? []).some((b) => b.id === editing.againstBillId)
                          ? [{ value: editing.againstBillId, label: editing.againstBillNo ?? `Bill #${editing.againstBillId}`, sublabel: editing.againstBillRef ?? undefined }]
                          : []),
                        ...(vendorBills.data?.bills ?? []).map((b) => ({
                          value: b.id,
                          label: b.internalNo,
                          sublabel: b.vendorInvoiceNo,
                          meta: formatINR(b.balancePaise + (editing && b.id === editing.againstBillId ? editing.appliedPaise : 0)),
                        })),
                      ]}
                      value={billId}
                      onChange={setBillId}
                      placeholder="Standalone"
                      searchPlaceholder="Search bills"
                      showAvatar={false}
                      clearable
                    />
                  </Field>
                  <div className="flex gap-1 rounded-md border p-1 text-[13px]" data-slot="vendor-credit-mode">
                    {([['amount', 'By amount'], ['goods', 'Goods sent back (item lines)']] as const).map(([v, l]) => (
                      <button key={v} type="button" onClick={() => { setMode(v); if (v === 'amount') setGoods([]); }}
                        className={`flex-1 rounded px-2 py-1 ${mode === v ? 'bg-primary text-white' : 'hover:bg-muted'}`} data-slot={`vc-mode-${v}`}>{l}</button>
                    ))}
                  </div>
                  {mode === 'goods' && (
                    <div className="space-y-2 rounded-md border p-3" data-slot="vendor-credit-goods">
                      <p className="text-xs text-muted-foreground">
                        {billId ? 'Each item on the bill, with what came in. Enter how many go back: they leave stock out of this bill\'s FIFO layer.' : 'No bill named: the goods leave the newest layer received by the credit\'s date.'}
                      </p>
                      <table className="w-full text-[12.5px]">
                        <thead className="text-[11px] uppercase text-muted-foreground"><tr><th className="py-1 text-left font-medium">Item</th><th className="py-1 text-right font-medium">Came in</th><th className="py-1 text-right font-medium">Qty back</th><th className="py-1 text-right font-medium">Rate</th><th className="py-1 text-right font-medium">GST</th></tr></thead>
                        <tbody>
                          {goods.map((g, i) => (
                            <tr key={g.key} className="border-t" data-slot="vc-goods-row">
                              <td className="py-1 pr-2">{g.name || stockItems.data?.items.find((it) => String(it.id) === String(g.itemId))?.name || 'Item'}</td>
                              <td className="py-1 text-right tabular">{g.cameIn ?? '—'}</td>
                              <td className="py-1 text-right"><Input type="number" min={0} step="any" value={g.qty || ''} placeholder="0" className="h-7 w-20 text-right" data-slot="vc-goods-qty"
                                onChange={(e) => setGoods(goods.map((x, k) => (k === i ? { ...x, qty: Math.max(0, Number(e.target.value) || 0) } : x)))} /></td>
                              {/* Against a bill the rate is the bill's; with no bill it is the supplier's credit note rate, so it can be changed. */}
                              <td className="py-1 text-right tabular">{g.billLineId ? formatINR(g.ratePaise) : (
                                <Input type="number" min={0} step="0.01" value={g.ratePaise ? g.ratePaise / 100 : ''} className="ml-auto h-7 w-24 text-right" data-slot="vc-goods-rate" aria-label="Rate"
                                  onChange={(e) => setGoods(goods.map((x, k) => (k === i ? { ...x, ratePaise: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)) } : x)))} />
                              )}</td>
                              <td className="py-1 text-right tabular">{g.gstRatePct}%</td>
                            </tr>
                          ))}
                          {!goods.length && <tr><td colSpan={5} className="py-2 text-center text-muted-foreground">{billId ? 'This bill has no item lines.' : 'Add the items going back.'}</td></tr>}
                        </tbody>
                      </table>
                      {!billId && (
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <Combobox options={(stockItems.data?.items ?? []).map((it) => ({ value: it.id, label: it.name, sublabel: it.sku ?? undefined }))}
                              value={pickItem} onChange={setPickItem} placeholder="Add an item" searchPlaceholder="Search items" showAvatar={false} />
                          </div>
                          <Button size="sm" variant="outline" data-slot="vc-add-item" disabled={!pickItem} onClick={() => {
                            const it = (stockItems.data?.items ?? []).find((x) => x.id === pickItem);
                            if (!it) return;
                            setGoods([...goods, { key: `i${Date.now()}`, itemId: it.id, billLineId: null, name: it.name, cameIn: null, qty: 1, ratePaise: it.purchasePricePaise ?? 0, gstRatePct: it.gstRatePct ?? gstRate }]);
                            setPickItem('');
                          }}>Add</Button>
                        </div>
                      )}
                    </div>
                  )}
                  <Field label="Reason" required>
                    <Combobox
                      options={[...(REASONS.includes(reason) ? [] : [reason]), ...REASONS].map((r) => ({ value: r, label: r }))}
                      value={reason}
                      onChange={setReason}
                      showAvatar={false}
                    />
                  </Field>
                  {mode === 'amount' && <div className="grid grid-cols-2 gap-4">
                    <Field label="Taxable amount" required>
                      <MoneyInput valuePaise={amount} onChangePaise={setAmount} />
                    </Field>
                    <Field label="GST rate" hint="Match the original bill">
                      <Combobox
                        options={RATE_OPTIONS}
                        value={String(gstRate)}
                        onChange={(v) => setGstRate(Number(v))}
                        showAvatar={false}
                      />
                    </Field>
                  </div>}
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Input credit was claimed on this cost</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Turn this off for a blocked or reverse-charge purchase, where the tax was never put in
                        the credit pot to begin with.
                      </p>
                    </div>
                    <Switch checked={itcClaimed} onCheckedChange={setItcClaimed} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Credit incl. GST</span>
                    <Money
                      value={mode === 'goods' ? goodsTaxable + goodsTax : amount + Math.round((amount * gstRate) / 100)}
                      className="font-semibold"
                    />
                  </div>
                  {saveError && <p className="text-sm text-destructive" data-slot="vendor-credit-error">{saveError}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={saving} data-slot="vendor-credit-save">
                    {saving ? 'Saving…' : editing ? 'Save' : 'Record credit'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />
      <DeleteDocumentDialog kind="vendor-credit" id={deleting?.id ?? ''} number={deleting?.number ?? ''} open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null); }} onDeleted={() => void state.refetch()} />
      <AsyncPage state={state}>
        {(d) =>
          d.documents.length === 0 ? (
            <EmptyState
              icon={FileMinus}
              title="No vendor credits"
              description="Record one when a supplier short-ships, over-bills, or takes goods back."
            />
          ) : (
            <DataTable
              rows={d.documents}
              columns={[...columns, documentMenuColumn<PurchaseDocRow>('vendor-credit', state.refetch,
                (r) => { if (!loadingEdit) void startEdit(r.id); }, (r) => r.status !== 'refunded')]}
              getRowId={(r) => r.id}
              selectable
              bulkActions={(selected) => <BulkPrintButton kind="vendor-credit" ids={selected.map((r) => r.id)} />}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search credit or vendor…"
            />
          )
        }
      </AsyncPage>
    </>
  );
}
