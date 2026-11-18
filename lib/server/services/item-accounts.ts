import type { Executor } from '@/lib/server/db';
import { CODE, accountIds } from '@/lib/server/ledger/chart-of-accounts';

/**
 * The income account each item's sale goes to, as Zoho Books posts it: an
 * invoice line credits its item's sales account, and a credit note line
 * debits the same one back.
 *
 * Only accounts other than Sales are returned. A line with no account of its
 * own is posted to Sales by the posting code already, so an item kept on Sales
 * (and every line with no item) needs nothing on the line.
 */
export async function itemSaleAccounts(ex: Executor, orgId: number, itemIds: (number | null | undefined)[]): Promise<Map<number, number>> {
  const ids = [...new Set(itemIds.filter((x): x is number => !!x).map(Number))];
  if (!ids.length) return new Map();
  const sales = (await accountIds(ex, orgId))[CODE.SALES];
  const rows = await ex.selectFrom('items as i')
    .innerJoin('accounts as a', 'a.id', 'i.sale_account_id')
    .select(['i.id', 'i.sale_account_id'])
    .where('i.org_id', '=', orgId).where('i.id', 'in', ids)
    // A switched-off or non-income head is not posted to; the line falls back to Sales.
    .where('a.org_id', '=', orgId).where('a.type', '=', 'income').where('a.is_active', '=', 1)
    .execute();
  return new Map(rows.filter((r) => r.sale_account_id && r.sale_account_id !== sales).map((r) => [r.id, r.sale_account_id!]));
}
