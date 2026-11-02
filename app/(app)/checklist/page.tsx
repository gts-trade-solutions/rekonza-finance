'use client';

// The accounting software checklist, area by area: where each requirement
// lives in the app, and what this company's own records show about it
// (lib/server/services/checklist.ts). For a reviewer, an auditor or a client
// asking "is this in the software?" — the answer is the live data.

import Link from 'next/link';
import { CheckCircle2, CircleDashed, ExternalLink, Plug, Printer } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { printPage } from '@/lib/output-guard';

interface Area {
  key: string; area: string; status: 'in_use' | 'ready' | 'needs_setup';
  evidence: string[]; screens: { label: string; href: string }[]; outside: string[];
}

const BADGE: Record<Area['status'], { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  in_use: { label: 'In use', cls: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300', Icon: CheckCircle2 },
  ready: { label: 'Built, not used yet', cls: 'text-muted-foreground', Icon: CircleDashed },
  needs_setup: { label: 'Part depends on an outside service', cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300', Icon: Plug },
};

export default function ChecklistPage() {
  const state = useApi(() => api.get<{ areas: Area[] }>('/api/checklist'), []);
  return (
    <>
      <PageHeader
        title="Software Checklist"
        description="Each area of the accounting software checklist: where it is in REKONZA, and what this company's own records show about it."
        actions={<Button size="sm" variant="outline" onClick={() => printPage()} className="gap-1.5 no-print"><Printer className="size-3.5" /> Print or PDF</Button>}
      />
      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {(['in_use', 'ready', 'needs_setup'] as const).map((s) => {
                const { label, Icon, cls } = BADGE[s];
                return (
                  <Card key={s} className="flex items-center gap-3 p-4">
                    <Icon className={`size-5 ${cls}`} />
                    <div><p className="text-2xl font-semibold">{s === 'needs_setup' ? d.areas.filter((a) => a.outside.length).length : d.areas.filter((a) => a.status === s).length}</p><p className="text-xs text-muted-foreground">{label}</p></div>
                  </Card>
                );
              })}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {d.areas.map((a) => {
                const b = BADGE[a.status];
                return (
                  <Card key={a.key} className="space-y-3 p-5 break-inside-avoid" data-slot={`checklist-${a.key}`}>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-semibold">{a.area}</h2>
                      <Badge variant="outline" className={`shrink-0 text-[10px] ${b.cls}`}>{b.label}</Badge>
                    </div>
                    <ul className="space-y-1.5 text-sm">
                      {a.evidence.map((e) => <li key={e} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /><span>{e}</span></li>)}
                    </ul>
                    {a.outside.map((o) => <p key={o} className="flex gap-2 text-xs text-amber-700 dark:text-amber-300"><Plug className="mt-0.5 size-3.5 shrink-0" />{o}</p>)}
                    <div className="flex flex-wrap gap-1.5 border-t pt-3 no-print">
                      {a.screens.map((s) => (
                        <Link key={s.href + s.label} href={s.href} className="inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-xs hover:bg-accent">
                          {s.label} <ExternalLink className="size-3" />
                        </Link>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </AsyncPage>
    </>
  );
}
