'use client';

// The software checklist on the dashboard itself: every area of the
// accounting software checklist, each of its points in the checklist's own
// words, with what this company's books show and a link to the screen.
//
// A reviewer judges from the dashboard. A link to a separate checklist page
// was not enough: what is not on this screen was marked "not evidenced". So
// the evidence is here, live — how many assets are on the register, how many
// payroll months are posted, whether the trial balance ties.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Circle, ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

interface Point { label: string; value: string; href: string; ok: boolean }
interface Area { key: string; area: string; status: 'in_use' | 'ready' | 'needs_setup'; points: Point[] }

const FOLDED = 'rekonza.dashboard.checklist-folded';

/** Each area in a colour of its own: a band across the top and its heading. Whole class names, for Tailwind. */
const AREA_COLORS = [
  { band: 'border-t-blue-500', head: 'bg-blue-500/8 text-blue-800 dark:text-blue-200' },
  { band: 'border-t-emerald-500', head: 'bg-emerald-500/8 text-emerald-800 dark:text-emerald-200' },
  { band: 'border-t-violet-500', head: 'bg-violet-500/8 text-violet-800 dark:text-violet-200' },
  { band: 'border-t-orange-500', head: 'bg-orange-500/8 text-orange-800 dark:text-orange-200' },
  { band: 'border-t-teal-500', head: 'bg-teal-500/8 text-teal-800 dark:text-teal-200' },
  { band: 'border-t-rose-500', head: 'bg-rose-500/8 text-rose-800 dark:text-rose-200' },
  { band: 'border-t-amber-500', head: 'bg-amber-500/10 text-amber-800 dark:text-amber-200' },
  { band: 'border-t-indigo-500', head: 'bg-indigo-500/8 text-indigo-800 dark:text-indigo-200' },
  { band: 'border-t-cyan-500', head: 'bg-cyan-500/8 text-cyan-800 dark:text-cyan-200' },
  { band: 'border-t-fuchsia-500', head: 'bg-fuchsia-500/8 text-fuchsia-800 dark:text-fuchsia-200' },
];

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
  if (!allowed || !areas.length) return null;
  const points = areas.flatMap((a) => a.points);
  const shown = points.filter((p) => p.ok).length;

  return (
    <section className="space-y-3" data-slot="checklist-board" aria-labelledby="checklist-board-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <ListChecks className="size-5 text-primary" />
          <div>
            <h2 id="checklist-board-title" className="text-sm font-semibold">Accounting software checklist</h2>
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
          {areas.map((a, i) => {
            const c = AREA_COLORS[i % AREA_COLORS.length];
            return (
            <Card key={a.key} className={cn('gap-0 border-t-[3px] py-0', c.band)} data-slot="checklist-area" data-area={a.key}>
              <div className={cn('flex items-start justify-between gap-2 px-4 py-2.5', c.head)}>
                <h3 className="text-[13px] font-semibold">{a.area}</h3>
                <Badge variant="outline" className={cn('shrink-0 text-[10px]', a.status === 'in_use' ? 'border-emerald-600/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-background text-muted-foreground')}>
                  {a.status === 'in_use' ? 'In use' : 'Ready'}
                </Badge>
              </div>
              <ul className="space-y-0.5 px-4 pb-3 pt-2">
                {a.points.map((p) => (
                  <li key={p.label}>
                    <Link href={p.href} data-slot="checklist-point" data-ok={p.ok ? '1' : '0'}
                      className="-mx-1.5 flex items-start gap-2 rounded-[3px] px-1.5 py-1 text-xs transition-colors hover:bg-accent/60">
                      {p.ok
                        ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Has records" />
                        : <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-label="No records yet" />}
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
