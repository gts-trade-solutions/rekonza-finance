'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' module Preferences: Quotes, Sales Orders, Invoices, Delivery
// Challans and Credit Notes (Settings → Module Settings, and each module's ⋯ →
// Preferences). What the module allows once a document has gone out, what
// accepting a quote does, and the Terms & Conditions and Customer Notes every
// new one starts with (services/doc-preferences.ts). Numbering is Settings →
// Transaction Number Series.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { SettingsNav } from '@/components/settings/all-settings';
import { usePermission } from '@/lib/store/hooks';
import { useApi } from '@/lib/api/use-api';
import { docPreferences, type DocPreferences } from '@/lib/api/client';
import { PREF_MODULES, type PrefModule } from '@/components/settings/pref-modules';

export default function ModulePreferencesPage() {
  const { module } = useParams<{ module: string }>();
  const m = PREF_MODULES[module] ?? PREF_MODULES.quotes;
  const state = useApi(() => docPreferences.get(m.type), [m.type]);
  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-75px)]" data-slot="settings-frame">
      <SettingsNav href={`/settings/preferences/${module}`} />
      <div className="settings-page min-w-0 flex-1 space-y-5 px-6 pb-6 pt-5">
        <PageHeader title={m.title} description={`${m.title} Preferences: what a ${m.noun} allows once it has gone out, and what every new one starts with.`} />
        <AsyncPage state={state}>
          {(p) => <Preferences key={m.type} m={m} prefs={p} onSaved={() => void state.refetch()} />}
        </AsyncPage>
      </div>
    </div>
  );
}

const ON_ACCEPT = [
  { value: 'nothing', label: 'Do not convert it' },
  { value: 'invoice', label: 'Convert it to a draft invoice' },
  { value: 'sales_order', label: 'Convert it to a sales order' },
] as const;

function Preferences({ m, prefs, onSaved }: { m: PrefModule; prefs: DocPreferences; onSaved: () => void }) {
  const canEdit = usePermission('settings', 'edit');
  const [allowEdit, setAllowEdit] = useState(prefs.settings.allowEditAfterSending !== false);
  const [onAccept, setOnAccept] = useState<'nothing' | 'invoice' | 'sales_order'>(prefs.settings.onQuoteAccepted ?? 'nothing');
  const [terms, setTerms] = useState(prefs.terms ?? '');
  const [notes, setNotes] = useState(prefs.notes ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTerms(prefs.terms ?? ''); setNotes(prefs.notes ?? ''); }, [prefs]);
  const save = async () => {
    setBusy(true);
    try {
      await docPreferences.save({
        type: m.type, terms, notes,
        settings: { allowEditAfterSending: allowEdit, ...(m.type === 'estimate' ? { onQuoteAccepted: onAccept } : {}) },
      });
      toast.success(`${m.title} preferences saved`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-5 text-[13px]" data-slot="module-preferences">
      <Card className="space-y-4 p-5">
        <h2 className="text-[15px] font-medium">General</h2>
        {m.type !== 'challan' && (
          <label className="flex items-center gap-2" data-slot="pref-allow-edit">
            <Checkbox checked={allowEdit} onCheckedChange={(v) => setAllowEdit(v === true)} disabled={!canEdit} /> {m.edit}
          </label>
        )}
        {m.type === 'estimate' && (
          <div className="space-y-2" data-slot="pref-on-accept">
            <p className="text-muted-foreground">When a customer accepts a quote</p>
            {ON_ACCEPT.map((o) => (
              <label key={o.value} className="flex items-center gap-2">
                <input type="radio" name="on-accept" value={o.value} checked={onAccept === o.value} onChange={() => setOnAccept(o.value)} disabled={!canEdit} /> {o.label}
              </label>
            ))}
          </div>
        )}
        <p className="text-muted-foreground">
          The {m.noun}&apos;s number series (prefix and next number) is in{' '}
          <Link href="/settings?tab=numbering" className="text-link hover:underline">Transaction Number Series</Link>.
        </p>
      </Card>
      <Card className="space-y-2 p-5">
        <h2 className="text-[15px] font-medium">Terms &amp; Conditions</h2>
        <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} disabled={!canEdit} data-slot="pref-terms"
          placeholder={`Printed on every new ${m.noun}; it can be changed on each one.`} />
      </Card>
      <Card className="space-y-2 p-5">
        <h2 className="text-[15px] font-medium">Customer Notes</h2>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} disabled={!canEdit} data-slot="pref-notes"
          placeholder={`Shown on every new ${m.noun}; it can be changed on each one.`} />
      </Card>
      {canEdit && <Button onClick={() => void save()} disabled={busy} data-slot="pref-save">{busy ? 'Saving…' : 'Save'}</Button>}
    </div>
  );
}
