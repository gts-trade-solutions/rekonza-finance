'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Sending a period's books to TallyPrime.
//
// The screen answers three questions before anything is downloaded: what is in
// the period, what each of our accounts will be called over there, and what to
// do with the two files. The order on screen is the order of the job — pick the
// months, check the names, download ledgers, then vouchers.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { ArrowDownToLine, FileDown, Pencil, RotateCcw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { AsyncPage } from '@/components/shared/async-state';
import { tally, type LedgerMapRow, type TallyExportSummary } from '@/lib/api/tally';
import { TALLY_GROUPS } from '@/lib/tally/export';
import { describeRange, fromPreset, type RangeValue } from '@/lib/date-range';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { longDate } from '@/components/tally/format';

const today = () => new Date().toISOString().slice(0, 10);

export function ExportPanel() {
  const canEdit = usePermission('tally', 'edit');
  const [range, setRange] = useState<RangeValue>(() => fromPreset('this_month', today()));
  const [editing, setEditing] = useState(false);
  const state = useApi<TallyExportSummary>(
    () => tally.exportSummary(range.from, range.to),
    [range.from, range.to],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="micro-label">Period</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything posted in these dates, {describeRange(range).toLowerCase()}.
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-6">
            <Summary summary={d} range={range} />
            {d.warnings.length > 0 && <Warnings warnings={d.warnings} />}
            <Steps range={range} canDownload={d.voucherCount > 0} />
            <LedgerNames
              rows={d.map}
              canEdit={canEdit}
              editing={editing}
              onEditing={setEditing}
              onSaved={() => void state.refetch()}
            />
          </div>
        )}
      </AsyncPage>
    </div>
  );
}

function Summary({ summary: d, range }: { summary: TallyExportSummary; range: RangeValue }) {
  if (d.voucherCount === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground" data-slot="tally-export-empty">
        Nothing is posted in {describeRange(range).toLowerCase()}. Pick other dates, or enter some documents first.
      </Card>
    );
  }
  return (
    <section className="space-y-3" data-slot="tally-export-summary">
      <h2 className="micro-label">What will be sent</h2>
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Voucher type in Tally</th>
              <th className="px-4 py-2.5 text-right font-medium">Vouchers</th>
              <th className="px-4 py-2.5 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {d.byType.map((t) => (
              <tr key={t.voucherType}>
                <td className="px-4 py-2.5 font-medium">{t.voucherType}</td>
                <td className="px-4 py-2.5 text-right num">{t.count}</td>
                <td className="px-4 py-2.5 text-right">
                  <Money value={t.amountPaise} whole />
                </td>
              </tr>
            ))}
            <tr className="bg-muted/40 font-medium">
              <td className="px-4 py-2.5">
                {d.voucherCount} voucher{d.voucherCount === 1 ? '' : 's'}
              </td>
              <td className="px-4 py-2.5 text-right num">{d.ledgerCount} ledgers</td>
              <td className="px-4 py-2.5 text-right num">
                {d.partyCount} part{d.partyCount === 1 ? 'y' : 'ies'}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      {d.lastExport && (
        <p className="text-xs text-muted-foreground">
          Last download: {d.lastExport.kind === 'masters' ? 'ledgers' : 'vouchers'} up to{' '}
          {longDate(d.lastExport.to)}
          {d.lastExport.by ? ` by ${d.lastExport.by}` : ''}, on {longDate(d.lastExport.at.slice(0, 10))}.
        </p>
      )}
    </section>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <Card className="flex flex-row gap-3 border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30" data-slot="tally-export-warnings">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <div className="space-y-1 text-sm">
        {warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </Card>
  );
}

function Steps({ range, canDownload }: { range: RangeValue; canDownload: boolean }) {
  const download = (kind: 'masters' | 'vouchers') => {
    window.location.href = tally.exportFile(kind, range.from, range.to);
    toast.success(kind === 'masters' ? 'Ledgers file downloaded.' : 'Vouchers file downloaded.');
  };
  return (
    <section className="space-y-3">
      <h2 className="micro-label">Import into Tally</h2>
      <Card className="space-y-4 p-5" data-slot="tally-export-steps">
        <ol className="space-y-4 text-sm">
          <li className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-xl">
              <p className="font-medium">1. The ledgers, first</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                The customers, suppliers and accounts these vouchers name, so Tally has somewhere to
                put them. Ledgers Tally already has are left exactly as they are.
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={!canDownload} onClick={() => download('masters')} data-slot="tally-export-masters">
              <FileDown className="size-3.5" /> Ledgers file
            </Button>
          </li>
          <li className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-xl">
              <p className="font-medium">2. The vouchers</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Every invoice, bill, payment and journal in the period. Importing the same file twice
                updates the same vouchers instead of entering them again.
              </p>
            </div>
            <Button size="sm" disabled={!canDownload} onClick={() => download('vouchers')} data-slot="tally-export-vouchers">
              <ArrowDownToLine className="size-3.5" /> Vouchers file
            </Button>
          </li>
          <li className="max-w-2xl">
            <p className="font-medium">3. In TallyPrime</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Open the company, then Gateway of Tally → Import → Ledgers for the first file and
              Vouchers for the second. Tally lists anything it could not accept; nothing else stops.
            </p>
          </li>
        </ol>
      </Card>
    </section>
  );
}

function LedgerNames({
  rows, canEdit, editing, onEditing, onSaved,
}: {
  rows: LedgerMapRow[];
  canEdit: boolean;
  editing: boolean;
  onEditing: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, { ledgerName: string; parentGroup: string }>>({});
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const groups = useMemo(() => TALLY_GROUPS.map((g) => ({ value: g, label: g })), []);

  const shown = showAll ? rows : rows.filter((r) => r.used > 0);
  const valueOf = (r: LedgerMapRow) => draft[r.accountId] ?? { ledgerName: r.ledgerName, parentGroup: r.parentGroup };
  const changed = Object.keys(draft).length;

  const save = async () => {
    setSaving(true);
    try {
      await tally.saveLedgerNames(Object.entries(draft).map(([accountId, v]) => ({ accountId, ...v })));
      setDraft({});
      onEditing(false);
      onSaved();
      toast.success('Saved. The next download uses these names.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async (r: LedgerMapRow) => {
    await tally.resetLedgerName(r.accountId);
    setDraft((d) => {
      const next = { ...d };
      delete next[r.accountId];
      return next;
    });
    onSaved();
  };

  return (
    <section className="space-y-3" data-slot="tally-export-map">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="micro-label">What our accounts are called in Tally</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Change a name here to match a ledger the accountant already keeps, so nothing is created twice.
            Customers and suppliers keep their own names and are not listed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Only those used' : 'Show every account'}
          </Button>
          {canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => onEditing(true)} data-slot="tally-export-edit-map">
              <Pencil className="size-3.5" /> Change names
            </Button>
          )}
          {editing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setDraft({}); onEditing(false); }}>Cancel</Button>
              <Button size="sm" disabled={!changed || saving} onClick={() => void save()} data-slot="tally-export-save-map">
                Save {changed || ''}
              </Button>
            </>
          )}
        </div>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Our account</th>
              <th className="px-4 py-2.5 font-medium">Ledger in Tally</th>
              <th className="px-4 py-2.5 font-medium">Under group</th>
              <th className="px-4 py-2.5 text-right font-medium">Used</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((r) => {
              const v = valueOf(r);
              return (
                <tr key={r.accountId}>
                  <td className="px-4 py-2 align-middle">
                    <span className="font-mono text-xs text-muted-foreground">{r.code}</span>{' '}
                    <span className="font-medium">{r.accountName}</span>
                  </td>
                  <td className="px-4 py-2 align-middle">
                    {editing ? (
                      <Input
                        value={v.ledgerName}
                        maxLength={100}
                        onChange={(e) => setDraft((d) => ({ ...d, [r.accountId]: { ...v, ledgerName: e.target.value } }))}
                      />
                    ) : (
                      <span className="flex items-center gap-2">
                        {r.ledgerName}
                        {!r.isDefault && <Badge variant="secondary">changed</Badge>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 align-middle">
                    {editing ? (
                      <Combobox
                        options={groups}
                        value={v.parentGroup}
                        onChange={(g) => setDraft((d) => ({ ...d, [r.accountId]: { ...v, parentGroup: g } }))}
                        showAvatar={false}
                        searchPlaceholder="Search groups"
                      />
                    ) : (
                      <span className="text-muted-foreground">{r.parentGroup}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right align-middle">
                    {r.used > 0 ? <span className="num">{r.used}</span> : <span className="text-muted-foreground">—</span>}
                    {!r.isDefault && canEdit && !editing && (
                      <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reset(r)} title="Back to the default name">
                        <RotateCcw className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No account is used in this period. Show every account to set names in advance.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
