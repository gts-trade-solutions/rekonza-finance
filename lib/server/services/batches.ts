import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Batches and expiry.
//
// A batch-tracked item names its batch on every purchase, with the dates on
// the pack, and on every sale. Stock by batch is the lines added up: bought,
// returned and adjusted in, sold out. A sale that names no batch takes the one
// that expires first and still has stock (first expiry, first out), and
// selling a batch past its expiry is flagged.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, notFound } from '../http';

export interface BatchInput { batchNo: string; mfgDate?: string | null; expiryDate?: string | null }

/** The batch with this number for the item, made if it is new; its dates filled in if they were missing. */
export async function findOrCreateBatch(trx: Trx, orgId: number, itemId: number, b: BatchInput): Promise<number> {
  const batchNo = b.batchNo.trim();
  if (!batchNo) throw badRequest('Give the batch number.');
  if (b.mfgDate && b.expiryDate && b.expiryDate < b.mfgDate) throw badRequest(`Batch ${batchNo} expires before it was made.`);
  const found = await trx.selectFrom('batches').select(['id', 'mfg_date', 'expiry_date'])
    .where('org_id', '=', orgId).where('item_id', '=', itemId).where('batch_no', '=', batchNo).executeTakeFirst();
  if (found) {
    const patch = {
      ...(found.mfg_date === null && b.mfgDate ? { mfg_date: b.mfgDate } : {}),
      ...(found.expiry_date === null && b.expiryDate ? { expiry_date: b.expiryDate } : {}),
    };
    if (Object.keys(patch).length) await trx.updateTable('batches').set(patch).where('id', '=', found.id).execute();
    return found.id;
  }
  return Number((await trx.insertInto('batches').values({
    org_id: orgId, item_id: itemId, batch_no: batchNo, mfg_date: b.mfgDate ?? null, expiry_date: b.expiryDate ?? null,
  }).executeTakeFirstOrThrow()).insertId);
}

export interface BatchStock { batchId: string; itemId: string; itemName: string; batchNo: string; mfgDate: string | null; expiryDate: string | null; qty: number }

/** Every batch's quantity on a date, from the lines that name it. */
export async function batchStock(ex: Executor, orgId: number, asOf: string, itemId?: number): Promise<BatchStock[]> {
  const { rows } = await sql<{ id: number; item_id: number; name: string; batch_no: string; mfg_date: string | null; expiry_date: string | null; qty: string }>`
    SELECT b.id, b.item_id, i.name, b.batch_no, b.mfg_date, b.expiry_date, COALESCE(SUM(m.q), 0) AS qty
      FROM batches b
      JOIN items i ON i.id = b.item_id
      LEFT JOIN (
        SELECT bl.batch_id, bl.qty AS q FROM bill_lines bl JOIN bills x ON x.id = bl.bill_id
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft','void') AND x.bill_date <= ${asOf} AND bl.batch_id IS NOT NULL
        UNION ALL
        SELECT cl.batch_id, cl.qty FROM credit_note_lines cl JOIN credit_notes x ON x.id = cl.credit_note_id
         WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.note_date <= ${asOf} AND cl.batch_id IS NOT NULL
        UNION ALL
        SELECT a.batch_id, a.qty_delta FROM stock_adjustments a
         WHERE a.org_id = ${orgId} AND a.adjust_date <= ${asOf} AND a.batch_id IS NOT NULL
        UNION ALL
        -- Received and not yet billed: the bill made from the note carries the rest.
        SELECT gl.batch_id, gl.qty - COALESCE((
                 SELECT SUM(bl.qty) FROM bill_lines bl JOIN bills bb ON bb.id = bl.bill_id
                  WHERE bl.source_line_type = 'goods_receipt' AND bl.source_line_id = gl.id
                    AND bb.status NOT IN ('draft','void') AND bb.bill_date <= ${asOf}), 0)
          FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id
         WHERE g.org_id = ${orgId} AND g.status <> 'cancelled' AND g.receipt_date <= ${asOf} AND gl.batch_id IS NOT NULL
        UNION ALL
        SELECT il.batch_id, -il.qty FROM invoice_lines il JOIN invoices x ON x.id = il.invoice_id
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft','void') AND x.invoice_date <= ${asOf} AND il.batch_id IS NOT NULL
      ) m ON m.batch_id = b.id
     WHERE b.org_id = ${orgId} ${itemId ? sql`AND b.item_id = ${itemId}` : sql``}
     GROUP BY b.id, b.item_id, i.name, b.batch_no, b.mfg_date, b.expiry_date
     ORDER BY i.name, b.expiry_date IS NULL, b.expiry_date, b.batch_no
  `.execute(ex);
  return rows.map((r) => ({
    batchId: String(r.id), itemId: String(r.item_id), itemName: r.name, batchNo: r.batch_no,
    mfgDate: r.mfg_date ? String(r.mfg_date).slice(0, 10) : null, expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
    qty: Number(r.qty),
  }));
}

/**
 * First expiry, first out: the unexpired batch that expires soonest and holds
 * enough; failing that, the soonest-expiring with any stock.
 */
export async function fefoPick(ex: Executor, orgId: number, itemId: number, qty: number, date: string): Promise<BatchStock | null> {
  const all = (await batchStock(ex, orgId, date, itemId)).filter((b) => b.qty > 0);
  const live = all.filter((b) => !b.expiryDate || b.expiryDate >= date);
  return live.find((b) => b.qty >= qty) ?? live[0] ?? all[0] ?? null;
}

/** Batch lines for a sale: each tracked item's batch, picked if not named, with warnings for short or expired stock. */
export async function batchesForSale(
  trx: Trx, orgId: number, date: string, lines: { itemId?: number | null; qty: number; batchId?: number | null }[], warnings: string[],
): Promise<(number | null)[]> {
  const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  if (!ids.length) return lines.map(() => null);
  const tracked = await trx.selectFrom('items').select(['id', 'name']).where('org_id', '=', orgId).where('id', 'in', ids).where('track_batches', '=', 1).execute();
  const out: (number | null)[] = [];
  for (const l of lines) {
    const item = tracked.find((t) => t.id === l.itemId);
    if (!item) { out.push(null); continue; }
    let batch: BatchStock | null = null;
    if (l.batchId) {
      batch = (await batchStock(trx, orgId, date, item.id)).find((b) => b.batchId === String(l.batchId)) ?? null;
      if (!batch) throw notFound(`That batch is not one of ${item.name}'s.`);
    } else {
      batch = await fefoPick(trx, orgId, item.id, l.qty, date);
    }
    if (!batch) { warnings.push(`${item.name} has no batch in stock; the sale names none.`); out.push(null); continue; }
    if (batch.expiryDate && batch.expiryDate < date) warnings.push(`${item.name} batch ${batch.batchNo} expired on ${batch.expiryDate}.`);
    if (batch.qty < l.qty) warnings.push(`${item.name} batch ${batch.batchNo} has ${batch.qty} in stock, ${l.qty} going out.`);
    out.push(Number(batch.batchId));
  }
  return out;
}
