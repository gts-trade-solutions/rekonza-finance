'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A budget's amounts, period by period, as Zoho Books' budget form has them:
// its name, year and period; whom it is for (the whole business, a branch, a
// cost centre or a project); the accounts; and a grid of amounts, with the
// shortcuts that save typing twelve numbers for each line — fill from last
// year's actuals, raise or lower everything by a percentage, the same amount
// in every period, and copy the first period across.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Plus, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { Field } from '@/components/shared/form-bits';
import { useCostCentres } from '@/components/forms/cost-centre-picker';
import { accounts as accountsApi, budgetPlans, projects as projectsApi, type AccountRow, type BudgetPeriodKind } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';

const COUNT: Record<BudgetPeriodKind, number> = { monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1 };
const MON = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const labels = (fy: string, period: BudgetPeriodKind) => {
  const y = Number(fy.slice(0, 4));
  if (period === 'monthly') return MON.map((m, i) => `${m} ${i < 9 ? y : y + 1}`.slice(0, 8));
  if (period === 'quarterly') return ['Q1 Apr–Jun', 'Q2 Jul–Sep', 'Q3 Oct–Dec', 'Q4 Jan–Mar'];
  if (period === 'half_yearly') return ['H1 Apr–Sep', 'H2 Oct–Mar'];
  return [`FY ${fy}`];
};
const toPaise = (s: string) => Math.max(0, Math.round((Number(String(s).replace(/,/g, '')) || 0) * 100));
const toText = (p: number) => (p ? String(p / 100) : '');

export default function BudgetEditorPage() {
  return <Suspense fallback={<LoadingRows rows={8} />}><Editor /></Suspense>;
}

function Editor() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const branches = useAppStore((s) => s.branches);
  const centres = useCostCentres();
  const projectList = useApi(() => projectsApi.list({ status: 'all' }).catch(() => ({ projects: [] })), []);
  const chart = useApi(() => accountsApi.list(), []);
  const years = useApi(() => budgetPlans.list(), []);

  const [loaded, setLoaded] = useState(!id);
  const [name, setName] = useState('');
  const [fy, setFy] = useState(params.get('fy') ?? '');
  const [period, setPeriod] = useState<BudgetPeriodKind>('monthly');
  const [scope, setScope] = useState('');
  const [withBs, setWithBs] = useState(false);
  const [primary, setPrimary] = useState(false);
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<{ accountId: string; amounts: string[] }[]>([]);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [pct, setPct] = useState('0');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!fy && years.data?.years.length) {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);
      setFy(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
    }
  }, [years.data, fy]);

  // Editing: load the budget once.
  useEffect(() => {
    if (!id) return;
    void budgetPlans.get(id).then((p) => {
      setName(p.name); setFy(p.fyLabel); setPeriod(p.period); setWithBs(p.includeBalanceSheet); setPrimary(p.isPrimary); setNotes(p.notes ?? '');
      setScope(p.costCentreId ? `cc:${p.costCentreId}` : p.projectId ? `pr:${p.projectId}` : p.branchId ? `br:${p.branchId}` : '');
      setRows(p.lines.map((l) => ({ accountId: l.accountId, amounts: l.amountsPaise.map(toText) })));
      setLoaded(true);
    }).catch((e) => toast.error('That budget could not be opened', { description: e instanceof Error ? e.message : String(e) }));
  }, [id]);

  const accounts = useMemo(() => new Map((chart.data?.accounts ?? []).map((a) => [a.id, a])), [chart.data]);
  const choosable = (chart.data?.accounts ?? []).filter((a) => a.isActive && (withBs || a.type === 'income' || a.type === 'expense'));
  const n = COUNT[period];
  const heads = labels(fy || '2026-27', period);

  // A change of period keeps each line's year total, spread evenly over the new periods.
  const changePeriod = (p: BudgetPeriodKind) => {
    const m = COUNT[p];
    setRows((rs) => rs.map((r) => {
      const total = r.amounts.reduce((t, a) => t + toPaise(a), 0);
      const each = Math.floor(total / m / 100) * 100;
      return { ...r, amounts: Array.from({ length: m }, (_, i) => toText(i === m - 1 ? total - each * (m - 1) : each)) };
    }));
    setPeriod(p);
  };
  const scopeIds = () => ({
    branchId: scope.startsWith('br:') ? scope.slice(3) : null,
    costCentreId: scope.startsWith('cc:') ? scope.slice(3) : null,
    projectId: scope.startsWith('pr:') ? scope.slice(3) : null,
  });
  const setCell = (accountId: string, i: number, v: string) => setRows((rs) => rs.map((r) => (r.accountId === accountId ? { ...r, amounts: r.amounts.map((a, k) => (k === i ? v : a)) } : r)));
  const sameEvery = (accountId: string, v: string) => setRows((rs) => rs.map((r) => (r.accountId === accountId ? { ...r, amounts: Array(n).fill(v) } : r)));
  const copyAcross = (accountId?: string) => setRows((rs) => rs.map((r) => (!accountId || r.accountId === accountId ? { ...r, amounts: Array(n).fill(r.amounts[0] ?? '') } : r)));
  const adjustAll = () => {
    const k = 1 + (Number(pct) || 0) / 100;
    setRows((rs) => rs.map((r) => ({ ...r, amounts: r.amounts.map((a) => toText(Math.round((toPaise(a) * k) / 100) * 100)) })));
    toast.success(`Every amount changed by ${pct}%`);
  };
  const addAccounts = (ids: string[]) => {
    setRows((rs) => [...rs, ...ids.filter((x) => !rs.some((r) => r.accountId === x)).map((x) => ({ accountId: x, amounts: Array(n).fill('') }))]);
  };
  const fillFromActuals = async () => {
    setBusy('fill');
    try {
      const ids = rows.map((r) => r.accountId);
      const r = await budgetPlans.fill({ fyLabel: fy, period, accountIds: ids.length ? ids : choosable.filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.id), adjustPct: Number(pct) || 0, ...scopeIds() });
      const got = new Map(r.lines.map((l) => [l.accountId, l.amountsPaise]));
      if (ids.length) setRows((rs) => rs.map((x) => ({ ...x, amounts: (got.get(x.accountId) ?? Array(n).fill(0)).map(toText) })));
      else setRows(r.lines.filter((l) => l.amountsPaise.some((a) => a > 0)).map((l) => ({ accountId: l.accountId, amounts: l.amountsPaise.map(toText) })));
      const anything = r.lines.some((l) => l.amountsPaise.some((a) => a > 0));
      if (anything) toast.success(`Filled from FY ${r.sourceFy} actuals${Number(pct) ? `, ${Number(pct) > 0 ? '+' : ''}${pct}%` : ''}`);
      else toast.info(`FY ${r.sourceFy} has no actuals for these accounts`, { description: 'Enter the amounts yourself, or use "Same amount every period" on each line.' });
    } catch (e) {
      toast.error('Not filled', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const r = await budgetPlans.save({
        id, name: name.trim(), fyLabel: fy, period, ...scopeIds(), includeBalanceSheet: withBs, isPrimary: primary || undefined, notes: notes.trim() || null,
        lines: rows.map((x) => ({ accountId: x.accountId, amountsPaise: Array.from({ length: n }, (_, i) => toPaise(x.amounts[i] ?? '')) })),
      });
      toast.success(`Budget ${name.trim()} saved`, { description: 'Open Budget vs Actuals to compare it with the books.' });
      router.push(`/reports/budget-vs-actuals?plan=${r.id}`);
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) return <LoadingRows rows={8} />;
  const groups: { title: string; types: AccountRow['type'][] }[] = [
    { title: 'Income', types: ['income'] }, { title: 'Expenses', types: ['expense'] },
    ...(withBs ? [{ title: 'Assets', types: ['asset'] as AccountRow['type'][] }, { title: 'Liabilities and equity', types: ['liability', 'equity'] as AccountRow['type'][] }] : []),
  ];
  const rowTotal = (r: { amounts: string[] }) => r.amounts.reduce((t, a) => t + toPaise(a), 0);
  const typeTotal = (types: AccountRow['type'][], i?: number) => rows.filter((r) => types.includes(accounts.get(r.accountId)?.type as AccountRow['type']))
    .reduce((t, r) => t + (i === undefined ? rowTotal(r) : toPaise(r.amounts[i] ?? '')), 0);

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit gap-1.5"><Link href="/accountant/budgets"><ArrowLeft className="size-3.5" /> Budgets</Link></Button>
      <PageHeader title={id ? `Edit budget ${name}` : 'New Budget'} description="Name it, choose the year and how it is entered, add the accounts, and enter the amounts." />
      <Card className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6" data-slot="budget-form">
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Original" data-slot="budget-name" /></Field>
        <Field label="Financial year" required>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="budget-form-fy">
            {[...new Set([fy, ...(years.data?.years ?? [])].filter(Boolean))].sort().reverse().map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </Field>
        <Field label="Budget period" required>
          <select value={period} onChange={(e) => changePeriod(e.target.value as BudgetPeriodKind)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="budget-period">
            <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="half_yearly">Half-yearly</option><option value="yearly">Yearly</option>
          </select>
        </Field>
        <Field label="For">
          <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="budget-scope">
            <option value="">Whole business</option>
            {branches.length > 1 && <optgroup label="Branch">{branches.map((b) => <option key={b.id} value={`br:${b.id}`}>{b.name}</option>)}</optgroup>}
            {centres.length > 0 && <optgroup label="Cost centre">{centres.map((c) => <option key={c.id} value={`cc:${c.id}`}>{c.code} {c.name}</option>)}</optgroup>}
            {(projectList.data?.projects.length ?? 0) > 0 && <optgroup label="Project">{projectList.data!.projects.map((p) => <option key={p.id} value={`pr:${p.id}`}>{p.name}</option>)}</optgroup>}
          </select>
        </Field>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></Field>
        <div className="flex flex-col justify-end gap-1.5 text-xs">
          <label className="flex items-center gap-2"><input type="checkbox" checked={withBs} onChange={(e) => setWithBs(e.target.checked)} data-slot="budget-with-bs" /> Include asset and liability accounts</label>
          {!scope && <label className="flex items-center gap-2"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> The year&apos;s primary budget</label>}
        </div>
      </Card>

      <Card className="flex flex-wrap items-end gap-2 p-3" data-slot="budget-tools">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setPicked(new Set()); setFilter(''); setPicking(true); }} data-slot="budget-add-accounts"><Plus className="size-3.5" /> Add accounts</Button>
        <Button size="sm" variant="outline" onClick={() => addAccounts(choosable.filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.id))} data-slot="budget-add-all">Add all income and expense accounts</Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="block">+/- %</span>
          <Input type="number" value={pct} onChange={(e) => setPct(e.target.value)} className="h-8 w-20" data-slot="budget-pct" />
        </label>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy === 'fill' || !fy} onClick={() => void fillFromActuals()} data-slot="budget-fill-actuals">
          {busy === 'fill' ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Fill from last year&apos;s actuals (+/- %)
        </Button>
        <Button size="sm" variant="outline" onClick={adjustAll} disabled={!rows.length} data-slot="budget-adjust">Apply +/- % to every amount</Button>
        <Button size="sm" variant="outline" onClick={() => copyAcross()} disabled={!rows.length || n === 1} data-slot="budget-copy-across">Copy first period across</Button>
      </Card>

      {rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground" data-slot="budget-grid-empty">
          No accounts yet. Use <span className="font-medium text-foreground">Add accounts</span> or <span className="font-medium text-foreground">Add all income and expense accounts</span>,
          or <span className="font-medium text-foreground">Fill from last year&apos;s actuals</span> to start from what the books showed.
        </Card>
      ) : (
        <Card className="gap-0 overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm" data-slot="budget-grid">
            <thead>
              <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 text-left font-semibold">Account</th>
                {heads.map((h) => <th key={h} className="px-1 py-2 text-right font-semibold">{h}</th>)}
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-2 py-2 text-left font-semibold">Same amount every period</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const list = rows.filter((r) => g.types.includes(accounts.get(r.accountId)?.type as AccountRow['type']));
                if (!list.length) return null;
                return [
                  <tr key={`${g.title}-h`} className="rpt-head border-b"><td colSpan={n + 4} className="sticky left-0 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">{g.title}</td></tr>,
                  ...list.map((r) => <GridRow key={r.accountId} acc={accounts.get(r.accountId)} amounts={r.amounts} n={n}
                    onCell={(i, v) => setCell(r.accountId, i, v)} onSame={(v) => sameEvery(r.accountId, v)} onCopy={() => copyAcross(r.accountId)}
                    onRemove={() => setRows((rs) => rs.filter((x) => x.accountId !== r.accountId))} total={rowTotal(r)} />),
                  <tr key={`${g.title}-t`} className="rpt-total border-b font-semibold" data-slot="budget-grid-total">
                    <td className="sticky left-0 bg-background px-3 py-1.5">Total {g.title.toLowerCase()}</td>
                    {Array.from({ length: n }, (_, i) => <td key={i} className="px-1 py-1.5 text-right"><Money value={typeTotal(g.types, i)} /></td>)}
                    <td className="px-3 py-1.5 text-right"><Money value={typeTotal(g.types)} /></td><td colSpan={2} />
                  </tr>,
                ];
              })}
              <tr className="rpt-result-strong border-t-2 font-semibold" data-slot="budget-grid-net">
                <td className="sticky left-0 bg-background px-3 py-2">Budgeted profit (income less expenses)</td>
                {Array.from({ length: n }, (_, i) => <td key={i} className="px-1 py-2 text-right"><Money value={typeTotal(['income'], i) - typeTotal(['expense'], i)} /></td>)}
                <td className="px-3 py-2 text-right"><Money value={typeTotal(['income']) - typeTotal(['expense'])} /></td><td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild><Link href="/accountant/budgets">Cancel</Link></Button>
        <Button disabled={busy === 'save' || name.trim().length < 2 || !fy} onClick={() => void save()} className="gap-1.5" data-slot="budget-save">
          {busy === 'save' && <Loader2 className="size-3.5 animate-spin" />} Save budget
        </Button>
      </div>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-lg" data-slot="budget-pick-dialog">
          <DialogHeader>
            <DialogTitle>Add accounts</DialogTitle>
            <DialogDescription>Income and expense accounts{withBs ? ', and assets and liabilities' : ''}. Tick the ones this budget covers.</DialogDescription>
          </DialogHeader>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by name or code" data-slot="budget-pick-search" />
          <div className="max-h-[50vh] space-y-0.5 overflow-auto rounded-md border p-2 thin-scroll">
            {choosable.filter((a) => !rows.some((r) => r.accountId === a.id) && `${a.code} ${a.name}`.toLowerCase().includes(filter.toLowerCase())).map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                <input type="checkbox" checked={picked.has(a.id)} onChange={(e) => setPicked((s) => { const x = new Set(s); if (e.target.checked) x.add(a.id); else x.delete(a.id); return x; })} data-slot="budget-pick-account" />
                <span className="font-mono text-xs text-muted-foreground">{a.code}</span> {a.name}
                <span className="ml-auto text-[10px] capitalize text-muted-foreground">{a.type}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPicking(false)}>Cancel</Button>
            <Button disabled={!picked.size} onClick={() => { addAccounts([...picked]); setPicking(false); }} data-slot="budget-pick-add">Add {picked.size || ''}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function GridRow({ acc, amounts, n, onCell, onSame, onCopy, onRemove, total }: {
  acc: AccountRow | undefined; amounts: string[]; n: number; total: number;
  onCell: (i: number, v: string) => void; onSame: (v: string) => void; onCopy: () => void; onRemove: () => void;
}) {
  const [same, setSame] = useState('');
  return (
    <tr className="border-b last:border-0" data-slot="budget-grid-row">
      <td className="sticky left-0 z-10 bg-background px-3 py-1">
        <span className="font-mono text-[11px] text-muted-foreground">{acc?.code}</span> <span className="font-medium">{acc?.name ?? 'Account'}</span>
      </td>
      {Array.from({ length: n }, (_, i) => (
        <td key={i} className="px-1 py-1">
          <input inputMode="decimal" value={amounts[i] ?? ''} onChange={(e) => onCell(i, e.target.value.replace(/[^0-9.]/g, ''))}
            className="h-8 w-24 rounded border border-input bg-background px-1.5 text-right text-sm tabular-nums outline-none focus:border-primary" aria-label={`${acc?.name} period ${i + 1}`} data-slot="budget-cell" />
        </td>
      ))}
      <td className="px-3 py-1 text-right font-medium"><Money value={total} /></td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-1">
          <input inputMode="decimal" value={same} onChange={(e) => setSame(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="₹" className="h-8 w-20 rounded border border-input bg-background px-1.5 text-right text-sm" data-slot="budget-same-input" />
          <Button size="icon-sm" variant="outline" title="Put this amount in every period" disabled={!same} onClick={() => onSame(same)} data-slot="budget-same-go"><ArrowRight className="size-3.5" /></Button>
          {n > 1 && <Button size="xs" variant="ghost" title="Copy the first period to every period" onClick={onCopy}>Copy across</Button>}
        </div>
      </td>
      <td className="px-2 py-1"><Button size="icon-sm" variant="ghost" aria-label={`Remove ${acc?.name}`} onClick={onRemove}><Trash2 className="size-3.5" /></Button></td>
    </tr>
  );
}
