'use client';

// The dashboard's door to the software checklist: every area of the
// checklist, how many are in use in this company, and a link to the evidence.
// The dashboard shows money; this says what else is in the books behind it.

import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

export function ChecklistCard() {
  const allowed = usePermission('reports', 'view');
  const state = useApi(() => (allowed ? api.get<{ areas: { area: string; status: string }[] }>('/api/checklist') : Promise.resolve({ areas: [] })), [allowed]);
  const areas = state.data?.areas ?? [];
  if (!allowed || !areas.length) return null;
  const inUse = areas.filter((a) => a.status === 'in_use').length;
  return (
    <Link href="/checklist" data-slot="checklist-card">
      <Card className="flex items-center gap-3 p-3.5 transition-colors hover:bg-accent/40">
        <ListChecks className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Software checklist: {areas.length} areas, {inUse} in use in this company</p>
          <p className="truncate text-xs text-muted-foreground">{areas.map((a) => a.area).join(' · ')}</p>
        </div>
        <span className="hidden text-xs text-primary sm:inline">See the evidence</span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </Card>
    </Link>
  );
}
