'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' "Customize Report", for the profit and loss, balance sheet,
// trial balance, general ledger, account transactions and cash flow.
//
//   General   the period, the report basis, compare with N previous periods
//             or years, and "Report by" month, quarter or year columns;
//   Filters   accounts (all, non-zero, with transactions), account types,
//             chosen accounts, branch, cost centre, project, reporting tag,
//             customers and vendors;
//   Columns   which columns show, where the report has columns.
//
// "Save as custom report" keeps the lot under a name, private or shared with
// the company, listed under Reports → Custom Reports. The figures come from
// the server (lib/server/reports/custom-report.ts) over only the journal
// lines the filters keep, and the heading — on screen, in print and in every
// export — states each filter, because an auditor files what they print.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { useCostCentres } from '@/components/forms/cost-centre-picker';
import {
  api, customReports, projects as projectsApi,
  type CustomReportData, type CustomReportKind, type CustomReportSpec,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { ledgerHref, sourceHref } from '@/lib/source-links';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

export const REPORT_TITLE: Record<CustomReportKind, string> = {
  'profit-and-loss': 'Profit and Loss', 'balance-sheet': 'Balance Sheet', 'trial-balance': 'Trial Balance',
  'general-ledger': 'General Ledger', 'account-transactions': 'Account Transactions', 'cash-flow': 'Cash Flow Statement',
};
export const REPORT_PATH: Record<CustomReportKind, string> = {
  'profit-and-loss': '/reports/profit-and-loss', 'balance-sheet': '/reports/balance-sheet', 'trial-balance': '/reports/trial-balance',
  'general-ledger': '/reports/general-ledger', 'account-transactions': '/reports/account-transactions', 'cash-flow': '/reports/cash-flow',
};

/** The columns each report can show or hide. */
const COLUMN_CHOICES: Record<CustomReportKind, [string, string][]> = {
  'profit-and-loss': [['code', 'Account code'], ['pct', '% of operating income'], ['change', 'Change against the next column']],
  'balance-sheet': [['code', 'Account code'], ['change', 'Change against the next column']],
  'trial-balance': [['code', 'Account code'], ['type', 'Account type'], ['debit', 'Debit'], ['credit', 'Credit'], ['net', 'Net balance']],
  'general-ledger': [['date', 'Date'], ['entry', 'Entry'], ['description', 'Description'], ['contact', 'Customer / vendor'], ['source', 'Source'], ['debit', 'Debit'], ['credit', 'Credit'], ['balance', 'Balance']],
  'account-transactions': [['date', 'Date'], ['entry', 'Entry'], ['account', 'Account'], ['description', 'Description'], ['contact', 'Customer / vendor'], ['source', 'Source'], ['debit', 'Debit'], ['credit', 'Credit']],
  'cash-flow': [['change', 'Change against the next column']],
};
const DEFAULT_OFF = new Set(['pct', 'change', 'net', 'type']);
export const columnOn = (spec: CustomReportSpec, key: string) => spec.columns?.[key] ?? !DEFAULT_OFF.has(key);

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

/** Is anything customised beyond the plain report's own controls? */
export const isCustomised = (s: CustomReportSpec | null) => !!s;

/**
 * The customised state of one report page: null is the plain report. Opened
 * with ?custom=<id> it loads that saved custom report; a ledger opened from a
 * budget or another filtered report brings its filters in the address.
 */
export function useCustomReport(report: CustomReportKind, base: () => Omit<CustomReportSpec, 'report'>) {
  const params = useSearchParams();
  const [spec, setSpec] = useState<CustomReportSpec | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; mine: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = params.get('custom');
    if (id) {
      void customReports.get(id).then((r) => {
        const v = r.reports[0];
        if (v) { setSpec({ ...v.spec, report }); setSaved({ id: v.id, name: v.name, mine: v.mine }); }
      }).catch((e) => toast.error('That custom report could not be opened', { description: e instanceof Error ? e.message : String(e) }));
      return;
    }
    // Filters in the address (a budget's or a filtered report's drill-down).
    const list = (k: string) => (params.get(k) ?? '').split(',').filter(Boolean);
    const filter = { branchId: params.get('branchId'), costCentreIds: list('costCentreIds'), projectIds: list('projectIds'), tagOptionIds: list('tagOptionIds'), contactIds: list('contactIds') };
    if (filter.costCentreIds.length || filter.projectIds.length || filter.tagOptionIds.length || filter.contactIds.length || filter.branchId) {
      setSpec({ ...base(), report, filter });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return {
    spec, saved, open, setOpen,
    apply: (s: CustomReportSpec) => { setSpec(s); setOpen(false); },
    clear: () => { setSpec(null); setSaved(null); },
    start: () => spec ?? { ...base(), report, accounts: 'non_zero' as const, compareMode: 'none' as const, reportBy: 'total' as const },
    onSaved: (id: string, name: string) => setSaved({ id, name, mine: true }),
  };
}

export function CustomizeButton({ onClick, active }: { onClick: () => void; active: boolean }) {
  return (
    <Button size="sm" variant={active ? 'default' : 'outline'} className="h-9 gap-1.5 self-end" onClick={onClick} data-slot="customize-report">
      <SlidersHorizontal className="size-3.5" /> Customize Report
    </Button>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

function Checklist({ options, value, onChange, placeholder, slot }: {
  options: { value: string; label: string; sub?: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; slot: string;
}) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  return (
    <div className="space-y-1.5" data-slot={slot}>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-8 text-sm" />
      <div className="max-h-40 space-y-0.5 overflow-auto rounded-md border p-1.5 thin-scroll">
        {shown.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Nothing to choose.</p>}
        {shown.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-accent">
            <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} data-slot={`${slot}-option`} />
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.sub && <span className="text-[10px] text-muted-foreground">{o.sub}</span>}
          </label>
        ))}
      </div>
      {value.length > 0 && <p className="text-[11px] text-muted-foreground">{value.length} chosen · <button type="button" className="text-primary hover:underline" onClick={() => onChange([])}>clear</button></p>}
    </div>
  );
}

export function CustomizePanel({ open, onOpenChange, initial, onApply, saved, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial: CustomReportSpec; onApply: (s: CustomReportSpec) => void;
  saved?: { id: string; name: string; mine: boolean } | null; onSaved?: (id: string, name: string) => void;
}) {
  const [s, setS] = useState<CustomReportSpec>(initial);
  const [tab, setTab] = useState<'general' | 'filters' | 'columns'>('general');
  const [saveName, setSaveName] = useState('');
  const [shared, setShared] = useState(false);
  useEffect(() => { if (open) { setS(initial); setSaveName(saved?.name ?? ''); setTab('general'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const accounts = useAppStore((st) => st.accounts);
  const contacts = useAppStore((st) => st.contacts);
  const branches = useAppStore((st) => st.branches);
  const centres = useCostCentres();
  const projectList = useApi(() => (open ? projectsApi.list({ status: 'all' }).catch(() => ({ projects: [] })) : Promise.resolve({ projects: [] })), [open]);
  const tags = useApi(() => (open ? api.get<{ tags: { id: string; name: string; options: { id: string; value: string }[] }[] }>('/api/reporting-tags').catch(() => ({ tags: [] })) : Promise.resolve({ tags: [] })), [open]);
  const f = s.filter ?? {};
  const setF = (patch: Partial<NonNullable<CustomReportSpec['filter']>>) => setS({ ...s, filter: { ...f, ...patch } });
  const asAt = s.report === 'balance-sheet' || s.report === 'trial-balance';
  const lineReport = s.report === 'general-ledger' || s.report === 'account-transactions';

  const save = async () => {
    try {
      if (saved?.mine && saveName.trim() === saved.name) {
        await customReports.update(saved.id, { spec: s, shared });
        toast.success(`Custom report "${saved.name}" updated`);
        onSaved?.(saved.id, saved.name);
      } else {
        const r = await customReports.save(s.report, saveName.trim(), shared, s);
        toast.success(`Saved as custom report "${saveName.trim()}"`, { description: 'Find it under Reports → Custom Reports.' });
        onSaved?.(r.id, saveName.trim());
      }
      onApply(s);
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" data-slot="customize-panel">
        <DialogHeader>
          <DialogTitle>Customize Report · {REPORT_TITLE[s.report]}</DialogTitle>
          <DialogDescription>Choose the period, the columns and the filters. The report&apos;s heading will list every filter applied.</DialogDescription>
        </DialogHeader>
        <div role="tablist" className="inline-flex w-fit gap-1 rounded-lg border bg-muted/40 p-1">
          {(['general', 'filters', 'columns'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-slot={`customize-tab-${t}`}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
              {t === 'general' ? 'General' : t === 'filters' ? 'Filters' : 'Show / Hide Columns'}
            </button>
          ))}
        </div>

        {tab === 'general' && (
          <div className="grid gap-3 text-[13px] sm:grid-cols-2">
            {!asAt && <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">From</span><Input type="date" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} data-slot="customize-from" /></label>}
            <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">{asAt ? 'As of' : 'To'}</span><Input type="date" value={s.to} onChange={(e) => setS({ ...s, to: e.target.value })} data-slot="customize-to" /></label>
            {s.report !== 'cash-flow' && !lineReport && (
              <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Report basis</span>
                <select value={s.basis ?? 'accrual'} onChange={(e) => setS({ ...s, basis: e.target.value as 'accrual' | 'cash' })} className="h-9 w-full rounded-md border bg-background px-2" data-slot="customize-basis">
                  <option value="accrual">Accrual</option><option value="cash">Cash</option>
                </select>
              </label>
            )}
            {!lineReport && (
              <>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Report by</span>
                  <select value={s.reportBy ?? 'total'} onChange={(e) => setS({ ...s, reportBy: e.target.value as CustomReportSpec['reportBy'] })} className="h-9 w-full rounded-md border bg-background px-2" data-slot="customize-report-by">
                    <option value="total">Total only</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option>
                  </select>
                </label>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Compare with</span>
                  <select value={s.compareMode ?? 'none'} disabled={(s.reportBy ?? 'total') !== 'total'} onChange={(e) => setS({ ...s, compareMode: e.target.value as CustomReportSpec['compareMode'], compareCount: s.compareCount || 1 })} className="h-9 w-full rounded-md border bg-background px-2 disabled:opacity-50" data-slot="customize-compare">
                    <option value="none">Nothing</option><option value="previous_period">Previous period(s)</option><option value="previous_year">Previous year(s)</option>
                  </select>
                </label>
                {(s.compareMode ?? 'none') !== 'none' && (s.reportBy ?? 'total') === 'total' && (
                  <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Number of periods to compare</span>
                    <Input type="number" min={1} max={12} value={s.compareCount ?? 1} onChange={(e) => setS({ ...s, compareCount: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} data-slot="customize-compare-count" />
                  </label>
                )}
                {(s.reportBy ?? 'total') !== 'total' && <p className="text-xs text-muted-foreground sm:col-span-2">With columns by {s.reportBy}, the comparison is the columns themselves.</p>}
              </>
            )}
          </div>
        )}

        {tab === 'filters' && (
          <div className="grid gap-4 text-[13px] sm:grid-cols-2">
            {s.report !== 'cash-flow' && s.report !== 'general-ledger' && (
              <div className="space-y-1.5 sm:col-span-2">
                <span className="block text-xs font-medium text-muted-foreground">Accounts</span>
                <div className="flex flex-wrap gap-4" role="radiogroup">
                  {([['non_zero', 'Non-zero balances'], ['with_txns', 'With transactions'], ['all', 'All accounts']] as const).map(([v, l]) => (
                    <label key={v} className="flex items-center gap-1.5"><input type="radio" name="accounts-mode" checked={(s.accounts ?? 'non_zero') === v} onChange={() => setS({ ...s, accounts: v })} data-slot={`customize-accounts-${v}`} /> {l}</label>
                  ))}
                </div>
              </div>
            )}
            {s.report !== 'cash-flow' && s.report !== 'general-ledger' && (
              <div className="space-y-1.5 sm:col-span-2">
                <span className="block text-xs font-medium text-muted-foreground">Account types</span>
                <div className="flex flex-wrap gap-3">
                  {TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={(f.accountTypes ?? []).includes(t)}
                      onChange={(e) => setF({ accountTypes: e.target.checked ? [...(f.accountTypes ?? []), t] : (f.accountTypes ?? []).filter((x) => x !== t) })} data-slot={`customize-type-${t}`} /> {t}</label>
                  ))}
                </div>
              </div>
            )}
            {s.report !== 'cash-flow' && s.report !== 'general-ledger' && (
              <div className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Chosen accounts</span>
                <Checklist slot="customize-accounts" placeholder="Search accounts" value={f.accountIds ?? []} onChange={(v) => setF({ accountIds: v })}
                  options={accounts.filter((a) => !a.isArchived).map((a) => ({ value: a.id, label: a.name, sub: a.code }))} />
              </div>
            )}
            <div className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Customers and vendors</span>
              <Checklist slot="customize-contacts" placeholder="Search customers or vendors" value={f.contactIds ?? []} onChange={(v) => setF({ contactIds: v })}
                options={contacts.map((c) => ({ value: c.id, label: c.displayName, sub: c.kind === 'both' ? 'customer, vendor' : c.kind }))} />
            </div>
            {s.report !== 'cash-flow' && (
              <div className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Cost centres</span>
                <Checklist slot="customize-cost-centres" placeholder="Search cost centres" value={f.costCentreIds ?? []} onChange={(v) => setF({ costCentreIds: v })}
                  options={centres.map((c) => ({ value: c.id, label: c.name, sub: c.code }))} />
              </div>
            )}
            <div className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Projects</span>
              <Checklist slot="customize-projects" placeholder="Search projects" value={f.projectIds ?? []} onChange={(v) => setF({ projectIds: v })}
                options={(projectList.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name, sub: p.customerName }))} />
            </div>
            <div className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Reporting tags</span>
              <Checklist slot="customize-tags" placeholder="Search tag values" value={f.tagOptionIds ?? []} onChange={(v) => setF({ tagOptionIds: v })}
                options={(tags.data?.tags ?? []).flatMap((t) => t.options.map((o) => ({ value: o.id, label: o.value, sub: t.name })))} />
            </div>
            {branches.length > 1 && (
              <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Branch</span>
                <select value={f.branchId ?? ''} onChange={(e) => setF({ branchId: e.target.value || null })} className="h-9 w-full rounded-md border bg-background px-2" data-slot="customize-branch">
                  <option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              A customer or vendor counts on a line that names them, and on the other lines of an entry that names only them (an invoice&apos;s sales and tax). A project and a tag follow
              each entry to its document. {s.report === 'balance-sheet' || s.report === 'trial-balance' ? 'Filtered, a balance sheet or trial balance takes in only part of each entry, so it cannot balance; the report says so.' : ''}
              {s.report === 'cash-flow' ? 'Cost centres do not apply to cash: bank lines carry none.' : ''}
            </p>
          </div>
        )}

        {tab === 'columns' && (
          <div className="space-y-2 text-[13px]" data-slot="customize-columns">
            {COLUMN_CHOICES[s.report].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={columnOn(s, k)} onChange={(e) => setS({ ...s, columns: { ...(s.columns ?? {}), [k]: e.target.checked } })} data-slot={`customize-col-${k}`} /> {l}</label>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-slot="customize-save">
          <p className="text-xs font-medium">Save as custom report</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name it" className="h-8 w-56" data-slot="customize-save-name" />
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} data-slot="customize-save-shared" /> Share with everyone in the company</label>
            <Button size="sm" variant="outline" disabled={saveName.trim().length < 1} onClick={() => void save()} data-slot="customize-save-go">{saved?.mine && saveName.trim() === saved.name ? 'Update saved report' : 'Save and run'}</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { if (s.from > s.to && !asAt) { toast.error('The period starts after it ends.'); return; } onApply(s); }} data-slot="customize-apply">Run Report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The customised report ───────────────────────────────────────────────────

/** The rows of a customised report for CSV, Excel and PDF, the heading first. */
export function customRows(d: CustomReportData, org: string): (string | number)[][] {
  const s = d.spec;
  const title = REPORT_TITLE[s.report];
  const head: (string | number)[][] = [[`${org} — ${title}${d.account ? ` · ${d.account.code} ${d.account.name}` : ''}`], ...d.applied.map((a) => [a]), ...(d.notes.length ? d.notes.map((n) => [`Note: ${n}`]) : [])];
  const r = (p: number) => toRupees(p);
  if (s.report === 'general-ledger' || s.report === 'account-transactions') {
    const cols = COLUMN_CHOICES[s.report].filter(([k]) => columnOn(s, k));
    const val = (l: NonNullable<CustomReportData['lines']>[number], k: string): string | number => ({
      date: l.date, entry: `#${l.entryNo}`, account: `${l.accountCode ?? ''} ${l.account ?? ''}`.trim(), description: l.description, contact: l.contact ?? '',
      source: l.sourceType.replace(/_/g, ' '), debit: r(l.debitPaise), credit: r(l.creditPaise), balance: l.runningPaise !== undefined ? r(l.runningPaise) : '',
    } as Record<string, string | number>)[k];
    return [...head, cols.map(([, l]) => l),
      ...(d.opening !== undefined ? [cols.map(([k]) => (k === 'description' ? 'Opening balance' : k === 'balance' ? r(d.opening!) : ''))] : []),
      ...(d.lines ?? []).map((l) => cols.map(([k]) => val(l, k))),
      ...(d.closing !== undefined ? [cols.map(([k]) => (k === 'description' ? 'Closing balance' : k === 'balance' ? r(d.closing!) : ''))] : []),
    ];
  }
  if (s.report === 'trial-balance') {
    const parts = (['debit', 'credit', 'net'] as const).filter((k) => columnOn(s, k));
    const header = [...(columnOn(s, 'code') ? ['Code'] : []), 'Account', ...(columnOn(s, 'type') ? ['Type'] : []), ...d.columns.flatMap((c) => parts.map((p) => `${c.label} ${p}`))];
    const rows = d.sections[0]?.rows ?? [];
    return [...head, header,
      ...rows.map((x) => [...(columnOn(s, 'code') ? [x.code] : []), x.name, ...(columnOn(s, 'type') ? [x.type ?? ''] : []), ...d.columns.flatMap((_, i) => parts.map((p) => r(p === 'debit' ? x.debit![i] : p === 'credit' ? x.credit![i] : x.values[i])))]),
      [...(columnOn(s, 'code') ? [''] : []), 'Total', ...(columnOn(s, 'type') ? [''] : []), ...d.columns.flatMap((_, i) => parts.map((p) => (p === 'debit' ? r(d.results[0].values[i]) : p === 'credit' ? r(d.results[1].values[i]) : r(d.results[0].values[i] - d.results[1].values[i]))))],
    ];
  }
  const header = ['Account', ...(columnOn(s, 'code') ? ['Code'] : []), ...d.columns.map((c) => c.label)];
  const out: (string | number)[][] = [...head, header];
  for (const sec of d.sections) {
    out.push([`${'  '.repeat(sec.depth)}${sec.label}`]);
    for (const x of sec.rows) out.push([`${'  '.repeat(sec.depth + 1)}${x.name}`, ...(columnOn(s, 'code') ? [x.code] : []), ...x.values.map(r)]);
    out.push([`${'  '.repeat(sec.depth)}Total for ${sec.label}`, ...(columnOn(s, 'code') ? [''] : []), ...sec.totals.map(r)]);
  }
  for (const x of d.results) out.push([x.label, ...(columnOn(s, 'code') ? [''] : []), ...x.values.map(r)]);
  return out;
}

export function CustomReportView({ state, saved, onEdit, onClear, children }: {
  state: ReturnType<typeof useCustomReportData>; saved?: { id: string; name: string } | null; onEdit: () => void; onClear: () => void; children?: (d: CustomReportData) => ReactNode;
}) {
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
      {(d) => !d ? null : (
        <div className="space-y-3">
          <Card className="space-y-1 p-3 text-xs" data-slot="custom-report-heading">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{saved ? `Custom report: ${saved.name}` : 'Customised report'}</p>
              <Button size="xs" variant="outline" onClick={onEdit} className="no-print">Edit filters</Button>
              <Button size="xs" variant="ghost" onClick={onClear} className="gap-1 no-print" data-slot="custom-report-clear"><X className="size-3" /> Back to the plain report</Button>
              <Link href="/reports/custom-reports" className="ml-auto text-primary hover:underline no-print">All custom reports</Link>
            </div>
            <ul className="list-disc pl-4 text-muted-foreground" data-slot="custom-report-applied">{d.applied.map((a) => <li key={a}>{a}</li>)}</ul>
          </Card>
          {d.notes.map((n) => (
            <Card key={n} className={cn('flex items-start gap-2 p-3 text-sm', d.cannotBalance ? 'border-amber-500/50 bg-amber-500/5' : 'border-muted')} data-slot={d.cannotBalance ? 'custom-cannot-balance' : 'custom-note'}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" /> <p>{n}</p>
            </Card>
          ))}
          {d.balanced && !d.cannotBalance && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400" data-slot="custom-balanced">
              <CheckCircle2 className="size-3.5" /> {d.balanced.every(Boolean) ? (d.spec.report === 'trial-balance' ? 'Debits equal credits in every column.' : 'Assets equal liabilities plus equity in every column.') : 'A column does not balance — look at it before relying on it.'}
            </p>
          )}
          {children ? children(d) : <CustomTable d={d} />}
        </div>
      )}
    </AsyncPage>
  );
}

function filterQuery(spec: CustomReportSpec) {
  const f = spec.filter ?? {};
  const q = new URLSearchParams();
  if (f.branchId) q.set('branchId', String(f.branchId));
  for (const k of ['costCentreIds', 'projectIds', 'tagOptionIds', 'contactIds'] as const) if (f[k]?.length) q.set(k, f[k]!.join(','));
  const s = q.toString();
  return s ? `&${s}` : '';
}

export function CustomTable({ d }: { d: CustomReportData }) {
  const s = d.spec;
  const fq = filterQuery(s);
  const showCode = columnOn(s, 'code');
  if (s.report === 'general-ledger' || s.report === 'account-transactions') {
    const cols = COLUMN_CHOICES[s.report].filter(([k]) => columnOn(s, k));
    if (s.report === 'general-ledger' && !d.account) return <p className="py-10 text-center text-sm text-muted-foreground">Choose an account to see its ledger.</p>;
    return (
      <Card className="gap-0 overflow-x-auto p-0">
        <table className="w-full text-sm" data-slot="custom-lines">
          <thead><tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">{cols.map(([k, l]) => <th key={k} className={cn('px-3 py-2', ['debit', 'credit', 'balance'].includes(k) ? 'text-right' : 'text-left')}>{l}</th>)}</tr></thead>
          <tbody>
            {d.opening !== undefined && <tr className="rpt-sub border-b"><td colSpan={cols.length - (columnOn(s, 'balance') ? 1 : 0)} className="px-3 py-1.5">Opening balance</td>{columnOn(s, 'balance') && <td className="px-3 py-1.5 text-right"><Money value={d.opening} /></td>}</tr>}
            {(d.lines ?? []).length === 0 && <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-muted-foreground">No lines match these filters in the period.</td></tr>}
            {(d.lines ?? []).map((l, i) => (
              <tr key={`${l.entryId}-${i}`} className="border-b last:border-0" data-slot="custom-line">
                {cols.map(([k]) => (
                  <td key={k} className={cn('px-3 py-1.5', ['debit', 'credit', 'balance'].includes(k) && 'text-right')}>
                    {k === 'date' ? l.date : k === 'entry' ? `#${l.entryNo}` : k === 'account' ? `${l.accountCode ?? ''} ${l.account ?? ''}` : k === 'description' ? l.description : k === 'contact' ? l.contact ?? '—'
                      : k === 'source' ? (sourceHref(l.sourceType, l.sourceId) ? <Link href={sourceHref(l.sourceType, l.sourceId)!} className="capitalize hover:underline">{l.sourceType.replace(/_/g, ' ')}</Link> : <span className="capitalize">{l.sourceType.replace(/_/g, ' ')}</span>)
                        : k === 'debit' ? <Money value={l.debitPaise} showZero={false} /> : k === 'credit' ? <Money value={l.creditPaise} showZero={false} /> : l.runningPaise !== undefined ? <Money value={l.runningPaise} /> : ''}
                  </td>
                ))}
              </tr>
            ))}
            {d.closing !== undefined && <tr className="rpt-total border-t-2 font-semibold"><td colSpan={cols.length - (columnOn(s, 'balance') ? 1 : 0)} className="px-3 py-2">Closing balance</td>{columnOn(s, 'balance') && <td className="px-3 py-2 text-right"><Money value={d.closing} /></td>}</tr>}
          </tbody>
        </table>
      </Card>
    );
  }
  if (s.report === 'trial-balance') {
    const parts = (['debit', 'credit', 'net'] as const).filter((k) => columnOn(s, k));
    return (
      <Card className="gap-0 overflow-x-auto p-0">
        <table className="w-full text-sm" data-slot="custom-table">
          <thead>
            <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              {showCode && <th className="px-3 py-2 text-left">Code</th>}<th className="px-3 py-2 text-left">Account</th>{columnOn(s, 'type') && <th className="px-3 py-2 text-left">Type</th>}
              {d.columns.map((c) => parts.map((p) => <th key={`${c.key}${p}`} className="px-3 py-2 text-right">{d.columns.length > 1 ? `${c.label} ` : ''}{p}</th>))}
            </tr>
          </thead>
          <tbody>
            {(d.sections[0]?.rows ?? []).map((x) => (
              <tr key={x.accountId} className="border-b" data-slot="rpt-account">
                {showCode && <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{x.code}</td>}
                <td className="px-3 py-1.5"><Link href={`${ledgerHref(x.accountId, s.from, s.to)}${fq}`} className="hover:underline">{x.name}</Link></td>
                {columnOn(s, 'type') && <td className="px-3 py-1.5 text-xs capitalize text-muted-foreground">{x.type}</td>}
                {d.columns.map((c, i) => parts.map((p) => <td key={`${c.key}${p}`} className="px-3 py-1.5 text-right"><Money value={p === 'debit' ? x.debit![i] : p === 'credit' ? x.credit![i] : x.values[i]} showZero={p === 'net'} /></td>))}
              </tr>
            ))}
            <tr className="rpt-total border-t-2 font-semibold" data-slot="rpt-total">
              {showCode && <td />}<td className="px-3 py-2">Total</td>{columnOn(s, 'type') && <td />}
              {d.columns.map((c, i) => parts.map((p) => <td key={`${c.key}${p}`} className="px-3 py-2 text-right"><Money value={p === 'debit' ? d.results[0].values[i] : p === 'credit' ? d.results[1].values[i] : d.results[0].values[i] - d.results[1].values[i]} /></td>))}
            </tr>
          </tbody>
        </table>
      </Card>
    );
  }
  const pct = s.report === 'profit-and-loss' && columnOn(s, 'pct');
  const change = columnOn(s, 'change') && d.columns.length > 1;
  const income = d.sections.find((x) => x.key === 'operating-income')?.totals ?? [];
  const cellsFor = (vals: number[], strong = false, link?: (i: number) => string) => d.columns.map((c, i) => (
    <td key={c.key} className={cn('whitespace-nowrap px-3 py-1.5 text-right', strong && 'font-semibold')}>
      {link ? <Link href={link(i)} className="hover:underline"><Money value={vals[i]} /></Link> : <Money value={vals[i]} />}
      {pct && income[i] ? <span className="ml-1.5 text-[10px] text-muted-foreground">{((vals[i] / income[i]) * 100).toFixed(1)}%</span> : null}
      {change && i < d.columns.length - 1 ? <span className={cn('ml-1.5 text-[10px]', vals[i] - vals[i + 1] >= 0 ? 'text-emerald-700' : 'text-destructive')}>{vals[i + 1] ? `${(((vals[i] - vals[i + 1]) / Math.abs(vals[i + 1])) * 100).toFixed(1)}%` : '—'}</span> : null}
    </td>
  ));
  const cols = 1 + (showCode ? 1 : 0) + d.columns.length;
  return (
    <Card className="gap-0 overflow-x-auto p-0">
      <table className="w-full text-sm" data-slot="custom-table">
        <thead>
          <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left">Account</th>{showCode && <th className="px-3 py-2 text-left">Code</th>}
            {d.columns.map((c) => <th key={c.key} className="px-3 py-2 text-right" data-slot="custom-column">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.sections.map((sec) => [
            <tr key={`${sec.key}-h`} className={sec.depth === 0 ? 'rpt-head' : 'rpt-sub'} data-slot="rpt-heading"><td colSpan={cols} className="py-1.5 pr-3 text-sm" style={{ paddingLeft: `${0.75 + sec.depth}rem` }}>{sec.label}</td></tr>,
            ...sec.rows.map((x) => (
              <tr key={`${sec.key}-${x.accountId}`} className="rpt-line border-b border-dashed" data-slot="rpt-account">
                <td className="py-1.5 pr-3" style={{ paddingLeft: `${1.5 + sec.depth}rem` }}>{x.name}{x.computed ? <span className="ml-1 text-[10px] text-muted-foreground">worked out</span> : null}</td>
                {showCode && <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{x.code}</td>}
                {cellsFor(x.values, false, x.code && s.report !== 'cash-flow' ? (i) => `${ledgerHref(x.accountId, s.report === 'balance-sheet' ? '1900-01-01' : d.columns[i].from, d.columns[i].to)}${fq}` : undefined)}
              </tr>
            )),
            ...(sec.headingOnly && sec.rows.length === 0 ? [] : [
              <tr key={`${sec.key}-t`} className="rpt-total border-b" data-slot="rpt-total">
                <td className="py-1.5 pr-3 font-semibold" style={{ paddingLeft: `${0.75 + sec.depth}rem` }}>Total for {sec.label}</td>{showCode && <td />}{cellsFor(sec.totals, true)}
              </tr>,
            ]),
          ])}
          {d.results.map((x) => (
            <tr key={x.key} className={cn('border-y-2', x.key === 'net' || x.key === 'le' || x.key === 'closing' ? 'rpt-result-strong' : 'rpt-result')} data-slot={`custom-result-${x.key}`}>
              <td className="px-3 py-2 font-semibold">{x.label}</td>{showCode && <td />}{cellsFor(x.values, true)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** The heading lines a customised report prints and exports, and the PDF needs. */
export const appliedLines = (d: CustomReportData | null | undefined) => (d ? [...d.applied, ...d.notes.map((n) => `Note: ${n}`)] : []);

export function useCustomReportData(spec: CustomReportSpec | null) {
  // The same request the view makes; useApi's own cache keeps it to one.
  return useApi(() => (spec ? customReports.run(spec) : Promise.resolve(null)), [spec ? JSON.stringify(spec) : '']);
}

export const useOrgName = () => useAppStore((s) => s.org?.name ?? '');
