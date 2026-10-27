import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Cost centres: what each department, project, vehicle or site earned and
// spent. The ledger carries them on income and expense lines (posting.ts);
// this is the master and the profit and loss by centre, with what was posted
// to no centre shown beside them so the columns add up to the whole P&L.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

export interface CostCentre { id: string; code: string; name: string; category: string | null; isActive: boolean }

export async function listCostCentres(ex: Executor, orgId: number): Promise<CostCentre[]> {
  const rows = await ex.selectFrom('cost_centres').selectAll().where('org_id', '=', orgId).orderBy('category').orderBy('code').execute();
  return rows.map((r) => ({ id: String(r.id), code: r.code, name: r.name, category: r.category, isActive: !!r.is_active }));
}

export async function saveCostCentre(
  trx: Trx, orgId: number, input: { id?: number | null; code: string; name: string; category?: string | null; isActive?: boolean },
) {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,20}$/.test(code)) throw badRequest('A code is up to twenty letters, digits or "-".');
  if (!input.name.trim()) throw badRequest('Name the cost centre.');
  const clash = await trx.selectFrom('cost_centres').select('id').where('org_id', '=', orgId).where('code', '=', code)
    .$if(!!input.id, (q) => q.where('id', '!=', input.id!)).executeTakeFirst();
  if (clash) throw conflict(`Another cost centre already has the code ${code}.`);
  const values = { code, name: input.name.trim(), category: input.category?.trim() || null, is_active: input.isActive === false ? 0 : 1 };
  if (input.id) {
    const r = await trx.updateTable('cost_centres').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That cost centre was not found.');
    return input.id;
  }
  return Number((await trx.insertInto('cost_centres').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

export interface CostCentreColumn {
  id: string | null; code: string; name: string; category: string | null;
  incomePaise: Paise; expensePaise: Paise; netPaise: Paise;
  accounts: { code: string; name: string; type: 'income' | 'expense'; amountPaise: Paise }[];
}

/** Income and expense for each cost centre over a period, and what carries none. */
export async function costCentrePnl(ex: Executor, orgId: number, from: string, to: string): Promise<CostCentreColumn[]> {
  const { rows } = await sql<{ cost_centre_id: number | null; code: string; name: string; type: 'income' | 'expense'; dr: string; cr: string }>`
    SELECT l.cost_centre_id, a.code, a.name, a.type, SUM(l.debit) AS dr, SUM(l.credit) AS cr
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.org_id = ${orgId} AND l.entry_date BETWEEN ${from} AND ${to} AND a.type IN ('income', 'expense')
     GROUP BY l.cost_centre_id, a.code, a.name, a.type
     ORDER BY a.code`.execute(ex);
  const centres = await listCostCentres(ex, orgId);
  const columns = new Map<string, CostCentreColumn>();
  const col = (id: number | null) => {
    const key = id === null ? 'none' : String(id);
    let c = columns.get(key);
    if (!c) {
      const cc = centres.find((x) => x.id === key);
      c = { id: id === null ? null : key, code: cc?.code ?? '—', name: cc?.name ?? 'No cost centre', category: cc?.category ?? null, incomePaise: 0, expensePaise: 0, netPaise: 0, accounts: [] };
      columns.set(key, c);
    }
    return c;
  };
  for (const r of rows) {
    const c = col(r.cost_centre_id);
    const amount = r.type === 'income' ? toPaiseFromSql(r.cr) - toPaiseFromSql(r.dr) : toPaiseFromSql(r.dr) - toPaiseFromSql(r.cr);
    if (!amount) continue;
    c.accounts.push({ code: r.code, name: r.name, type: r.type, amountPaise: amount });
    if (r.type === 'income') c.incomePaise += amount; else c.expensePaise += amount;
  }
  for (const c of columns.values()) c.netPaise = c.incomePaise - c.expensePaise;
  // Every active centre appears, even with nothing posted yet; the unallocated column last.
  for (const cc of centres.filter((x) => x.isActive)) col(Number(cc.id));
  return [...columns.values()].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.code.localeCompare(b.code)));
}
