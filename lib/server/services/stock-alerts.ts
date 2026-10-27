import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Stock alerts, under the bell.
//
// Once a day the scheduler looks at each book's stock: items at or below their
// minimum level, and batches that have expired with stock on hand or will
// within thirty days. Whoever can see inventory is told. An alert that says
// the same as the last one of its kind is not sent again for a week, so the
// bell does not fill with one unchanged shortage.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Executor } from '../db';
import { stockPosition } from '../reports/stock';
import { batchStock } from './batches';
import { getPolicies } from './org-settings';
import { indiaToday } from './held-journals';
import { notify, usersWhoCan } from './notifications';

/** How far ahead an expiry is worth a warning. */
export const EXPIRY_WARN_DAYS = 30;

const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const listed = (parts: string[], max = 5) =>
  parts.slice(0, max).join('; ') + (parts.length > max ? `; and ${parts.length - max} more` : '');

export interface StockAlerts {
  short: { itemId: string; name: string; qty: number; minLevel: number; uqc: string }[];
  expired: { itemName: string; batchNo: string; expiryDate: string; qty: number }[];
  expiring: { itemName: string; batchNo: string; expiryDate: string; qty: number }[];
}

/** What is worth telling a book about its stock on a day. */
export async function stockAlerts(ex: Executor, orgId: number, day: string): Promise<StockAlerts> {
  const mins = await ex.selectFrom('items').select(['id', 'min_level']).where('org_id', '=', orgId)
    .where('kind', '=', 'goods').where('is_archived', '=', 0).where('min_level', 'is not', null).where('min_level', '>', '0').execute();
  const minBy = new Map(mins.map((m) => [String(m.id), Number(m.min_level)]));
  const short = minBy.size
    ? (await stockPosition(ex, orgId, day)).lines
        .filter((l) => minBy.has(l.itemId) && l.qty <= minBy.get(l.itemId)!)
        .map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, minLevel: minBy.get(l.itemId)!, uqc: l.uqc }))
    : [];
  const horizon = plusDays(day, EXPIRY_WARN_DAYS);
  const dated = (await batchStock(ex, orgId, day)).filter((b) => b.qty > 0 && b.expiryDate);
  const pick = (b: (typeof dated)[number]) => ({ itemName: b.itemName, batchNo: b.batchNo, expiryDate: b.expiryDate!, qty: b.qty });
  return {
    short,
    expired: dated.filter((b) => b.expiryDate! < day).map(pick),
    expiring: dated.filter((b) => b.expiryDate! >= day && b.expiryDate! <= horizon).map(pick),
  };
}

/** Sent unless one of the same kind went out today, or one saying the same went out this week. */
async function fresh(ex: Executor, orgId: number, kind: string, body: string): Promise<boolean> {
  const last = await ex.selectFrom('notifications').select(['body', 'created_at'])
    .where('org_id', '=', orgId).where('kind', '=', kind).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!last) return true;
  const age = Date.now() - new Date(last.created_at).getTime();
  if (age < 20 * 3_600_000) return false;
  return !(last.body === body && age < 7 * 86_400_000);
}

/** One book's alerts for the day. Returns how many notifications went out. */
export async function alertBook(ex: Executor, orgId: number, day: string): Promise<number> {
  if ((await getPolicies(ex, orgId)).features?.inventory === false) return 0;
  const a = await stockAlerts(ex, orgId, day);
  if (!a.short.length && !a.expired.length && !a.expiring.length) return 0;
  const to = await usersWhoCan(ex, orgId, 'inventory', 'view');
  if (!to.length) return 0;
  let sent = 0;
  if (a.short.length) {
    const body = listed(a.short.map((s) => `${s.name}: ${s.qty} ${s.uqc.toLowerCase()} left, minimum ${s.minLevel}`));
    if (await fresh(ex, orgId, 'stock_short', body)) {
      sent += await notify(ex, orgId, to, {
        kind: 'stock_short', title: `${a.short.length} item${a.short.length === 1 ? '' : 's'} at or below the minimum level`, body, href: '/inventory/stock',
      });
    }
  }
  if (a.expired.length || a.expiring.length) {
    const body = listed([
      ...a.expired.map((b) => `${b.itemName} batch ${b.batchNo}: ${b.qty} expired on ${b.expiryDate}`),
      ...a.expiring.map((b) => `${b.itemName} batch ${b.batchNo}: ${b.qty} expire on ${b.expiryDate}`),
    ]);
    const title = [
      a.expired.length && `${a.expired.length} batch${a.expired.length === 1 ? '' : 'es'} expired with stock`,
      a.expiring.length && `${a.expiring.length} expiring within ${EXPIRY_WARN_DAYS} days`,
    ].filter(Boolean).join(', ');
    if (await fresh(ex, orgId, 'batch_expiry', body)) {
      sent += await notify(ex, orgId, to, { kind: 'batch_expiry', title, body, href: '/inventory/batches' });
    }
  }
  return sent;
}

/** The scheduler's sweep: every book with a minimum level or a dated batch. */
export async function runStockAlerts(day = indiaToday()): Promise<number> {
  const { rows } = await sql<{ org_id: number }>`
    SELECT DISTINCT org_id FROM items WHERE min_level > 0 AND is_archived = 0
    UNION
    SELECT DISTINCT org_id FROM batches WHERE expiry_date IS NOT NULL AND expiry_date <= ${plusDays(day, EXPIRY_WARN_DAYS)}`.execute(db);
  let sent = 0;
  for (const r of rows) {
    try {
      sent += await transaction((trx) => alertBook(trx, Number(r.org_id), day));
    } catch (err) {
      console.error('[stock-alerts]', r.org_id, err);
    }
  }
  return sent;
}
