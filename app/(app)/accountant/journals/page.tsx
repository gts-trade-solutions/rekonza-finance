'use client';

// Manual journals — the primitive underneath every other screen.
//
// Each line is one-sided: a debit or a credit, never both. The two columns must
// agree exactly before anything can be posted, and the server enforces that
// again on arrival. An entry that does not balance is not a warning to be
// dismissed; it is an entry that cannot exist.

import { useState } from 'react';
import { BookOpen, CalendarClock, Clock, Plus, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { JournalEntryTable } from '@/components/shared/journal-table';
import { Attachments } from '@/components/shared/attachments';
import { CostCentreSelect, useCostCentres } from '@/components/forms/cost-centre-picker';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  accounts as accountsApi, bills as billApi, heldJournals, invoices as invoiceApi, journal,
  type AccountRow, type HeldJournalRow, type JournalEntryRow, type JournalResponse,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface DraftRow {
  key: string; accountId: string; debit: number; credit: number; description: string;
  /** On Receivables or Payables: whose account, and which of their documents it settles. */
  contactId: string; againstId: string;
  /** On an income or expense line: the cost centre it belongs to. */
  costCentreId: string;
}

const emptyRow = (k: string): DraftRow => ({ key: k, accountId: '', debit: 0, credit: 0, description: '', contactId: '', againstId: '', costCentreId: '' });
const AR_CODE = '1100';
const AP_CODE = '2100';
const today = () => new Date().toISOString().slice(0, 10);

type SaveMode = 'post' | 'optional' | 'post_dated';
const SAVE_LABEL: Record<SaveMode, string> = { post: 'Post journal', optional: 'Save as optional', post_dated: 'Save post-dated' };
const KIND_LABEL: Record<HeldJournalRow['kind'], string> = { optional: 'Optional', post_dated: 'Post-dated', approval: 'Awaiting approval' };
const dmy = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function JournalsPage() {
  const canCreate = usePermission('accountant', 'create');

  // Manual and opening entries only. Everything else on this ledger was posted
  // by a document, and belongs on that document's screen rather than here.
  const state = useApi<JournalResponse>(
    () => journal.list({ sourceType: 'manual,opening,write_off,doubtful_debts', limit: 300 }),
    [],
  );
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);
  const held = useApi(() => heldJournals.list(), []);
  const [mode, setMode] = useState<SaveMode>('post');

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [reverseOn, setReverseOn] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([emptyRow('r1'), emptyRow('r2')]);
  const [viewing, setViewing] = useState<JournalEntryRow | null>(null);

  const create = useApiAction(journal.create);
  const reverse = useApiAction(journal.reverse);

  const totalDr = rows.reduce((t, r) => t + r.debit, 0);
  const totalCr = rows.reduce((t, r) => t + r.credit, 0);
  const balanced = totalDr === totalCr && totalDr > 0;

  const accountChoices = (chart.data?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: `${a.code} · ${a.type}`,
  }));

  const update = (key: string, patch: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const codeOf = (accountId: string) => chart.data?.accounts.find((a) => a.id === accountId)?.code;
  const centres = useCostCentres();
  const onPnl = (accountId: string) => ['income', 'expense'].includes(chart.data?.accounts.find((a) => a.id === accountId)?.type ?? '');

  const save = async () => {
    if (!memo.trim()) {
      toast.error('Add a narration so the entry can be understood later.');
      return;
    }
    const partyLine = rows.find((r) => [AR_CODE, AP_CODE].includes(codeOf(r.accountId) ?? '') && !r.contactId && (r.debit || r.credit));
    if (partyLine) {
      toast.error('Say whose account it is', { description: 'A line on Receivables or Payables needs the customer or vendor, or it will not show against anyone.' });
      return;
    }
    const result = await create.run({
      date,
      memo: memo.trim(),
      reverseOn: reverseOn || null,
      mode,
      lines: rows
        .filter((r) => r.accountId && (r.debit > 0 || r.credit > 0))
        .map((r) => {
          const [targetType, targetId, balance] = r.againstId.split(':');
          return {
            accountId: r.accountId,
            debitPaise: r.debit,
            creditPaise: r.credit,
            description: r.description || null,
            contactId: r.contactId || null,
            costCentreId: r.costCentreId || null,
            against: r.againstId
              ? [{ targetType, targetId, amountPaise: Math.min(r.debit || r.credit, Number(balance)) }]
              : undefined,
          };
        }),
    });
    if (!result) {
      if (create.wasQueued()) { setRows([emptyRow('r1'), emptyRow('r2')]); setMemo(''); setOpen(false); return; }
      toast.error(create.error ?? 'The entry was not posted');
      return;
    }
    if (result.held) {
      toast.success(
        result.kind === 'approval' ? `Held for ${result.approverRole ?? 'second-person'} approval`
          : result.kind === 'optional' ? 'Saved as an optional voucher' : `Post-dated: it posts itself on ${dmy(date)}`,
        { description: result.kind === 'approval' ? 'A journal rule covers entries this size. It posts when someone else approves it.' : 'Nothing reaches the books until then.' },
      );
    } else {
      toast.success(`Journal entry #${result.entryNo} posted`);
    }
    setOpen(false);
    setRows([emptyRow('r1'), emptyRow('r2')]);
    setMemo('');
    setReverseOn('');
    setMode('post');
    state.refetch();
    held.refetch();
  };

  const doReverse = async (r: JournalEntryRow) => {
    const done = await reverse.run(r.id, `Manual reversal of JE #${r.entryNo}`);
    if (!done) {
      toast.error(reverse.error ?? 'Could not reverse that entry');
      return;
    }
    toast.success(`Reversal posted as #${done.entryNo}`, {
      description: 'The original entry stays in the books — nothing is ever deleted.',
    });
    state.refetch();
  };

  const columns: Column<JournalEntryRow>[] = [
    { key: 'no', header: 'JE #', sortValue: (r) => r.entryNo, cell: (r) => <span className="font-mono font-medium">#{r.entryNo}</span> },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => new Date(r.date).toLocaleDateString('en-IN') },
    {
      key: 'memo', header: 'Narration', sortValue: (r) => r.memo ?? '',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span>{r.memo}</span>
          {r.reversalOf && <Badge variant="outline" className="border-destructive/40 text-[9px]">Reversal</Badge>}
          {r.sourceType === 'opening' && <Badge variant="secondary" className="text-[9px]">Opening</Badge>}
        </div>
      ),
    },
    { key: 'lines', header: 'Lines', align: 'center', sortValue: (r) => r.lines.length, cell: (r) => r.lines.length },
    {
      key: 'amount', header: 'Amount', align: 'right',
      sortValue: (r) => r.totalDebitPaise,
      cell: (r) => <Money value={r.totalDebitPaise} className="font-medium" />,
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1.5">
          <Button size="xs" variant="outline" onClick={(e) => { e.stopPropagation(); setViewing(r); }}>
            View
          </Button>
          {canCreate && !r.reversalOf && (
            <Button
              size="xs"
              variant="outline"
              className="gap-1"
              disabled={reverse.busy}
              onClick={(e) => { e.stopPropagation(); void doReverse(r); }}
            >
              <Undo2 className="size-3" /> Reverse
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Manual journals"
        description="The raw primitive underneath every other screen. Nothing posts unless debits equal credits exactly."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New journal</Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>New journal entry</DialogTitle>
                  <DialogDescription>
                    Each line is one-sided — either a debit or a credit. The two columns must agree before this
                    can be saved.
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Date" required>
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                  <Field label="Narration" required className="sm:col-span-2">
                    <Input
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder="What this entry records"
                    />
                  </Field>
                  <Field label="Reverse automatically on" hint="For an accrual or provision; leave blank for an ordinary entry">
                    <Input type="date" value={reverseOn} min={date} onChange={(e) => setReverseOn(e.target.value)} />
                  </Field>
                  <Field label="Save as" className="sm:col-span-2"
                    hint={mode === 'optional' ? 'Kept out of the books until someone posts it' : mode === 'post_dated' ? 'Posts itself on the date above, which must be after today' : 'Posts to the books now'}>
                    <div>
                      <select value={mode} onChange={(e) => setMode(e.target.value as SaveMode)}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        <option value="post">Regular entry</option>
                        <option value="optional">Optional voucher</option>
                        <option value="post_dated">Post-dated voucher</option>
                      </select>
                    </div>
                  </Field>
                </div>

                <div className="overflow-x-auto rounded-lg border thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-semibold">Account</th>
                        <th className="px-3 py-2 text-left font-semibold">Description</th>
                        <th className="px-3 py-2 text-right font-semibold">Debit</th>
                        <th className="px-3 py-2 text-right font-semibold">Credit</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-b last:border-0">
                          <td className="px-3 py-2">
                            <Combobox
                              options={accountChoices}
                              value={r.accountId}
                              onChange={(v) => update(r.key, { accountId: v, contactId: '', againstId: '', costCentreId: '' })}
                              placeholder="Select account"
                              searchPlaceholder="Search accounts by name or code"
                              showAvatar={false}
                              className="h-8"
                            />
                            {[AR_CODE, AP_CODE].includes(codeOf(r.accountId) ?? '') && (
                              <PartyBits
                                side={codeOf(r.accountId) === AR_CODE ? 'customer' : 'vendor'}
                                row={r}
                                // Settles a document only on the side that reduces what is owed.
                                canSettle={codeOf(r.accountId) === AR_CODE ? r.credit > 0 : r.debit > 0}
                                onChange={(patch) => update(r.key, patch)}
                              />
                            )}
                            {centres.length > 0 && onPnl(r.accountId) && (
                              <CostCentreSelect centres={centres} value={r.costCentreId} onChange={(v) => update(r.key, { costCentreId: v })} className="mt-1 h-7 text-xs" />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              value={r.description}
                              onChange={(e) => update(r.key, { description: e.target.value })}
                              className="h-8 text-xs"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <MoneyInput
                              valuePaise={r.debit}
                              onChangePaise={(p) => update(r.key, { debit: p, credit: p > 0 ? 0 : r.credit })}
                              className="h-8 w-32"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <MoneyInput
                              valuePaise={r.credit}
                              onChangePaise={(p) => update(r.key, { credit: p, debit: p > 0 ? 0 : r.debit })}
                              className="h-8 w-32"
                            />
                          </td>
                          <td className="px-1 py-2">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                              disabled={rows.length <= 2}
                            >
                              <Trash2 className="size-3.5 text-muted-foreground" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-muted/40 font-semibold">
                        <td className="px-3 py-2" colSpan={2}>Total</td>
                        <td className="px-3 py-2 text-right"><Money value={totalDr} /></td>
                        <td className="px-3 py-2 text-right"><Money value={totalCr} /></td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRows((rs) => [...rs, emptyRow(`r${rs.length + 1}${Date.now()}`)])}
                    className="gap-1.5"
                  >
                    <Plus className="size-3.5" /> Add line
                  </Button>
                  <Badge
                    variant="outline"
                    className={
                      balanced
                        ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                        : 'border-amber-500/40 text-amber-700 dark:text-amber-300'
                    }
                  >
                    {balanced
                      ? 'Balanced — ready to post'
                      : `Out of balance by ₹${(Math.abs(totalDr - totalCr) / 100).toLocaleString('en-IN')}`}
                  </Badge>
                </div>

                {create.error && <p className="text-sm text-destructive">{create.error}</p>}

                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={!balanced || create.busy}>
                    {create.busy ? 'Saving…' : SAVE_LABEL[mode]}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Manual journals are for things no document covers — depreciation, accruals, corrections, year-end
          adjustments. Everywhere else in the app, entries like these are created for you automatically.
        </p>
      </Card>

      {(held.data?.held.length ?? 0) > 0 && (
        <HeldList rows={held.data!.held} canAct={canCreate} onChanged={() => { held.refetch(); state.refetch(); }} />
      )}

      <AsyncPage state={state}>
        {(d) => (
          <DataTable
            rows={d.entries}
            columns={columns}
            getRowId={(r) => r.id}
            initialSort={{ key: 'no', dir: 'desc' }}
            dateFilter={{ getDate: (r) => r.date }}
            searchPlaceholder="Search narration…"
            emptyMessage="No manual journals yet."
          />
        )}
      </AsyncPage>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Journal entry detail</DialogTitle></DialogHeader>
          {viewing && <JournalEntryTable entry={viewing} />}
          {viewing && <Attachments targetType="journal" targetId={viewing.id} canEdit={canCreate} title="Supporting documents" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Entries held out of the books: optional vouchers, post-dated ones waiting for
 * their day, and those a journal rule holds for approval.
 */
function HeldList({ rows, canAct, onChanged }: { rows: HeldJournalRow[]; canAct: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<{ status: string; entryNo?: number; approverRole?: string }>) => {
    setBusy(id);
    try {
      const r = await fn();
      toast.success(r.status === 'posted' ? `Posted as JE #${r.entryNo}` : r.status === 'approval' ? `Sent for ${r.approverRole} approval` : 'Discarded');
      onChanged();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="mb-4 space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Held out of the books</h3>
        <span className="text-xs text-muted-foreground">Counted in no report until posted</span>
      </div>
      <ul className="divide-y rounded-md border text-sm">
        {rows.map((h) => (
          <li key={h.id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge variant={h.kind === 'approval' ? 'secondary' : 'outline'} className="gap-1 text-[10px]">
                {h.kind === 'post_dated' && <CalendarClock className="size-3" />}{KIND_LABEL[h.kind]}
              </Badge>
              <span className="tabular-nums text-muted-foreground">{dmy(h.date)}</span>
              <button type="button" className="font-medium hover:underline" onClick={() => setOpened(opened === h.id ? null : h.id)}>{h.memo}</button>
              {h.reverseOn && <span className="text-xs text-muted-foreground">reverses {dmy(h.reverseOn)}</span>}
              <span className="text-xs text-muted-foreground">by {h.createdBy ?? 'unknown'}</span>
              <Money value={h.totalPaise} className="ml-auto font-medium" />
              {canAct && h.kind !== 'approval' && (
                <Button size="xs" variant="outline" disabled={busy === h.id} onClick={() => void act(h.id, () => heldJournals.post(h.id))}>Post now</Button>
              )}
              {h.kind === 'approval' && (
                <Link href="/approvals" className="text-xs font-medium text-primary hover:underline">Open approvals</Link>
              )}
              {canAct && (
                <Button size="xs" variant="ghost" disabled={busy === h.id} onClick={() => void act(h.id, () => heldJournals.discard(h.id))}>Discard</Button>
              )}
            </div>
            {h.lastError && <p className="mt-1 text-xs text-destructive">Not posted on its date: {h.lastError}</p>}
            {opened === h.id && (
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {h.lines.map((l, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1 pr-2 font-mono text-muted-foreground">{l.accountCode}</td>
                      <td className="py-1 pr-2">{l.accountName}{l.description ? ` · ${l.description}` : ''}</td>
                      <td className="py-1 text-right">{l.debitPaise ? <Money value={l.debitPaise} /> : ''}</td>
                      <td className="py-1 text-right">{l.creditPaise ? <Money value={l.creditPaise} /> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The party on a Receivables or Payables line, and — on the side that reduces
 * what they owe or are owed — which of their open documents the line settles.
 */
function PartyBits({ side, row, canSettle, onChange }: {
  side: 'customer' | 'vendor';
  row: DraftRow;
  canSettle: boolean;
  onChange: (patch: Partial<DraftRow>) => void;
}) {
  const open = useApi(async () => {
    if (!row.contactId || !canSettle) return [];
    if (side === 'customer') {
      const r = await invoiceApi.list({ customerId: row.contactId, open: true, limit: 200 });
      return r.invoices.map((i) => ({ value: `invoice:${i.id}:${i.balancePaise}`, label: `${i.number} · ₹${(i.balancePaise / 100).toLocaleString('en-IN')} due` }));
    }
    const r = await billApi.list({ vendorId: row.contactId, open: true, limit: 200 });
    return r.bills.map((b) => ({ value: `bill:${b.id}:${b.balancePaise}`, label: `${b.vendorInvoiceNo || b.internalNo} · ₹${(b.balancePaise / 100).toLocaleString('en-IN')} due` }));
  }, [side, row.contactId, canSettle]);

  return (
    <div className="mt-1.5 space-y-1.5">
      <ContactPicker kind={side} value={row.contactId} onChange={(v) => onChange({ contactId: v, againstId: '' })} />
      {canSettle && row.contactId && (
        <Combobox
          options={[{ value: '', label: 'On account — no particular document' }, ...(open.data ?? [])]}
          value={row.againstId}
          onChange={(v) => onChange({ againstId: v })}
          placeholder="Settles…"
          showAvatar={false}
          className="h-8"
        />
      )}
    </div>
  );
}
