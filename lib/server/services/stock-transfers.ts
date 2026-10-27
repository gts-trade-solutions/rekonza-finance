import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Stock transfers between godowns and branches (see reports/stock.ts for how
// they move quantities). Dispatched, the goods leave their godown; received,
// they arrive at the other; in between they are in transit. Nothing is posted:
// moving goods does not change what they cost, and closing stock is worked out
// from documents.
//
// Between two GSTINs a transfer is a supply (CGST Act Schedule I, para 2): it
// goes on a tax invoice to the other registration, not on a transfer. Within
// one GSTIN it travels on a delivery challan, with an e-way bill when it is
// worth more than the threshold.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';
import { allocateOrgNumber } from '../ledger/posting';
import { fyLabelFor } from './sales';
import { checkStock } from './guards';

async function warehouse(ex: Executor, orgId: number, id: number) {
  const w = await ex.selectFrom('warehouses as w')
    .leftJoin('branches as b', (j) => j.on((eb) => eb.or([
      eb('b.id', '=', eb.ref('w.branch_id')),
      eb.and([eb('w.branch_id', 'is', null), eb('b.org_id', '=', orgId), eb('b.is_primary', '=', 1)]),
    ])))
    .select(['w.id', 'w.name', 'b.id as branch_id', 'b.gstin', 'b.name as branch_name'])
    .where('w.id', '=', id).where('w.org_id', '=', orgId).executeTakeFirst();
  if (!w) throw notFound('That godown does not exist.');
  return w;
}

export interface TransferInput {
  fromWarehouseId: number;
  toWarehouseId: number;
  date: string;
  lines: { itemId: number; qty: number }[];
  vehicleNo?: string | null;
  ewayBillNo?: string | null;
  notes?: string | null;
}

export async function createTransfer(trx: Trx, orgId: number, userId: number | null, input: TransferInput) {
  if (input.fromWarehouseId === input.toWarehouseId) throw badRequest('A transfer goes from one godown to another.');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw badRequest('Add the items and quantities being moved.');
  const from = await warehouse(trx, orgId, input.fromWarehouseId);
  const to = await warehouse(trx, orgId, input.toWarehouseId);
  if (from.gstin && to.gstin && from.gstin !== to.gstin) {
    throw badRequest(
      `${from.branch_name} and ${to.branch_name} are separate GST registrations, so moving goods between them is a supply. ` +
        'Raise a tax invoice from one to the other instead.',
    );
  }
  const items = await trx.selectFrom('items').select(['id', 'name', 'track_inventory', 'kind'])
    .where('org_id', '=', orgId).where('id', 'in', lines.map((l) => l.itemId)).execute();
  for (const l of lines) {
    const it = items.find((i) => i.id === l.itemId);
    if (!it) throw notFound('One of the items does not exist.');
    if (it.kind !== 'goods' || !it.track_inventory) throw badRequest(`${it.name} is not stock that can be moved.`);
  }
  // Goods not at the godown cannot leave it: the book's negative-stock rule decides how firmly.
  const warnings: string[] = [];
  if (from.branch_id) await checkStock(trx, orgId, from.branch_id, input.date, lines, warnings);

  const number = await allocateOrgNumber(trx, orgId, 'ST', fyLabelFor(input.date), 'ST');
  const id = Number((await trx.insertInto('stock_transfers').values({
    org_id: orgId, number, from_warehouse_id: input.fromWarehouseId, to_warehouse_id: input.toWarehouseId,
    dispatch_date: input.date, vehicle_no: input.vehicleNo ?? null, eway_bill_no: input.ewayBillNo ?? null,
    notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.insertInto('stock_transfer_lines').values(lines.map((l) => ({ transfer_id: id, item_id: l.itemId, qty: String(l.qty) }))).execute();
  return { id, number, warnings };
}

export async function receiveTransfer(trx: Trx, orgId: number, id: number, date: string) {
  const t = await trx.selectFrom('stock_transfers').select(['number', 'status', 'dispatch_date'])
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That transfer does not exist.');
  if (t.status !== 'in_transit') throw conflict(`${t.number} is already ${t.status}.`);
  if (date < String(t.dispatch_date).slice(0, 10)) throw badRequest('Goods cannot arrive before they were sent.');
  await trx.updateTable('stock_transfers').set({ status: 'received', received_date: date }).where('id', '=', id).execute();
}

export async function cancelTransfer(trx: Trx, orgId: number, id: number) {
  const t = await trx.selectFrom('stock_transfers').select(['number', 'status'])
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That transfer does not exist.');
  if (t.status !== 'in_transit') throw conflict(`${t.number} has been ${t.status}; record a transfer back instead.`);
  await trx.updateTable('stock_transfers').set({ status: 'cancelled' }).where('id', '=', id).execute();
}

export async function listTransfers(ex: Executor, orgId: number) {
  const { rows } = await sql<{
    id: number; number: string; from_name: string; to_name: string; dispatch_date: string; received_date: string | null;
    status: string; vehicle_no: string | null; eway_bill_no: string | null; notes: string | null; items: string; qty: string;
  }>`
    SELECT t.id, t.number, f.name AS from_name, d.name AS to_name, t.dispatch_date, t.received_date, t.status,
           t.vehicle_no, t.eway_bill_no, t.notes,
           GROUP_CONCAT(CONCAT(i.name, ' × ', TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM l.qty))) ORDER BY i.name SEPARATOR ', ') AS items,
           SUM(l.qty) AS qty
      FROM stock_transfers t
      JOIN warehouses f ON f.id = t.from_warehouse_id
      JOIN warehouses d ON d.id = t.to_warehouse_id
      JOIN stock_transfer_lines l ON l.transfer_id = t.id
      JOIN items i ON i.id = l.item_id
     WHERE t.org_id = ${orgId}
     GROUP BY t.id, t.number, f.name, d.name, t.dispatch_date, t.received_date, t.status, t.vehicle_no, t.eway_bill_no, t.notes
     ORDER BY t.dispatch_date DESC, t.id DESC
     LIMIT 300
  `.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), number: r.number, from: r.from_name, to: r.to_name,
    dispatchDate: String(r.dispatch_date).slice(0, 10), receivedDate: r.received_date ? String(r.received_date).slice(0, 10) : null,
    status: r.status as 'in_transit' | 'received' | 'cancelled', vehicleNo: r.vehicle_no, ewayBillNo: r.eway_bill_no, notes: r.notes,
    items: r.items, qty: Number(r.qty),
  }));
}
