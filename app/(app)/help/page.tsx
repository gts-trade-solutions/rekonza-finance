'use client';

// The user manual: everyday tasks, screen by screen, searchable. The Tally
// topic carries the video on connecting TallyPrime.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { HELP } from '@/lib/help';
import { cn } from '@/lib/utils';

export default function HelpPage() {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(HELP[0].id);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP;
    return HELP.filter((t) => [t.title, t.summary, t.area, ...t.steps].join(' ').toLowerCase().includes(q));
  }, [query]);
  const topic = shown.find((t) => t.id === openId) ?? shown[0];
  const areas = [...new Set(shown.map((t) => t.area))];

  return (
    <>
      <PageHeader title="Help" description="How to do the everyday things, screen by screen." />
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit space-y-3 p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the manual" className="h-9 pl-8" />
          </div>
          {shown.length === 0 && <p className="px-2 py-4 text-center text-sm text-muted-foreground">Nothing matches.</p>}
          {areas.map((area) => (
            <div key={area}>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{area}</p>
              {shown.filter((t) => t.area === area).map((t) => (
                <button key={t.id} type="button" onClick={() => setOpenId(t.id)}
                  className={cn('block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent', topic?.id === t.id && 'bg-accent font-medium')}>
                  {t.title}
                </button>
              ))}
            </div>
          ))}
        </Card>

        <div className="space-y-4">
          {topic && (
            <Card className="space-y-3 p-5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{topic.area}</p>
              <h2 className="text-lg font-semibold">{topic.title}</h2>
              <p className="text-sm text-muted-foreground">{topic.summary}</p>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
                {topic.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
              {topic.links.length > 0 && (
                <div className="flex flex-wrap gap-3 border-t pt-3">
                  {topic.links.map((l) => (
                    <Link key={l.href + l.label} href={l.href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                      {l.label} <ArrowRight className="size-3.5" />
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}
          {topic?.id === 'tally' && <Card className="space-y-2 p-5">
            <h3 className="text-sm font-semibold">Video: connecting TallyPrime</h3>
            <video src="/rekonza-tutorial.mp4" controls preload="metadata" className="w-full rounded-md border bg-black" />
          </Card>}
        </div>
      </div>
    </>
  );
}
