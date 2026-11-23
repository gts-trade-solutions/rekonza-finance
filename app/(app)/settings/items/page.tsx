'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Settings → Items, as Zoho Books has it for India: how many digits an HSN code
// or SAC must have. Zoho's note is the law's: up to ₹5 crore aggregate turnover
// at least four, above it at least six; eight may always be given. Any properly
// formed code of that length is accepted on items and invoices (lib/tax/hsn.ts);
// the saved codes list only offers suggestions with their rates.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { SettingsNav } from '@/components/settings/all-settings';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { checkHsnCode, hsnHeadingLabel, HSN_DIGIT_CHOICES, legalMinimumDigits, type HsnDigits } from '@/lib/tax/hsn';
import { cn } from '@/lib/utils';

const LABEL: Record<HsnDigits, string> = {
  4: '4-digit HSN code',
  6: '6-digit HSN code',
  8: '8-digit HSN code',
};
const NOTE: Record<HsnDigits, string> = {
  4: 'For businesses with aggregate turnover up to ₹5 crore in the previous year.',
  6: 'Required for businesses with aggregate turnover above ₹5 crore in the previous year.',
  8: 'The full tariff code, which exports and imports use.',
};

export default function ItemSettingsPage() {
  const state = useApi(() => api.get<{ hsn: { digits: HsnDigits } }>('/api/settings/policies'), []);
  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-75px)]" data-slot="settings-frame">
      <SettingsNav href="/settings/items" />
      <div className="settings-page min-w-0 flex-1 space-y-5 px-6 pb-6 pt-5">
        <PageHeader title="Items" description="HSN Code or SAC: how many digits every code on your items and invoices must have." />
        <AsyncPage state={state}>
          {(d) => <HsnSetting digits={d.hsn?.digits ?? 4} onSaved={() => void state.refetch()} />}
        </AsyncPage>
      </div>
    </div>
  );
}

function HsnSetting({ digits, onSaved }: { digits: HsnDigits; onSaved: () => void }) {
  const canEdit = usePermission('settings', 'edit');
  const above5Cr = useAppStore((s) => s.org?.aatoAbove5Cr ?? false);
  const legal = legalMinimumDigits(above5Cr);
  const [pick, setPick] = useState<HsnDigits>(digits);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState('');
  useEffect(() => setPick(digits), [digits]);
  const check = trial.trim() ? checkHsnCode(trial, { digits: pick }) : null;

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings/policies', { hsn: { digits: pick } });
      toast.success(`HSN codes now need at least ${pick} digits`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <Card className="space-y-4 p-5" data-slot="hsn-setting">
        <div>
          <h3 className="text-sm font-semibold">HSN Code or SAC</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">Select the number of digits for the HSN code or SAC on your items and transactions.</p>
        </div>
        <div className="space-y-2" role="radiogroup" aria-label="Number of digits for HSN code">
          {HSN_DIGIT_CHOICES.map((n) => (
            <label key={n} className={cn('flex cursor-pointer items-start gap-3 rounded-[3px] border p-3', pick === n ? 'border-primary bg-primary/5' : 'hover:bg-row-hover')} data-slot={`hsn-digits-${n}`}>
              <input type="radio" name="hsn-digits" className="mt-0.5 accent-primary" checked={pick === n} disabled={!canEdit} onChange={() => setPick(n)} />
              <span>
                <span className="block text-[13.5px] font-medium">{LABEL[n]}</span>
                <span className="block text-[12.5px] text-muted-foreground">{NOTE[n]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="flex items-start gap-2 rounded-[3px] bg-muted/50 p-3 text-[12.5px] text-muted-foreground" data-slot="hsn-legal-note">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            As per GST notification 78/2020, businesses with aggregate turnover up to ₹5 crore must mention at least a 4-digit HSN code,
            and businesses above ₹5 crore at least a 6-digit code, on their tax invoices. SAC for services are six digits and begin with 99.
            {pick < legal && <strong className="block pt-1 text-destructive">Your organisation is marked above ₹5 crore turnover (Settings → Statutory details), so 6 digits are required.</strong>}
          </span>
        </p>
        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || pick === digits} data-slot="hsn-digits-save">Save</Button>
            {pick !== digits && <Button size="sm" variant="ghost" onClick={() => setPick(digits)}>Cancel</Button>}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-5" data-slot="hsn-validate">
        <h3 className="text-sm font-semibold">Validate HSN/SAC</h3>
        <p className="text-[13px] text-muted-foreground">Check a code before you use it: its format, its length against the setting above, and the chapter or service heading it falls under.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Input value={trial} onChange={(e) => setTrial(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="72142090" className="h-9 w-48 font-mono" aria-label="Code to validate" />
          {check && (
            <span className={cn('text-[13px]', check.ok ? 'text-emerald-700' : 'text-destructive')} data-slot={check.ok ? 'hsn-trial-valid' : 'hsn-trial-invalid'}>
              {check.ok ? `Valid ${check.kind === 'sac' ? 'SAC' : 'HSN'} · ${hsnHeadingLabel(trial) ?? check.heading}` : check.problem}
            </span>
          )}
        </div>
      </Card>

      <Card className="flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Saved HSN and SAC codes</h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Codes you use often, with their GST rate and cess: picking one fills the rate on items and invoice lines. Any other valid code can still be typed.</p>
        </div>
        <Button variant="outline" size="sm" asChild><Link href="/settings/hsn-codes">Manage saved codes</Link></Button>
      </Card>
    </div>
  );
}
