'use client';

// Zoho Books' panel for one bank line: "Match Transactions" and "Categorize
// Manually". Best Matches come with a one-click Match; Possible Matches and a
// search over everything else open in the books can be ticked together, so
// one line can pay several invoices, with any difference posted to an account
// (the bank's charge, usually). Categorize Manually lists Zoho's categories
// for money in or out, each with the form Zoho shows (lib/bank-categories.ts).

import { useEffect, useMemo, useState } from 'react';
import { Check, Link2, Loader2, Search, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';
import { categoriesFor, categoryOf, type BankCategory } from '@/lib/bank-categories';
import { cn } from '@/lib/utils';

export interface PanelMasters {
  accounts: { id: string; code: string; name: string; type: string }[];
  bankAccounts: { id: string; name: string; kind?: string }[];
  contacts: { id: string; kind: string; displayName: string }[];
}

type CandidateType = 'invoice' | 'bill' | 'payment' | 'expense' | 'transfer' | 'journal';
interface Candidate {
  key: string; type: CandidateType; id: string; number: string; party: string | null; contactId: string | null;
  date: string; amountPaise: number; totalPaise?: number; score: number; reasons: string[]; best: boolean;
}
interface Group { key: string; party: string | null; members: Candidate[]; amountPaise: number; reasons: string[] }
interface LineDetail {
  line: { id: string; date: string; narration: string; reference: string | null; amountPaise: number; direction: 'in' | 'out'; bankAccountId: string; bankName: string; status: string };
  best: Candidate[]; possible: Candidate[]; groups: Group[]; results: Candidate[] | null;
  links: { type: string; id: string; label: string; amountPaise: number; created: boolean; category: string | null }[];
  party: null | {
    documents: { id: string; number: string; date: string; dueDate: string; totalPaise: number; balancePaise: number }[];
    advances: { id: string; number: string; date: string; unusedPaise: number }[];
  };
}

const TYPE_LABEL: Record<CandidateType, string> = {
  invoice: 'Invoice', bill: 'Bill', payment: 'Payment', expense: 'Expense', transfer: 'Transfer', journal: 'Journal',
};
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const GST_RATES = [0, 5, 12, 18, 28];

export function BankLinePanel({ lineId, masters, onDone }: { lineId: string; masters: PanelMasters; onDone: () => void }) {
  const [tab, setTab] = useState<'match' | 'categorize'>('match');
  const detail = useApi<LineDetail>(() => api.get(`/api/banking/transactions/${lineId}`), [lineId]);
  const d = detail.data;

  // A line with nothing in the books that looks like it opens on Categorize, as in Zoho.
  useEffect(() => {
    if (d && !d.best.length && !d.groups.length && !d.possible.length) setTab('categorize');
    else setTab('match');
  }, [d?.line.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <Card className="p-5"><LoadingRows rows={4} /></Card>;
  const line = d.line;

  return (
    <div className="space-y-3" data-slot="bank-line-panel">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{line.direction === 'in' ? 'Deposit' : 'Withdrawal'} · {line.bankName}</p>
            <p className="mt-1 break-words text-sm font-medium" data-slot="panel-narration">{line.narration}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{day(line.date)}{line.reference ? ` · Ref ${line.reference}` : ''}</p>
          </div>
          <Money value={line.amountPaise} className={cn('shrink-0 text-lg font-semibold', line.direction === 'in' && 'text-emerald-600 dark:text-emerald-400')} />
        </div>
      </Card>

      <div className="flex gap-5 border-b" role="tablist">
        {([['match', 'Match Transactions'], ['categorize', 'Categorize Manually']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-slot="bank-panel-tab" data-tab={k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 pb-2 text-[13px] transition-colors', tab === k ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
            {k === 'match' && d.best.length + d.groups.length > 0 && (
              <span className="ml-1.5 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">{d.best.length + d.groups.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'match'
        ? <MatchTab detail={d} masters={masters} onDone={onDone} lineId={lineId} />
        : <CategorizeTab detail={d} masters={masters} onDone={onDone} lineId={lineId} />}
    </div>
  );
}

// ── Match Transactions ───────────────────────────────────────────────────────

function MatchTab({ detail, masters, onDone, lineId }: { detail: LineDetail; masters: PanelMasters; onDone: () => void; lineId: string }) {
  const line = detail.line;
  const [picked, setPicked] = useState<Record<string, { c: Candidate; amountPaise: number }>>({});
  const [searching, setSearching] = useState(false);
  const [filters, setFilters] = useState({ type: '', contactId: '', from: '', to: '', min: '', max: '', q: '' });
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [differenceAccountId, setDifferenceAccountId] = useState('');
  const act = useApiAction((input: unknown) => api.post<{ created?: string[] }>('/api/banking/transactions', input));

  const total = Object.values(picked).reduce((t, p) => t + p.amountPaise, 0);
  const difference = line.amountPaise - total;
  const bankCharges = masters.accounts.find((a) => a.code === '6800')?.id ?? '';
  useEffect(() => { if (difference !== 0 && !differenceAccountId && bankCharges) setDifferenceAccountId(bankCharges); }, [difference, differenceAccountId, bankCharges]);

  const toggle = (c: Candidate) => setPicked((p) => {
    const next = { ...p };
    // An open document is taken in full, as Zoho does; any difference shows below, to post to
    // bank charges or to make a part payment by lowering the amount.
    if (next[c.key]) delete next[c.key];
    else next[c.key] = { c, amountPaise: c.amountPaise };
    return next;
  });

  const match = async (picks: { c: Candidate; amountPaise: number }[], withDifference: boolean) => {
    const r = await act.run({
      action: 'match_many', transactionId: lineId,
      picks: picks.map(({ c, amountPaise }) => ({ type: c.type, id: c.id, ...(c.type === 'invoice' || c.type === 'bill' ? { amountPaise } : {}) })),
      differenceAccountId: withDifference ? differenceAccountId || null : null,
    });
    if (!r) return toast.error(act.error ?? 'Could not match that line.');
    toast.success('Matched', {
      description: r.created?.length ? `${r.created.join(', ')} recorded into ${line.bankName}.` : 'Nothing new was posted: it was already in the books.',
    });
    onDone();
  };

  const runSearch = async () => {
    const q = Object.fromEntries(Object.entries({
      ...filters, min: filters.min ? String(Math.round(Number(filters.min) * 100)) : '', max: filters.max ? String(Math.round(Number(filters.max) * 100)) : '',
    }).filter(([, v]) => v));
    try {
      const r = await api.get<LineDetail>(`/api/banking/transactions/${lineId}`, { ...q, search: '1' });
      setResults(r.results ?? []);
    } catch (e) {
      toast.error('Search failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const contactOptions = useMemo(() => masters.contacts.map((c) => ({ value: c.id, label: c.displayName })), [masters.contacts]);
  const accountOptions = useMemo(() => masters.accounts
    .filter((a) => ['expense', 'income'].includes(a.type) && a.code !== '1100' && a.code !== '2100')
    .map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` })), [masters.accounts]);
  const typeOptions = (line.direction === 'in' ? ['invoice', 'payment', 'transfer', 'journal'] : ['bill', 'payment', 'expense', 'transfer', 'journal']) as CandidateType[];

  // A plain function, not a component: a component declared here would be a new
  // one each render, and the amount box would lose focus with every key.
  const row = (c: Candidate) => {
    const on = !!picked[c.key];
    const open = c.type === 'invoice' || c.type === 'bill';
    return (
      <div key={c.key} className={cn('flex items-start gap-2.5 rounded-[3px] border p-2.5', on && 'border-primary/50 bg-primary/5')} data-slot="possible-match" data-key={c.key}>
        <Checkbox checked={on} onCheckedChange={() => toggle(c)} aria-label={`Pick ${c.number}`} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]"><span className="text-muted-foreground">{TYPE_LABEL[c.type]}</span> · <span className="font-medium">{c.number}</span></p>
          <p className="truncate text-xs text-muted-foreground">{c.party ?? '—'} · {day(c.date)}{open && c.totalPaise && c.totalPaise !== c.amountPaise ? ` · of ${formatINR(c.totalPaise)}` : ''}</p>
          {c.reasons.length > 0 && <p className="mt-0.5 truncate text-[11px] text-emerald-700 dark:text-emerald-400">{c.reasons.join(' · ')}</p>}
        </div>
        <div className="shrink-0 text-right">
          <Money value={c.amountPaise} className="text-[13px]" />
          {on && open && (
            <div className="mt-1 w-28">
              <MoneyInput valuePaise={picked[c.key].amountPaise}
                onChangePaise={(v) => setPicked((p) => ({ ...p, [c.key]: { c, amountPaise: Math.min(Math.max(v, 0), c.amountPaise) } }))} />
            </div>
          )}
        </div>
      </div>
    );
  };

  const nothing = !detail.best.length && !detail.groups.length && !detail.possible.length;
  return (
    <div className="space-y-3">
      {detail.best.length > 0 && (
        <Card className="space-y-2 p-4" data-slot="best-matches">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Sparkles className="size-3.5 text-emerald-600" /> Best Matches</p>
          {detail.best.map((c) => (
            <div key={c.key} className="flex items-center gap-3 rounded-[3px] border border-emerald-500/40 bg-emerald-500/5 p-2.5" data-slot="best-match" data-key={c.key}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px]"><span className="text-muted-foreground">{TYPE_LABEL[c.type]}</span> · <span className="font-medium">{c.number}</span></p>
                <p className="truncate text-xs text-muted-foreground">{c.party ?? '—'} · {day(c.date)}</p>
                <p className="mt-0.5 truncate text-[11px] text-emerald-700 dark:text-emerald-400">{c.reasons.join(' · ')}</p>
              </div>
              <Money value={c.amountPaise} className="shrink-0 text-[13px] font-medium" />
              <Button size="xs" disabled={act.busy} onClick={() => match([{ c, amountPaise: c.amountPaise }], false)} data-slot="best-match-button">
                {act.busy ? <Loader2 className="size-3 animate-spin" /> : <Link2 className="size-3" />} Match
              </Button>
            </div>
          ))}
        </Card>
      )}

      {detail.groups.map((g) => (
        <Card key={g.key} className="space-y-2 p-4" data-slot="group-match">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Sparkles className="size-3.5 text-emerald-600" /> Best Matches</p>
          <p className="text-xs text-muted-foreground">{g.reasons.join(' · ')}</p>
          {g.members.map((m) => (
            <div key={m.key} className="flex items-center justify-between rounded-[3px] border p-2 text-[13px]">
              <span><span className="text-muted-foreground">{TYPE_LABEL[m.type]}</span> · {m.number} <span className="text-xs text-muted-foreground">· {day(m.date)}</span></span>
              <Money value={m.amountPaise} />
            </div>
          ))}
          <Button size="sm" className="w-full gap-1.5" disabled={act.busy} onClick={() => match(g.members.map((m) => ({ c: m, amountPaise: m.amountPaise })), false)} data-slot="group-match-button">
            <Link2 className="size-3.5" /> Match all {g.members.length}
          </Button>
        </Card>
      ))}

      {detail.possible.length > 0 && (
        <Card className="space-y-2 p-4" data-slot="possible-matches">
          <p className="text-[13px] font-semibold">Possible Matches</p>
          <p className="text-xs text-muted-foreground">Tick one or more. Several can be matched to this line at once.</p>
          {detail.possible.map(row)}
        </Card>
      )}

      {nothing && !searching && (
        <Card className="p-4 text-sm text-muted-foreground" data-slot="no-matches">
          Nothing in the books looks like this line. Search for more transactions below, or categorize it manually.
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-link hover:underline" onClick={() => setSearching((s) => !s)} data-slot="search-more">
          <Search className="size-3.5" /> Search for more transactions
        </button>
        {searching && (
          <div className="space-y-2.5" data-slot="search-form">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Type">
                <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="search-type">
                  <option value="">All</option>
                  {typeOptions.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </Field>
              <Field label="Contact">
                <Combobox options={contactOptions} value={filters.contactId} onChange={(v) => setFilters({ ...filters, contactId: v })} placeholder="Any" clearable showAvatar={false} />
              </Field>
              <Field label="From"><Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
              <Field label="To"><Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
              <Field label="Amount from"><Input type="number" min="0" step="0.01" value={filters.min} onChange={(e) => setFilters({ ...filters, min: e.target.value })} /></Field>
              <Field label="Amount to"><Input type="number" min="0" step="0.01" value={filters.max} onChange={(e) => setFilters({ ...filters, max: e.target.value })} /></Field>
            </div>
            <Field label="Number, name or reference">
              <Input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
            </Field>
            <Button size="sm" variant="outline" onClick={runSearch} className="gap-1.5" data-slot="search-run"><Search className="size-3.5" /> Search</Button>
            {results && (results.length
              ? <div className="space-y-2" data-slot="search-results">{results.map(row)}</div>
              : <p className="text-xs text-muted-foreground">Nothing open in the books fits those filters.</p>)}
          </div>
        )}
      </Card>

      {Object.keys(picked).length > 0 && (
        <Card className="space-y-3 p-4" data-slot="match-summary">
          <div className="space-y-1 text-[13px]">
            <div className="flex justify-between"><span className="text-muted-foreground">Bank line</span><Money value={line.amountPaise} /></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Selected ({Object.keys(picked).length})</span><Money value={total} /></div>
            <div className={cn('flex justify-between font-medium', difference !== 0 && 'text-amber-700 dark:text-amber-400')}>
              <span>Difference</span><span data-slot="match-difference">{formatINR(difference)}</span>
            </div>
          </div>
          {difference !== 0 && (
            <Field label="Record the difference to" hint={line.direction === 'in' && difference < 0
              ? 'The bank received less than these: usually its charge for the transfer.' : 'Where the amount the documents do not explain goes.'}>
              <Combobox options={accountOptions} value={differenceAccountId} onChange={setDifferenceAccountId} placeholder="Choose an account" showAvatar={false} />
            </Field>
          )}
          {act.error && <p className="text-sm text-destructive">{act.error}</p>}
          <Button className="w-full gap-1.5" disabled={act.busy || (difference !== 0 && !differenceAccountId)}
            onClick={() => match(Object.values(picked), difference !== 0)} data-slot="match-selected">
            {act.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Match
          </Button>
        </Card>
      )}
    </div>
  );
}

// ── Categorize Manually ──────────────────────────────────────────────────────

function CategorizeTab({ detail, masters, onDone, lineId }: { detail: LineDetail; masters: PanelMasters; onDone: () => void; lineId: string }) {
  const line = detail.line;
  const options = categoriesFor(line.direction);
  const [category, setCategory] = useState<string>(options[0].key);
  const cat = categoryOf(category) as BankCategory;
  const [contactId, setContactId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [otherBankAccountId, setOther] = useState('');
  const [gstRatePct, setGst] = useState(0);
  const [itc, setItc] = useState<'eligible' | 'ineligible' | 'capital_goods'>('eligible');
  const [charges, setCharges] = useState(0);
  const [tds, setTds] = useState(0);
  const [reference, setReference] = useState(line.reference ?? '');
  const [notes, setNotes] = useState('');
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [paymentId, setPaymentId] = useState('');
  const act = useApiAction((input: unknown) => api.post<{ created?: string | null }>('/api/banking/transactions', input));

  // The account a category starts on, as Zoho fills it in: the Banking
  // Preferences' default expense or income account where one is set and fits
  // the category, else the category's usual account.
  const prefs = useApi<{ defaultExpenseAccountId: string | null; defaultIncomeAccountId: string | null }>(() => api.get('/api/banking/preferences'), []);
  useEffect(() => {
    const fits = (id: string | null) => {
      const a = id ? masters.accounts.find((x) => x.id === id) : undefined;
      return a && (!cat.accountTypes || cat.accountTypes.includes(a.type as never)) ? a.id : '';
    };
    const preferred = cat.side === 'out' ? fits(prefs.data?.defaultExpenseAccountId ?? null)
      : cat.engine === 'journal' && cat.accountTypes?.length === 1 && cat.accountTypes[0] === 'income' ? fits(prefs.data?.defaultIncomeAccountId ?? null) : '';
    const def = cat.engine === 'expense' || cat.engine === 'journal'
      ? preferred || (cat.defaultCode ? masters.accounts.find((a) => a.code === cat.defaultCode)?.id ?? '' : '')
      : cat.defaultCode ? masters.accounts.find((a) => a.code === cat.defaultCode)?.id ?? '' : '';
    setAccountId(def);
    setContactId(''); setOther(''); setGst(0); setAlloc({}); setPaymentId(''); setCharges(0); setTds(0);
  }, [category, prefs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsParty = cat.engine === 'customer' || cat.engine === 'vendor' || cat.engine === 'refund';
  const party = useApi<LineDetail | null>(
    () => (needsParty && contactId ? api.get(`/api/banking/transactions/${lineId}`, { party: contactId }) : Promise.resolve(null)),
    [needsParty, contactId, lineId],
  );
  const docs = party.data?.party?.documents ?? [];
  const advances = party.data?.party?.advances ?? [];
  const advance = cat.key === 'customer_advance' || cat.key === 'vendor_advance';
  // What the payment settles: a receipt is the line plus what the bank kept, plus TDS; a payment the line less the charge, plus TDS.
  const settles = (cat.engine === 'customer' ? line.amountPaise + charges : line.amountPaise - charges) + tds;

  // A party's open documents, oldest first, filled in up to what the payment settles, as Zoho does.
  useEffect(() => {
    if (advance || !docs.length) return;
    let left = settles;
    const next: Record<string, number> = {};
    for (const doc of docs) {
      const take = Math.max(0, Math.min(left, doc.balancePaise));
      next[doc.id] = take;
      left -= take;
    }
    setAlloc(next);
  }, [party.data, advance]); // eslint-disable-line react-hooks/exhaustive-deps

  const used = Object.values(alloc).reduce((t, v) => t + v, 0);
  const contactOptions = useMemo(() => masters.contacts
    .filter((c) => cat.contact === 'any' || !cat.contact || c.kind === cat.contact || c.kind === 'both')
    .map((c) => ({ value: c.id, label: c.displayName })), [masters.contacts, cat.contact]);
  const accountOptions = useMemo(() => masters.accounts
    .filter((a) => !cat.accountTypes || cat.accountTypes.includes(a.type as never))
    .filter((a) => a.code !== '1100' && a.code !== '2100')
    .map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` })), [masters.accounts, cat.accountTypes]);
  const otherOptions = useMemo(() => masters.bankAccounts
    .filter((b) => b.id !== line.bankAccountId && (cat.otherAccount !== 'card' || b.kind === 'card'))
    .map((b) => ({ value: b.id, label: b.name, sublabel: b.kind })), [masters.bankAccounts, line.bankAccountId, cat.otherAccount]);

  const save = async () => {
    const r = await act.run({
      action: 'categorise_as', transactionId: lineId, category,
      contactId: contactId || null,
      allocations: !advance && (cat.engine === 'customer' || cat.engine === 'vendor')
        ? Object.entries(alloc).filter(([, v]) => v > 0).map(([targetId, amountPaise]) => ({ targetId, amountPaise })) : undefined,
      bankChargesPaise: charges || undefined, tdsPaise: tds || undefined,
      otherBankAccountId: otherBankAccountId || null, accountId: accountId || null,
      gstRatePct: cat.tax ? gstRatePct : null, itcEligibility: cat.engine === 'expense' ? itc : undefined,
      paymentId: paymentId || null, reference: reference || null, notes: notes || null,
    });
    if (!r) return toast.error(act.error ?? 'Could not categorize that line.');
    toast.success(`Categorized as ${cat.label}`, { description: r.created ? `${r.created} recorded.` : 'The entry is posted.' });
    onDone();
  };

  const ready = (!cat.contactRequired || !!contactId)
    && (cat.engine !== 'transfer' || !!otherBankAccountId)
    && (cat.engine !== 'journal' && cat.engine !== 'expense' || !!accountId)
    && (cat.engine !== 'refund' || !!paymentId)
    && (advance || !(cat.engine === 'customer' || cat.engine === 'vendor') || used <= settles);

  return (
    <Card className="space-y-4 p-4" data-slot="categorize-form">
      <Field label="Category" required>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="category-picker">
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </Field>
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground" data-slot="category-hint">{cat.hint}</p>

      {cat.contact && (
        <Field label={cat.contact === 'vendor' ? 'Vendor' : cat.contact === 'customer' ? 'Customer' : 'Contact'} required={cat.contactRequired}>
          <Combobox options={contactOptions} value={contactId} onChange={setContactId} placeholder={cat.contactRequired ? 'Choose one' : 'None'} clearable={!cat.contactRequired} showAvatar={false} />
        </Field>
      )}

      {(cat.engine === 'journal' || cat.engine === 'expense') && (
        <Field label={cat.engine === 'expense' ? 'Expense account' : 'Account'} required>
          <Combobox options={accountOptions} value={accountId} onChange={setAccountId} placeholder="Choose an account" searchPlaceholder="Search by name or code" showAvatar={false} />
        </Field>
      )}

      {cat.engine === 'transfer' && (
        <Field label={line.direction === 'in' ? 'From account' : cat.otherAccount === 'card' ? 'Credit card' : 'To account'} required>
          <Combobox options={otherOptions} value={otherBankAccountId} onChange={setOther} placeholder="Choose an account" showAvatar={false} />
        </Field>
      )}

      {cat.tax && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="GST" hint="The amount includes it">
            <select value={gstRatePct} onChange={(e) => setGst(Number(e.target.value))} className="h-9 w-full rounded-md border bg-background px-2 text-sm" data-slot="category-gst">
              {GST_RATES.map((r) => <option key={r} value={r}>{r ? `GST ${r}%` : 'No GST'}</option>)}
            </select>
          </Field>
          {cat.engine === 'expense' && (
            <Field label="Input tax credit">
              <select value={itc} onChange={(e) => setItc(e.target.value as typeof itc)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="eligible">Eligible</option>
                <option value="ineligible">Not eligible</option>
                <option value="capital_goods">Capital goods</option>
              </select>
            </Field>
          )}
        </div>
      )}

      {(cat.engine === 'customer' || cat.engine === 'vendor') && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank charges (if any)"><MoneyInput valuePaise={charges} onChangePaise={setCharges} /></Field>
          <Field label={cat.engine === 'customer' ? 'TDS deducted by customer' : 'TDS withheld'}><MoneyInput valuePaise={tds} onChangePaise={setTds} /></Field>
        </div>
      )}

      {!advance && (cat.engine === 'customer' || cat.engine === 'vendor') && contactId && (
        <div className="space-y-2" data-slot="category-documents">
          <p className="text-[13px] font-medium">{cat.engine === 'customer' ? 'Unpaid invoices' : 'Unpaid bills'}</p>
          {party.loading ? <LoadingRows rows={2} /> : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing unpaid. The whole amount is kept as {cat.engine === 'customer' ? 'the customer’s credit' : 'an advance'}.</p>
          ) : (
            <div className="divide-y rounded-[3px] border">
              {docs.map((doc) => (
                <div key={doc.id} className="flex items-center gap-2 p-2 text-[13px]" data-slot="category-document">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{doc.number}</p>
                    <p className="text-xs text-muted-foreground">{day(doc.date)} · due {formatINR(doc.balancePaise)}</p>
                  </div>
                  <div className="w-28"><MoneyInput valuePaise={alloc[doc.id] ?? 0} onChangePaise={(v) => setAlloc({ ...alloc, [doc.id]: Math.min(Math.max(0, v), doc.balancePaise) })} /></div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Applied {formatINR(used)} of {formatINR(settles)}</span>
            <span className={cn(used > settles && 'text-destructive')}>{used > settles ? 'More than the payment' : settles - used > 0 ? `${formatINR(settles - used)} kept as an advance` : 'All applied'}</span>
          </div>
        </div>
      )}

      {cat.engine === 'refund' && contactId && (
        <Field label="Refund from" required hint="An advance or excess payment with money still unused.">
          {advances.length === 0 ? <p className="text-xs text-muted-foreground">This party has no unused advance to refund.</p> : (
            <div className="space-y-1.5" data-slot="category-advances">
              {advances.map((a) => (
                <label key={a.id} className={cn('flex cursor-pointer items-center gap-2 rounded-[3px] border p-2 text-[13px]', paymentId === a.id && 'border-primary/50 bg-primary/5')}>
                  <input type="radio" name="refund-from" checked={paymentId === a.id} onChange={() => setPaymentId(a.id)} />
                  <span className="flex-1">{a.number} <span className="text-xs text-muted-foreground">· {day(a.date)}</span></span>
                  <span className="text-xs">{formatINR(a.unusedPaise)} unused</span>
                </label>
              ))}
            </div>
          )}
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Reference#"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
        <Field label="Description"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
      </div>

      {act.error && <p className="text-sm text-destructive" data-slot="categorize-error">{act.error}</p>}
      <Button className="w-full gap-1.5" disabled={!ready || act.busy} onClick={save} data-slot="categorize-save">
        {act.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
      </Button>
    </Card>
  );
}

/** A categorized line: what it is matched to, and the way back. */
export function MatchedLinePanel({ lineId, onDone }: { lineId: string; onDone: () => void }) {
  const detail = useApi<LineDetail>(() => api.get(`/api/banking/transactions/${lineId}`), [lineId]);
  const act = useApiAction((input: unknown) => api.post('/api/banking/transactions', input));
  const d = detail.data;
  if (!d) return <Card className="p-5"><LoadingRows rows={3} /></Card>;
  const category = d.links.find((l) => l.category)?.category;
  const recorded = d.links.some((l) => l.created);
  return (
    <Card className="space-y-3 p-4" data-slot="matched-panel">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium">{d.line.narration}</p>
        <Money value={d.line.amountPaise} className="shrink-0 font-semibold" />
      </div>
      <p className="text-xs text-muted-foreground">{category ? `Categorized as ${categoryOf(category)?.label ?? category}` : 'Matched'} · {day(d.line.date)}</p>
      <div className="space-y-1.5" data-slot="matched-links">
        {d.links.map((l) => (
          <div key={`${l.type}:${l.id}`} className="flex items-center justify-between gap-2 rounded-[3px] border p-2 text-[13px]">
            <span className="min-w-0 truncate">{l.label}</span>
            {l.amountPaise ? <Money value={l.amountPaise} className="shrink-0" /> : null}
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {recorded
          ? 'Undoing takes back what this recorded: the receipt, payment, expense, transfer or entry is voided or reversed, and any invoice or bill it paid is open again.'
          : 'It was already in the books, so undoing only lets the line go; nothing is reversed.'}
      </p>
      {act.error && <p className="text-sm text-destructive">{act.error}</p>}
      <Button variant="outline" size="sm" disabled={act.busy} data-slot="unmatch-button" onClick={async () => {
        if (!(await act.run({ action: 'unmatch', transactionId: lineId }))) return toast.error(act.error ?? 'Could not undo that.');
        toast.info(category ? 'Uncategorized' : 'Unmatched');
        onDone();
      }}>
        {act.busy && <Loader2 className="size-3.5 animate-spin" />} {category ? 'Uncategorize' : 'Unmatch'}
      </Button>
    </Card>
  );
}
