'use client';

// One journal entry with its balance proof — the "show me what this did to my
// books" view used on every document detail screen.
//
// Takes either an entry that has already been fetched, or an id to fetch. The
// second form exists because a list screen usually has the entry in hand and a
// modal opened from a table usually does not.

import { Money } from '@/components/shared/money';
import { journal, type JournalEntryRow, type JournalResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

export function JournalEntryTable({ entry }: { entry: JournalEntryRow }) {
  const totalDr = entry.lines.reduce((t, l) => t + l.debitPaise, 0);
  const totalCr = entry.lines.reduce((t, l) => t + l.creditPaise, 0);
  const balanced = totalDr === totalCr;

  return (
    <div className="overflow-x-auto rounded-lg border thin-scroll">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-semibold">Account</th>
            <th className="px-3 py-2 text-left font-semibold">Narration</th>
            <th className="px-3 py-2 text-right font-semibold">Debit</th>
            <th className="px-3 py-2 text-right font-semibold">Credit</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l) => (
            <tr key={l.lineNo} className="border-b last:border-0">
              <td className="px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span>{' '}
                <span className="font-medium">{l.accountName}</span>
                {l.contactName && (
                  <span className="ml-1 text-xs text-muted-foreground">· {l.contactName}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{l.description ?? '—'}</td>
              <td className="px-3 py-2 text-right">
                {l.debitPaise > 0 ? <Money value={l.debitPaise} /> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {l.creditPaise > 0 ? <Money value={l.creditPaise} /> : <span className="text-muted-foreground">—</span>}
              </td>
            </tr>
          ))}
          <tr className="bg-muted/40 font-semibold">
            <td className="px-3 py-2" colSpan={2}>
              JE #{entry.entryNo} · {new Date(entry.date).toLocaleDateString('en-IN')}
            </td>
            <td className="px-3 py-2 text-right"><Money value={totalDr} /></td>
            <td className="px-3 py-2 text-right"><Money value={totalCr} /></td>
          </tr>
        </tbody>
      </table>
      <div
        className={
          'flex items-center gap-2 border-t px-3 py-2 text-xs ' +
          (balanced ? 'bg-emerald-500/5' : 'bg-destructive/5')
        }
      >
        <span className={'size-1.5 rounded-full ' + (balanced ? 'bg-emerald-500' : 'bg-destructive')} />
        <span className="text-muted-foreground">
          {balanced
            ? 'Balanced — debits equal credits to the paisa.'
            : 'This entry does not balance. That should be impossible — report it.'}
        </span>
      </div>
    </div>
  );
}

export function JournalTable({ entryId }: { entryId: string }) {
  const state = useApi<JournalResponse>(() => journal.list({ entryId, limit: 1 }), [entryId]);
  const entry = state.data?.entries[0];

  if (state.loading) {
    return <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.error || !entry) {
    return (
      <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
        {state.error ?? 'That entry could not be found.'}
      </div>
    );
  }
  return <JournalEntryTable entry={entry} />;
}
