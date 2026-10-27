'use client';

// Statutory settings that change with the business: the GST registration type
// (with the date each change took effect), e-invoicing, the TDS deductor and
// the person responsible, and each branch's own e-way bill threshold.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';

type RegType = 'regular' | 'composition' | 'unregistered';
interface Statutory {
  registration: {
    current: RegType;
    frequency: 'monthly' | 'quarterly';
    compositionCategory: string | null;
    compositionCategories: Record<string, string>;
    history: { id: string; effectiveFrom: string; fromType: RegType; toType: RegType; reason: string; by: string | null }[];
  };
  einvoicing: { applicable: boolean; from: string | null };
  deductor: {
    type: string | null; types: Record<string, string>;
    name: string | null; designation: string | null; pan: string | null; mobile: string | null; email: string | null;
  };
  payroll: { pfCode: string | null; esiCode: string | null };
  branches: { id: string; name: string; stateCode: string; stateName: string; builtInPaise: number; overridePaise: number | null }[];
}

const REG_LABEL: Record<RegType, string> = { regular: 'Regular', composition: 'Composition', unregistered: 'Unregistered' };
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** 1 April of each year from the mandate's start for ₹5 crore (2023) to the current one. */
function aprilFirsts(): string[] {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const out: string[] = [];
  for (let y = fy + 1; y >= 2020; y--) out.push(`${y}-04-01`);
  return out;
}

export function StatutoryPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi<Statutory>(() => api.get('/api/settings/statutory'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const send = async (key: string, payload: Record<string, unknown>, done: (r: never) => string) => {
    setBusy(key);
    try {
      const r = await api.post('/api/settings/statutory', payload);
      toast.success(done(r as never));
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <AsyncPage state={state}>
      {(d) => (
        <div className="space-y-4">
          <Registration d={d} canEdit={canEdit} busy={busy === 'registration'} send={send} />
          <Einvoicing d={d} canEdit={canEdit} busy={busy === 'einvoicing'} send={send} />
          <Deductor d={d} canEdit={canEdit} busy={busy === 'deductor'} send={send} />
          <PayrollCodes d={d} canEdit={canEdit} busy={busy === 'payroll'} send={send} />
          <EwayThresholds d={d} canEdit={canEdit} send={send} />
        </div>
      )}
    </AsyncPage>
  );
}

type Send = (key: string, payload: Record<string, unknown>, done: (r: never) => string) => Promise<boolean>;

function Registration({ d, canEdit, busy, send }: { d: Statutory; canEdit: boolean; busy: boolean; send: Send }) {
  const [f, setF] = useState({ toType: '' as RegType | '', effectiveFrom: '', reason: '' });
  const ready = f.toType && f.effectiveFrom && f.reason.trim().length >= 4;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">GST registration</h3>
        <Badge variant="outline">{REG_LABEL[d.registration.current]}</Badge>
        {d.registration.current === 'regular' && (
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Returns</span>
            <div className="flex rounded-md border p-0.5">
              {(['monthly', 'quarterly'] as const).map((v) => (
                <button key={v} type="button" disabled={!canEdit || busy}
                  title={v === 'quarterly' ? 'QRMP: turnover up to ₹5 crore; IFF and PMT-06 in between' : undefined}
                  onClick={() => void send('registration', { action: 'gst-frequency', frequency: v }, () => `Returns now filed ${v}`)}
                  className={`rounded px-2.5 py-1 capitalize ${d.registration.frequency === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {d.registration.current === 'composition' && (
        <Field label="Composition category" hint="Decides the rate on turnover paid each quarter by CMP-08" className="max-w-sm">
          <div><Select value={d.registration.compositionCategory ?? ''} disabled={!canEdit || busy}
            onValueChange={(v) => void send('registration', { action: 'composition-category', category: v }, () => 'Composition category saved')}>
            <SelectTrigger><SelectValue placeholder="Manufacturer, trader…" /></SelectTrigger>
            <SelectContent>
              {Object.entries(d.registration.compositionCategories).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select></div>
        </Field>
      )}
      <p className="text-xs text-muted-foreground">
        A change takes effect on a date: documents before it keep the type they were issued under. It cannot fall before an
        invoice already issued, or inside a closed period.
      </p>
      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-[180px_170px_1fr_auto] sm:items-end">
          <Field label="Change to">
            {/* Wrapped: the Select's hidden input would otherwise push it up off the row. */}
            <div><Select value={f.toType} onValueChange={(v) => setF({ ...f, toType: v as RegType })}>
              <SelectTrigger><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                {(Object.keys(REG_LABEL) as RegType[]).filter((t) => t !== d.registration.current)
                  .map((t) => <SelectItem key={t} value={t}>{REG_LABEL[t]}</SelectItem>)}
              </SelectContent>
            </Select></div>
          </Field>
          <Field label="With effect from"><Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Opted out of composition, order dated …" /></Field>
          <Button size="sm" disabled={!ready || busy} className="gap-1.5"
            onClick={async () => {
              if (await send('registration', { action: 'registration', ...f }, () => `Registration is now ${REG_LABEL[f.toType as RegType]}`)) {
                setF({ toType: '', effectiveFrom: '', reason: '' });
              }
            }}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Record change
          </Button>
        </div>
      )}
      {d.registration.history.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {d.registration.history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-3 px-3 py-2">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">{day(h.effectiveFrom)}</span>
              <span>{REG_LABEL[h.fromType]} → <span className="font-medium">{REG_LABEL[h.toType]}</span></span>
              <span className="text-xs text-muted-foreground">{h.reason}{h.by ? ` · ${h.by}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Einvoicing({ d, canEdit, busy, send }: { d: Statutory; canEdit: boolean; busy: boolean; send: Send }) {
  const [on, setOn] = useState(d.einvoicing.applicable);
  const [from, setFrom] = useState(d.einvoicing.from ?? '');
  useEffect(() => { setOn(d.einvoicing.applicable); setFrom(d.einvoicing.from ?? ''); }, [d.einvoicing]);
  const changed = on !== d.einvoicing.applicable || (on && from !== (d.einvoicing.from ?? ''));
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">E-invoicing</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Applies once aggregate turnover has passed ₹5 crore in any year since 2017-18, from the next 1 April, and does not
            lapse if turnover falls. Invoices to registered buyers, SEZs and exports then need an IRN within 30 days.
          </p>
        </div>
        <Switch checked={on} disabled={!canEdit} onCheckedChange={setOn} />
      </div>
      {on && (
        <Field label="Applies to invoices from" className="max-w-xs">
          <Select value={from} onValueChange={(v) => setFrom(String(v))} disabled={!canEdit}>
            <SelectTrigger><SelectValue placeholder={d.einvoicing.applicable && !d.einvoicing.from ? 'Every invoice (no start date recorded)' : '1 April of…'} /></SelectTrigger>
            <SelectContent>{aprilFirsts().map((a) => <SelectItem key={a} value={a}>{day(a)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      )}
      {canEdit && changed && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={busy || (on && !from)} className="gap-1.5"
            onClick={() => void send('einvoicing', { action: 'einvoicing', applicable: on, from: on ? from : null },
              (r: { queued: number; cleared: number }) => (on
                ? `E-invoicing on. ${r.queued} issued invoice(s) now need an IRN.`
                : `E-invoicing off. ${r.cleared} invoice(s) taken off the IRN queue.`))}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Save
          </Button>
          <span className="text-xs text-muted-foreground">
            {on ? 'Issued invoices from that date without an IRN will be queued for one.' : 'Invoices waiting for an IRN will be taken off the queue. Ones already registered are not touched.'}
          </span>
        </div>
      )}
    </Card>
  );
}

function Deductor({ d, canEdit, busy, send }: { d: Statutory; canEdit: boolean; busy: boolean; send: Send }) {
  const init = () => ({
    type: d.deductor.type ?? '', name: d.deductor.name ?? '', designation: d.deductor.designation ?? '',
    pan: d.deductor.pan ?? '', mobile: d.deductor.mobile ?? '', email: d.deductor.email ?? '',
  });
  const [f, setF] = useState(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(init()), [d.deductor]);
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">TDS deductor</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Reported in the header of every TDS and TCS return, with the person responsible for deducting and depositing the tax.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Deductor type">
          <Select value={f.type} onValueChange={(v) => setF({ ...f, type: String(v) })} disabled={!canEdit}>
            <SelectTrigger><SelectValue placeholder="Company, firm…" /></SelectTrigger>
            <SelectContent>{Object.entries(d.deductor.types).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Responsible person"><Input value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Designation"><Input value={f.designation} disabled={!canEdit} onChange={(e) => setF({ ...f, designation: e.target.value })} placeholder="Director" /></Field>
        <Field label="Their PAN"><Input value={f.pan} disabled={!canEdit} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} className="font-mono" maxLength={10} /></Field>
        <Field label="Mobile"><Input value={f.mobile} disabled={!canEdit} onChange={(e) => setF({ ...f, mobile: e.target.value })} inputMode="numeric" maxLength={10} /></Field>
        <Field label="Email"><Input type="email" value={f.email} disabled={!canEdit} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      </div>
      {canEdit && (
        <Button size="sm" disabled={busy} className="gap-1.5"
          onClick={() => void send('deductor', { action: 'deductor', ...f, type: f.type || null }, () => 'Deductor details saved')}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} Save
        </Button>
      )}
    </Card>
  );
}

function PayrollCodes({ d, canEdit, busy, send }: { d: Statutory; canEdit: boolean; busy: boolean; send: Send }) {
  const [f, setF] = useState({ pfCode: d.payroll.pfCode ?? '', esiCode: d.payroll.esiCode ?? '' });
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">PF and ESI registration</h3>
        <p className="mt-1 text-xs text-muted-foreground">The establishment&apos;s numbers with EPFO and ESIC, printed on payslips and needed for the monthly returns.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="PF establishment code"><Input value={f.pfCode} disabled={!canEdit} onChange={(e) => setF({ ...f, pfCode: e.target.value.toUpperCase() })} className="font-mono" placeholder="TNMAS0012345000" /></Field>
        <Field label="ESI employer code"><Input value={f.esiCode} disabled={!canEdit} onChange={(e) => setF({ ...f, esiCode: e.target.value })} className="font-mono" placeholder="17 digits" /></Field>
      </div>
      {canEdit && (
        <Button size="sm" disabled={busy} className="gap-1.5" onClick={() => void send('payroll', { action: 'payroll-codes', ...f }, () => 'Saved')}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} Save
        </Button>
      )}
    </Card>
  );
}

function EwayThresholds({ d, canEdit, send }: { d: Statutory; canEdit: boolean; send: Send }) {
  const [vals, setVals] = useState<Record<string, number>>({});
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">E-way bill threshold inside the state</h3>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Goods moving between states always need an e-way bill above ₹50,000. Several states have raised the limit for
          movement inside the state. Where your state&apos;s notification differs from the figure used here, set it per branch.
        </p>
      </div>
      <ul className="divide-y rounded-md border">
        {d.branches.map((b) => {
          const v = vals[b.id] ?? b.overridePaise ?? 0;
          return (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-40 flex-1">
                <p className="font-medium">{b.name}</p>
                <p className="text-xs text-muted-foreground">{b.stateName} · built-in {formatINR(b.builtInPaise)}</p>
              </div>
              {b.overridePaise !== null && <Badge variant="outline" className="text-[10px]">Own figure {formatINR(b.overridePaise)}</Badge>}
              {canEdit && (
                <>
                  <MoneyInput valuePaise={v} onChangePaise={(p) => setVals({ ...vals, [b.id]: p })} className="h-8 w-36" placeholder="Built-in" />
                  <Button size="sm" variant="outline" disabled={!v || v === b.overridePaise}
                    onClick={() => void send(`eway-${b.id}`, { action: 'eway-threshold', branchId: b.id, thresholdPaise: v }, () => `${b.name}: threshold set`)}>
                    Set
                  </Button>
                  {b.overridePaise !== null && (
                    <Button size="sm" variant="ghost"
                      onClick={() => { setVals({ ...vals, [b.id]: 0 }); void send(`eway-${b.id}`, { action: 'eway-threshold', branchId: b.id, thresholdPaise: null }, () => `${b.name}: back to the built-in figure`); }}>
                      Use built-in
                    </Button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
