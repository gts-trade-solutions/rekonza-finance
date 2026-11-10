'use client';

// What an import did, or would do: one line per part (customers, accounts,
// vouchers…), every row that failed, and the notes worth reading. Shared by
// Settings → Import and Tally → Import.

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { ImportOutcome, ImportResponse } from '@/lib/api/client';

export const PART_LABEL: Record<string, string> = {
  contacts: 'Customers and vendors', items: 'Items', accounts: 'Accounts', 'opening-ledger': 'Ledger openings',
  'opening-bills': 'Unpaid bills', journals: 'Journal vouchers', invoices: 'Invoices', bills: 'Bills',
  estimates: 'Quotes', 'sales-orders': 'Sales orders', 'credit-notes': 'Credit notes', 'purchase-orders': 'Purchase orders',
  expenses: 'Expenses', 'payments-received': 'Payments received', 'payments-made': 'Payments made',
};

export function Outcomes({ result }: { result: ImportResponse }) {
  const failed = result.outcomes.reduce((t, o) => t + o.errors.length, 0);
  return (
    <Card className={`space-y-3 p-5 ${failed ? 'border-destructive/40' : 'border-emerald-500/40'}`}>
      <p className="flex items-center gap-2 text-sm font-medium">
        {failed ? <AlertTriangle className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
        {result.committed
          ? 'Imported.'
          : failed ? `${failed} problem(s) to fix. Nothing was imported.` : 'The check passed. Nothing has been imported yet.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {result.outcomes.filter((o) => o.rows > 0).map((o, i) => (
          <div key={`${o.kind}-${i}`} className="rounded-md border p-3 text-sm">
            <p className="font-medium">{o.label ?? PART_LABEL[o.kind] ?? o.kind}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {o.created} {result.committed ? 'added' : 'to add'}{o.skipped ? `, ${o.skipped} already there` : ''}
            </p>
          </div>
        ))}
      </div>
      <ErrorList outcomes={result.outcomes} />
      {result.outcomes.some((o) => o.notes.length > 0) && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {result.outcomes.flatMap((o) => o.notes).map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </Card>
  );
}

function ErrorList({ outcomes }: { outcomes: ImportOutcome[] }) {
  const errors = outcomes.flatMap((o) => o.errors.map((e) => ({ ...e, kind: o.kind })));
  if (!errors.length) return null;
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border thin-scroll">
      <table className="w-full text-sm">
        <tbody>
          {errors.slice(0, 500).map((e, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="w-20 px-3 py-1.5 text-xs text-muted-foreground">{e.row ? `Row ${e.row}` : PART_LABEL[e.kind] ?? e.kind}</td>
              <td className="px-3 py-1.5 text-xs">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
