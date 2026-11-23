'use client';

// Zoho Books' Transaction Rules: the rules that recognise or categorise
// repeating statement lines (lib/bank-rules.ts decides what a rule catches).
//
// Rules run in order and the first that catches a line wins, so a specific
// rule has to sit above a general one. A rule only Recognizes lines unless it
// is set to Categorize them, on purpose: a rule that silently miscategorises
// is worse than one that asks, because a wrong account only surfaces at year
// end when somebody queries the figure.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, MoreHorizontal, Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { RULE_FIELDS, opsFor, type RuleCriterion } from '@/lib/bank-rules';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface RuleRow {
  id: string;
  name: string;
  applyTo: 'deposits' | 'withdrawals' | null;
  markAs: 'recognized' | 'categorized';
  matchMode: 'any' | 'all';
  criteria: RuleCriterion[];
  recordAsLabel: string;
  accountName: string | null;
  otherBankName: string | null;
  scope: 'all' | 'banks' | 'cards' | 'custom';
  scopeAccountIds: string[];
  isActive: boolean;
  timesApplied: number;
}

const criterionText = (c: RuleCriterion) =>
  `${RULE_FIELDS.find((f) => f.value === c.field)?.label ?? c.field} ${opsFor(c.field).find((o) => o.value === c.op)?.label ?? c.op} ${c.field === 'amount' ? `₹${c.value}` : `"${c.value}"`}`;
const SCOPE = { all: 'All Accounts', banks: 'All Banks', cards: 'All Cards', custom: 'Chosen accounts' } as const;

export default function TransactionRulesPage() {
  const router = useRouter();
  const canCreate = usePermission('banking', 'create');
  const canEdit = usePermission('banking', 'edit');
  const state = useApi<{ rules: RuleRow[] }>(() => api.get('/api/banking/rules'), []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await state.refetch(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'That did not work.'); }
  };

  return (
    <div className="-mx-6 -mt-5 min-h-[calc(100vh-3rem)] bg-surface" data-slot="transaction-rules">
      <div className="flex h-[65px] items-center gap-3 border-b px-4">
        <Button variant="outline" size="icon-sm" asChild aria-label="Back to Banking"><Link href="/banking"><ChevronLeft className="size-4" /></Link></Button>
        <h1 className="flex-1 text-[18px] font-semibold">Transaction Rules</h1>
        <Refreshing active={state.refreshing} />
        {canEdit && (state.data?.rules.length ?? 0) > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5" data-slot="run-rules"
            onClick={() => void run(async () => {
              const r = await api.patch<{ matched: number }>('/api/banking/rules', { action: 'run' });
              toast.info(r.matched ? `${r.matched} line${r.matched === 1 ? '' : 's'} categorised` : 'Rules run: lines they recognise are under Recognized');
            }, 'Rules run on every uncategorized line')}>
            <Zap className="size-3.5" /> Run rules now
          </Button>
        )}
        {canCreate && <Button size="sm" className="gap-1" asChild data-slot="new-rule"><Link href="/banking/rules/new"><Plus className="size-4" /> New Rule</Link></Button>}
      </div>

      <AsyncPage state={state} loading={<div className="p-5"><LoadingRows rows={5} /></div>}>
        {(data) => data.rules.length === 0 ? (
          <div className="grid place-items-center px-6 py-24 text-center" data-slot="rules-empty">
            <svg width="110" height="104" viewBox="0 0 110 104" aria-hidden className="mb-6">
              <rect x="0" y="0" width="72" height="24" rx="5" fill="#2fc17a" /><rect x="14" y="10" width="44" height="4" rx="2" fill="#fff" />
              <path d="M22 26v52h20M22 52h20" stroke="#9ba0b5" strokeWidth="2" fill="none" />
              <rect x="44" y="40" width="64" height="24" rx="5" fill="#b6b9c8" /><rect x="56" y="50" width="40" height="4" rx="2" fill="#fff" />
              <rect x="44" y="70" width="64" height="24" rx="5" fill="#9ba0b5" /><rect x="56" y="80" width="40" height="4" rx="2" fill="#fff" />
            </svg>
            <h2 className="text-[16px] font-medium">Create rules to automatically categorize transactions</h2>
            <p className="mt-2 max-w-md text-[13px] text-muted-foreground">Categorise multiple transactions automatically based on the account chosen and criteria you have set.</p>
            {canCreate && <Button size="sm" className="mt-4 gap-1" asChild><Link href="/banking/rules/new"><Plus className="size-4" /> New Rule</Link></Button>}
          </div>
        ) : (
          <table className="w-full text-[13px]" data-slot="rules-table">
            <thead>
              <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                <th className="px-5 py-2.5 font-semibold">Rule Name</th>
                <th className="px-4 py-2.5 font-semibold">Apply To</th>
                <th className="px-4 py-2.5 font-semibold">Criteria</th>
                <th className="px-4 py-2.5 font-semibold">Record As</th>
                <th className="px-4 py-2.5 font-semibold">Mark As</th>
                <th className="px-4 py-2.5 text-right font-semibold">Caught</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="w-12 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} className="border-b align-top hover:bg-row-hover" data-slot="rule-row">
                  <td className="px-5 py-3">
                    {canEdit ? <Link href={`/banking/rules/${r.id}/edit`} className="text-link hover:underline">{r.name}</Link> : r.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{r.applyTo === 'deposits' ? 'Deposits' : r.applyTo === 'withdrawals' ? 'Withdrawals' : 'Deposits and withdrawals'}</span>
                    <span className="block text-[11px] text-muted-foreground">{r.scope === 'custom' ? `${r.scopeAccountIds.length} account${r.scopeAccountIds.length === 1 ? '' : 's'}` : SCOPE[r.scope]}</span>
                  </td>
                  <td className="px-4 py-3">
                    {r.criteria.map((c, i) => (
                      <span key={i} className="block">{i > 0 && <span className="text-[11px] uppercase text-muted-foreground">{r.matchMode === 'any' ? 'or ' : 'and '}</span>}{criterionText(c)}</span>
                    ))}
                  </td>
                  <td className="px-4 py-3"><span className="block">{r.recordAsLabel}</span><span className="block text-[11px] text-muted-foreground">{r.accountName ?? r.otherBankName ?? '—'}</span></td>
                  <td className="px-4 py-3">{r.markAs === 'categorized' ? 'Categorized' : 'Recognized'}</td>
                  <td className="px-4 py-3 text-right tabular">{r.timesApplied}</td>
                  <td className="px-4 py-3">
                    <Switch checked={r.isActive} disabled={!canEdit} aria-label={r.isActive ? 'Active' : 'Inactive'} data-slot="rule-active"
                      onCheckedChange={(v) => void run(() => api.patch('/api/banking/rules', { action: 'toggle', id: r.id, isActive: !!v }), v ? `${r.name} is on` : `${r.name} is off`)} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canEdit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={`More for ${r.name}`} className="text-muted-foreground outline-none hover:text-foreground"><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => router.push(`/banking/rules/${r.id}/edit`)}>Edit</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => {
                            if (window.confirm(`Delete the rule ${r.name}? Lines it already categorised keep their category.`)) void run(() => api.delete(`/api/banking/rules?id=${r.id}`), 'Rule deleted');
                          }}>Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncPage>
    </div>
  );
}
