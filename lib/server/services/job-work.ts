import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Job work (CGST Act s.143, Rule 45).
//
// Goods go to a job worker on a job-work challan without tax and remain the
// principal's own stock. They come back on a receipt against the challan,
// with any waste noted; waste leaves stock at that point. Inputs not back
// within one year of the challan, capital goods within three, are treated as
// supplied on the day they were sent, and tax is due with interest.
//
// ITC-04 reports both directions: half-yearly for a business above ₹5 crore
// turnover, yearly otherwise.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;

/** Each job-work challan line: sent, back, wasted, and what is still out. */
export async function jobWorkLines(ex: Executor, orgId: number, challanId?: number) {
  const { rows } = await sql<{
    challan_id: number; number: string; challan_date: string; status: string; worker: string; gstin: string | null; state_code: string | null;
    line_id: number; item_id: number | null; description: string | null; hsn_sac: string | null; uqc: string | null; qty: string; rate: string;
    received: string; waste: string;
  }>`
    SELECT d.id AS challan_id, d.number, d.challan_date, d.status, c.display_name AS worker, c.gstin, c.state_code,
           cl.id AS line_id, cl.item_id, cl.description, cl.hsn_sac, cl.uqc, cl.qty, cl.rate,
           COALESCE(SUM(rl.qty_received), 0) AS received, COALESCE(SUM(rl.qty_waste), 0) AS waste
      FROM delivery_challans d
      JOIN contacts c ON c.id = d.customer_id
      JOIN challan_lines cl ON cl.challan_id = d.id
      LEFT JOIN job_work_receipt_lines rl ON rl.challan_line_id = cl.id
     WHERE d.org_id = ${orgId} AND d.challan_type = 'job_work' AND d.status <> 'cancelled'
       ${challanId ? sql`AND d.id = ${challanId}` : sql``}
     GROUP BY d.id, d.number, d.challan_date, d.status, c.display_name, c.gstin, c.state_code,
              cl.id, cl.item_id, cl.description, cl.hsn_sac, cl.uqc, cl.qty, cl.rate
     ORDER BY d.challan_date, d.id, cl.line_no
  `.execute(ex);
  return rows.map((r) => {
    const sent = Number(r.qty);
    const back = Number(r.received);
    const waste = Number(r.waste);
    const date = String(r.challan_date).slice(0, 10);
    return {
      challanId: String(r.challan_id), number: r.number, date, status: r.status, worker: r.worker, gstin: r.gstin, stateCode: r.state_code,
      lineId: String(r.line_id), itemId: r.item_id ? String(r.item_id) : null, description: r.description, hsnSac: r.hsn_sac, uqc: r.uqc,
      sent, received: back, waste, outstanding: Math.max(0, sent - back - waste),
      valuePaise: Math.round(toPaiseFromSql(r.rate) * sent),
      /** Inputs not back by this date are treated as supplied on the day they were sent. */
      dueBack: addYears(date, 1),
    };
  });
}

export interface ReceiptInput {
  challanId: number;
  date: string;
  jobWorkerChallanNo?: string | null;
  jobWorkerChallanDate?: string | null;
  natureOfJob?: string | null;
  notes?: string | null;
  lines: { challanLineId: number; qtyReceived: number; qtyWaste?: number }[];
}

export async function receiveJobWork(trx: Trx, orgId: number, userId: number | null, input: ReceiptInput) {
  const challan = await trx.selectFrom('delivery_challans').select(['id', 'number', 'challan_type', 'status', 'challan_date'])
    .where('id', '=', input.challanId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!challan) throw notFound('That challan does not exist.');
  if (challan.challan_type !== 'job_work') throw badRequest(`${challan.number} did not send goods for job work.`);
  if (challan.status === 'cancelled' || challan.status === 'returned') throw conflict(`${challan.number} is ${challan.status}.`);
  if (input.date < String(challan.challan_date).slice(0, 10)) throw badRequest('Goods cannot come back before they went.');
  const open = await jobWorkLines(trx, orgId, input.challanId);
  const lines = input.lines.filter((l) => l.qtyReceived > 0 || (l.qtyWaste ?? 0) > 0);
  if (!lines.length) throw badRequest('Enter what came back, or what was wasted.');
  for (const l of lines) {
    const o = open.find((x) => x.lineId === String(l.challanLineId));
    if (!o) throw notFound('One of the lines is not on that challan.');
    if (l.qtyReceived < 0 || (l.qtyWaste ?? 0) < 0) throw badRequest('Quantities cannot be negative.');
    if (l.qtyReceived + (l.qtyWaste ?? 0) > o.outstanding + 1e-9) {
      throw badRequest(`Only ${o.outstanding} of ${o.description ?? 'that line'} is still with the job worker.`);
    }
  }
  const id = Number((await trx.insertInto('job_work_receipts').values({
    org_id: orgId, challan_id: input.challanId, received_date: input.date,
    job_worker_challan_no: input.jobWorkerChallanNo ?? null, job_worker_challan_date: input.jobWorkerChallanDate ?? null,
    nature_of_job: input.natureOfJob ?? null, notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.insertInto('job_work_receipt_lines').values(lines.map((l) => ({
    receipt_id: id, challan_line_id: l.challanLineId, qty_received: String(l.qtyReceived), qty_waste: String(l.qtyWaste ?? 0),
  }))).execute();
  const after = await jobWorkLines(trx, orgId, input.challanId);
  if (after.every((l) => l.outstanding <= 0)) {
    await trx.updateTable('delivery_challans').set({ status: 'returned' }).where('id', '=', input.challanId).execute();
  }
  return { id };
}

/** ITC-04 for a period: goods sent (table 4) and received back (table 5A), and what is overdue. */
export async function itc04(ex: Executor, orgId: number, from: string, to: string) {
  const lines = await jobWorkLines(ex, orgId);
  const sent = lines.filter((l) => l.date >= from && l.date <= to);
  const { rows } = await sql<{
    received_date: string; jw_no: string | null; jw_date: string | null; nature: string | null; number: string; challan_date: string;
    worker: string; gstin: string | null; description: string | null; uqc: string | null; qty_received: string; qty_waste: string;
  }>`
    SELECT r.received_date, r.job_worker_challan_no AS jw_no, r.job_worker_challan_date AS jw_date, r.nature_of_job AS nature,
           d.number, d.challan_date, c.display_name AS worker, c.gstin, cl.description, cl.uqc, rl.qty_received, rl.qty_waste
      FROM job_work_receipts r
      JOIN delivery_challans d ON d.id = r.challan_id
      JOIN contacts c ON c.id = d.customer_id
      JOIN job_work_receipt_lines rl ON rl.receipt_id = r.id
      JOIN challan_lines cl ON cl.id = rl.challan_line_id
     WHERE r.org_id = ${orgId} AND r.received_date BETWEEN ${from} AND ${to}
     ORDER BY r.received_date, r.id
  `.execute(ex);
  return {
    from, to,
    sent,
    received: rows.map((r) => ({
      receivedDate: String(r.received_date).slice(0, 10), jobWorkerChallanNo: r.jw_no, jobWorkerChallanDate: r.jw_date ? String(r.jw_date).slice(0, 10) : null,
      natureOfJob: r.nature, challanNumber: r.number, challanDate: String(r.challan_date).slice(0, 10), worker: r.worker, gstin: r.gstin,
      description: r.description, uqc: r.uqc, qtyReceived: Number(r.qty_received), qtyWaste: Number(r.qty_waste),
    })),
    // Still out a year after they went: supplied, in law, on the day they were sent.
    overdue: lines.filter((l) => l.outstanding > 0 && l.dueBack <= to),
  };
}
