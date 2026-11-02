'use client';

// Journal templates — manual journals kept to be used again, as Zoho Books
// keeps them: the rent accrual, the salary provision. Use one and the journal
// form opens filled; nothing posts until the entry is saved there. New ones
// are saved from the journal form itself ("Save as template").

import Link from 'next/link';
import { LayoutTemplate, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { api, type JournalTemplateRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

export default function JournalTemplatesPage() {
  const canCreate = usePermission('accountant', 'create');
  const state = useApi(() => api.get<{ templates: JournalTemplateRow[] }>('/api/journal-templates'), []);

  const remove = async (t: JournalTemplateRow) => {
    if (!window.confirm(`Delete the template ${t.name}? Entries already posted from it stay.`)) return;
    try {
      await api.post('/api/journal-templates', { action: 'delete', id: t.id });
      toast.success(`Template ${t.name} deleted`);
      state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

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
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">{t.createdBy ? `By ${t.createdBy} · ` : ''}changed {new Date(t.updatedAt).toLocaleDateString('en-IN')}</p>
                  {canCreate && (
                    <span className="flex gap-1.5">
                      <Button size="xs" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => remove(t)}><Trash2 className="size-3" /> Delete</Button>
                      <Button size="xs" asChild className="gap-1"><Link href={`/accountant/journals?template=${t.id}`}><Play className="size-3" /> Use</Link></Button>
                    </span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState icon={LayoutTemplate} title="No journal templates yet" description="Open New journal, fill in an entry you make often, and choose Save as template." />
        )}
      </AsyncPage>
    </>
  );
}
