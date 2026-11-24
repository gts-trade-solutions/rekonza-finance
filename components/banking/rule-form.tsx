'use client';

// Zoho Books' "New Rules" form (and Edit Rule): what a rule applies to, whether
// it only recognises a line or categorises it, the criteria (all of them, or
// any one), what the line is recorded as and into which account (or, for a
// Customer or Vendor Payment, from or to which contact), where the
// reference comes from, and which accounts the rule runs on. The choices are
// the ones the server can carry out (lib/bank-rules.ts); the server checks
// them again (services/bank-rules.ts).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CirclePlus, CreditCard, Info, Landmark, ListChecks, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FormErrors, FormRow } from '@/components/shared/form-layout';
import { LoadingRows } from '@/components/shared/async-state';
import {
  MATCH_MODES, REFERENCE_MODES, RULE_FIELDS, opsFor, recordAsOptions,
  type RuleApplyTo, type RuleCriterion, type RuleMatchMode, type RuleScope,
} from '@/lib/bank-rules';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

export interface RuleRecord {
  id: string; name: string; applyTo: RuleApplyTo | null; markAs: 'recognized' | 'categorized'; matchMode: RuleMatchMode;
  criteria: RuleCriterion[]; recordAs: string | null; accountId: string | null; otherBankAccountId: string | null;
  contactId: string | null; referenceMode: 'statement' | 'none'; scope: RuleScope; scopeAccountIds: string[];
}
interface Masters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind?: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

const blank = (): RuleCriterion => ({ field: 'narration', op: 'contains', value: '' });

function Radio({ name, checked, onChange, children, help }: { name: string; checked: boolean; onChange: () => void; children: React.ReactNode; help?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="size-3.5 accent-primary" />
      {children}
      {help && (
        <Tooltip>
          <TooltipTrigger render={<span role="button" tabIndex={0} aria-label={`About ${String(children)}`} className="text-muted-foreground" />}><Info className="size-3.5" /></TooltipTrigger>
          <TooltipContent className="max-w-xs text-[12px]">{help}</TooltipContent>
        </Tooltip>
      )}
    </label>
  );
}

export function RuleForm({ editing }: { editing?: RuleRecord }) {
  const router = useRouter();
  const masters = useApi<Masters>(() => api.get('/api/masters'), []);
  const [name, setName] = useState(editing?.name ?? '');
  const [applyTo, setApplyTo] = useState<RuleApplyTo>(editing?.applyTo ?? 'deposits');
  const [markAs, setMarkAs] = useState<'recognized' | 'categorized'>(editing?.markAs ?? 'recognized');
  const [matchMode, setMatchMode] = useState<RuleMatchMode>(editing?.matchMode ?? 'any');
  const [criteria, setCriteria] = useState<RuleCriterion[]>(editing?.criteria.length ? editing.criteria : [blank()]);
  const [recordAs, setRecordAs] = useState(editing?.recordAs ?? '');
  const [accountId, setAccountId] = useState(editing?.accountId ?? editing?.otherBankAccountId ?? '');
  const [contactId, setContactId] = useState(editing?.contactId ?? '');
  const [referenceMode, setReferenceMode] = useState<'statement' | 'none'>(editing?.referenceMode ?? 'statement');
  const [scope, setScope] = useState<RuleScope>(editing?.scope ?? 'custom');
  const [scopeIds, setScopeIds] = useState<string[]>(editing?.scopeAccountIds ?? []);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const recordOptions = useMemo(() => recordAsOptions(applyTo).map((c) => ({ value: c.key, label: c.label })), [applyTo]);
  const cat = recordAsOptions(applyTo).find((c) => c.key === recordAs) ?? null;
  const transfer = cat?.engine === 'transfer';
  // Zoho's Customer Payment / Vendor Payment: from or to a contact, settling their oldest open invoices or bills.
  const payment = cat?.engine === 'customer' || cat?.engine === 'vendor';
  const contactOptions = useMemo(() => (masters.data?.contacts ?? [])
    .filter((c) => c.kind === 'both' || c.kind === (cat?.engine === 'vendor' ? 'vendor' : 'customer'))
    .map((c) => ({ value: c.id, label: c.displayName })), [masters.data, cat]);
  const accountOptions = useMemo(() => {
    if (!masters.data || !cat) return [];
    if (transfer) return masters.data.bankAccounts.filter((b) => cat.otherAccount !== 'card' || b.kind === 'card').map((b) => ({ value: b.id, label: b.name, sublabel: b.kind }));
    return masters.data.accounts
      .filter((a) => (!cat.accountTypes || cat.accountTypes.includes(a.type as never)) && a.code !== '1100' && a.code !== '2100')
      .map((a) => ({ value: a.id, label: a.name, sublabel: a.code }));
  }, [masters.data, cat, transfer]);
  const bankOptions = useMemo(() => (masters.data?.bankAccounts ?? []).map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.data]);

  const setCrit = (i: number, patch: Partial<RuleCriterion>) => setCriteria((cs) => cs.map((c, j) => {
    if (j !== i) return c;
    const next = { ...c, ...patch };
    // A text comparison does not fit an amount, nor the other way round.
    if (patch.field && !opsFor(patch.field).some((o) => o.value === next.op)) next.op = opsFor(patch.field)[0].value;
    return next;
  }));

  const save = async () => {
    const problems: string[] = [];
    if (!name.trim()) problems.push('Enter a rule name.');
    criteria.forEach((c, i) => { if (!c.value.trim()) problems.push(`Criterion ${i + 1}: enter what to compare with.`); });
    if (!recordAs) problems.push('Choose how to record the transactions.');
    if (recordAs && payment && !contactId) problems.push(cat?.engine === 'vendor' ? 'Choose the vendor.' : 'Choose the customer.');
    if (recordAs && !payment && !accountId) problems.push('Choose the account.');
    if (scope === 'custom' && !scopeIds.length) problems.push('Choose the accounts the rule is for.');
    if (problems.length) { setErrors(problems); return; }
    setErrors([]); setSaving(true);
    const payload = {
      name: name.trim(), applyTo, markAs, matchMode, criteria: criteria.map((c) => ({ ...c, value: c.value.trim() })), recordAs,
      accountId: transfer || payment ? null : accountId, otherBankAccountId: transfer ? accountId : null, contactId: payment ? contactId : null, referenceMode, scope,
      scopeAccountIds: scope === 'custom' ? scopeIds : null,
    };
    try {
      if (editing) await api.put(`/api/banking/rules/${editing.id}`, payload);
      else await api.post('/api/banking/rules', payload);
      toast.success(editing ? 'Rule saved' : 'Rule created', { description: markAs === 'categorized' ? 'Lines it catches are categorized when rules next run.' : 'Lines it catches show under Recognized.' });
      router.push('/banking/rules');
    } catch (e) {
      setErrors([e instanceof ApiError ? e.message : 'The rule was not saved.']);
    } finally {
      setSaving(false);
    }
  };

  if (masters.loading && !masters.data) return <LoadingRows rows={8} />;
  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-3rem)] flex-col bg-surface" data-slot="rule-form">
      <div className="flex h-[65px] shrink-0 items-center border-b px-5">
        <h1 className="flex-1 text-[20px] font-normal">{editing ? 'Edit Rule' : 'New Rules'}</h1>
        <Link href="/banking/rules" aria-label="Close" className="grid size-8 place-items-center text-destructive hover:opacity-80">×</Link>
      </div>
      <div className="flex-1 space-y-5 px-5 py-6">
        <div className="max-w-[740px]"><FormErrors errors={errors} onClose={() => setErrors([])} /></div>
        <FormRow label="Rule Name" required htmlFor="rule-name"><Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></FormRow>
        <FormRow label="Apply To" required>
          <div className="flex h-9 items-center gap-8" data-slot="rule-apply-to">
            <Radio name="apply-to" checked={applyTo === 'deposits'} onChange={() => { setApplyTo('deposits'); setRecordAs(''); setAccountId(''); }}>Deposits</Radio>
            <Radio name="apply-to" checked={applyTo === 'withdrawals'} onChange={() => { setApplyTo('withdrawals'); setRecordAs(''); setAccountId(''); }}>Withdrawals</Radio>
          </div>
        </FormRow>
        <FormRow label="Mark Transaction As" required>
          <div className="flex h-9 items-center gap-8" data-slot="rule-mark-as">
            <Radio name="mark-as" checked={markAs === 'recognized'} onChange={() => setMarkAs('recognized')}
              help="The line is shown under Recognized with what the rule would record, for you to accept.">Recognized</Radio>
            <Radio name="mark-as" checked={markAs === 'categorized'} onChange={() => setMarkAs('categorized')}
              help="The line is recorded at once, as the rule says, when the rules run (on import, or Run rules now).">Categorized</Radio>
          </div>
        </FormRow>
        <hr className="max-w-[740px]" />
        <FormRow label="Categorise the transactions when" required>
          <Combobox options={MATCH_MODES} value={matchMode} onChange={(v) => setMatchMode((v as RuleMatchMode) || 'any')} showAvatar={false} />
        </FormRow>
        <div className="space-y-2 sm:pl-[180px]" data-slot="rule-criteria">
          {criteria.map((c, i) => (
            <div key={i} className="flex max-w-[560px] items-center gap-2" data-slot="rule-criterion">
              <span className="grid h-9 w-7 shrink-0 place-items-center rounded-l border bg-muted text-[13px]">{i + 1}</span>
              <div className="w-40"><Combobox options={RULE_FIELDS} value={c.field} onChange={(v) => v && setCrit(i, { field: v as RuleCriterion['field'] })} showAvatar={false} /></div>
              <div className="w-48"><Combobox options={opsFor(c.field)} value={c.op} onChange={(v) => v && setCrit(i, { op: v as RuleCriterion['op'] })} showAvatar={false} /></div>
              <Input value={c.value} onChange={(e) => setCrit(i, { value: e.target.value })} inputMode={c.field === 'amount' ? 'decimal' : undefined}
                placeholder={c.field === 'amount' ? '0.00' : ''} className="w-40" aria-label={`Criterion ${i + 1} value`} />
              {criteria.length > 1 && <button type="button" aria-label={`Remove criterion ${i + 1}`} onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>}
            </div>
          ))}
          {criteria.length < 10 && (
            <button type="button" onClick={() => setCriteria((cs) => [...cs, blank()])} className="inline-flex items-center gap-1.5 text-[13px] text-link" data-slot="add-criterion">
              <CirclePlus className="size-4 fill-primary text-primary-foreground" /> Add Criterion
            </button>
          )}
        </div>
        <hr className="max-w-[740px]" />
        <FormRow label="Record As" required>
          <Combobox options={recordOptions} value={recordAs} onChange={(v) => { setRecordAs(v); setAccountId(''); setContactId(''); }} showAvatar={false} placeholder=" " />
        </FormRow>
        {payment ? (
          <FormRow label={cat?.engine === 'vendor' ? 'Vendor' : 'Customer'} required
            hint={cat?.engine === 'vendor' ? 'Paid against their oldest open bills first; anything over is kept as an advance.' : 'Set against their oldest open invoices first; anything over is kept as an advance.'}>
            <Combobox options={contactOptions} value={contactId} onChange={setContactId} showAvatar={false} placeholder={cat?.engine === 'vendor' ? 'Select a vendor' : 'Select a customer'} data-slot="rule-contact" />
          </FormRow>
        ) : (
          <FormRow label="Account" required hint={cat?.hint}>
            <Combobox options={accountOptions} value={accountId} onChange={setAccountId} showAvatar={false} placeholder="Select an account" disabled={!recordAs} />
          </FormRow>
        )}
        <FormRow label="Reference Number">
          <Combobox options={REFERENCE_MODES} value={referenceMode} onChange={(v) => setReferenceMode((v as 'statement' | 'none') || 'statement')} showAvatar={false} />
        </FormRow>
        <hr className="max-w-[740px]" />
        <FormRow label="Associate Accounts" required width="lg">
          <div className="space-y-3 rounded-md border bg-[#f9f9fb] p-3" data-slot="rule-scope">
            <div className="flex flex-wrap gap-2">
              {([['all', 'All Accounts', Wallet], ['banks', 'All Banks', Landmark], ['cards', 'All Cards', CreditCard], ['custom', 'Custom', ListChecks]] as const).map(([v, l, I]) => (
                <label key={v} className={cn('inline-flex cursor-pointer items-center gap-2 rounded-md border bg-surface px-3 py-1.5 text-[13px]', scope === v && 'border-primary')}>
                  <input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} className="size-3.5 accent-primary" />{l}<I className="size-4 text-muted-foreground" />
                </label>
              ))}
            </div>
            {scope === 'custom' && <MultiCombobox options={bankOptions} value={scopeIds} onChange={setScopeIds} placeholder="Select accounts" searchPlaceholder="Search accounts" />}
            <p className="text-[12px] text-muted-foreground">Note: Depending on the selected Record As, some Associate Account options may not apply.</p>
          </div>
        </FormRow>
      </div>
      <div className="sticky bottom-0 flex gap-2 border-t bg-surface px-5 py-3">
        <Button onClick={() => void save()} disabled={saving} data-slot="rule-save">{saving ? 'Saving…' : 'Save'}</Button>
        <Button variant="outline" asChild><Link href="/banking/rules">Cancel</Link></Button>
      </div>
    </div>
  );
}
