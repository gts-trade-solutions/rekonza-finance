'use client';

// Journal templates — manual journals kept to be used again, as Zoho Books
// keeps them: the rent accrual, the salary provision. Use one and the journal
// form opens filled; nothing posts until the entry is saved there. New ones
// are saved from the journal form itself ("Save as template"); here each one
// can be edited (its name, narration, accounts and amounts) or deleted, with
// the buttons on the card. A template posts nothing, so neither touches the
// ledger: entries already made from it stay as they are.

import Link from 'next/link';
import { useState } from 'react';
import { LayoutTemplate, Play, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { RowActions } from '@/components/shared/row-actions';
import { accounts as accountsApi, api, type AccountRow, type JournalTemplateRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface DraftLine { key: string; accountId: string; debit: number; credit: number; description: string; contactId: string | null; costCentreId: string | null }

export default function JournalTemplatesPage() {
  const canCreate = usePermission('accountant', 'create');
  const state = useApi(() => api.get<{ templates: JournalTemplateRow[] }>('/api/journal-templates'), []);
  const [editing, setEditing] = useState<JournalTemplateRow | null>(null);

  return (
    <>
      <PageHeader
        title="Journal templates"
        description="Manual journals kept to be used again. Use one to open the journal form filled in; save new ones from the journal form."
        actions={<Button size="sm" variant="outline" asChild><Link href="/accountant/journals">Manual journals</Link></Button>}
      />
      <AsyncPage state={state}>
        {(d) => d.templates.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {d.templates.map((t) => (
              <Card key={t.id} className="space-y-3 p-4" data-slot="journal-template">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name}</p>
                    {t.memo && <p className="truncate text-xs text-muted-foreground">{t.memo}</p>}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">{t.withAmounts ? 'With amounts' : 'Accounts only'}</Badge>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {t.lines.map((l, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1 pr-2"><span className="font-mono text-muted-foreground">{l.accountCode}</span> {l.accountName}{l.description ? <span className="text-muted-foreground"> · {l.description}</span> : null}</td>
                        <td className="py-1 text-right tabular-nums">{l.debitPaise ? <Money value={l.debitPaise} /> : ''}</td>
                        <td className="py-1 pl-2 text-right tabular-nums">{l.creditPaise ? <Money value={l.creditPaise} /> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">{t.createdBy ? `By ${t.createdBy} · ` : ''}changed {new Date(t.updatedAt).toLocaleDateString('en-IN')}</p>
                  {canCreate && (
                    <RowActions
                      label={`template ${t.name}`}
                      onEdit={() => setEditing(t)}
                      onDelete={async () => { await api.post('/api/journal-templates', { action: 'delete', id: t.id }); state.refetch(); }}
                      done={`Template ${t.name} deleted`}
                      deleteTitle={`Delete the template ${t.name}?`}
                      deleteDescription="Only the template goes. Entries already posted from it stay in the ledger as they are."
                      withReasonField={false}
                      extra={<Button size="xs" asChild className="gap-1"><Link href={`/accountant/journals?template=${t.id}`}><Play className="size-3" /> Use</Link></Button>}
                    />
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState icon={LayoutTemplate} title="No journal templates yet" description="Open New journal, fill in an entry you make often, and choose Save as template." />
        )}
      </AsyncPage>
      {editing && <TemplateDialog template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); state.refetch(); }} />}
    </>
  );
}

/** Edit a template: its name, narration, and lines (with or without amounts). */
function TemplateDialog({ template, onClose, onSaved }: { template: JournalTemplateRow; onClose: () => void; onSaved: () => void }) {
  const chart = useApi<{ accounts: AccountRow[] }>(() => accountsApi.list(), []);
  const [name, setName] = useState(template.name);
  const [memo, setMemo] = useState(template.memo ?? '');
  const [withAmounts, setWithAmounts] = useState(template.withAmounts);
  const [lines, setLines] = useState<DraftLine[]>(template.lines.map((l, i) => ({
    key: `l${i}`, accountId: l.accountId, debit: l.debitPaise, credit: l.creditPaise, description: l.description ?? '', contactId: l.contactId, costCentreId: l.costCentreId,
  })));
  const [busy, setBusy] = useState(false);
  const options = (chart.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name, sublabel: `${a.code} · ${a.type}` }));
  const dr = lines.reduce((t, l) => t + l.debit, 0);
  const cr = lines.reduce((t, l) => t + l.credit, 0);
  const set = (key: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    const filled = lines.filter((l) => l.accountId);
    if (!name.trim()) { toast.error('Give the template a name.'); return; }
    if (filled.length < 2) { toast.error('A template needs at least two lines.'); return; }
    if (withAmounts && (dr === 0 || dr !== cr)) { toast.error('With amounts, the debits must equal the credits. Or keep it to accounts only.'); return; }
    setBusy(true);
    try {
      await api.post('/api/journal-templates', {
        action: 'save', id: template.id, name: name.trim(), memo: memo.trim() || null, withAmounts,
        lines: filled.map((l) => ({
          accountId: l.accountId, debitPaise: withAmounts ? l.debit : 0, creditPaise: withAmounts ? l.credit : 0,
          description: l.description.trim() || null, contactId: l.contactId, costCentreId: l.costCentreId,
        })),
      });
      toast.success(`Template ${name.trim()} saved`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-3xl" data-slot="template-edit">
        <DialogHeader>
          <DialogTitle>Edit template</DialogTitle>
          <DialogDescription>What the journal form is filled with when the template is used. Nothing posts from here.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></Field>
          <Field label="Narration"><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withAmounts} onChange={(e) => setWithAmounts(e.target.checked)} /> Keep the amounts (otherwise only the accounts are filled in)</label>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border thin-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-[11px] uppercase text-muted-foreground">
                <th className="px-2 py-2 font-semibold">Account</th>
                <th className="px-2 py-2 font-semibold">Description</th>
                {withAmounts && <th className="w-32 px-2 py-2 text-right font-semibold">Debit</th>}
                {withAmounts && <th className="w-32 px-2 py-2 text-right font-semibold">Credit</th>}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="border-b last:border-0">
                  <td className="min-w-[200px] px-2 py-1.5">
                    <Combobox options={options} value={l.accountId} onChange={(v) => set(l.key, { accountId: v })} placeholder="Select account" searchPlaceholder="Search accounts" showAvatar={false} />
                  </td>
                  <td className="px-2 py-1.5"><Input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} className="h-8" /></td>
                  {withAmounts && <td className="px-2 py-1.5"><MoneyInput valuePaise={l.debit} onChangePaise={(p) => set(l.key, { debit: p, credit: p ? 0 : l.credit })} className="h-8" /></td>}
                  {withAmounts && <td className="px-2 py-1.5"><MoneyInput valuePaise={l.credit} onChangePaise={(p) => set(l.key, { credit: p, debit: p ? 0 : l.debit })} className="h-8" /></td>}
                  <td className="px-1">
                    <Button size="icon-xs" variant="ghost" aria-label="Remove line" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
            {withAmounts && (
              <tfoot>
                <tr className="border-t bg-muted/30 text-xs font-medium">
                  <td className="px-2 py-1.5" colSpan={2}>{dr === cr ? 'Balanced' : 'Debits and credits differ'}</td>
                  <td className="px-2 py-1.5 text-right"><Money value={dr} /></td>
                  <td className="px-2 py-1.5 text-right"><Money value={cr} /></td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <Button size="sm" variant="outline" className="w-fit gap-1" disabled={lines.length >= 50}
          onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, accountId: '', debit: 0, credit: 0, description: '', contactId: null, costCentreId: null }])}>
          <Plus className="size-3.5" /> Add a line
        </Button>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="template-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
