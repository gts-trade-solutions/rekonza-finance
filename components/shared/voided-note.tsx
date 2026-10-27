'use client';

import { Ban } from 'lucide-react';
import { Card } from '@/components/ui/card';

/** Who cancelled a document, when, and why. Older voids carry no reason. */
export function VoidedNote({ voided, what }: { voided: { at: string | null; reason: string | null; by: string | null } | null; what: string }) {
  if (!voided) return null;
  const at = voided.at
    ? new Date(voided.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-4" data-slot="voided-note">
      <Ban className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
      <div className="text-sm">
        <p className="font-medium">
          This {what} was cancelled{voided.by ? ` by ${voided.by}` : ''}{at ? ` on ${at}` : ''}.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {voided.reason ? <>Reason: {voided.reason}</> : 'Cancelled before reasons were recorded.'} Its entry was reversed; the number stays in the series.
        </p>
      </div>
    </Card>
  );
}
