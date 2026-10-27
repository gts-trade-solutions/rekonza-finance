'use client';

// The provision for doubtful debts, beside the receivables ageing it is
// worked out from: a rate for each age bucket, the provision that gives, and
// one entry to bring the books to it.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

interface Plan {
  asOf: string; rates: Record<string, number>;
  buckets: { bucket: string; owedPaise: number; ratePct: number; provisionPaise: number }[];
  targetPaise: number; currentPaise: number; changePaise: number;
}

export function DoubtfulDebtsCard({ asOf }: { asOf: string }) {
  const canPost = usePermission('accountant', 'create');
  const [rates, setRates] = useState<Record<string, number> | null>(null);
  const state = useApi(() => api.get<Plan>('/api/doubtful-debts', { asOf, rates: rates ? JSON.stringify(rates) : undefined }), [asOf, JSON.stringify(rates)]);
  const [busy, setBusy] = useState(false);
  const p = state.data;
  if (!p) return null;

  const post = async () => {
    setBusy(true);
    try {
      await api.post('/api/doubtful-debts', { asOf, rates: rates ?? p.rates });
      toast.success(`Provision set to ₹${(p.targetPaise / 100).toLocaleString('en-IN')} at ${asOf}`);
      void state.refetch();
    } catch (e) {
      toast.error('Not posted', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="no-print space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">Provision for doubtful debts</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          What is not expected to be collected, as a percentage of each age bucket. Posting raises or lowers the provision to
          this figure at the report date; it sits against receivables in the balance sheet. A debt known to be lost is
          written off from its invoice instead.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-6">
        {p.buckets.map((b) => (
          <div key={b.bucket} className="rounded-md border p-2 text-xs">
            <p className="font-medium">{b.bucket}</p>
            <p className="text-muted-foreground"><Money value={b.owedPaise} /></p>
            <div className="mt-1 flex items-center gap-1">
              <Input type="number" min={0} max={100} className="h-7 w-16 text-xs" value={(rates ?? p.rates)[b.bucket] ?? 0}
                onChange={(e) => setRates({ ...(rates ?? p.rates), [b.bucket]: Math.min(100, Math.max(0, Number(e.target.value))) })} />%
            </div>
            <p className="mt-1"><Money value={b.provisionPaise} /></p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>
          Provision should be <Money value={p.targetPaise} className="font-semibold" />; the books hold <Money value={p.currentPaise} />.
          {p.changePaise !== 0 && <> The entry would {p.changePaise > 0 ? 'raise' : 'release'} <Money value={Math.abs(p.changePaise)} />.</>}
        </span>
        {canPost && (
          <Button size="sm" onClick={() => void post()} disabled={busy || p.changePaise === 0}>
            {busy && <Loader2 className="size-4 animate-spin" />} Post provision
          </Button>
        )}
      </div>
    </Card>
  );
}
