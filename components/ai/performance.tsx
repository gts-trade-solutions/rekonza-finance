'use client';

// The assistant's speed and savings over the last thirty days: answers given
// again instantly from the cache, the typical wait, and how much of each
// prompt the model provider served from its own cache.

import { Gauge } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatCharge } from '@/lib/billing/catalog';

interface Performance {
  days: number;
  questions: number;
  answeredFromCache: number;
  averageSeconds: number | null;
  promptCachePct: number | null;
  creditsSavedMc: number;
  lookups: number;
  lookupsReused: number;
}

export function PerformanceButton() {
  const state = useApi<Performance>(() => api.get('/api/ai/performance'), []);
  const p = state.data;
  return (
    <Popover>
      <PopoverTrigger className="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-accent">
        <Gauge className="size-3.5" /> Speed &amp; savings
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-semibold">Speed &amp; savings</p>
          <p className="text-xs text-muted-foreground">The last {p?.days ?? 30} days in this company.</p>
        </div>
        {!p ? (
          <p className="text-xs text-muted-foreground">{state.error ?? 'Loading…'}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <Row label="Questions asked" value={p.questions.toLocaleString('en-IN')} />
            <Row label="Typical time to an answer" value={p.averageSeconds === null ? '—' : `${p.averageSeconds} s`} />
            <Row label="Answered instantly from the cache" value={`${p.answeredFromCache.toLocaleString('en-IN')}`} hint="The same first question, asked again while nothing in the books had changed: given at once, free." />
            <Row label="Credits saved by the cache" value={formatCharge(p.creditsSavedMc)} />
            <Row label="Prompt served from the provider's cache" value={p.promptCachePct === null ? '—' : `${p.promptCachePct}%`} hint="Charged by OpenAI at a fraction of the price." />
            <Row label="Lookups reused (since restart)" value={p.lookupsReused.toLocaleString('en-IN')} hint="Figures read for one answer and reused by the next, instead of being read again." />
          </dl>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="font-medium tabular">{value}</dd>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
