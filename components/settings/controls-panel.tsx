'use client';

// Internal controls (services/controls.ts): each area an auditor looks at,
// whether this book has it, the evidence from its own records, and what is
// missing — then the switches that turn the controls on.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, CircleOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AsyncPage } from '@/components/shared/async-state';
import { api, ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';

type Status = 'in_place' | 'partial' | 'off' | 'attention';
type Enforcement = 'off' | 'warn' | 'block';
interface Control { key: string; area: string; status: Status; evidence: string; gap: string | null; href: string }
interface Controls {
  changeReasons: boolean; segregation: Enforcement; autoIrn: boolean; creditHoldDays: number; creditHold: Enforcement;
  billsDueDays: number; concentrationPct: number; escalateAfterDays: number; autoDepreciation: boolean;
}
interface Response {
  controls: Control[];
  policies: {
    controls: Controls;
    password: { minLength: number; expiryDays: number; history: number };
    stockAccounting: { method: 'periodic' | 'perpetual'; from: string | null };
  };
}

const STATUS: Record<Status, { label: string; icon: typeof CheckCircle2; tone: string }> = {
  in_place: { label: 'In place', icon: CheckCircle2, tone: 'text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/5' },
  attention: { label: 'Needs attention', icon: AlertTriangle, tone: 'text-amber-700 dark:text-amber-400 border-amber-500/40 bg-amber-500/5' },
  partial: { label: 'Partly in place', icon: CircleDashed, tone: 'text-sky-700 dark:text-sky-400 border-sky-500/40 bg-sky-500/5' },
  off: { label: 'Off', icon: CircleOff, tone: 'text-muted-foreground border-border bg-muted/40' },
};

function EnforcementPick({ value, onChange, disabled }: { value: Enforcement; onChange: (v: Enforcement) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {(['off', 'warn', 'block'] as const).map((v) => (
        <button key={v} type="button" disabled={disabled} onClick={() => onChange(v)}
          className={cn('rounded px-2.5 py-1 text-xs capitalize', value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
          {v}
        </button>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function ControlsPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi<Response>(() => api.get('/api/controls'), []);
  const [c, setC] = useState<Controls | null>(null);
  const [pw, setPw] = useState<Response['policies']['password'] | null>(null);
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state.data) return;
    setC(state.data.policies.controls);
    setPw(state.data.policies.password);
    const now = new Date();
    setFrom(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
  }, [state.data]);

  const save = async (patch: Record<string, unknown>, done = 'Saved') => {
    setBusy(true);
    try {
      await api.put('/api/settings/policies', patch);
      toast.success(done);
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const setControl = <K extends keyof Controls>(k: K, v: Controls[K]) => {
    if (!c) return;
    setC({ ...c, [k]: v });
    void save({ controls: { [k]: v } });
  };

  const switchPerpetual = async () => {
    if (!window.confirm(`Switch to perpetual inventory from ${from}? The stock on hand the day before is posted into the Inventory account, and from then every sale posts its cost. This is not undone by a switch back.`)) return;
    setBusy(true);
    try {
      const r = await api.post<{ from: string; openingPaise: number }>('/api/settings/stock-accounting', { action: 'switch', from });
      toast.success('Perpetual inventory is on', { description: `₹${(r.openingPaise / 100).toLocaleString('en-IN')} of stock on hand taken into the ledger on ${r.from}.` });
      await state.refetch();
    } catch (e) {
      toast.error('Not switched', { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AsyncPage state={state}>
      {(d) => {
        const tally = (s: Status) => d.controls.filter((x) => x.status === s).length;
        const stock = d.policies.stockAccounting;
        return (
          <div className="space-y-5">
            <Card className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="font-semibold">Internal controls</h3>
                  <p className="text-sm text-muted-foreground">Each area an auditor reviews, read from this book&apos;s own settings and records.</p>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {(['in_place', 'attention', 'partial', 'off'] as const).map((s) => (
                    <Badge key={s} variant="outline" className={STATUS[s].tone}>{tally(s)} {STATUS[s].label.toLowerCase()}</Badge>
                  ))}
                </div>
              </div>
            </Card>

            <div className="grid gap-3 lg:grid-cols-2" data-slot="controls-list">
              {d.controls.map((x) => {
                const S = STATUS[x.status];
                return (
                  <Card key={x.key} className={cn('space-y-2 p-4', x.status === 'attention' && 'border-amber-500/40')}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{x.area}</p>
                      <Badge variant="outline" className={cn('shrink-0 gap-1', S.tone)}><S.icon className="size-3" />{S.label}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{x.evidence}</p>
                    {x.gap && <p className="text-sm"><span className="font-medium">To complete: </span>{x.gap}</p>}
                    <Link href={x.href} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      Open <ArrowRight className="size-3" />
                    </Link>
                  </Card>
                );
              })}
            </div>

            {c && pw && (
              <Card className="p-4">
                <h3 className="font-semibold">Settings</h3>
                <p className="mb-2 text-sm text-muted-foreground">{canEdit ? 'Changes apply at once and are kept in the audit trail.' : 'Only an admin can change these.'}</p>
                <Row title="Reason required for every change" hint="Editing or removing anything asks why; the answer is kept in the audit trail beside who and when.">
                  <Switch checked={c.changeReasons} disabled={!canEdit || busy} onCheckedChange={(v) => setControl('changeReasons', v)} />
                </Row>
                <Row title="Segregation of duties" hint="Paying a bill you entered or approved. Block means the payment must be made by someone else.">
                  <EnforcementPick value={c.segregation} disabled={!canEdit || busy} onChange={(v) => setControl('segregation', v)} />
                </Row>
                <Row title="Register IRNs automatically" hint="An invoice needing an IRN is sent for it as soon as it is issued; a refusal becomes an exception.">
                  <Switch checked={c.autoIrn} disabled={!canEdit || busy} onCheckedChange={(v) => setControl('autoIrn', v)} />
                </Row>
                <Row title="Credit hold" hint={`Invoicing a customer with something more than ${c.creditHoldDays} days past due.`}>
                  <div className="flex items-center gap-2">
                    <Input type="number" className="h-8 w-20" min={0} max={365} value={c.creditHoldDays} disabled={!canEdit || busy}
                      onChange={(e) => setC({ ...c, creditHoldDays: Number(e.target.value) })}
                      onBlur={() => void save({ controls: { creditHoldDays: c.creditHoldDays } })} aria-label="Days past due" />
                    <EnforcementPick value={c.creditHold} disabled={!canEdit || busy} onChange={(v) => setControl('creditHold', v)} />
                  </div>
                </Row>
                <Row title="Bills due soon" hint="Bills falling due within this many days are raised for whoever pays them.">
                  <Input type="number" className="h-8 w-20" min={0} max={60} value={c.billsDueDays} disabled={!canEdit || busy}
                    onChange={(e) => setC({ ...c, billsDueDays: Number(e.target.value) })}
                    onBlur={() => void save({ controls: { billsDueDays: c.billsDueDays } })} aria-label="Days before due" />
                </Row>
                <Row title="Customer concentration" hint="A customer owing more than this share of all receivables is raised as a risk.">
                  <div className="flex items-center gap-1">
                    <Input type="number" className="h-8 w-20" min={5} max={100} value={c.concentrationPct} disabled={!canEdit || busy}
                      onChange={(e) => setC({ ...c, concentrationPct: Number(e.target.value) })}
                      onBlur={() => void save({ controls: { concentrationPct: c.concentrationPct } })} aria-label="Per cent" />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </Row>
                <Row title="Escalate to admins" hint="Days an exception may sit past its date (after the owner is reminded) before every admin is told.">
                  <Input type="number" className="h-8 w-20" min={1} max={60} value={c.escalateAfterDays} disabled={!canEdit || busy}
                    onChange={(e) => setC({ ...c, escalateAfterDays: Number(e.target.value) })}
                    onBlur={() => void save({ controls: { escalateAfterDays: c.escalateAfterDays } })} aria-label="Days" />
                </Row>
                <Row title="Depreciation at month end" hint="Post each month's depreciation by itself when the month ends.">
                  <Switch checked={c.autoDepreciation} disabled={!canEdit || busy} onCheckedChange={(v) => setControl('autoDepreciation', v)} />
                </Row>
                <Row title="Passwords" hint="Minimum length, days before a password must be changed (0 never), and how many old ones may not be reused.">
                  <div className="flex items-end gap-2">
                    {([['minLength', 'Length', 8, 64], ['expiryDays', 'Expiry days', 0, 365], ['history', 'History', 0, 24]] as const).map(([k, label, min, max]) => (
                      <div key={k} className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">{label}</Label>
                        <Input type="number" className="h-8 w-20" min={min} max={max} value={pw[k]} disabled={!canEdit || busy}
                          onChange={(e) => setPw({ ...pw, [k]: Number(e.target.value) })}
                          onBlur={() => void save({ password: { [k]: pw[k] } }, 'Password rules saved')} />
                      </div>
                    ))}
                  </div>
                </Row>
                <Row title="Stock in the ledger" hint={stock.method === 'perpetual'
                  ? `Perpetual from ${stock.from}: every sale posts its cost, stock purchases go to Inventory, and month end brings Inventory into line.`
                  : 'Periodic, as in Tally: cost of goods sold is worked out for the statements. Perpetual posts each sale\'s cost and keeps Inventory in the ledger.'}>
                  {stock.method === 'perpetual' ? (
                    <Badge variant="outline" className={STATUS.in_place.tone}>Perpetual</Badge>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input type="date" className="h-8 w-40" value={from} disabled={!canEdit || busy} onChange={(e) => setFrom(e.target.value)} aria-label="Perpetual from" />
                      <Button size="sm" disabled={!canEdit || busy || !/-01$/.test(from)} onClick={switchPerpetual}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Switch to perpetual
                      </Button>
                    </div>
                  )}
                </Row>
              </Card>
            )}
          </div>
        );
      }}
    </AsyncPage>
  );
}
