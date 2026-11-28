import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Stock and cash below nothing, said on the statements themselves.
//
// The independent check (2026-11-28): overselling left a closing stock of
// −₹75,240 in the profit and loss and the balance sheet, and Cash in Hand at
// −₹11,098, with nothing on either statement to say so. Neither can be true of
// a real business — stock on the shelf and cash in the till are never less
// than nothing (AS 2 / Ind AS 2 values stock that exists; a negative cash
// balance means a receipt or a withdrawal was never recorded) — so a negative
// figure is an error in the books, and the statements must not carry it as if
// it were a fact (Companies Act, 2013, s.129: statements that give a true and
// fair view). The documents stay as they are, and the figures are not quietly
// set to nil, which would hide the error in another place: the statements show
// each item and cash account below zero, by name and amount, with where to put
// it right. New documents that would cause it are warned about or refused as
// they are saved (services/guards.ts, Settings → Policies).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { stockPosition } from './stock';

export interface BelowZero {
  asOf: string;
  stock: { itemId: string; name: string; qty: number; uqc: string; valuePaise: Paise }[];
  stockValuePaise: Paise;
  cash: { bankAccountId: string; name: string; balancePaise: Paise }[];
}

export async function belowZero(ex: Executor, orgId: number, asOf: string, branchId?: number): Promise<BelowZero> {
  const pos = await stockPosition(ex, orgId, asOf, { branchId, includeArchived: true });
  const stock = pos.lines.filter((l) => l.qty < -1e-9)
    .map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, uqc: l.uqc, valuePaise: l.valuePaise }));
  const { rows } = await sql<{ id: number; name: string; v: string | null }>`
    SELECT b.id, b.name, (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl
                           WHERE jl.org_id = b.org_id AND jl.account_id = b.ledger_account_id AND jl.entry_date <= ${asOf}
                           ${branchId ? sql`AND jl.entry_id IN (SELECT e.id FROM journal_entries e WHERE e.org_id = b.org_id AND e.branch_id = ${branchId})` : sql``}) AS v
      FROM bank_accounts b
     WHERE b.org_id = ${orgId} AND b.kind = 'cash'
  `.execute(ex);
  const cash = rows.map((r) => ({ bankAccountId: String(r.id), name: r.name, balancePaise: toPaiseFromSql(r.v ?? '0') }))
    .filter((c) => c.balancePaise < 0);
  return { asOf, stock, stockValuePaise: stock.reduce((t, s) => t + s.valuePaise, 0), cash };
}
