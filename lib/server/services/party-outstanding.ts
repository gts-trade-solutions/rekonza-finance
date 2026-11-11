import 'server-only';

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';

/**
 * Journals that reach a party's account with no invoice or bill behind them:
 * posted by hand, on a schedule, or brought across from Tally's vouchers. A
 * reversal carries its original's source, so a withdrawn journal nets to nil.
 */
export const PARTY_JOURNAL_SOURCES = ['manual', 'recurring', 'tally_import'] as const;

export interface BeyondDocuments {
  receivablePaise: Paise;
  payablePaise: Paise;
}

/**
 * What a party owes, or is owed, that their invoices and bills do not show:
 * unpaid opening bills from before the books started, and journals posted
 * straight to their account. Added to the documents' balances, a customer's
 * page and the customer list agree with the statement and the ageing, for a
 * company brought across from Tally as much as one that began here.
 *
 * Money received ahead of an invoice is not taken off: it stays a credit,
 * shown with the payments, as Zoho Books keeps it.
 */
export async function outstandingBeyondDocuments(
  ex: Executor,
  orgId: number,
  contactIds: number[],
): Promise<Map<number, BeyondDocuments>> {
  const out = new Map<number, BeyondDocuments>();
  if (!contactIds.length) return out;
  const of = (id: number) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { receivablePaise: 0, payablePaise: 0 }));
    return v;
  };

  const ids = sql.join(contactIds);
  const [openings, journals] = await Promise.all([
    sql<{ id: number; kind: 'receivable' | 'payable'; v: string }>`
      SELECT contact_id AS id, kind, COALESCE(SUM(amount - amount_paid), 0) AS v
        FROM opening_documents
       WHERE org_id = ${orgId} AND status <> 'void' AND contact_id IN (${ids})
       GROUP BY contact_id, kind`.execute(ex),
    sql<{ id: number; code: string; v: string }>`
      SELECT jl.contact_id AS id, a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
        FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
        JOIN journal_entries e ON e.id = jl.entry_id
       WHERE jl.org_id = ${orgId} AND a.code IN (${CODE.AR}, ${CODE.AP})
         AND jl.contact_id IN (${ids})
         AND e.source_type IN (${sql.join([...PARTY_JOURNAL_SOURCES])})
       GROUP BY jl.contact_id, a.code`.execute(ex),
  ]);

  for (const r of openings.rows) {
    const v = of(Number(r.id));
    if (r.kind === 'receivable') v.receivablePaise += toPaiseFromSql(r.v);
    else v.payablePaise += toPaiseFromSql(r.v);
  }
  for (const r of journals.rows) {
    const v = of(Number(r.id));
    // A debit on the receivable is owed to us; a credit on the payable, by us.
    if (r.code === CODE.AR) v.receivablePaise += toPaiseFromSql(r.v);
    else v.payablePaise -= toPaiseFromSql(r.v);
  }
  return out;
}
