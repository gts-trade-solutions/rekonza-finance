'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated statements (lib/server/reports/consolidated.ts): the companies
// you work in and may see the books of, account by account in columns, an
// Eliminations column and the group total — the profit and loss, the balance
// sheet and the trial balance — with what they owe and sold each other taken
// out, unrealised profit in stock taken out, the parent's investment set
// against the subsidiaries' share capital, and the minority's share shown.
//
// The consolidation check sets each company beside the eliminations and the
// group, and proves the group balance sheet balances; it prints on its own.
// Every company figure opens that company's ledger for the account without
// leaving this screen. Group set-up names the parent, each subsidiary's
// ownership and the investment account, and links customers and vendors that
// are group companies when their PANs do not say so.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Download, Network, Printer, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { downloadCsv, useReportRange } from '@/components/shared/report-shell';
import { consolidation, type ConsolidatedReport, type ConsolidatedRowData, type ConsolidatedSum, type ConsolidationSetup } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';
import { dayLabel } from '@/lib/date-range';
import { downloadWorkbook } from '@/lib/xlsx';
import { downloadPdf, istNow, pdfTable, type PdfRow } from '@/lib/pdf';
import { allowOutput, printPage } from '@/lib/output-guard';
import { useAppStore } from '@/lib/store';

type Tab = 'statements' | 'trial-balance' | 'check' | 'eliminations';
const TABS: [Tab, string][] = [['statements', 'Statements'], ['trial-balance', 'Trial balance'], ['check', 'Consolidation check'], ['eliminations', 'Eliminations']];

export default function ConsolidatedPage() {
  const [range, setRange] = useReportRange();
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>('statements');
  const [setupOpen, setSetupOpen] = useState(false);
  const [drill, setDrill] = useState<{ orgId: string; company: string; code: string; name: string } | null>(null);
  const state = useApi(() => consolidation.report(range.from, range.to, chosen ?? undefined), [range.from, range.to, chosen?.join(',')]);
  const org = useAppStore((s) => s.org?.name ?? '');

  return (
    <>
      <PageHeader
        title="Consolidated statements"
        description="The companies you work in, side by side, with what they owe and sold each other eliminated, unrealised profit in stock taken out, and the group total."
        actions={(
          <div className="flex flex-wrap items-end gap-2 no-print">
            <DateRangePicker value={range} onChange={setRange} />
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSetupOpen(true)} data-slot="consolidated-setup"><Network className="size-3.5" /> Group set-up</Button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted" data-slot="consolidated-export"><Download className="size-3.5" /> Export</DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => state.data && exportAll(state.data, org, 'xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => state.data && exportAll(state.data, org, 'csv')}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => state.data && exportAll(state.data, org, 'pdf')} data-slot="consolidated-export-pdf">PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => printPage()}><Printer className="size-3.5" /> Print</Button>
          </div>
        )}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => {
          const included = d.companies.filter((c) => c.included);
          return (
            <div className="space-y-4">
              <Card className="flex flex-wrap items-center gap-3 p-3 text-sm no-print" data-slot="consolidated-companies">
                <span className="text-xs font-medium text-muted-foreground">Companies</span>
                {d.companies.map((c) => (
                  <label key={c.orgId} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={c.included}
                      onChange={(e) => {
                        const now = d.companies.filter((x) => (x.orgId === c.orgId ? e.target.checked : x.included)).map((x) => x.orgId);
                        if (now.length) setChosen(now);
                      }} />
                    {c.name}{d.group?.parentOrgId === c.orgId ? <span className="text-[10px] text-primary"> (parent)</span> : null}
                    {d.group?.members.find((m) => m.orgId === c.orgId) ? <span className="text-[10px] text-muted-foreground"> ({d.group.members.find((m) => m.orgId === c.orgId)!.ownershipPct}% owned)</span> : null}
                  </label>
                ))}
              </Card>
              {d.companies.length < 2 && (
                <Card className="space-y-2 border-amber-500/40 bg-amber-500/5 p-4 text-sm" data-slot="consolidated-one-company">
                  <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-amber-600" /> You can see the books of {d.companies.length === 1 ? 'one company' : 'no company'} only, so there is nothing to consolidate yet.</p>
                  <ol className="list-decimal space-y-1 pl-6 text-muted-foreground">
                    <li>Add the second company: click your company&apos;s name at the top right ▸ <span className="font-medium text-foreground">Add a company</span>, give its name and state, and <span className="font-medium text-foreground">Create and move there</span>. You are its admin with the same password.</li>
                    <li>Record what the companies did with each other: one company&apos;s invoice to the other, the other&apos;s bill from it, payments.</li>
                    <li>Come back here (Reports ▸ Consolidated statements), tick both companies and choose the period. Use <span className="font-medium text-foreground">Group set-up</span> to name the parent, the ownership, and which customer or vendor is the other company if their PANs do not say so.</li>
                  </ol>
                </Card>
              )}
              {d.notes.map((n) => (
                <Card key={n} className="flex items-start gap-2 border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-slot="consolidated-note">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" /> <p>{n}</p>
                </Card>
              ))}
              <div className="print-only mb-2 border-b pb-2">
                <p className="text-lg font-bold">{org} — Consolidated statements</p>
                <p className="text-xs">{dayLabel(d.from)} to {dayLabel(d.to)} · {included.map((c) => c.name).join(', ')}</p>
              </div>
              <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1 no-print">
                {TABS.map(([t, l]) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-slot={`consolidated-tab-${t}`}
                    className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{l}</button>
                ))}
              </div>
              {tab === 'statements' && <Statements d={d} onDrill={setDrill} />}
              {tab === 'trial-balance' && <TrialBalanceView d={d} onDrill={setDrill} />}
              {tab === 'check' && <CheckView d={d} />}
              {tab === 'eliminations' && <EliminationsView d={d} />}
            </div>
          );
        }}
      </AsyncPage>
      {setupOpen && <SetupDialog orgIds={chosen ?? undefined} onClose={() => setSetupOpen(false)} onSaved={() => { setSetupOpen(false); state.refetch(); }} />}
      {drill && <LedgerDialog drill={drill} from={range.from} to={range.to} onClose={() => setDrill(null)} />}
    </>
  );
}

type Drill = (d: { orgId: string; company: string; code: string; name: string }) => void;

function Statements({ d, onDrill }: { d: ConsolidatedReport; onDrill: Drill }) {
  const included = d.companies.filter((c) => c.included);
  const ids = included.map((c) => c.orgId);
  const cols = ids.length + 3;
  const line = (label: string, s: ConsolidatedSum | ConsolidatedRowData, strong = false, key?: string, code?: string) => (
    <tr key={key ?? label} className={cn('border-b', strong ? 'rpt-total font-semibold' : 'rpt-line')} data-slot={strong ? 'rpt-total' : 'rpt-account'}>
      <td className="px-3 py-1.5">{label}</td>
      {ids.map((id) => (
        <td key={id} className="px-3 py-1.5 text-right">
          {code && !strong ? <button type="button" className="hover:underline" data-slot="consolidated-drill" onClick={() => onDrill({ orgId: id, company: included.find((c) => c.orgId === id)!.name, code, name: label })}><Money value={s.by[id] ?? 0} /></button> : <Money value={s.by[id] ?? 0} />}
        </td>
      ))}
      <td className="px-3 py-1.5 text-right text-muted-foreground" data-slot="consolidated-elim">{s.elimination ? <Money value={s.elimination} /> : ''}</td>
      <td className="px-3 py-1.5 text-right font-medium" data-slot="consolidated-group"><Money value={s.total} /></td>
    </tr>
  );
  const section = (title: string, list: ConsolidatedRowData[], total: ConsolidatedSum) => (
    <Fragment key={title}>
      <tr className="rpt-head border-b" data-slot="rpt-heading"><td colSpan={cols} className="px-3 py-2 text-xs uppercase tracking-wide">{title}</td></tr>
      {list.map((r) => line(`${r.code ? `${r.code} ` : ''}${r.name}`, r, false, `${title}-${r.code || r.name}`, r.code || undefined))}
      {line(`Total ${title.toLowerCase()}`, total, true)}
    </Fragment>
  );
  const plain = (label: string, v: number, key: string) => (
    <tr key={key} className="border-b text-sm" data-slot={`consolidated-${key}`}>
      <td className="px-3 py-1.5 pl-6 text-muted-foreground">{label}</td>
      <td colSpan={ids.length + 1} />
      <td className="px-3 py-1.5 text-right"><Money value={v} /></td>
    </tr>
  );
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-slot="consolidated-table">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Account</th>
              {included.map((c) => <th key={c.orgId} className="px-3 py-2 text-right font-semibold">{c.name}</th>)}
              <th className="px-3 py-2 text-right font-semibold">Eliminations</th>
              <th className="px-3 py-2 text-right font-semibold">Group</th>
            </tr>
          </thead>
          <tbody>
            <tr className="rpt-sub border-b"><td colSpan={cols} className="px-3 py-2 text-sm font-semibold">Profit and loss, {dayLabel(d.from)} to {dayLabel(d.to)}</td></tr>
            {section('Income', d.income, d.totalIncome)}
            {section('Expenses', d.expenses, d.totalExpense)}
            {line('Net profit', d.netProfit, true)}
            {d.nci.length > 0 && plain('Attributable to owners of the parent', d.profitAttributable.ownersPaise, 'owners-profit')}
            {d.nci.length > 0 && plain('Attributable to non-controlling interest', d.profitAttributable.nciPaise, 'nci-profit')}
            <tr className="rpt-sub border-b" data-slot="rpt-heading"><td colSpan={cols} className="px-3 py-2 text-sm font-semibold">Balance sheet on {dayLabel(d.to)}</td></tr>
            {section('Assets', d.assets, d.totalAssets)}
            {section('Liabilities', d.liabilities, d.totalLiabilities)}
            {section("Owners' equity", d.equity, d.totalEquity)}
          </tbody>
        </table>
      </div>
      <p className={cn('flex items-center gap-1.5 border-t px-3 py-2 text-xs', d.check.group.balanced ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')} data-slot="consolidated-balanced">
        {d.check.group.balanced ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
        {d.check.group.balanced ? 'The group balance sheet balances: assets equal liabilities plus equity (non-controlling interest included).' : `The group balance sheet is out by ${toRupees(d.check.group.assets - d.check.group.liabilitiesAndEquity)} — see the Eliminations tab: something owed in one book is not owing in the other.`}
        <span className="ml-auto text-muted-foreground">Click a company&apos;s figure to open its ledger.</span>
      </p>
    </Card>
  );
}

function TrialBalanceView({ d, onDrill }: { d: ConsolidatedReport; onDrill: Drill }) {
  const included = d.companies.filter((c) => c.included);
  const dr = (v: number) => (v > 0 ? <Money value={v} /> : '');
  const cr = (v: number) => (v < 0 ? <Money value={-v} /> : '');
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-slot="consolidated-tb">
          <thead>
            <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              <th rowSpan={2} className="px-3 py-2 text-left">Account</th>
              {included.map((c) => <th key={c.orgId} colSpan={2} className="border-l px-3 py-1.5 text-center">{c.name}</th>)}
              <th colSpan={2} className="border-l px-3 py-1.5 text-center">Eliminations</th>
              <th colSpan={2} className="border-l px-3 py-1.5 text-center">Group</th>
            </tr>
            <tr className="border-b bg-muted/40 text-[10px] uppercase text-muted-foreground">
              {[...included.map((c) => c.orgId), 'e', 'g'].map((k) => <Fragment key={k}><th className="border-l px-3 py-1 text-right">Debit</th><th className="px-3 py-1 text-right">Credit</th></Fragment>)}
            </tr>
          </thead>
          <tbody>
            {d.trialBalance.rows.map((r) => (
              <tr key={r.code || r.name} className="border-b" data-slot="consolidated-tb-row">
                <td className="px-3 py-1.5">{r.code ? <span className="font-mono text-xs text-muted-foreground">{r.code} </span> : null}{r.name}</td>
                {included.map((c) => (
                  <Fragment key={c.orgId}>
                    <td className="border-l px-3 py-1.5 text-right">{r.code && r.by[c.orgId] ? <button type="button" className="hover:underline" onClick={() => onDrill({ orgId: c.orgId, company: c.name, code: r.code, name: r.name })}>{dr(r.by[c.orgId] ?? 0)}</button> : dr(r.by[c.orgId] ?? 0)}</td>
                    <td className="px-3 py-1.5 text-right">{r.code && r.by[c.orgId] ? <button type="button" className="hover:underline" onClick={() => onDrill({ orgId: c.orgId, company: c.name, code: r.code, name: r.name })}>{cr(r.by[c.orgId] ?? 0)}</button> : cr(r.by[c.orgId] ?? 0)}</td>
                  </Fragment>
                ))}
                <td className="border-l px-3 py-1.5 text-right text-muted-foreground">{dr(r.elimination)}</td><td className="px-3 py-1.5 text-right text-muted-foreground">{cr(r.elimination)}</td>
                <td className="border-l px-3 py-1.5 text-right font-medium">{dr(r.total)}</td><td className="px-3 py-1.5 text-right font-medium">{cr(r.total)}</td>
              </tr>
            ))}
            <tr className="rpt-total border-t-2 font-semibold" data-slot="consolidated-tb-total">
              <td className="px-3 py-2">Total</td>
              {included.map((c) => <Fragment key={c.orgId}><td className="border-l px-3 py-2 text-right"><Money value={d.trialBalance.debit.by[c.orgId] ?? 0} /></td><td className="px-3 py-2 text-right"><Money value={d.trialBalance.credit.by[c.orgId] ?? 0} /></td></Fragment>)}
              <td className="border-l px-3 py-2 text-right"><Money value={d.trialBalance.debit.elimination} /></td><td className="px-3 py-2 text-right"><Money value={d.trialBalance.credit.elimination} /></td>
              <td className="border-l px-3 py-2 text-right"><Money value={d.trialBalance.debit.total} /></td><td className="px-3 py-2 text-right"><Money value={d.trialBalance.credit.total} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        Ledger balances only. The inter-company balances and trade come out here; stock, unrealised profit, goodwill and the non-controlling interest are adjustments
        to the statements, not ledger balances, and are on the Statements tab. {d.trialBalance.debit.total === d.trialBalance.credit.total ? 'Debits equal credits for the group.' : 'Debits and credits differ — look at each company.'}
      </p>
    </Card>
  );
}

function CheckView({ d }: { d: ConsolidatedReport }) {
  const ok = (b: boolean) => (b ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-3.5" /> Yes</span> : <span className="inline-flex items-center gap-1 text-destructive"><XCircle className="size-3.5" /> No</span>);
  const row = (label: string, income: number, profit: number, assets: number, le: number, balanced: boolean | null, strong = false, slot?: string) => (
    <tr className={cn('border-b', strong && 'font-semibold')} data-slot={slot}>
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right"><Money value={income} /></td><td className="px-3 py-2 text-right"><Money value={profit} /></td>
      <td className="px-3 py-2 text-right"><Money value={assets} /></td><td className="px-3 py-2 text-right"><Money value={le} /></td>
      <td className="px-3 py-2">{balanced === null ? '' : ok(balanced)}</td>
    </tr>
  );
  const sum = (k: 'income' | 'netProfit' | 'assets' | 'liabilitiesAndEquity') => d.check.companies.reduce((t, c) => t + c[k], 0);
  return (
    <Card className="space-y-3 p-4" data-slot="consolidated-check">
      <div className="flex items-center gap-2">
        <Building2 className="size-4 text-primary" />
        <p className="text-sm font-semibold">Consolidation check, {dayLabel(d.from)} to {dayLabel(d.to)}</p>
        <Button size="xs" variant="outline" className="ml-auto gap-1 no-print" onClick={() => printPage('Consolidation check')}><Printer className="size-3" /> Print</Button>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="px-3 py-2 text-left">Company</th><th className="px-3 py-2 text-right">Income</th><th className="px-3 py-2 text-right">Net profit</th><th className="px-3 py-2 text-right">Assets</th><th className="px-3 py-2 text-right">Liabilities + equity</th><th className="px-3 py-2 text-left">Balances</th></tr></thead>
        <tbody>
          {d.check.companies.map((c) => <Fragment key={c.orgId}>{row(c.name, c.income, c.netProfit, c.assets, c.liabilitiesAndEquity, c.balanced && c.tbBalanced, false, 'check-company')}</Fragment>)}
          {row('Sum of the companies', sum('income'), sum('netProfit'), sum('assets'), sum('liabilitiesAndEquity'), null, true, 'check-sum')}
          {row('Eliminations', d.check.eliminations.income, d.check.eliminations.netProfit, d.check.eliminations.assets, d.check.eliminations.liabilitiesAndEquity, null, false, 'check-elim')}
          {row('Group', d.check.group.income, d.check.group.netProfit, d.check.group.assets, d.check.group.liabilitiesAndEquity, d.check.group.balanced, true, 'check-group')}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Group = sum of the companies + eliminations, line by line. Group liabilities and equity include the non-controlling interest of <Money value={d.check.group.nciPaise} />.
        Assets {d.check.group.balanced ? 'equal' : 'do not equal'} liabilities plus equity: <Money value={d.check.group.assets} /> against <Money value={d.check.group.liabilitiesAndEquity} />.
      </p>
    </Card>
  );
}

function EliminationsView({ d }: { d: ConsolidatedReport }) {
  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-4" data-slot="consolidated-intercompany">
        <p className="text-sm font-semibold">Inter-company balances and trade</p>
        {d.interCompany.length === 0 ? (
          <p className="text-xs text-muted-foreground">No dealings between these companies were found. A customer or vendor counts as a group company when its PAN, or the PAN in its GSTIN, is that company&apos;s PAN — or when Group set-up links it.</p>
        ) : (
          <>
            <table className="w-full text-xs">
              <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1.5 text-left">Between</th><th className="py-1.5 text-right">Owed, in its books</th><th className="py-1.5 text-right">Owing, in the other&apos;s</th><th className="py-1.5 text-right">Difference</th><th className="py-1.5 text-right">Sold</th><th className="py-1.5 text-right">Bought, in the other&apos;s</th><th className="py-1.5 text-right">Difference</th></tr></thead>
              <tbody>
                {d.interCompany.map((p) => (
                  <tr key={`${p.fromOrgId}-${p.toOrgId}`} className="border-b last:border-0" data-slot="intercompany-row">
                    <td className="py-1.5">{p.fromName} → {p.toName}</td>
                    <td className="py-1.5 text-right"><Money value={p.receivablePaise} /></td><td className="py-1.5 text-right"><Money value={p.counterpartPayablePaise} /></td>
                    <td className={cn('py-1.5 text-right', p.balanceDifferencePaise ? 'font-medium text-amber-700' : 'text-muted-foreground')}><Money value={p.balanceDifferencePaise} /></td>
                    <td className="py-1.5 text-right"><Money value={p.salesPaise} /></td><td className="py-1.5 text-right"><Money value={p.counterpartPurchasesPaise} /></td>
                    <td className={cn('py-1.5 text-right', p.tradeDifferencePaise ? 'font-medium text-amber-700' : 'text-muted-foreground')}><Money value={p.tradeDifferencePaise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="flex items-center gap-1.5 text-xs" data-slot="intercompany-agree">
              {d.unreconciledPaise === 0 && d.interCompany.every((p) => !p.tradeDifferencePaise)
                ? <><CheckCircle2 className="size-3.5 text-emerald-600" /> Both sides agree.</>
                : <><AlertTriangle className="size-3.5 text-amber-600" /> A difference is shown above: a bill not yet entered by the buyer, or money in transit. Each side is taken out as its own book records it; reconcile them before relying on the group totals.</>}
            </p>
          </>
        )}
      </Card>
      <Card className="space-y-2 p-4" data-slot="consolidated-unrealised">
        <p className="text-sm font-semibold">Unrealised profit in stock</p>
        {d.unrealisedProfit.closing.length === 0 ? (
          <p className="text-xs text-muted-foreground">No group company holds stock bought from another at {dayLabel(d.to)}, so there is no unrealised profit to take out.</p>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1.5 text-left">Held by</th><th className="py-1.5 text-left">Bought from</th><th className="py-1.5 text-left">Item</th><th className="py-1.5 text-right">Quantity held</th><th className="py-1.5 text-right">Price paid</th><th className="py-1.5 text-right">Seller&apos;s cost</th><th className="py-1.5 text-right">Unrealised profit</th></tr></thead>
            <tbody>
              {d.unrealisedProfit.closing.map((u, i) => (
                <tr key={i} className="border-b last:border-0" data-slot="unrealised-row">
                  <td className="py-1.5">{u.buyerName}</td><td className="py-1.5">{u.sellerName}</td><td className="py-1.5">{u.item}</td><td className="py-1.5 text-right">{u.qtyHeld}</td>
                  <td className="py-1.5 text-right"><Money value={u.unitPricePaise} /></td><td className="py-1.5 text-right">{u.sellerUnitCostPaise !== null ? <Money value={u.sellerUnitCostPaise} /> : 'by margin'}</td>
                  <td className="py-1.5 text-right font-medium"><Money value={u.profitPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted-foreground">Held at the end <Money value={d.unrealisedProfit.closingPaise} />; held at the start of the period <Money value={d.unrealisedProfit.openingPaise} /> (realised now). Charged to the period: <Money value={d.unrealisedProfit.chargePaise} />. Losses are not taken out (AS 21 para 17).</p>
      </Card>
      <Card className="space-y-2 p-4" data-slot="consolidated-investments">
        <p className="text-sm font-semibold">Investment, share capital, goodwill and non-controlling interest</p>
        {d.investments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No parent is set up, so no investment is set against share capital. Use Group set-up to name the parent and each subsidiary&apos;s ownership.</p>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1.5 text-left">Subsidiary</th><th className="py-1.5 text-right">Owned</th><th className="py-1.5 text-right">Investment</th><th className="py-1.5 text-right">Share capital</th><th className="py-1.5 text-right">Reserves at acquisition</th><th className="py-1.5 text-right">Goodwill</th><th className="py-1.5 text-right">Capital reserve</th><th className="py-1.5 text-right">NCI: profit</th><th className="py-1.5 text-right">NCI: net assets</th></tr></thead>
            <tbody>
              {d.investments.map((i) => {
                const n = d.nci.find((x) => x.orgId === i.subsidiaryOrgId);
                return (
                  <tr key={i.subsidiaryOrgId} className="border-b last:border-0" data-slot="investment-row">
                    <td className="py-1.5">{i.subsidiary}{!i.identified && <span className="ml-1 text-amber-700">(investment account not found)</span>}</td>
                    <td className="py-1.5 text-right">{i.ownershipPct}%</td><td className="py-1.5 text-right"><Money value={i.investmentPaise} /></td><td className="py-1.5 text-right"><Money value={i.shareCapitalPaise} /></td>
                    <td className="py-1.5 text-right"><Money value={i.preAcquisitionPaise} /></td><td className="py-1.5 text-right"><Money value={i.goodwillPaise} /></td><td className="py-1.5 text-right"><Money value={i.capitalReservePaise} /></td>
                    <td className="py-1.5 text-right"><Money value={n?.profitSharePaise ?? 0} /></td><td className="py-1.5 text-right"><Money value={n?.netAssetsSharePaise ?? 0} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function LedgerDialog({ drill, from, to, onClose }: { drill: { orgId: string; company: string; code: string; name: string }; from: string; to: string; onClose: () => void }) {
  const state = useApi(() => consolidation.ledger(drill.orgId, drill.code, from, to), [drill.orgId, drill.code, from, to]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-slot="consolidated-ledger">
        <DialogHeader>
          <DialogTitle>{drill.name} — {drill.company}</DialogTitle>
          <DialogDescription>The account&apos;s ledger in {drill.company}, {dayLabel(from)} to {dayLabel(to)}, read without moving into that company.</DialogDescription>
        </DialogHeader>
        <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
          {(l) => !l.account ? <p className="text-sm text-muted-foreground">That account is not in {drill.company}&apos;s chart.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1.5 text-left">Date</th><th className="py-1.5 text-left">Entry</th><th className="py-1.5 text-left">Description</th><th className="py-1.5 text-right">Debit</th><th className="py-1.5 text-right">Credit</th><th className="py-1.5 text-right">Balance</th></tr></thead>
              <tbody>
                <tr className="border-b"><td colSpan={5} className="py-1.5 text-muted-foreground">Opening balance</td><td className="py-1.5 text-right"><Money value={l.openingPaise} /></td></tr>
                {l.lines.map((x, i) => (
                  <tr key={i} className="border-b" data-slot="consolidated-ledger-line">
                    <td className="py-1.5">{x.date}</td><td className="py-1.5">#{x.entryNo}</td><td className="py-1.5">{x.description ?? x.memo ?? ''}{x.contactName ? ` · ${x.contactName}` : ''}</td>
                    <td className="py-1.5 text-right"><Money value={x.debitPaise} showZero={false} /></td><td className="py-1.5 text-right"><Money value={x.creditPaise} showZero={false} /></td><td className="py-1.5 text-right"><Money value={x.runningPaise} /></td>
                  </tr>
                ))}
                <tr className="font-semibold"><td colSpan={5} className="py-1.5">Closing balance</td><td className="py-1.5 text-right"><Money value={l.closingPaise} /></td></tr>
              </tbody>
            </table>
          )}
        </AsyncPage>
      </DialogContent>
    </Dialog>
  );
}

function SetupDialog({ orgIds, onClose, onSaved }: { orgIds?: string[]; onClose: () => void; onSaved: () => void }) {
  const state = useApi(() => consolidation.setup(orgIds), [orgIds?.join(',')]);
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Record<string, { pct: string; acquiredOn: string; investmentAccountId: string }>>({});
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const s: ConsolidationSetup | null = state.data ?? null;
    if (!s) return;
    const p = s.group?.parentOrgId ?? s.companies[0]?.orgId ?? '';
    setParent(p);
    setName(s.group?.name ?? '');
    const m: typeof members = {};
    for (const c of s.companies) {
      const g = s.group?.members.find((x) => x.orgId === c.orgId);
      m[c.orgId] = { pct: String(g?.ownershipPct ?? 100), acquiredOn: g?.acquiredOn ?? '', investmentAccountId: g?.investmentAccountId ?? '' };
    }
    setMembers(m);
    const l: Record<string, string> = {};
    for (const c of s.companies) for (const k of c.contacts) l[`${c.orgId}:${k.id}`] = k.groupCompanyOrgId ?? '';
    setLinks(l);
  }, [state.data]);
  const save = async () => {
    const s = state.data!;
    setBusy(true);
    try {
      const original = new Map<string, string>(s.companies.flatMap((c) => c.contacts.map((k): [string, string] => [`${c.orgId}:${k.id}`, k.groupCompanyOrgId ?? ''])));
      await consolidation.saveSetup({
        parentOrgId: parent, name,
        members: s.companies.filter((c) => c.orgId !== parent).map((c) => ({ orgId: c.orgId, ownershipPct: Number(members[c.orgId]?.pct) || 100, acquiredOn: members[c.orgId]?.acquiredOn || null, investmentAccountId: members[c.orgId]?.investmentAccountId || null })),
        links: Object.entries(links).filter(([k, v]) => original.get(k) !== v).map(([k, v]) => { const [orgId, contactId] = k.split(':'); return { orgId, contactId, counterpartOrgId: v || null }; }),
      });
      toast.success('Group set up', { description: 'The consolidated statements now follow it.' });
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl" data-slot="consolidated-setup-dialog">
        <DialogHeader>
          <DialogTitle>Group set-up</DialogTitle>
          <DialogDescription>Name the parent and each subsidiary&apos;s ownership (default 100%), and the account in the parent&apos;s books that holds the investment in it. Link a customer or vendor to the group company it is, when their PANs do not say so.</DialogDescription>
        </DialogHeader>
        <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
          {(s) => s.companies.length < 2 ? <p className="text-sm text-muted-foreground">Only one company is open to you. Add another from the company menu at the top first.</p> : (
            <div className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Parent company</span>
                  <select value={parent} onChange={(e) => setParent(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2" data-slot="setup-parent">
                    {s.companies.map((c) => <option key={c.orgId} value={c.orgId} disabled={!c.canEdit}>{c.name}{c.canEdit ? '' : ' (you are not its admin or accountant)'}</option>)}
                  </select>
                </label>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Group name</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Race Auto group" data-slot="setup-name" /></label>
              </div>
              <table className="w-full text-sm" data-slot="setup-members">
                <thead><tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1.5 text-left">Subsidiary</th><th className="py-1.5 text-left">Owned %</th><th className="py-1.5 text-left">Acquired on</th><th className="py-1.5 text-left">Investment account (parent&apos;s books)</th></tr></thead>
                <tbody>
                  {s.companies.filter((c) => c.orgId !== parent).map((c) => (
                    <tr key={c.orgId} className="border-b" data-slot="setup-member">
                      <td className="py-1.5">{c.name}</td>
                      <td className="py-1.5"><Input type="number" min={0.01} max={100} value={members[c.orgId]?.pct ?? '100'} onChange={(e) => setMembers({ ...members, [c.orgId]: { ...members[c.orgId], pct: e.target.value } })} className="h-8 w-24" data-slot="setup-pct" /></td>
                      <td className="py-1.5"><Input type="date" value={members[c.orgId]?.acquiredOn ?? ''} onChange={(e) => setMembers({ ...members, [c.orgId]: { ...members[c.orgId], acquiredOn: e.target.value } })} className="h-8 w-40" data-slot="setup-acquired" /></td>
                      <td className="py-1.5">
                        <select value={members[c.orgId]?.investmentAccountId ?? ''} onChange={(e) => setMembers({ ...members, [c.orgId]: { ...members[c.orgId], investmentAccountId: e.target.value } })} className="h-8 w-full rounded-md border bg-background px-2" data-slot="setup-investment">
                          <option value="">1700 Non-current Investments, if it holds a balance</option>
                          {(s.companies.find((x) => x.orgId === parent)?.assetAccounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="space-y-2">
                <p className="text-xs font-medium">Customers and vendors that are group companies</p>
                {s.companies.map((c) => (
                  <div key={c.orgId} className="rounded-md border p-2" data-slot="setup-links">
                    <p className="mb-1 text-xs font-medium">In {c.name}&apos;s books</p>
                    <div className="max-h-40 space-y-1 overflow-auto thin-scroll">
                      {c.contacts.map((k) => (
                        <label key={k.id} className="flex items-center gap-2 text-xs" data-slot="setup-link">
                          <span className="min-w-0 flex-1 truncate">{k.name} <span className="text-muted-foreground">({k.kind})</span></span>
                          <select value={links[`${c.orgId}:${k.id}`] ?? ''} onChange={(e) => setLinks({ ...links, [`${c.orgId}:${k.id}`]: e.target.value })} className="h-7 rounded border bg-background px-1" aria-label={`${k.name} is`}>
                            <option value="">not a group company</option>
                            {s.companies.filter((x) => x.orgId !== c.orgId).map((x) => <option key={x.orgId} value={x.orgId}>is {x.name}</option>)}
                          </select>
                        </label>
                      ))}
                      {!c.contacts.length && <p className="text-xs text-muted-foreground">No customers or vendors yet.</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </AsyncPage>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !state.data || state.data.companies.length < 2 || !parent} onClick={() => void save()} data-slot="setup-save">Save group set-up</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Exports: the companies and the eliminations, with the check ──

function exportRows(d: ConsolidatedReport): { cells: (string | number)[]; style?: PdfRow['style'] }[] {
  const included = d.companies.filter((c) => c.included);
  const ids = included.map((c) => c.orgId);
  const r = (p: number) => toRupees(p);
  const out: { cells: (string | number)[]; style?: PdfRow['style'] }[] = [];
  const sec = (title: string, list: ConsolidatedRowData[], total: ConsolidatedSum) => {
    out.push({ cells: [title.toUpperCase()], style: 'heading' });
    for (const x of list) out.push({ cells: [`${x.code ? `${x.code} ` : ''}${x.name}`, ...ids.map((id) => r(x.by[id] ?? 0)), r(x.elimination), r(x.total)] });
    out.push({ cells: [`Total ${title.toLowerCase()}`, ...ids.map((id) => r(total.by[id] ?? 0)), r(total.elimination), r(total.total)], style: 'total' });
  };
  out.push({ cells: [`PROFIT AND LOSS ${d.from} TO ${d.to}`], style: 'heading' });
  sec('Income', d.income, d.totalIncome);
  sec('Expenses', d.expenses, d.totalExpense);
  out.push({ cells: ['Net profit', ...ids.map((id) => r(d.netProfit.by[id] ?? 0)), r(d.netProfit.elimination), r(d.netProfit.total)], style: 'total' });
  if (d.nci.length) {
    out.push({ cells: ['Attributable to owners of the parent', ...ids.map(() => ''), '', r(d.profitAttributable.ownersPaise)] });
    out.push({ cells: ['Attributable to non-controlling interest', ...ids.map(() => ''), '', r(d.profitAttributable.nciPaise)] });
  }
  out.push({ cells: [`BALANCE SHEET ON ${d.to}`], style: 'heading' });
  sec('Assets', d.assets, d.totalAssets);
  sec('Liabilities', d.liabilities, d.totalLiabilities);
  sec("Owners' equity", d.equity, d.totalEquity);
  out.push({ cells: ['CONSOLIDATION CHECK (income, net profit, assets, liabilities + equity)'], style: 'heading' });
  for (const c of d.check.companies) out.push({ cells: [`${c.name}: ${c.balanced ? 'balances' : 'DOES NOT balance'}`, r(c.income), r(c.netProfit), r(c.assets), r(c.liabilitiesAndEquity)] });
  out.push({ cells: ['Eliminations', r(d.check.eliminations.income), r(d.check.eliminations.netProfit), r(d.check.eliminations.assets), r(d.check.eliminations.liabilitiesAndEquity)] });
  out.push({ cells: [`Group: ${d.check.group.balanced ? 'assets equal liabilities plus equity' : 'DOES NOT balance'}`, r(d.check.group.income), r(d.check.group.netProfit), r(d.check.group.assets), r(d.check.group.liabilitiesAndEquity)], style: 'total' });
  return out;
}

function exportAll(d: ConsolidatedReport, org: string, as: 'xlsx' | 'csv' | 'pdf') {
  const included = d.companies.filter((c) => c.included);
  const header = ['Account', ...included.map((c) => c.name), 'Eliminations', 'Group'];
  const name = `Consolidated statements ${d.from} to ${d.to}`;
  const rows = exportRows(d);
  const top = [`${org} — consolidated statements of ${included.map((c) => c.name).join(', ')}`, `${d.from} to ${d.to}`, ...(d.group ? [`Parent: ${d.group.parentName}; ${d.group.members.map((m) => `${m.name} ${m.ownershipPct}%`).join(', ')}`] : []), ...d.notes];
  const ic = [['INTER-COMPANY'], ['Between', 'Owed (its books)', 'Owing (other books)', 'Difference', 'Sold', 'Bought (other books)', 'Difference'],
    ...d.interCompany.map((p) => [`${p.fromName} → ${p.toName}`, toRupees(p.receivablePaise), toRupees(p.counterpartPayablePaise), toRupees(p.balanceDifferencePaise), toRupees(p.salesPaise), toRupees(p.counterpartPurchasesPaise), toRupees(p.tradeDifferencePaise)]),
    ['UNREALISED PROFIT IN STOCK'], ['Held by', 'Bought from', 'Item', 'Qty', 'Price paid', "Seller's cost", 'Profit'],
    ...d.unrealisedProfit.closing.map((u) => [u.buyerName, u.sellerName, u.item, u.qtyHeld, toRupees(u.unitPricePaise), u.sellerUnitCostPaise !== null ? toRupees(u.sellerUnitCostPaise) : 'margin', toRupees(u.profitPaise)])];
  if (as === 'csv') { downloadCsv(`${name}.csv`, [...top.map((t) => [t]), header, ...rows.map((x) => x.cells), ...ic]); return; }
  if (as === 'xlsx') {
    const num = (c: string | number) => (typeof c === 'number' ? c : c);
    downloadWorkbook(name, [
      { name: 'Statements', rows: [header, ...rows.map((x) => x.cells.map(num)), [], ...top.map((t) => [t])] },
      { name: 'Trial balance', rows: [['Account', ...included.flatMap((c) => [`${c.name} Dr`, `${c.name} Cr`]), 'Eliminations Dr', 'Eliminations Cr', 'Group Dr', 'Group Cr'],
        ...d.trialBalance.rows.map((t) => [`${t.code ? `${t.code} ` : ''}${t.name}`, ...included.flatMap((c) => [Math.max(0, toRupees(t.by[c.orgId] ?? 0)), Math.max(0, -toRupees(t.by[c.orgId] ?? 0))]), Math.max(0, toRupees(t.elimination)), Math.max(0, -toRupees(t.elimination)), Math.max(0, toRupees(t.total)), Math.max(0, -toRupees(t.total))])] },
      { name: 'Eliminations', rows: ic },
    ]);
    return;
  }
  if (!allowOutput('export', name)) return;
  downloadPdf(name, pdfTable({
    title: 'Consolidated statements', org, lines: top, landscape: included.length > 2,
    columns: header.map((h, i) => ({ header: h, width: i === 0 ? 3 : 1 })), rows: rows.map((x) => ({ cells: x.cells, style: x.style })), footer: `Exported ${istNow()}`,
  }));
}
