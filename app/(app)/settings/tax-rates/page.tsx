'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TDS and TCS rates, by the date each took effect.
//
// A bill is deducted, and an invoice collects, at the rate in force on its own
// date. When a rate changes, the change is added from its date as a new row —
// never typed over the old one, because documents already raised were taxed
// at the old rate.
//
// The rates that ship with the software came from published rate charts, not
// the gazette. Every one shows as "to verify" until someone qualified checks
// it against the law and marks it verified; changing a rate clears that mark.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, BadgeCheck, ExternalLink, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { taxRates, type TaxRatesResponse, type TcsRateRow, type TdsRateRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { ACT_2025_FROM } from '@/lib/tax/statutory-rates';

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Rupees typed as text, to paise; blank means no threshold. */
const toPaiseOrNull = (v: string): number | null => (v.trim() === '' ? null : Math.round(Number(v) * 100));
const rupeesText = (p: number | null) => (p === null ? '' : String(p / 100));

type Form =
  | {
      kind: 'tds'; code: string; actRef: string; nature: string; effectiveFrom: string;
      rateIndividualPct: string; rateOtherPct: string; rateNoPanPct: string;
      thresholdSingle: string; thresholdAnnual: string; onExcessOnly: boolean; sourceUrl: string;
    }
  | {
      kind: 'tcs'; code: string; actRef: string; nature: string; effectiveFrom: string;
      ratePct: string; rateNoPanPct: string; threshold: string; sourceUrl: string;
    };

const tdsForm = (r?: TdsRateRow): Form => ({
  kind: 'tds',
  code: r?.code ?? '', actRef: r?.actRef ?? '', nature: r?.nature ?? '', effectiveFrom: r?.effectiveFrom ?? '',
  rateIndividualPct: r ? String(r.rateIndividualPct) : '', rateOtherPct: r ? String(r.rateOtherPct) : '',
  rateNoPanPct: r ? String(r.rateNoPanPct) : '20',
  thresholdSingle: rupeesText(r?.thresholdSinglePaise ?? null), thresholdAnnual: rupeesText(r?.thresholdAnnualPaise ?? null),
  onExcessOnly: r?.onExcessOnly ?? false, sourceUrl: r?.sourceUrl ?? '',
});

const tcsForm = (r?: TcsRateRow): Form => ({
  kind: 'tcs',
  code: r?.code ?? '', actRef: r?.actRef ?? '', nature: r?.nature ?? '', effectiveFrom: r?.effectiveFrom ?? '',
  ratePct: r ? String(r.ratePct) : '', rateNoPanPct: r ? String(r.rateNoPanPct) : '5',
  threshold: rupeesText(r?.thresholdPaise ?? null), sourceUrl: r?.sourceUrl ?? '',
});

function Status({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge variant="outline" className="gap-1 border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300">
      <BadgeCheck className="size-3" /> Verified
    </Badge>
  ) : (
    <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">
      To verify
    </Badge>
  );
}

function Source({ url }: { url: string | null }) {
  if (!url) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
      Source <ExternalLink className="size-3" />
    </a>
  );
}

export default function TaxRatesPage() {
  const canEdit = usePermission('gst', 'edit');
  const state = useApi<TaxRatesResponse>(() => taxRates.get(), []);
  const [form, setForm] = useState<Form | null>(null);

  const save = useApiAction(taxRates.save);
  const verify = useApiAction(taxRates.verify);
  const remove = useApiAction(taxRates.remove);
  const busy = save.busy || verify.busy || remove.busy;

  const submit = async () => {
    if (!form) return;
    if (!form.code.trim() || !form.nature.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom)) {
      toast.error('A rate needs a section, what it covers, and the date it took effect.');
      return;
    }
    const common = {
      code: form.code.trim(), actRef: form.actRef.trim() || null, nature: form.nature.trim(),
      effectiveFrom: form.effectiveFrom, sourceUrl: form.sourceUrl.trim() || null,
    };
    const payload = form.kind === 'tds'
      ? {
          kind: 'tds' as const, ...common,
          rateIndividualPct: Number(form.rateIndividualPct), rateOtherPct: Number(form.rateOtherPct),
          rateNoPanPct: Number(form.rateNoPanPct),
          thresholdSinglePaise: toPaiseOrNull(form.thresholdSingle),
          thresholdAnnualPaise: toPaiseOrNull(form.thresholdAnnual),
          onExcessOnly: form.onExcessOnly,
        }
      : {
          kind: 'tcs' as const, ...common,
          ratePct: Number(form.ratePct), rateNoPanPct: Number(form.rateNoPanPct),
          thresholdPaise: toPaiseOrNull(form.threshold),
        };
    const done = await save.run(payload);
    if (!done) return;
    toast.success(`${common.code} from ${fmtDate(common.effectiveFrom)} saved`, {
      description: 'It shows as to verify until someone checks it.',
    });
    setForm(null);
    state.refetch();
  };

  const markVerified = async (kind: 'tds' | 'tcs', code: string, effectiveFrom: string) => {
    if (await verify.run({ kind, code, effectiveFrom })) {
      toast.success(`${code} marked verified`);
      state.refetch();
    } else toast.error(verify.error ?? 'Could not mark it verified');
  };

  const drop = async (kind: 'tds' | 'tcs', code: string, effectiveFrom: string) => {
    if (await remove.run({ kind, code, effectiveFrom })) {
      toast.info(`${code} from ${fmtDate(effectiveFrom)} removed`);
      state.refetch();
    } else toast.error(remove.error ?? 'Could not remove it');
  };

  const th = 'px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
  const actions = (kind: 'tds' | 'tcs', r: { code: string; effectiveFrom: string; verified: boolean }, edit: () => void) =>
    canEdit && (
      <div className="flex items-center justify-end gap-1">
        {!r.verified && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy}
            onClick={() => void markVerified(kind, r.code, r.effectiveFrom)}>
            Mark verified
          </Button>
        )}
        <button type="button" aria-label={`Edit ${r.code}`} onClick={edit}
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <Pencil className="size-3.5" />
        </button>
        <button type="button" aria-label={`Remove ${r.code} from ${r.effectiveFrom}`} disabled={busy}
          onClick={() => void drop(kind, r.code, r.effectiveFrom)}
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    );

  return (
    <>
      <PageHeader
        title="TDS & TCS Rates"
        description="The rate for each section by the date it took effect. Bills and invoices use the one in force on their own date."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings"><ArrowLeft className="mr-1.5 size-3.5" /> Settings</Link>
            </Button>
            {canEdit && (
              <>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setForm(tcsForm())}>
                  <Plus className="size-4" /> TCS rate
                </Button>
                <Button size="sm" className="gap-1.5" onClick={() => setForm(tdsForm())}>
                  <Plus className="size-4" /> TDS rate
                </Button>
              </>
            )}
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const unverified = d.tds.filter((r) => !r.verified).length + d.tcs.filter((r) => !r.verified).length;
          return (
            <>
              {unverified > 0 && (
                <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4">
                  <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
                  <div className="text-sm">
                    <p className="font-medium">{unverified} rate{unverified === 1 ? '' : 's'} still to verify</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {d.shipped
                        ? 'These are the rates that came with the software, taken from published rate charts. '
                        : ''}
                      Have your CA check each against the Act and mark it verified before relying on it for a
                      filing. From {fmtDate(ACT_2025_FROM)}, returns use the Income-tax Act, 2025 references shown
                      under each section.
                    </p>
                  </div>
                </Card>
              )}

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={th}>TDS section</th>
                    <th className={th}>From</th>
                    <th className={`${th} text-right`}>Rate</th>
                    <th className={`${th} text-right`}>No PAN</th>
                    <th className={th}>Threshold</th>
                    <th className={th}>Source</th>
                    <th className={th}>Status</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {d.tds.map((r) => (
                    <tr key={`${r.code}-${r.effectiveFrom}`} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="px-3 py-2">
                        <p className="text-sm font-medium">{r.code} — {r.nature}</p>
                        {r.actRef && <p className="text-xs text-muted-foreground">Income-tax Act, 2025: {r.actRef}</p>}
                      </td>
                      <td className="px-3 py-2 text-sm">{fmtDate(r.effectiveFrom)}</td>
                      <td className="px-3 py-2 text-right text-sm tabular">
                        {r.rateIndividualPct === r.rateOtherPct
                          ? `${r.rateOtherPct}%`
                          : `${r.rateIndividualPct}% / ${r.rateOtherPct}%`}
                        {r.rateIndividualPct !== r.rateOtherPct && (
                          <span className="block text-[10px] text-muted-foreground">individual / others</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-sm tabular">{r.rateNoPanPct}%</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.thresholdSinglePaise !== null && <span className="block">Over {formatINR(r.thresholdSinglePaise)} a payment</span>}
                        {r.thresholdAnnualPaise !== null && <span className="block">Over {formatINR(r.thresholdAnnualPaise)} a year</span>}
                        {r.onExcessOnly && <span className="block">On the excess only</span>}
                      </td>
                      <td className="px-3 py-2"><Source url={r.sourceUrl} /></td>
                      <td className="px-3 py-2"><Status verified={r.verified} /></td>
                      <td className="px-3 py-2">{actions('tds', r, () => setForm(tdsForm(r)))}</td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={th}>TCS head</th>
                    <th className={th}>From</th>
                    <th className={`${th} text-right`}>Rate</th>
                    <th className={`${th} text-right`}>No PAN</th>
                    <th className={th}>Threshold</th>
                    <th className={th}>Source</th>
                    <th className={th}>Status</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {d.tcs.map((r) => (
                    <tr key={`${r.code}-${r.effectiveFrom}`} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="px-3 py-2">
                        <p className="text-sm font-medium">{r.nature}</p>
                        <p className="text-xs text-muted-foreground">{r.code}{r.actRef ? ` · Income-tax Act, 2025: ${r.actRef}` : ''}</p>
                      </td>
                      <td className="px-3 py-2 text-sm">{fmtDate(r.effectiveFrom)}</td>
                      <td className="px-3 py-2 text-right text-sm tabular">{r.ratePct}%</td>
                      <td className="px-3 py-2 text-right text-sm tabular">{r.rateNoPanPct}%</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.thresholdPaise !== null ? `Sales over ${formatINR(r.thresholdPaise)}` : 'Every sale'}
                      </td>
                      <td className="px-3 py-2"><Source url={r.sourceUrl} /></td>
                      <td className="px-3 py-2"><Status verified={r.verified} /></td>
                      <td className="px-3 py-2">{actions('tcs', r, () => setForm(tcsForm(r)))}</td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
              <p className="text-xs text-muted-foreground">
                TCS on ordinary sales of goods ended on 1 April 2025. Only the goods listed above still carry it.
              </p>
            </>
          );
        }}
      </AsyncPage>

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{form?.kind === 'tcs' ? 'TCS rate' : 'TDS rate'}</DialogTitle>
            <DialogDescription>
              A change of rate is a new row from the date it took effect. Correct an existing row only when it was
              entered wrongly.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Section" required hint={form.kind === 'tds' ? 'e.g. 194C' : 'e.g. TCS-SCRAP'}>
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Took effect on" required>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
              </Field>
              <Field label="What it covers" required className="sm:col-span-2">
                <Input value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} />
              </Field>
              <Field label="Income-tax Act, 2025 reference" hint="e.g. 393(1) Table Sl. 6(i)" className="sm:col-span-2">
                <Input value={form.actRef} onChange={(e) => setForm({ ...form, actRef: e.target.value })} />
              </Field>
              {form.kind === 'tds' ? (
                <>
                  <Field label="Rate, individuals & HUFs (%)">
                    <Input inputMode="decimal" value={form.rateIndividualPct}
                      onChange={(e) => setForm({ ...form, rateIndividualPct: e.target.value })} />
                  </Field>
                  <Field label="Rate, others (%)">
                    <Input inputMode="decimal" value={form.rateOtherPct}
                      onChange={(e) => setForm({ ...form, rateOtherPct: e.target.value })} />
                  </Field>
                  <Field label="Rate without PAN (%)">
                    <Input inputMode="decimal" value={form.rateNoPanPct}
                      onChange={(e) => setForm({ ...form, rateNoPanPct: e.target.value })} />
                  </Field>
                  <Field label="Single payment over (₹)" hint="Blank for none">
                    <Input inputMode="decimal" value={form.thresholdSingle}
                      onChange={(e) => setForm({ ...form, thresholdSingle: e.target.value })} />
                  </Field>
                  <Field label="Year's total over (₹)" hint="Blank for none">
                    <Input inputMode="decimal" value={form.thresholdAnnual}
                      onChange={(e) => setForm({ ...form, thresholdAnnual: e.target.value })} />
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <Checkbox checked={form.onExcessOnly}
                      onCheckedChange={(v) => setForm({ ...form, onExcessOnly: v === true })} />
                    Deduct only on the excess
                  </label>
                </>
              ) : (
                <>
                  <Field label="Rate (%)">
                    <Input inputMode="decimal" value={form.ratePct}
                      onChange={(e) => setForm({ ...form, ratePct: e.target.value })} />
                  </Field>
                  <Field label="Rate without PAN (%)">
                    <Input inputMode="decimal" value={form.rateNoPanPct}
                      onChange={(e) => setForm({ ...form, rateNoPanPct: e.target.value })} />
                  </Field>
                  <Field label="Only on sales over (₹)" hint="Blank for every sale" className="sm:col-span-2">
                    <Input inputMode="decimal" value={form.threshold}
                      onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
                  </Field>
                </>
              )}
              <Field label="Source" hint="Where the rate was checked: the Act, a notification or a circular" className="sm:col-span-2">
                <Input value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://" />
              </Field>
              {save.error && <p className="text-sm text-destructive sm:col-span-2">{save.error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{save.busy ? 'Saving…' : 'Save rate'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
