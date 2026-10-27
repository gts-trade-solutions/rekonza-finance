'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Connecting invoices to the government portal, as a checklist.
//
// Five steps, and the order is real: nothing can log in without the server's
// keys, no API user can be created for a registration with a wrong GSTIN, and
// a login that has never been tested is not a connection. Each step says what
// is missing in words, and the one to do next is marked — so the path from
// "stand-in" to a real IRN is visible on the screen where the IRNs are.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, PlugZap, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { BranchPortalReadiness, PortalReadiness, PortalReadinessStep } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const STEPS: Record<PortalReadinessStep['key'], { title: string; why: string }> = {
  server: {
    title: 'Portal keys on the server',
    why: 'The client ID, client secret and public key issued when you register for e-invoice API access.',
  },
  details: {
    title: 'Registration details',
    why: 'GSTIN, city and PIN code, exactly as on the GST registration certificate.',
  },
  credentials: {
    title: 'API user for this GSTIN',
    why: 'A username and password created on the e-invoice portal for this GSTIN — not your GST login.',
  },
  login: {
    title: 'Login tested',
    why: 'Proves the keys and the API user work together before a real invoice depends on them.',
  },
  first_irn: {
    title: 'First invoice registered',
    why: 'An IRN and QR code issued by the portal, not the stand-in.',
  },
};

const ENVIRONMENT = {
  'stand-in': { label: 'Stand-in — nothing filed', tone: 'text-muted-foreground' },
  sandbox: { label: 'Sandbox — test data, nothing filed', tone: 'border-sky-500/40 text-sky-700 dark:text-sky-300' },
  production: { label: 'Production — files with the portal', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' },
} as const;

const doneCount = (b: BranchPortalReadiness) => b.steps.filter((s) => s.done).length;

export function PortalSetupCard({ portal }: { portal: PortalReadiness }) {
  const [branchId, setBranchId] = useState(portal.branches[0]?.branchId ?? null);
  const [open, setOpen] = useState(!portal.connected);
  const branch = portal.branches.find((b) => b.branchId === branchId) ?? portal.branches[0];
  if (!branch) return null;

  const done = doneCount(branch);
  const next = branch.steps.findIndex((s) => !s.done);
  const complete = next === -1;

  return (
    <Card className="overflow-hidden p-0" data-slot="portal-setup">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-full',
            complete ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-primary/10 text-primary',
          )}
        >
          <PlugZap className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {complete ? 'Connected to the government portal' : 'Connect invoices to the government portal'}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {complete
              ? `${branch.name} registers invoices through the ${branch.providerLabel}.`
              : `${done} of 5 steps done for ${branch.name}. Until then, invoices get stand-in IRNs that start with DEMO.`}
          </span>
        </span>
        <Badge variant="outline" className={cn('hidden shrink-0 text-[10px] sm:inline-flex', ENVIRONMENT[branch.environment].tone)}>
          {ENVIRONMENT[branch.environment].label}
        </Badge>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-4 border-t px-4 py-4">
          {portal.branches.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Registration">
              {portal.branches.map((b) => (
                <button
                  key={b.branchId}
                  type="button"
                  role="radio"
                  aria-checked={b.branchId === branch.branchId}
                  onClick={() => setBranchId(b.branchId)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    b.branchId === branch.branchId ? 'border-primary bg-primary/5 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {b.name} · {doneCount(b)}/5
                </button>
              ))}
            </div>
          )}

          <ol className="space-y-3">
            {branch.steps.map((s, i) => {
              const isNext = i === next;
              return (
                <li key={s.key} className="flex gap-3" data-slot="portal-step" data-step={s.key} data-done={s.done}>
                  <span className="mt-0.5 shrink-0">
                    {s.done ? (
                      <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="Done" />
                    ) : (
                      <Circle className={cn('size-4', isNext ? 'text-primary' : 'text-muted-foreground/60')} aria-label="Not done" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm', s.done ? 'text-muted-foreground' : 'font-medium')}>
                      {i + 1}. {STEPS[s.key].title}
                      {isNext && (
                        <Badge variant="outline" className="ml-2 border-primary/40 align-middle text-[10px] text-primary">
                          Next
                        </Badge>
                      )}
                    </p>
                    {!s.done && (
                      <>
                        <p className="mt-0.5 text-xs text-muted-foreground">{STEPS[s.key].why}</p>
                        {isNext && s.todo.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5">
                            {s.todo.map((t) => (
                              <li key={t} className="text-xs text-amber-700 dark:text-amber-300">
                                {t}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button size="sm" variant={complete ? 'outline' : 'default'} asChild>
              <Link href="/settings?tab=integrations">
                <Settings2 className="size-3.5" /> Settings → Integrations
              </Link>
            </Button>
            <p className="text-xs text-muted-foreground">
              Test first on NIC&apos;s sandbox — real calls, test data, nothing filed. Production filing needs access through
              a GST Suvidha Provider.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
