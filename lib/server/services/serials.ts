import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Serial numbers.
//
// An item tracked by serial number names each piece as it comes in (a bill, a
// goods receipt, a return, an adjustment) and as it goes out (an invoice, a
// write-off). Each naming is a move on the document line; a piece is in stock
// while its moves on live documents add up to more than nothing. Voiding a
// document takes its moves out of the count without touching them.
//
// A piece cannot come in while it is already in stock, nor go out while it is
// not: both are almost always a mistyped number. A line that names no numbers
// at all is let through with a warning, as a batch line naming no batch is:
// stock bought before tracking was switched on has none to give.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, conflict } from '../http';

export type SerialDoc = 'bill' | 'goods_receipt' | 'invoice' | 'credit_note' | 'adjustment';

export interface SerialLine {
  lineId: number | null;
  itemId: number | null | undefined;
  qty: number;
  serials?: string[] | null;
}

/** Trimmed, blanks dropped. */
export const cleanSerials = (list: string[] | null | undefined): string[] =>
  (list ?? []).map((s) => s.trim()).filter(Boolean);

/** Moves that count: their document is issued and not voided or cancelled. */
const live = (orgId: number) => sql`
  SELECT sm.serial_id, sm.direction, sm.doc_type, sm.doc_id FROM serial_moves sm
    LEFT JOIN bills b ON sm.doc_type = 'bill' AND b.id = sm.doc_id
    LEFT JOIN goods_receipts g ON sm.doc_type = 'goods_receipt' AND g.id = sm.doc_id
    LEFT JOIN invoices v ON sm.doc_type = 'invoice' AND v.id = sm.doc_id
    LEFT JOIN credit_notes c ON sm.doc_type = 'credit_note' AND c.id = sm.doc_id
   WHERE sm.org_id = ${orgId}
     AND (   (sm.doc_type = 'bill' AND b.status NOT IN ('draft','void'))
          OR (sm.doc_type = 'goods_receipt' AND g.status <> 'cancelled')
          OR (sm.doc_type = 'invoice' AND v.status NOT IN ('draft','void'))
          OR (sm.doc_type = 'credit_note' AND c.status <> 'void')
          OR sm.doc_type = 'adjustment')`;

/** Each serial's count on live documents, leaving one document out. */
async function balances(ex: Executor, orgId: number, serialIds: number[], except: { type: SerialDoc; id: number }) {
  if (!serialIds.length) return new Map<number, number>();
  const { rows } = await sql<{ serial_id: number; bal: string }>`
    SELECT m.serial_id, SUM(m.direction) AS bal FROM (${live(orgId)}) m
     WHERE m.serial_id IN (${sql.join(serialIds)})
       AND NOT (m.doc_type = ${except.type} AND m.doc_id = ${except.id})
     GROUP BY m.serial_id`.execute(ex);
  return new Map(rows.map((r) => [Number(r.serial_id), Number(r.bal)]));
}

async function findOrCreateSerial(trx: Trx, orgId: number, itemId: number, serialNo: string): Promise<number> {
  const found = await trx.selectFrom('item_serials').select('id')
    .where('org_id', '=', orgId).where('item_id', '=', itemId).where('serial_no', '=', serialNo).executeTakeFirst();
  if (found) return found.id;
  return Number((await trx.insertInto('item_serials').values({ org_id: orgId, item_id: itemId, serial_no: serialNo })
    .executeTakeFirstOrThrow()).insertId);
}

/**
 * Record the numbered pieces a document's lines move: in (+1) or out (-1).
 *
 * A line naming numbers has to name one per piece. `check` is whether the
 * document counts now; a draft's numbers are recorded but checked against
 * stock only when it is issued (checkSerials). Lines that name none add a
 * warning when `warnings` is given.
 */
export async function recordSerials(
  trx: Trx, orgId: number, doc: { type: SerialDoc; id: number }, direction: 1 | -1, lines: SerialLine[],
  opts: { check: boolean; warnings?: string[] },
): Promise<void> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  const items = itemIds.length
    ? await trx.selectFrom('items').select(['id', 'name', 'track_serials']).where('org_id', '=', orgId).where('id', 'in', itemIds).execute()
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    const serials = cleanSerials(l.serials);
    if (!item?.track_serials) {
      if (serials.length) throw badRequest(`Line ${i + 1}: ${item?.name ?? 'this line'} is not tracked by serial number.`);
      continue;
    }
    const qty = Math.abs(l.qty);
    if (!serials.length) {
      opts.warnings?.push(`${item.name}: ${qty} piece(s) ${direction > 0 ? 'came in' : 'went out'} with no serial numbers.`);
      continue;
    }
    if (!Number.isInteger(qty) || serials.length !== qty) {
      throw badRequest(`Line ${i + 1}: ${qty} of ${item.name}, but ${serials.length} serial number(s). Give one for each piece.`);
    }
    for (const s of serials) {
      const key = `${item.id}|${s.toUpperCase()}`;
      if (seen.has(key)) throw badRequest(`${item.name} serial ${s} is named twice.`);
      seen.add(key);
      const serialId = await findOrCreateSerial(trx, orgId, item.id, s);
      await trx.insertInto('serial_moves').values({
        org_id: orgId, serial_id: serialId, doc_type: doc.type, doc_id: doc.id, line_id: l.lineId, direction,
      }).execute();
    }
  }
  if (opts.check) await checkSerials(trx, orgId, doc);
}

/**
 * The pieces a document moves, against stock without it: nothing coming in
 * that is already here, nothing going out that is not.
 */
export async function checkSerials(trx: Trx, orgId: number, doc: { type: SerialDoc; id: number }): Promise<void> {
  const moves = await trx.selectFrom('serial_moves as m')
    .innerJoin('item_serials as s', 's.id', 'm.serial_id')
    .innerJoin('items as i', 'i.id', 's.item_id')
    .select(['m.serial_id', 'm.direction', 's.serial_no', 'i.name'])
    .where('m.org_id', '=', orgId).where('m.doc_type', '=', doc.type).where('m.doc_id', '=', doc.id)
    .execute();
  const bal = await balances(trx, orgId, moves.map((m) => m.serial_id), doc);
  for (const m of moves) {
    const b = bal.get(m.serial_id) ?? 0;
    if (m.direction > 0 && b > 0) throw conflict(`${m.name} serial ${m.serial_no} is already in stock.`);
    if (m.direction < 0 && b < 1) throw conflict(`${m.name} serial ${m.serial_no} is not in stock.`);
  }
}

export interface SerialInStock { serialId: string; itemId: string; itemName: string; serialNo: string }

/** The numbered pieces on hand, for one item or all. */
export async function serialStock(ex: Executor, orgId: number, itemId?: number): Promise<SerialInStock[]> {
  const { rows } = await sql<{ id: number; item_id: number; name: string; serial_no: string }>`
    SELECT s.id, s.item_id, i.name, s.serial_no
      FROM item_serials s
      JOIN items i ON i.id = s.item_id
      JOIN (${live(orgId)}) m ON m.serial_id = s.id
     WHERE s.org_id = ${orgId} ${itemId ? sql`AND s.item_id = ${itemId}` : sql``}
     GROUP BY s.id, s.item_id, i.name, s.serial_no
    HAVING SUM(m.direction) > 0
     ORDER BY i.name, s.serial_no`.execute(ex);
  return rows.map((r) => ({ serialId: String(r.id), itemId: String(r.item_id), itemName: r.name, serialNo: r.serial_no }));
}

export interface SerialMove {
  docType: SerialDoc; docId: string; number: string; date: string; party: string | null; direction: 1 | -1; live: boolean;
}

/**
 * Everything known about a serial number: which item, whether it is here, and
 * each document it came in or went out on — the warranty question, answered.
 */
export async function serialHistory(ex: Executor, orgId: number, serialNo: string) {
  const serials = await ex.selectFrom('item_serials as s').innerJoin('items as i', 'i.id', 's.item_id')
    .select(['s.id', 's.serial_no', 's.item_id', 'i.name'])
    .where('s.org_id', '=', orgId).where('s.serial_no', '=', serialNo.trim()).execute();
  if (!serials.length) return [];
  const ids = serials.map((s) => s.id);
  const { rows } = await sql<{
    serial_id: number; doc_type: SerialDoc; doc_id: number; direction: number;
    number: string | null; doc_date: string | null; party: string | null; status: string | null;
  }>`
    SELECT sm.serial_id, sm.doc_type, sm.doc_id, sm.direction,
           COALESCE(b.vendor_invoice_no, g.number, v.number, c.number, CONCAT('Adjustment #', a.id)) AS number,
           COALESCE(b.bill_date, g.receipt_date, v.invoice_date, c.note_date, a.adjust_date) AS doc_date,
           COALESCE(bv.display_name, gv.display_name, vc.display_name, cc.display_name) AS party,
           COALESCE(b.status, g.status, v.status, c.status, 'posted') AS status
      FROM serial_moves sm
      LEFT JOIN bills b ON sm.doc_type = 'bill' AND b.id = sm.doc_id
      LEFT JOIN contacts bv ON bv.id = b.vendor_id
      LEFT JOIN goods_receipts g ON sm.doc_type = 'goods_receipt' AND g.id = sm.doc_id
      LEFT JOIN contacts gv ON gv.id = g.vendor_id
      LEFT JOIN invoices v ON sm.doc_type = 'invoice' AND v.id = sm.doc_id
      LEFT JOIN contacts vc ON vc.id = v.customer_id
      LEFT JOIN credit_notes c ON sm.doc_type = 'credit_note' AND c.id = sm.doc_id
      LEFT JOIN contacts cc ON cc.id = c.customer_id
      LEFT JOIN stock_adjustments a ON sm.doc_type = 'adjustment' AND a.id = sm.doc_id
     WHERE sm.org_id = ${orgId} AND sm.serial_id IN (${sql.join(ids)})
     ORDER BY doc_date, sm.id`.execute(ex);
  const dead = (r: (typeof rows)[number]) =>
    r.status === 'void' || r.status === 'cancelled' || (r.status === 'draft' && (r.doc_type === 'invoice' || r.doc_type === 'bill'));
  return serials.map((s) => {
    const moves: SerialMove[] = rows.filter((r) => r.serial_id === s.id).map((r) => ({
      docType: r.doc_type, docId: String(r.doc_id), number: r.number ?? '', date: r.doc_date ? String(r.doc_date).slice(0, 10) : '',
      party: r.party, direction: r.direction > 0 ? 1 : -1, live: !dead(r),
    }));
    return {
      serialId: String(s.id), itemId: String(s.item_id), itemName: s.name, serialNo: s.serial_no,
      inStock: moves.filter((m) => m.live).reduce((t, m) => t + m.direction, 0) > 0,
      moves,
    };
  });
}
