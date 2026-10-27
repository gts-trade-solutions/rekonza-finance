'use client';

// Fixed assets — what the business owns, and what it is worth now.
//
// The register is the list a CARO auditor asks for: each asset with its tag,
// location and custodian, its cost and the depreciation written off it, and
// when it was last physically verified. Depreciation under Schedule II is run
// for a period at a time and posted; the Income-tax book is worked out beside
// it, by blocks, and never posted.

import { useMemo, useState } from 'react';
import { Building2, Calculator, Landmark, Loader2, PackagePlus, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ReportTable } from '@/components/shared/report-shell';
import { AddAssetDialog, AssetDialog, ClassDialog } from '@/components/assets/asset-dialogs';
import {
  fixedAssets, type AssetClassRow, type AssetRegisterRow, type DepreciationRunRow, type ItBlockRow,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATUS: Record<AssetRegisterRow['status'], { label: string; tone: string }> = {
  cwip: { label: 'CWIP', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300' },
  in_use: { label: 'In use', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
  disposed: { label: 'Disposed', tone: 'text-muted-foreground' },
};

export default function FixedAssetsPage() {
  const state = useApi(() => fixedAssets.register(), []);
  const canEdit = usePermission('accountant', 'edit');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState('register');

  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="The register, depreciation under Schedule II, capital work in progress, and the Income-tax block schedule."
        actions={canEdit && (
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><PackagePlus className="size-4" /> Add asset</Button>
        )}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="register">Register ({d.assets.filter((a) => a.status !== 'disposed').length})</TabsTrigger>
              <TabsTrigger value="depreciation">Depreciation</TabsTrigger>
              <TabsTrigger value="it">Income-tax book</TabsTrigger>
              <TabsTrigger value="classes">Classes</TabsTrigger>
            </TabsList>
            <TabsContent value="register" className="mt-4 space-y-4">
              <Register assets={d.assets} onOpen={setOpenId} />
            </TabsContent>
            <TabsContent value="depreciation" className="mt-4">
              <Depreciation canEdit={canEdit} onChanged={() => void state.refetch()} />
            </TabsContent>
            <TabsContent value="it" className="mt-4">
              <ItBook canEdit={canEdit} classes={d.classes} />
            </TabsContent>
            <TabsContent value="classes" className="mt-4">
              <Classes classes={d.classes} canEdit={canEdit} onChanged={() => void state.refetch()} />
            </TabsContent>
          </Tabs>
        )}
      </AsyncPage>

      <AddAssetDialog
        open={adding}
        classes={state.data?.classes ?? []}
        onClose={() => setAdding(false)}
        onDone={(id) => { setAdding(false); void state.refetch(); setOpenId(id); }}
      />
      <AssetDialog id={openId} canEdit={canEdit} onClose={() => setOpenId(null)} onChanged={() => void state.refetch()} />
    </>
  );
}

function Register({ assets, onOpen }: { assets: AssetRegisterRow[]; onOpen: (id: string) => void }) {
  const [show, setShow] = useState<'live' | 'all'>('live');
  const rows = show === 'live' ? assets.filter((a) => a.status !== 'disposed') : assets;
  const live = assets.filter((a) => a.status !== 'disposed');
  const sum = (k: 'costPaise' | 'accumulatedPaise' | 'netPaise') => live.reduce((t, a) => t + a[k], 0);
  const flagged = live.filter((a) => a.flags.length).length;

  const cols: Column<AssetRegisterRow>[] = [
    { key: 'tag', header: 'Tag', sortValue: (r) => r.tagNo, cell: (r) => <span className="font-mono text-xs font-medium">{r.tagNo}</span> },
    {
      key: 'name', header: 'Asset', sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted-foreground">{r.className}{r.location ? ` · ${r.location}` : ''}{r.custodian ? ` · ${r.custodian}` : ''}</p>
          {r.flags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.flags.map((f) => <Badge key={f} variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">{f}</Badge>)}
            </div>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <Badge variant="outline" className={`text-[10px] ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</Badge> },
    { key: 'use', header: 'In use from', sortValue: (r) => r.putToUseOn ?? '', cell: (r) => <span className="text-xs">{fmt(r.putToUseOn)}</span> },
    { key: 'cost', header: 'Cost', align: 'right', sortValue: (r) => r.costPaise, cell: (r) => <Money value={r.costPaise} /> },
    { key: 'acc', header: 'Depreciation', align: 'right', sortValue: (r) => r.accumulatedPaise, cell: (r) => <Money value={r.accumulatedPaise} showZero={false} className="text-muted-foreground" /> },
    { key: 'net', header: 'Net block', align: 'right', sortValue: (r) => r.netPaise, cell: (r) => <Money value={r.netPaise} className="font-medium" /> },
  ];

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Gross block" value={formatINRCompact(sum('costPaise'))} sub={`${live.length} asset(s)`} icon={Building2} />
        <StatTile label="Depreciation to date" value={formatINRCompact(sum('accumulatedPaise'))} sub="Schedule II, posted" icon={Calculator} />
        <StatTile label="Net block" value={formatINRCompact(sum('netPaise'))} sub="What the balance sheet carries" icon={Landmark} />
        <StatTile label="Needs attention" value={String(flagged)} sub="Insurance, AMC or verification" tone={flagged ? 'warning' : 'default'} />
      </div>
      <div className="flex justify-end">
        <div className="flex rounded-md border p-0.5 text-xs">
          {(['live', 'all'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setShow(k)}
              className={`rounded px-2.5 py-1 ${show === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
              {k === 'live' ? 'Held now' : 'Including disposed'}
            </button>
          ))}
        </div>
      </div>
      <DataTable rows={rows} columns={cols} getRowId={(r) => r.id} onRowClick={(r) => onOpen(r.id)}
        searchPlaceholder="Search tag, asset, location…" emptyMessage="No assets in the register yet." />
    </>
  );
}

function Depreciation({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const state = useApi(() => fixedAssets.runs(), []);
  const lastMonthEnd = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10);
  }, []);
  const [to, setTo] = useState(lastMonthEnd);
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useApi(
    async () => (branchId ? fixedAssets.preview(branchId, to) : null),
    [branchId, to],
  );

  const run = async () => {
    setBusy(true);
    try {
      const r = await fixedAssets.act<{ totalPaise: number; from: string }>({ action: 'run', branchId, to });
      toast.success(r.totalPaise ? `Depreciation of ₹${(r.totalPaise / 100).toLocaleString('en-IN')} posted, ${r.from} to ${to}` : 'Nothing to depreciate in that period');
      void state.refetch(); void preview.refetch(); onChanged();
    } catch (e) {
      toast.error('Not run', { description: err(e) });
    } finally {
      setBusy(false);
    }
  };
  const undo = async (r: DepreciationRunRow) => {
    if (!window.confirm(`Undo the run to ${fmt(r.to)} at ${r.branchName}? Its entry is reversed; run it again after the correction.`)) return;
    try {
      await fixedAssets.act({ action: 'reverse-run', branchId: r.branchId });
      toast.success('Run undone');
      void state.refetch(); void preview.refetch(); onChanged();
    } catch (e) {
      toast.error('Not undone', { description: err(e) });
    }
  };

  return (
    <AsyncPage state={state}>
      {(d) => {
        const latest = new Map<string, string>();
        for (const r of d.runs) if (!r.reversed && r.branchId && !latest.has(r.branchId)) latest.set(r.branchId, r.id);
        return (
          <div className="space-y-4">
            <Card className="space-y-4 p-5">
              <div>
                <h3 className="text-sm font-semibold">Charge depreciation</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Each run picks up where the last one ended and charges every asset in use, day by day, at its class&apos;s
                  method and life. Monthly runs keep the profit and loss honest month by month; one run at the year end is
                  enough for the accounts.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                <Field label="Branch">
                  <Select value={branchId} onValueChange={setBranchId}>
                    <SelectTrigger><SelectValue placeholder="Pick a branch" /></SelectTrigger>
                    <SelectContent>
                      {d.next.map((n) => (
                        <SelectItem key={n.branchId} value={n.branchId}>{n.branchName}{n.from ? ` · from ${fmt(n.from)}` : ' · nothing in use'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Up to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
                <Button onClick={() => void run()} disabled={!canEdit || busy || !branchId || !preview.data?.totalPaise} className="gap-1.5">
                  {busy && <Loader2 className="size-4 animate-spin" />} Post
                </Button>
              </div>
              {preview.error && <p className="text-sm text-destructive">{preview.error}</p>}
              {preview.data && preview.data.lines.length > 0 && (
                <ReportTable>
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`}>Asset</th>
                      <th className={`${th} text-left`}>From</th>
                      <th className={`${th} text-right`}>Days</th>
                      <th className={`${th} text-right`}>Depreciation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.lines.map((l) => (
                      <tr key={l.assetId} className="border-b last:border-0">
                        <td className="px-3 py-2 text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{l.tag}</span>{l.name}</td>
                        <td className="px-3 py-2 text-xs">{fmt(l.from)}</td>
                        <td className="px-3 py-2 text-right text-xs tabular">{l.days}</td>
                        <td className="px-3 py-2 text-right"><Money value={l.amountPaise} /></td>
                      </tr>
                    ))}
                    <tr className="bg-muted/30 font-semibold">
                      <td className="px-3 py-2" colSpan={3}>Dr Depreciation · Cr Accumulated Depreciation</td>
                      <td className="px-3 py-2 text-right"><Money value={preview.data.totalPaise} /></td>
                    </tr>
                  </tbody>
                </ReportTable>
              )}
            </Card>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Runs</h3>
              {d.runs.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No depreciation has been run yet.</p>
              ) : (
                <ReportTable>
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`}>Branch</th>
                      <th className={`${th} text-left`}>Period</th>
                      <th className={`${th} text-right`}>Charged</th>
                      <th className="w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {d.runs.map((r) => (
                      <tr key={r.id} className={`border-b last:border-0 ${r.reversed ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-2 text-sm">{r.branchName}</td>
                        <td className="px-3 py-2 text-xs">{fmt(r.from)} – {fmt(r.to)}{r.reversed && <Badge variant="outline" className="ml-2 text-[10px]">Undone</Badge>}</td>
                        <td className="px-3 py-2 text-right"><Money value={r.totalPaise} /></td>
                        <td className="px-2 py-2 text-right">
                          {canEdit && !r.reversed && r.branchId && latest.get(r.branchId) === r.id && (
                            <Button size="xs" variant="ghost" className="gap-1" onClick={() => void undo(r)}><Undo2 className="size-3" /> Undo</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ReportTable>
              )}
            </div>
          </div>
        );
      }}
    </AsyncPage>
  );
}

function ItBook({ canEdit, classes }: { canEdit: boolean; classes: AssetClassRow[] }) {
  const lastFy = (() => { const d = new Date(); return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0); })();
  const [fy, setFy] = useState(lastFy);
  const state = useApi(() => fixedAssets.it(fy), [fy]);
  const [block, setBlock] = useState('');
  const [opening, setOpening] = useState(0);
  const blocks = useMemo(() => [...new Map(classes.map((c) => [c.itBlock, c.itRatePct])).entries()], [classes]);

  const saveOpening = async () => {
    const rate = blocks.find(([b]) => b === block)?.[1] ?? 0;
    try {
      await fixedAssets.act({ action: 'it-opening', fyStart: fy, block, ratePct: rate, openingPaise: opening });
      toast.success(`Opening WDV for ${block} set`);
      setOpening(0);
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: err(e) });
    }
  };

  const total = (k: keyof ItBlockRow) => (state.data?.blocks ?? []).reduce((t, b) => t + (b[k] as number), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[0, 1, 2, 3].map((i) => lastFy - i).map((y) => <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Worked out, never posted: the depreciation the tax return claims, and what the deferred tax note compares with the books.</p>
      </div>
      <AsyncPage state={state}>
        {(d) => d.blocks.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No blocks with anything in them this year.</p>
        ) : (
          <ReportTable>
            <thead>
              <tr className="border-b bg-muted/50">
                <th className={`${th} text-left`}>Block</th>
                <th className={`${th} text-right`}>Opening WDV</th>
                <th className={`${th} text-right`}>Added ≥ 180 days</th>
                <th className={`${th} text-right`}>Added &lt; 180 days</th>
                <th className={`${th} text-right`}>Sold</th>
                <th className={`${th} text-right`}>Depreciation</th>
                <th className={`${th} text-right`}>Closing WDV</th>
              </tr>
            </thead>
            <tbody>
              {d.blocks.map((b) => (
                <tr key={b.block} className="border-b last:border-0">
                  <td className="px-3 py-2 text-sm">{b.block}<span className="ml-1 text-xs text-muted-foreground">{b.ratePct}%</span>
                    {b.shortTermGainPaise !== 0 && (
                      <span className="block text-[11px] text-amber-700 dark:text-amber-300">
                        Short-term capital {b.shortTermGainPaise > 0 ? 'gain' : 'loss'} (s.50): <Money value={Math.abs(b.shortTermGainPaise)} />
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right"><Money value={b.openingPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={b.additionsFullPaise} showZero={false} /></td>
                  <td className="px-3 py-2 text-right"><Money value={b.additionsHalfPaise} showZero={false} /></td>
                  <td className="px-3 py-2 text-right"><Money value={b.salesPaise} showZero={false} /></td>
                  <td className="px-3 py-2 text-right font-medium"><Money value={b.depreciationPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={b.closingPaise} /></td>
                </tr>
              ))}
              <tr className="bg-muted/30 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right"><Money value={total('openingPaise')} /></td>
                <td className="px-3 py-2 text-right"><Money value={total('additionsFullPaise')} /></td>
                <td className="px-3 py-2 text-right"><Money value={total('additionsHalfPaise')} /></td>
                <td className="px-3 py-2 text-right"><Money value={total('salesPaise')} /></td>
                <td className="px-3 py-2 text-right"><Money value={total('depreciationPaise')} /></td>
                <td className="px-3 py-2 text-right"><Money value={total('closingPaise')} /></td>
              </tr>
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
      {canEdit && (
        <Card className="space-y-3 p-4">
          <p className="text-sm font-medium">Opening written-down value</p>
          <p className="text-xs text-muted-foreground">
            The first year&apos;s opening for each block comes from the last tax return. Later years carry forward on their own.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <Field label="Block">
              <Select value={block} onValueChange={setBlock}>
                <SelectTrigger><SelectValue placeholder="Pick a block" /></SelectTrigger>
                <SelectContent>{blocks.map(([b, r]) => <SelectItem key={b} value={b}>{b} · {r}%</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={`WDV on 1 April ${fy}`}><MoneyInput valuePaise={opening} onChangePaise={setOpening} /></Field>
            <Button variant="outline" onClick={() => void saveOpening()} disabled={!block}>Set</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Classes({ classes, canEdit, onChanged }: { classes: AssetClassRow[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<AssetClassRow | 'new' | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          A class sets the ledger an asset sits in, its Schedule II useful life and method, and its Income-tax block and
          rate. An asset can override the life and residual value for itself.
        </p>
        {canEdit && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing('new')}><Plus className="size-4" /> Class</Button>}
      </div>
      <ReportTable>
        <thead>
          <tr className="border-b bg-muted/50">
            <th className={`${th} text-left`}>Class</th>
            <th className={`${th} text-left`}>Ledger</th>
            <th className={`${th} text-left`}>Companies Act</th>
            <th className={`${th} text-left`}>Income-tax block</th>
            <th className="w-16" />
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <tr key={c.id} className="border-b last:border-0">
              <td className="px-3 py-2 text-sm font-medium">{c.name}</td>
              <td className="px-3 py-2 text-xs">{c.accountName}</td>
              <td className="px-3 py-2 text-xs">{c.method.toUpperCase()} · {c.usefulLifeYears} years · residual {c.residualPct}%</td>
              <td className="px-3 py-2 text-xs">{c.itBlock} · {c.itRatePct}%</td>
              <td className="px-2 py-2 text-right">{canEdit && <Button size="xs" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>}</td>
            </tr>
          ))}
        </tbody>
      </ReportTable>
      <ClassDialog value={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onChanged(); }} />
    </div>
  );
}
