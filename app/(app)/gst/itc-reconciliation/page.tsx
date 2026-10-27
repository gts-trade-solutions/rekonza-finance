'use client';

// Books against GSTR-2B.
//
// Since 2022 input credit is only claimable if the supplier actually filed the
// invoice. What is in your books is irrelevant if it is not in your 2B — so the
// comparison has to run in both directions, and the expensive direction is the
// second one: a bill you hold and have already claimed credit on, that the
// supplier never filed.
//
// The statement comes from the GSTR-2B JSON the portal lets you download, and
// each supplier line carries what was decided for it in IMS — accepted,
// rejected or kept pending. A line with no action is deemed accepted when the
// portal generates 2B, so silence is a decision too.

import { useRef, useState } from 'react';
import { CheckCircle2, Mail, ShieldAlert, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { gst, gstr2b, type ItcMatchRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { formatINRCompact } from '@/lib/money';

const BUCKETS = {
  matched: {
    label: 'Matched',
    tone: 'text-emerald-600 dark:text-emerald-400',
    blurb: 'Your bill and the supplier’s filing agree. Credit is safe to claim.',
  },
  mismatch: {
    label: 'Mismatched',
    tone: 'text-amber-600 dark:text-amber-400',
    blurb:
      'Both sides reported the invoice but the figures differ. Someone has a typo — usually worth a phone call.',
  },
  missing_in_books: {
    label: 'Not in your books',
    tone: 'text-blue-600 dark:text-blue-400',
    blurb: 'The supplier filed an invoice you never recorded. You are leaving credit on the table — book it.',
  },
  missing_in_portal: {
    label: 'Supplier has not filed',
    tone: 'text-red-600 dark:text-red-400',
    blurb:
      'You claimed credit but the government has no record. This is the money most at risk — chase the vendor before the annual return.',
  },
} as const;

type Bucket = keyof typeof BUCKETS;

const thisMonth = () => new Date().toISOString().slice(0, 7);
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const IMS: Record<'accepted' | 'rejected' | 'pending', { label: string; tone: string }> = {
  accepted: { label: 'Accepted', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  rejected: { label: 'Rejected', tone: 'border-red-500/40 text-red-700 dark:text-red-300' },
  pending: { label: 'Pending', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
};

function ImsBadge({ action }: { action: ItcMatchRow['imsAction'] }) {
  if (!action) {
    return <span className="text-[10px] text-muted-foreground" title="The portal deems it accepted">No action</span>;
  }
  return <Badge variant="outline" className={cn('text-[10px]', IMS[action].tone)}>{IMS[action].label}</Badge>;
}

function MatchTable({
  rows, selected, onToggle, canEdit,
}: {
  rows: ItcMatchRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  canEdit: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
        Nothing in this bucket for the period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border thin-scroll">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            {canEdit && <th className="w-8 px-3 py-2" />}
            <th className="px-3 py-2 text-left font-semibold">Supplier</th>
            <th className="px-3 py-2 text-left font-semibold">GSTIN</th>
            <th className="px-3 py-2 text-left font-semibold">Their invoice</th>
            <th className="px-3 py-2 text-left font-semibold">Date</th>
            <th className="px-3 py-2 text-left font-semibold">Our bill</th>
            <th className="px-3 py-2 text-right font-semibold">Portal</th>
            <th className="px-3 py-2 text-right font-semibold">Books</th>
            <th className="px-3 py-2 text-right font-semibold">Difference</th>
            <th className="px-3 py-2 text-left font-semibold">IMS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.vendorGstin}-${r.invoiceNo}-${i}`} className="border-b last:border-0 hover:bg-accent/40">
              {canEdit && (
                <td className="px-3 py-2">
                  {r.id && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.invoiceNo}`}
                      checked={selected.has(r.id)}
                      onChange={() => onToggle(r.id!)}
                      className="size-3.5 accent-primary"
                    />
                  )}
                </td>
              )}
              <td className="px-3 py-2 font-medium">{r.vendorName ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-[10px]">{r.vendorGstin}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {r.invoiceNo}
                {r.docType !== 'invoice' && (
                  <Badge variant="secondary" className="ml-1.5 text-[9px]">
                    {r.docType === 'credit_note' ? 'Credit note' : 'Debit note'}
                  </Badge>
                )}
                {r.isReverseCharge && <Badge variant="secondary" className="ml-1.5 text-[9px]">RCM</Badge>}
              </td>
              <td className="px-3 py-2 text-xs">{short(r.invoiceDate)}</td>
              <td className="px-3 py-2 text-xs">{r.billNo ?? '—'}</td>
              <td className="px-3 py-2 text-right"><Money value={r.portalTaxPaise} showZero={false} /></td>
              <td className="px-3 py-2 text-right"><Money value={r.booksTaxPaise} showZero={false} /></td>
              <td className="px-3 py-2 text-right">
                <Money value={r.differencePaise} colored showZero={false} className="font-medium" />
              </td>
              <td className="px-3 py-2">
                {r.id ? <ImsBadge action={r.imsAction} /> : <span className="text-[10px] text-muted-foreground">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ItcReconciliationPage() {
  const [period, setPeriod] = useState(thisMonth());
  const state = useApi(() => gst.itc(period), [period]);
  const canEdit = usePermission('gst', 'edit');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const importer = useApiAction(gstr2b.import);
  const ims = useApiAction(gstr2b.ims);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // The file is read in the browser and sent as JSON; nothing is sent until
  // it has at least parsed.
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      toast.error('That file is not JSON. Download GSTR-2B as JSON from the portal.');
      return;
    }
    const r = await importer.run(json);
    if (fileRef.current) fileRef.current.value = '';
    if (!r) { toast.error(importer.error ?? 'The file could not be imported.'); return; }
    toast.success(`GSTR-2B for ${r.gstin}, ${r.returnPeriod.slice(0, 2)}/${r.returnPeriod.slice(2)} imported`, {
      description: `${r.inserted} new, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} could not be read` : ''}.`,
    });
    const imported = `${r.returnPeriod.slice(2)}-${r.returnPeriod.slice(0, 2)}`;
    if (imported !== period) setPeriod(imported); else state.refetch();
  };

  const act = async (action: 'accepted' | 'rejected' | 'pending' | null) => {
    const r = await ims.run([...selected], action);
    if (!r) { toast.error(ims.error ?? 'Nothing was changed.'); return; }
    toast.success(`${r.updated} line${r.updated === 1 ? '' : 's'} ${action ? `marked ${action}` : 'cleared'}`, {
      description: 'Take the same action in the portal’s IMS before GSTR-2B is generated.',
    });
    setSelected(new Set());
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="ITC reconciliation"
        description="Your purchase records against what the government says your suppliers actually filed."
        actions={
          <>
            <Input
              type="month"
              value={period}
              onChange={(e) => { setPeriod(e.target.value); setSelected(new Set()); }}
              className="h-8 w-40"
            />
            {canEdit && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
                <Button size="sm" className="gap-1.5" disabled={importer.busy} onClick={() => fileRef.current?.click()}>
                  <Upload className="size-3.5" /> {importer.busy ? 'Importing…' : 'Import GSTR-2B'}
                </Button>
              </>
            )}
          </>
        }
      />

      <AsyncPage state={state}>
        {(d) => {
          const byBucket = (b: Bucket) => d.rows.filter((r) => r.matchStatus === b);
          const missed = byBucket('missing_in_books').reduce((t, r) => t + r.portalTaxPaise, 0);

          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Credit at risk"
                  value={formatINRCompact(d.summary.atRiskPaise)}
                  sub="Claimed in your books, not supported by the portal"
                  icon={ShieldAlert}
                  tone={d.summary.atRiskPaise > 0 ? 'danger' : 'positive'}
                />
                <StatTile
                  label="Credit not claimed"
                  value={formatINRCompact(missed)}
                  sub="Filed by a supplier, missing from your books"
                  icon={TriangleAlert}
                  tone={missed > 0 ? 'warning' : 'positive'}
                />
                <StatTile
                  label="Matched cleanly"
                  value={`${d.summary.matched} of ${d.summary.total}`}
                  sub="Both sides agree to the paisa"
                  icon={CheckCircle2}
                  tone="positive"
                />
              </div>

              {d.summary.atRiskPaise > 0 && (
                <Card className="flex flex-wrap items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">
                      <Money value={d.summary.atRiskPaise} /> of input credit is not backed by a supplier filing.
                    </span>{' '}
                    Since 2022 credit is only claimable if it appears in your GSTR-2B. If these are not filed
                    before the annual return, the credit has to be reversed with interest — so this is a phone call
                    worth making now rather than in September.
                  </p>
                  <Button variant="outline" size="sm" className="gap-1.5" disabled>
                    <Mail className="size-3.5" /> Chase suppliers
                  </Button>
                </Card>
              )}

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">IMS</span>
                <span>{d.summary.ims_accepted ?? 0} accepted</span>·
                <span>{d.summary.ims_rejected ?? 0} rejected</span>·
                <span>{d.summary.ims_pending ?? 0} pending</span>·
                <span>{d.summary.ims_no_action ?? 0} with no action (deemed accepted)</span>
              </div>

              {canEdit && selected.size > 0 && (
                <Card className="flex flex-wrap items-center gap-2 p-3">
                  <span className="text-sm font-medium">{selected.size} selected</span>
                  <Button size="sm" variant="outline" disabled={ims.busy} onClick={() => void act('accepted')}>Accept</Button>
                  <Button size="sm" variant="outline" disabled={ims.busy} onClick={() => void act('rejected')}>Reject</Button>
                  <Button size="sm" variant="outline" disabled={ims.busy} onClick={() => void act('pending')}>Keep pending</Button>
                  <Button size="sm" variant="ghost" disabled={ims.busy} onClick={() => void act(null)}>Clear action</Button>
                  <span className="text-xs text-muted-foreground">Credit notes can be accepted or rejected, not kept pending.</span>
                </Card>
              )}

              <Tabs defaultValue="missing_in_portal">
                <TabsList>
                  {(Object.keys(BUCKETS) as Bucket[]).map((b) => (
                    <TabsTrigger key={b} value={b}>
                      {BUCKETS[b].label} ({byBucket(b).length})
                    </TabsTrigger>
                  ))}
                </TabsList>
                {(Object.keys(BUCKETS) as Bucket[]).map((b) => (
                  <TabsContent key={b} value={b} className="mt-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className={`shrink-0 text-[10px] ${BUCKETS[b].tone}`}>
                        {BUCKETS[b].label}
                      </Badge>
                      <p className="text-xs text-muted-foreground">{BUCKETS[b].blurb}</p>
                    </div>
                    <MatchTable rows={byBucket(b)} selected={selected} onToggle={toggle} canEdit={canEdit} />
                  </TabsContent>
                ))}
              </Tabs>

              <Card className="flex items-start gap-3 p-4">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Matching is on the supplier&apos;s own invoice number and GSTIN, because that is what the portal
                  keys on — our internal bill number means nothing to them. A supplier who types their own invoice
                  number differently in their GSTR-1 will show here as unmatched even when the money is right.
                </p>
              </Card>
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
