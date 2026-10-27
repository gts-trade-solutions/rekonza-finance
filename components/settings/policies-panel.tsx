'use client';

// The book's own policies: which parts of the app it uses, and how firmly the
// credit-limit, stock and cash rules are applied as documents are saved.

import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

type Enforcement = 'off' | 'warn' | 'block';
interface Policies {
  features: { inventory: boolean; fixedAssets: boolean; tdsTcs: boolean; ewayBills: boolean; approvals: boolean; tally: boolean; analytics: boolean; payroll: boolean; gst: boolean; multiCurrency: boolean; costCentres: boolean };
  creditLimit: Enforcement; negativeStock: Enforcement; cashLimits: Enforcement; sessionIdleMinutes: number;
  requireMfa: 'off' | 'admins' | 'everyone';
  stockValuation: 'average' | 'fifo';
  signIn: { allowedIps: string[]; adminsAnywhere: boolean; maxSessions: number; alertNewDevice: boolean };
  reminders: { enabled: boolean; stages: number[]; channel: 'whatsapp' | 'email' | 'sms' };
}

const FEATURES: { key: keyof Policies['features']; label: string; hint: string }[] = [
  { key: 'inventory', label: 'Inventory', hint: 'Stock on hand, adjustments, warehouses.' },
  { key: 'fixedAssets', label: 'Fixed assets', hint: 'The register and depreciation.' },
  { key: 'tdsTcs', label: 'TDS & TCS', hint: 'Deduction on bills, returns, certificates.' },
  { key: 'ewayBills', label: 'E-way bills', hint: 'For goods moving above ₹50,000.' },
  { key: 'approvals', label: 'Approvals', hint: 'A second person before a document posts.' },
  { key: 'tally', label: 'Tally', hint: 'The connector and Tally reports.' },
  { key: 'analytics', label: 'Analytics', hint: 'Custom dashboards.' },
  { key: 'payroll', label: 'Payroll', hint: 'Employees, salaries, PF, ESI and TDS on salary.' },
  { key: 'gst', label: 'GST', hint: 'Returns, e-invoices, e-way bills and input credit. Off for a business not registered under GST.' },
  { key: 'multiCurrency', label: 'Foreign currency', hint: 'Invoices and bills in other currencies, exchange gains and losses.' },
  { key: 'costCentres', label: 'Cost centres', hint: 'Income and expense by department, project, site or vehicle.' },
];

const RULES: { key: 'creditLimit' | 'negativeStock' | 'cashLimits'; label: string; hint: string }[] = [
  { key: 'creditLimit', label: 'Credit limits', hint: 'An invoice that takes a customer past the limit on their account.' },
  { key: 'negativeStock', label: 'Negative stock', hint: 'Selling more of an item than there is in stock at the branch.' },
  { key: 'cashLimits', label: 'Cash limits', hint: 'Cash of ₹2 lakh or more from one person in a day (section 269ST); cash expenses above ₹10,000 to one person in a day (40A(3)).' },
];

export function PoliciesPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi(() => api.get<Policies>('/api/settings/policies'), []);
  const save = async (patch: Partial<Omit<Policies, 'signIn' | 'reminders'>> & { signIn?: Partial<Policies['signIn']>; reminders?: Partial<Policies['reminders']> }) => {
    try {
      await api.put('/api/settings/policies', patch);
      toast.success('Saved');
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <AsyncPage state={state}>
      {(p) => (
        <div className="space-y-4">
          <Card className="space-y-3 p-5">
            <div>
              <h3 className="text-sm font-semibold">How firmly the rules apply</h3>
              <p className="mt-1 text-xs text-muted-foreground">Off ignores it. Warn saves the document and says so. Block refuses to save — an approver can override a blocked credit limit.</p>
            </div>
            {RULES.map((r) => (
              <div key={r.key} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                <div className="min-w-0 max-w-xl">
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{r.hint}</p>
                </div>
                <div className="flex rounded-md border p-0.5 text-xs">
                  {(['off', 'warn', 'block'] as const).map((v) => (
                    <button key={v} type="button" disabled={!canEdit} onClick={() => void save({ [r.key]: v })}
                      className={`rounded px-2.5 py-1 capitalize ${p[r.key] === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Card>

          <Card className="space-y-3 p-5">
            <div>
              <h3 className="text-sm font-semibold">Parts of the app this book uses</h3>
              <p className="mt-1 text-xs text-muted-foreground">Switched off, a part leaves the menus. Nothing already recorded is touched, and it can be switched back on at any time.</p>
            </div>
            {FEATURES.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-3 border-t pt-3">
                <div><p className="text-sm font-medium">{f.label}</p><p className="text-xs text-muted-foreground">{f.hint}</p></div>
                <Switch checked={p.features[f.key]} disabled={!canEdit} onCheckedChange={(v) => void save({ features: { ...p.features, [f.key]: v } })} />
              </div>
            ))}
          </Card>

          <Card className="space-y-2 p-5">
            <h3 className="text-sm font-semibold">Valuing closing stock</h3>
            <p className="text-xs text-muted-foreground">Weighted average cost for the year, or first in, first out. Both are allowed by AS 2; a change is a change of accounting policy and is disclosed in the accounts.</p>
            <div className="flex w-fit rounded-md border p-0.5 text-xs">
              {(['average', 'fifo'] as const).map((v) => (
                <button key={v} type="button" disabled={!canEdit} onClick={() => void save({ stockValuation: v })}
                  className={`rounded px-2.5 py-1 ${p.stockValuation === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {v === 'average' ? 'Weighted average' : 'FIFO'}
                </button>
              ))}
            </div>
          </Card>

          <Card className="space-y-2 p-5">
            <h3 className="text-sm font-semibold">Sign-out after inactivity</h3>
            <p className="text-xs text-muted-foreground">Minutes without any activity before a session ends. 0 keeps sessions for their full lifetime.</p>
            <div className="flex items-center gap-2">
              <Input type="number" min={0} max={1440} defaultValue={p.sessionIdleMinutes} disabled={!canEdit} className="h-9 w-28"
                onBlur={(e) => { const n = Number(e.target.value); if (n !== p.sessionIdleMinutes) void save({ sessionIdleMinutes: n }); }} />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </Card>

          <Card className="space-y-2 p-5">
            <h3 className="text-sm font-semibold">Require two-step sign-in</h3>
            <p className="text-xs text-muted-foreground">A code from an authenticator app as well as the password. Anyone it covers who has not set it up is asked to, and can do nothing else until they have. Turn it on for yourself first (Settings → Sign-ins).</p>
            <div className="flex w-fit rounded-md border p-0.5 text-xs">
              {(['off', 'admins', 'everyone'] as const).map((v) => (
                <button key={v} type="button" disabled={!canEdit} onClick={() => void save({ requireMfa: v })}
                  className={`rounded px-2.5 py-1 ${p.requireMfa === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {v === 'off' ? 'Nobody' : v === 'admins' ? 'Admins' : 'Everyone'}
                </button>
              ))}
            </div>
          </Card>

          <Card className="space-y-3 p-5 lg:col-span-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Payment reminders</h3>
                <p className="text-xs text-muted-foreground">Queued each night for invoices still owed, on these days from the due date, under Sales → Payment Reminders. They go from your own WhatsApp, email or messages until a provider is connected.</p>
              </div>
              <Switch checked={p.reminders.enabled} disabled={!canEdit} onCheckedChange={(v) => void save({ reminders: { enabled: v } })} />
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <p className="text-xs font-medium">Days from the due date</p>
                <Input key={p.reminders.stages.join(',')} defaultValue={p.reminders.stages.join(', ')} disabled={!canEdit} className="h-9 w-56 font-mono"
                  onBlur={(e) => {
                    const stages = e.target.value.split(/[\s,]+/).filter(Boolean).map(Number);
                    if (stages.join(',') !== p.reminders.stages.join(',')) void save({ reminders: { stages } });
                  }} />
                <p className="text-[11px] text-muted-foreground">-3 is three days before, 0 the day, 7 a week late.</p>
              </div>
              <div className="flex w-fit rounded-md border p-0.5 text-xs">
                {(['whatsapp', 'email', 'sms'] as const).map((c) => (
                  <button key={c} type="button" disabled={!canEdit} onClick={() => void save({ reminders: { channel: c } })}
                    className={`rounded px-2.5 py-1 ${p.reminders.channel === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                    {c === 'whatsapp' ? 'WhatsApp' : c === 'email' ? 'Email' : 'SMS'}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card className="space-y-3 p-5 lg:col-span-2">
            <div>
              <h3 className="text-sm font-semibold">Where from, and how many</h3>
              <p className="text-xs text-muted-foreground">Limits on signing in beyond the password. Every refusal is in the audit trail.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Allowed addresses</p>
                <p className="text-xs text-muted-foreground">One a line: an address (203.0.113.7), a range (203.0.113.0/24) or a wildcard (192.168.1.*). Empty allows anywhere.</p>
                <textarea key={p.signIn.allowedIps.join(',')} defaultValue={p.signIn.allowedIps.join('\n')} disabled={!canEdit} rows={4}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring"
                  onBlur={(e) => {
                    const list = e.target.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
                    if (list.join(',') !== p.signIn.allowedIps.join(',')) void save({ signIn: { allowedIps: list } });
                  }} />
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={p.signIn.adminsAnywhere} disabled={!canEdit} onCheckedChange={(v) => void save({ signIn: { adminsAnywhere: v } })} />
                  Admins may sign in from anywhere
                </label>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Open sessions a person may keep</p>
                  <p className="text-xs text-muted-foreground">Signing in again ends the oldest beyond the limit. 0 sets no limit.</p>
                  <Input type="number" min={0} max={20} defaultValue={p.signIn.maxSessions} disabled={!canEdit} className="h-9 w-28"
                    onBlur={(e) => { const n = Number(e.target.value); if (n !== p.signIn.maxSessions) void save({ signIn: { maxSessions: n } }); }} />
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Switch checked={p.signIn.alertNewDevice} disabled={!canEdit} onCheckedChange={(v) => void save({ signIn: { alertNewDevice: v } })} />
                  <span>Tell people when their account signs in from a new browser<span className="block text-xs text-muted-foreground">A notice under their bell, with the address.</span></span>
                </label>
              </div>
            </div>
          </Card>
        </div>
      )}
    </AsyncPage>
  );
}
