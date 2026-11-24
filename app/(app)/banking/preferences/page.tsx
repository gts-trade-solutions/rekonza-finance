'use client';

// Zoho Books' Banking → More → Preferences: the options Rekonza acts on
// (services/banking-preferences.ts). Statements by email have their own window
// (Auto-upload bank statements from email), reached from here too.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { FormErrors, FormRow } from '@/components/shared/form-layout';
import { LoadingRows } from '@/components/shared/async-state';
import { InboundStatementsDialog } from '@/components/banking/inbound-statements';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Prefs {
  applyRulesOnImport: boolean; autoMatchOnImport: boolean; matchWindowDays: number;
  defaultExpenseAccountId: string | null; defaultIncomeAccountId: string | null;
  showPaymentClearing: boolean; keepDuplicates: boolean; inboundEnabled: boolean; inboundSenders: string[];
}
interface Masters { accounts: { id: string; code: string; name: string; type: string }[] }

function Tick({ checked, onChange, children, hint, slot, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint?: string; slot: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2.5 text-[13px]">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" data-slot={slot} disabled={disabled} />
      <span><span className="block">{children}</span>{hint && <span className="block text-[12px] text-muted-foreground">{hint}</span>}</span>
    </label>
  );
}

export default function BankingPreferencesPage() {
  const canEdit = usePermission('banking', 'edit');
  const state = useApi<Prefs>(() => api.get('/api/banking/preferences'), []);
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const [p, setP] = useState<Prefs | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [inbound, setInbound] = useState(false);
  useEffect(() => { if (state.data) setP(state.data); }, [state.data]);
  const accounts = (types: string[]) => (masters.data?.accounts ?? []).filter((a) => types.includes(a.type)).map((a) => ({ value: a.id, label: a.name, sublabel: a.code }));
  const expenseOptions = useMemo(() => accounts(['expense', 'asset']), [masters.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const incomeOptions = useMemo(() => accounts(['income']), [masters.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return <LoadingRows rows={8} />;
  const set = (patch: Partial<Prefs>) => setP({ ...p, ...patch });
  const save = async () => {
    setSaving(true); setErrors([]);
    try {
      const saved = await api.put<Prefs>('/api/banking/preferences', p);
      setP(saved);
      toast.success('Preferences saved');
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : 'The preferences were not saved.']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-3rem)] flex-col bg-surface" data-slot="banking-preferences">
      <div className="flex h-[65px] shrink-0 items-center border-b px-5">
        <h1 className="flex-1 text-[20px] font-normal">Banking Preferences</h1>
        <Link href="/banking" aria-label="Close" className="grid size-8 place-items-center text-destructive hover:opacity-80">×</Link>
      </div>
      <div className="flex-1 space-y-6 px-5 py-6">
        <div className="max-w-[740px]"><FormErrors errors={errors} onClose={() => setErrors([])} /></div>
        <FormRow label="When a statement is imported" width="lg">
          <div className="space-y-3">
            <Tick slot="pref-rules" checked={p.applyRulesOnImport} onChange={(v) => set({ applyRulesOnImport: v })} disabled={!canEdit}
              hint="Lines a rule catches are categorized, or shown under Recognized. Off: rules run only when you choose Run rules now.">Apply the transaction rules</Tick>
            <Tick slot="pref-match" checked={p.autoMatchOnImport} onChange={(v) => set({ autoMatchOnImport: v })} disabled={!canEdit}
              hint="A line that is a payment already entered, or names an open invoice, is matched to it.">Match lines to payments and invoices</Tick>
            <Tick slot="pref-duplicates" checked={p.keepDuplicates} onChange={(v) => set({ keepDuplicates: v })} disabled={!canEdit}
              hint="A line that repeats one already imported is kept under Excluded → Automatically Excluded, where it can be restored. Off: it is left out.">Keep duplicate lines as Automatically Excluded</Tick>
          </div>
        </FormRow>
        <FormRow label="Match a payment within" hint="How many days apart a payment entered and its statement line may be and still be matched.">
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={30} value={p.matchWindowDays} onChange={(e) => set({ matchWindowDays: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
              className="w-24" disabled={!canEdit} data-slot="pref-window" />
            <span className="text-[13px] text-muted-foreground">days of the statement date</span>
          </div>
        </FormRow>
        <hr className="max-w-[740px]" />
        <FormRow label="Categorize money out to" hint="The account Categorize Manually offers first for an expense.">
          <Combobox options={expenseOptions} value={p.defaultExpenseAccountId ?? ''} onChange={(v) => set({ defaultExpenseAccountId: v || null })} showAvatar={false} placeholder="The usual account for each category" clearable disabled={!canEdit} />
        </FormRow>
        <FormRow label="Categorize money in to" hint="The account Categorize Manually offers first for other income.">
          <Combobox options={incomeOptions} value={p.defaultIncomeAccountId ?? ''} onChange={(v) => set({ defaultIncomeAccountId: v || null })} showAvatar={false} placeholder="The usual account for each category" clearable disabled={!canEdit} />
        </FormRow>
        <hr className="max-w-[740px]" />
        <FormRow label="Banking Overview" width="lg">
          <Tick slot="pref-clearing" checked={p.showPaymentClearing} onChange={(v) => set({ showPaymentClearing: v })} disabled={!canEdit}
            hint="The tile, and its line on the chart.">Show the Payment Clearing tile</Tick>
        </FormRow>
        <FormRow label="Statements by email" width="lg">
          <div className="space-y-2 text-[13px]">
            <Tick slot="pref-inbound" checked={p.inboundEnabled} onChange={(v) => set({ inboundEnabled: v })} disabled={!canEdit}>Accept bank statements emailed to each account&apos;s own address</Tick>
            <button type="button" className="text-link hover:underline" onClick={() => setInbound(true)} data-slot="pref-inbound-open">Addresses, allowed senders and what has arrived</button>
          </div>
        </FormRow>
      </div>
      <div className="sticky bottom-0 flex gap-2 border-t bg-surface px-5 py-3">
        {canEdit && <Button onClick={() => void save()} disabled={saving} data-slot="pref-save">{saving ? 'Saving…' : 'Save'}</Button>}
        <Button variant="outline" asChild><Link href="/banking">Cancel</Link></Button>
      </div>
      <InboundStatementsDialog open={inbound} onOpenChange={(v) => { setInbound(v); if (!v) state.refetch(); }} />
    </div>
  );
}
