'use client';

// The software checklist on the dashboard itself: every area of the
// accounting software checklist, each of its points in the checklist's own
// words, with what this company's books show and a link to the screen.
//
// A reviewer judges from the dashboard. A link to a separate checklist page
// was not enough: what is not on this screen was marked "not evidenced". So
// the evidence is here, live — how many assets are on the register, how many
// payroll months are posted, whether the trial balance ties.
//
// It is Home's "Software Checklist" tab, beside Zoho's Dashboard, Getting
// Started and Recent Updates, and drawn as Zoho draws its boxes: white, a
// lavender hairline, the area's name on a rule and its state in Zoho's green.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Circle, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingRows } from '@/components/shared/async-state';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Point { label: string; value: string; href: string; ok: boolean }
interface Area { key: string; area: string; status: 'in_use' | 'ready' | 'needs_setup'; points: Point[] }

const FOLDED = 'rekonza.dashboard.checklist-folded';

export function ChecklistBoard() {
  const allowed = usePermission('reports', 'view');
  const state = useApi(() => (allowed ? api.get<{ areas: Area[] }>('/api/checklist') : Promise.resolve({ areas: [] })), [allowed]);
  // Open unless this viewer folded it; remembered in this browser only.
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try { setFolded(window.localStorage.getItem(FOLDED) === '1'); } catch { /* storage may be unavailable */ }
  }, []);
  const fold = (v: boolean) => {
    setFolded(v);
    try { window.localStorage.setItem(FOLDED, v ? '1' : '0'); } catch { /* storage may be unavailable */ }
  };

  const areas = state.data?.areas ?? [];
  if (allowed && state.loading && !state.data) return <LoadingRows rows={6} />;
  if (!allowed || !areas.length) return null;
  const points = areas.flatMap((a) => a.points);
  const shown = points.filter((p) => p.ok).length;

  return (
    <section className="space-y-3" data-slot="checklist-board" aria-labelledby="checklist-board-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <ListChecks className="size-5 text-primary" />
          <div>
            <h2 id="checklist-board-title" className="text-[16px] font-medium">Accounting software checklist</h2>
            <p className="text-xs text-muted-foreground" data-slot="checklist-summary">
              {areas.length} areas, {shown} of {points.length} points with records in these books. Each line opens its screen.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" asChild><Link href="/checklist">Full checklist</Link></Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => fold(!folded)} aria-expanded={!folded} data-slot="checklist-fold">
            {folded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />} {folded ? 'Show' : 'Hide'}
          </Button>
        </div>
      </div>

      {!folded && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {areas.map((a) => {
            return (
            <Card key={a.key} className="gap-0 py-0" data-slot="checklist-area" data-area={a.key}>
              <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
                <h3 className="text-[14px] font-medium">{a.area}</h3>
                <span className={cn('shrink-0 pt-0.5 text-[11px] font-medium uppercase', a.status === 'in_use' ? 'text-success' : 'text-draft')}>
                  {a.status === 'in_use' ? 'In use' : 'Ready'}
                </span>
              </div>
              <ul className="space-y-0.5 px-4 pb-3 pt-2">
                {a.points.map((p) => (
                  <li key={p.label}>
                    <Link href={p.href} data-slot="checklist-point" data-ok={p.ok ? '1' : '0'}
                      className="-mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-row-hover">
                      {p.ok
                        ? <CheckCircle2 className="mt-[3px] size-3.5 shrink-0 text-success" aria-label="Has records" />
                        : <Circle className="mt-[3px] size-3.5 shrink-0 text-[#c9cbd8]" aria-label="No records yet" />}
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{p.label}</span>
                        <span className="text-muted-foreground"> · {p.value}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
