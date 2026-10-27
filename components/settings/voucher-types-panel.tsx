'use client';

// Voucher types: named kinds of a document — export invoices, service credit
// notes, job-work challans — each numbered in its own series, picked when the
// document is raised.

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

type DocType = 'INV' | 'CN' | 'DC' | 'EST' | 'SO' | 'PO';
const DOC_LABEL: Record<DocType, string> = { INV: 'Invoice', CN: 'Credit note', DC: 'Delivery challan', EST: 'Quote', SO: 'Sales order', PO: 'Purchase order' };
interface VoucherType {
  id: string; docType: DocType; code: string; name: string; prefix: string; isActive: boolean;
  printHeading: string | null; printTerms: string | null; printShowUpi: boolean; printShowBank: boolean; restricted: boolean;
}

export function VoucherTypesPanel({ canEdit }: { canEdit: boolean }) {
  const state = useApi<{ types: VoucherType[] }>(() => api.get('/api/voucher-types'), []);
  const [f, setF] = useState({ docType: 'INV' as DocType, name: '', code: '', prefix: '' });
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<VoucherType | null>(null);
  const save = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post('/api/voucher-types', payload);
      toast.success(done);
      setF({ docType: f.docType, name: '', code: '', prefix: '' });
      await state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mt-4 space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">Voucher types</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Kinds of document with their own number series, such as export invoices numbered EXP/26-27/0001. Each series
          runs per registration and year like the ordinary one; GST allows several, each unique.
        </p>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={2} />}>
        {(d) => (
          <ul className="divide-y rounded-md border text-sm">
            {d.types.length === 0 && <li className="px-3 py-2 text-muted-foreground">None yet: every document is in its ordinary series.</li>}
            {d.types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Badge variant="secondary" className="text-[10px]">{DOC_LABEL[t.docType] ?? t.docType}</Badge>
                <span className="font-medium">{t.name}</span>
                <Badge variant="outline" className="font-mono text-[10px]">{t.prefix}/yy-yy/0001</Badge>
                {t.printHeading && <span className="text-xs text-muted-foreground">prints “{t.printHeading}”</span>}
                {canEdit && (
                  <div className="ml-auto flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Only admins, and roles given it under Users → Roles, may raise it">
                      Restricted <Switch checked={t.restricted} onCheckedChange={(v) => void save({ ...t, restricted: v }, v ? `${t.name} restricted: give it to roles under Users → Roles` : `${t.name} open to everyone who can raise its kind`)} />
                    </label>
                    <Button size="xs" variant="ghost" onClick={() => setPrinting(printing?.id === t.id ? null : t)}>Print format</Button>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      In use <Switch checked={t.isActive} onCheckedChange={(v) => void save({ ...t, isActive: v }, v ? `${t.name} back in use` : `${t.name} retired`)} />
                    </label>
                  </div>
                )}
                {printing?.id === t.id && (
                  <div className="grid w-full basis-full gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                    <Field label="Heading" hint="Printed under the statutory title, which stays as the law has it">
                      <Input value={printing.printHeading ?? ''} onChange={(e) => setPrinting({ ...printing, printHeading: e.target.value })} placeholder="Export invoice" />
                    </Field>
                    <div className="space-y-2 pt-5 text-sm">
                      <label className="flex items-center gap-2"><Switch checked={printing.printShowUpi} onCheckedChange={(v) => setPrinting({ ...printing, printShowUpi: v })} /> Print the UPI code</label>
                      <label className="flex items-center gap-2"><Switch checked={printing.printShowBank} onCheckedChange={(v) => setPrinting({ ...printing, printShowBank: v })} /> Print the bank details</label>
                    </div>
                    <Field label="Terms" hint="Used when the document has none of its own" className="sm:col-span-2">
                      <textarea value={printing.printTerms ?? ''} onChange={(e) => setPrinting({ ...printing, printTerms: e.target.value })} rows={3}
                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring" />
                    </Field>
                    <Button size="sm" className="w-fit" disabled={busy}
                      onClick={() => void save({ ...printing }, `${t.name}'s print format saved`).then(() => setPrinting(null))}>
                      Save print format
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncPage>
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[150px_1fr_110px_110px_auto] sm:items-end">
          <Field label="For">
            <div>
              <select value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value as DocType })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {(Object.keys(DOC_LABEL) as DocType[]).map((k) => <option key={k} value={k}>{DOC_LABEL[k]}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Export invoice" /></Field>
          <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().slice(0, 10) })} placeholder="EXP" className="font-mono" /></Field>
          <Field label="Prefix"><Input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase().slice(0, 5) })} placeholder="EXP" className="font-mono" /></Field>
          <Button size="sm" className="gap-1.5 justify-self-start" disabled={busy || !f.name || !f.code || !f.prefix}
            onClick={() => void save({ ...f }, `${f.name} added`)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
          </Button>
        </div>
      )}
    </Card>
  );
}
