'use client';

// ─────────────────────────────────────────────────────────────────────────────
// HSN & SAC — the organisation's approved code list.
//
// Every taxable line on an invoice must carry one of these, and nothing else.
// The reason is GSTR-1 Table 12: the portal validates each code against the
// official master and checks the rate charged against the rate the code
// implies. A typo does not fail quietly — the whole return bounces. Curating
// the list here, once, removes that entire class of filing error, at the cost
// of an admin adding a code when the business starts selling something new.
//
// The list lives in the database and every invoice line is checked against it
// on the server. Hiding the free-text box would only be a courtesy; the check
// is what actually stops a bad code reaching a return.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Boxes, History, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { hsnCodes, type HsnCodeRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const KIND_OPTIONS = [
  { value: 'hsn', label: 'HSN — goods' },
  { value: 'sac', label: 'SAC — services' },
];

// 40% is the demerit-goods rate from 22 September 2025; 12% and 28% remain
// for documents dated before it, and 28% for tobacco.
const RATE_OPTIONS = [0, 0.25, 3, 5, 12, 18, 28, 40].map((r) => ({ value: String(r), label: `${r}%` }));

const UQC_OPTIONS = ['NOS', 'PCS', 'KGS', 'LTR', 'MTR', 'BOX', 'SET', 'BAG'].map((u) => ({
  value: u,
  label: u,
}));

const BLANK = {
  code: '',
  kind: 'hsn' as 'hsn' | 'sac',
  description: '',
  gstRatePct: '18',
  cessRatePct: '0',
  uqc: 'NOS',
};

/**
 * HSN is 4, 6 or 8 digits. SAC is always 6 and always begins 99 — that prefix
 * is what tells the portal a line is a service rather than a good.
 */
function validate(code: string, kind: 'hsn' | 'sac'): string | null {
  if (!/^[0-9]+$/.test(code)) return 'Codes are digits only.';
  if (kind === 'sac') {
    if (code.length !== 6) return 'A SAC is exactly 6 digits.';
    if (!code.startsWith('99')) return 'Every SAC begins with 99.';
    return null;
  }
  if (![4, 6, 8].includes(code.length)) return 'An HSN is 4, 6 or 8 digits.';
  if (code.startsWith('99')) return 'Codes beginning 99 are services — choose SAC.';
  return null;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A code's rates by date. A rate change is recorded from the day it took
 * effect, never typed over the old rate: invoices dated before it were raised
 * at the old rate and must keep it.
 */
function RateHistory({ code, canEdit, onChanged }: { code: HsnCodeRow; canEdit: boolean; onChanged: () => void }) {
  const [from, setFrom] = useState('');
  const [rate, setRate] = useState(String(code.gstRatePct));
  const [cess, setCess] = useState(String(code.cessRatePct));
  const [note, setNote] = useState('');
  const add = useApiAction(hsnCodes.addRate);
  const remove = useApiAction(hsnCodes.removeRate);

  const save = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { toast.error('Pick the date the rate took effect.'); return; }
    const done = await add.run({
      hsnCodeId: code.id, effectiveFrom: from, gstRatePct: Number(rate),
      cessRatePct: code.kind === 'hsn' ? Number(cess || 0) : 0, note: note.trim() || null,
    });
    if (!done) return;
    toast.success(`${code.code}: ${rate}% from ${fmtDate(from)}`);
    setFrom(''); setNote('');
    onChanged();
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <History className="size-4 text-muted-foreground" /> Rate history
      </p>
      {code.rates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No changes recorded. Every document uses {code.gstRatePct}%{code.cessRatePct > 0 ? ` + ${code.cessRatePct}% cess` : ''}.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {[...code.rates].reverse().map((r) => (
            <li key={r.effectiveFrom} className="flex items-center justify-between gap-2">
              <span>
                From {fmtDate(r.effectiveFrom)}: <span className="tabular font-medium">{r.gstRatePct}%</span>
                {r.cessRatePct > 0 && <span className="text-muted-foreground"> + {r.cessRatePct}% cess</span>}
                {r.note && <span className="block text-xs text-muted-foreground">{r.note}</span>}
              </span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove the rate from ${r.effectiveFrom}`}
                  onClick={async () => {
                    if (await remove.run(code.id, r.effectiveFrom)) onChanged();
                  }}
                  className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-4">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Effective from" />
          <Combobox options={RATE_OPTIONS} value={rate} onChange={setRate} showAvatar={false} />
          {code.kind === 'hsn' ? (
            <Input
              value={cess}
              onChange={(e) => setCess(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="Cess %"
              aria-label="Cess rate"
              inputMode="decimal"
            />
          ) : <span />}
          <Button size="sm" onClick={save} disabled={add.busy}>{add.busy ? 'Saving…' : 'Add change'}</Button>
          <Input
            className="sm:col-span-4"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Notification or reason, e.g. Notification 9/2025-CT(R)"
          />
          {(add.error ?? remove.error) && (
            <p className="text-sm text-destructive sm:col-span-4">{add.error ?? remove.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function HsnCodesPage() {
  const canEdit = usePermission('settings', 'edit');
  const state = useApi<{ hsnCodes: HsnCodeRow[] }>(() => hsnCodes.list(), []);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<HsnCodeRow | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);

  const create = useApiAction(hsnCodes.create);
  const update = useApiAction(hsnCodes.update);
  const remove = useApiAction(hsnCodes.remove);
  const busy = create.busy || update.busy || remove.busy;

  // Memoised so the empty fallback is not a fresh array on every render, which
  // would make the filter below recompute for no reason.
  const codes = useMemo(() => state.data?.hsnCodes ?? [], [state.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return codes;
    // Same rule the invoice picker uses: codes match by prefix, text anywhere.
    return codes.filter((c) => c.code.startsWith(q) || c.description.toLowerCase().includes(q));
  }, [codes, query]);

  const startNew = () => {
    setEditing(null);
    setF(BLANK);
    create.reset();
    update.reset();
    setOpen(true);
  };

  const startEdit = (c: HsnCodeRow) => {
    setEditing(c);
    setF({
      code: c.code,
      kind: c.kind,
      description: c.description,
      gstRatePct: String(c.gstRatePct),
      cessRatePct: String(c.cessRatePct),
      uqc: c.uqc ?? 'NOS',
    });
    create.reset();
    update.reset();
    setOpen(true);
  };

  const save = async () => {
    const code = f.code.trim();
    const err = validate(code, f.kind);
    if (err) { toast.error(err); return; }
    if (!f.description.trim()) {
      toast.error('Add a description so the next person knows what it covers.');
      return;
    }

    const rate = Number(f.gstRatePct);
    // Cess is levied on goods only; a service code never carries it.
    const cess = f.kind === 'hsn' ? Number(f.cessRatePct || 0) : 0;
    if (!Number.isFinite(cess) || cess < 0) {
      toast.error('The cess rate is a percentage of zero or more.');
      return;
    }
    if (editing) {
      // The code itself is not editable. Changing it would silently detach every
      // item and line already carrying the old one.
      const done = await update.run({
        id: editing.id,
        description: f.description.trim(),
        gstRatePct: rate,
        cessRatePct: cess,
        uqc: f.kind === 'hsn' ? f.uqc : null,
      });
      if (!done) return;
      toast.success(`${editing.code} updated`);
    } else {
      const done = await create.run({
        code,
        description: f.description.trim(),
        gstRatePct: rate,
        cessRatePct: cess,
        uqc: f.kind === 'hsn' ? f.uqc : null,
      });
      if (!done) return;
      toast.success(`${code} added`, { description: 'It is now selectable on invoice lines.' });
    }
    setOpen(false);
    state.refetch();
  };

  const toggleActive = async (c: HsnCodeRow, active: boolean) => {
    const done = await update.run({ id: c.id, isActive: active });
    if (!done) {
      toast.error(update.error ?? `${c.code} could not be changed`);
      return;
    }
    toast.info(active ? `${c.code} is selectable again` : `${c.code} hidden from new documents`, {
      description: active ? undefined : 'Documents already using it are untouched.',
    });
    state.refetch();
  };

  const drop = async (c: HsnCodeRow) => {
    const done = await remove.run(c.id);
    if (!done) {
      toast.error(remove.error ?? `${c.code} is in use`, {
        description: 'Turn it off instead — deleting would leave those documents without a code.',
      });
      return;
    }
    toast.info(`${c.code} removed`);
    state.refetch();
  };

  const goods = codes.filter((c) => c.kind === 'hsn').length;
  const services = codes.filter((c) => c.kind === 'sac').length;
  const th = 'px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

  return (
    <>
      <PageHeader
        title="HSN & SAC Codes"
        description="The only codes your team can put on an invoice. Curated here so nothing invalid ever reaches a GST return."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings">
                <ArrowLeft className="mr-1.5 size-3.5" /> Settings
              </Link>
            </Button>
            {canEdit && (
              <Button size="sm" onClick={startNew} className="gap-1.5">
                <Plus className="size-4" /> New Code
              </Button>
            )}
          </>
        }
      />

      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
        <div className="flex items-center gap-2 text-sm">
          <Boxes className="size-4 text-muted-foreground" />
          <span className="tabular font-medium">{goods}</span>
          <span className="text-muted-foreground">HSN codes for goods</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Wrench className="size-4 text-muted-foreground" />
          <span className="tabular font-medium">{services}</span>
          <span className="text-muted-foreground">SAC codes for services</span>
        </div>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type the first digits, or a description"
            className="pl-8"
          />
        </div>
      </Card>

      <AsyncPage state={state}>
        {() =>
          filtered.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title={query ? `No code starts with “${query}”` : 'No codes configured'}
              description={
                query
                  ? 'Search matches the start of the code, or anywhere in the description.'
                  : 'Add the ten or fifteen codes your business actually sells under.'
              }
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={cn(th, 'text-left')}>Code</th>
                    <th className={cn(th, 'text-left')}>Type</th>
                    <th className={cn(th, 'text-left')}>Description</th>
                    <th className={cn(th, 'text-right')}>GST</th>
                    <th className={cn(th, 'text-right')}>Items</th>
                    <th className={cn(th, 'text-right')}>Lines</th>
                    <th className={cn(th, 'text-center')}>Selectable</th>
                    <th className="w-20 px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      className={cn('border-b last:border-0 hover:bg-accent/40', !c.isActive && 'opacity-55')}
                    >
                      <td className="px-4 py-2 font-mono text-sm font-medium">{c.code}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {c.kind === 'sac' ? 'SAC' : 'HSN'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-sm text-muted-foreground">{c.description}</td>
                      <td className="px-4 py-2 text-right text-sm tabular">
                        {c.gstRatePct}%
                        {c.cessRatePct > 0 && (
                          <span className="block text-xs text-muted-foreground">+ {c.cessRatePct}% cess</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-sm tabular text-muted-foreground">{c.itemCount}</td>
                      <td className="px-4 py-2 text-right text-sm tabular text-muted-foreground">{c.lineCount}</td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          checked={c.isActive}
                          disabled={!canEdit || busy}
                          onCheckedChange={(v) => void toggleActive(c, v)}
                        />
                      </td>
                      <td className="px-4 py-2">
                        {canEdit && (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              aria-label={`Edit ${c.code}`}
                              onClick={() => startEdit(c)}
                              className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${c.code}`}
                              disabled={busy}
                              onClick={() => void drop(c)}
                              className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            </Card>
          )
        }
      </AsyncPage>

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <Boxes className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sales users cannot type a code that is not on this list — the invoice picker offers these and nothing
          else, and the server rejects any line that carries something different. Disabling a code hides it from
          new documents but leaves every invoice that already used it exactly as filed, because a posted document
          must always report the code it was filed under.
        </p>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.code}` : 'Add a code'}</DialogTitle>
            <DialogDescription>
              Use the code exactly as it appears in the GST master. The rate here becomes the default when a line
              picks this code without an item behind it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Applies to" required>
              <Combobox
                options={KIND_OPTIONS}
                value={f.kind}
                onChange={(v) => setF({ ...f, kind: v as 'hsn' | 'sac' })}
                showAvatar={false}
                disabled={!!editing}
              />
            </Field>
            <Field
              label="Code"
              required
              hint={
                editing
                  ? 'A code cannot be changed once approved — items and filed lines point at it.'
                  : f.kind === 'sac'
                    ? 'Six digits, beginning 99'
                    : 'Four, six or eight digits'
              }
              error={create.fieldErrors.code}
            >
              <Input
                value={f.code}
                disabled={!!editing}
                onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^0-9]/g, '').slice(0, 8) })}
                placeholder={f.kind === 'sac' ? '990000' : '0000'}
                className="font-mono"
                inputMode="numeric"
              />
            </Field>
            <Field
              label="Description"
              required
              hint="What the code covers, in your own words"
              error={create.fieldErrors.description ?? update.fieldErrors.description}
            >
              <Input
                value={f.description}
                onChange={(e) => setF({ ...f, description: e.target.value })}
                placeholder="Description of the goods or service"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default GST rate" required>
                <Combobox
                  options={RATE_OPTIONS}
                  value={f.gstRatePct}
                  onChange={(v) => setF({ ...f, gstRatePct: v })}
                  showAvatar={false}
                />
              </Field>
              {f.kind === 'hsn' && (
                <Field label="Unit (UQC)" hint="The unit GSTR-1 expects">
                  <Combobox
                    options={UQC_OPTIONS}
                    value={f.uqc}
                    onChange={(v) => setF({ ...f, uqc: v })}
                    showAvatar={false}
                  />
                </Field>
              )}
              {f.kind === 'hsn' && (
                <Field label="Cess rate (%)" hint="Compensation cess on these goods. Leave 0 if none applies.">
                  <Input
                    value={f.cessRatePct}
                    onChange={(e) => setF({ ...f, cessRatePct: e.target.value.replace(/[^0-9.]/g, '') })}
                    inputMode="decimal"
                    className="tabular"
                  />
                </Field>
              )}
            </div>
            {editing && (
              <RateHistory
                code={codes.find((c) => c.id === editing.id) ?? editing}
                canEdit={canEdit}
                onChanged={() => state.refetch()}
              />
            )}
            {(create.error ?? update.error) && (
              <p className="text-sm text-destructive">{create.error ?? update.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add code'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
