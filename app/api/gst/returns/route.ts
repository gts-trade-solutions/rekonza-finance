import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { gstr1Report } from '@/lib/server/gst/gstr1-report';
import { gstr3bChecks, reconciliation } from '@/lib/server/gst/gstr3b-checks';
import {
  deleteGstr3bPayment, gstr3bPaymentFor, gstr3bSettlement, recordGstr3bPayment, updateGstr3bPayment,
} from '@/lib/server/gst/gstr3b-payment';
import { claimDecisions, claimShifts } from '@/lib/server/gst/itc-claims';

// ─────────────────────────────────────────────────────────────────────────────
// The return filing reports (status review 7, item 11):
//
//   GET  view=gstr1-report     every table of GSTR-1, amendments, the tie-out
//   GET  view=gstr3b-checks    GSTR-3B against GSTR-1 / GSTR-2B and the ledger
//   GET  view=gstr3b-payment   the set-off and cash, recorded or to record
//   GET  view=reconciliation   GSTR-1 vs GSTR-3B vs the books, month by month
//   GET  view=itc-claims       the credit moved by GSTR-2B claim decisions
//   POST / PUT / DELETE        record, correct, delete the GSTR-3B payment
// ─────────────────────────────────────────────────────────────────────────────

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const lastFullFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};

const Q = z.object({
  view: z.enum(['gstr1-report', 'gstr3b-checks', 'gstr3b-payment', 'reconciliation', 'itc-claims']),
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Give the month as yyyy-mm.').optional(),
  ret: z.string().regex(/^\d{4}-(\d{2}|Q[1-4])$/, 'Give the return period as yyyy-mm or yyyy-Qn.').optional(),
  fy: z.coerce.number().int().min(2017).max(2100).optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const today = localToday();
    const month = q.period ?? today.slice(0, 7);
    switch (q.view) {
      case 'gstr1-report':
        return gstr1Report(db, orgId, month);
      case 'gstr3b-checks':
        return gstr3bChecks(db, orgId, q.ret ?? month, today);
      case 'gstr3b-payment': {
        const ret = q.ret ?? month;
        const [recorded, settlement] = await Promise.all([gstr3bPaymentFor(db, orgId, ret, today), gstr3bSettlement(db, orgId, ret, today)]);
        return { recorded, settlement };
      }
      case 'reconciliation':
        return reconciliation(db, orgId, q.fy ?? lastFullFy(), today);
      case 'itc-claims': {
        const shifts = await claimShifts(db, orgId, [month]);
        // Every bill still held back, whatever its month: the credit waiting for the supplier.
        const held = await db.selectFrom('gst_itc_claims as g').innerJoin('bills as b', 'b.id', 'g.bill_id').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
          .select(['b.id', 'b.internal_no', 'b.vendor_invoice_no', 'b.bill_date', 'c.display_name', 'c.gstin', 'g.decision', 'g.claim_period', 'g.note',
            'b.cgst', 'b.sgst', 'b.igst', 'b.cess'])
          .where('g.org_id', '=', orgId).where('b.status', 'not in', ['draft', 'void']).orderBy('b.bill_date').execute();
        const decisions = await claimDecisions(db, orgId, held.map((h) => h.id));
        return {
          period: month,
          shifts,
          decisions: held.map((h) => ({
            billId: String(h.id), number: h.internal_no, vendorInvoiceNo: h.vendor_invoice_no, billDate: String(h.bill_date).slice(0, 10),
            party: h.display_name, gstin: h.gstin, decision: h.decision, claimPeriod: h.claim_period, note: h.note,
            by: decisions.get(h.id)?.by ?? null, taxPaise: [h.cgst, h.sgst, h.igst, h.cess].reduce((t, v) => t + Math.round(Number(v) * 100), 0),
          })),
        };
      }
    }
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Pay = z.object({
  period: z.string().regex(/^\d{4}-(\d{2}|Q[1-4])$/),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date it was paid.'),
  cpin: z.string().trim().max(20).nullish(),
  bankAccountId: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null || v === '' ? null : Number(v))),
  notes: z.string().trim().max(300).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Pay.extend({ action: z.literal('gstr3b-payment') }));
    return transaction(async (trx) => {
      const r = await recordGstr3bPayment(trx, orgId, user.userId, input, localToday());
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'gst_tax_payment', targetId: r.id, targetLabel: `GSTR-3B ${input.period}`,
        detail: `GSTR-3B ${input.period}: ₹${(r.creditUsedPaise / 100).toFixed(2)} set off from credit and ₹${(r.cashPaise / 100).toFixed(2)} paid in cash on ${input.paidOn}${input.cpin ? ` (CPIN ${input.cpin})` : ''}`,
        ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

export const PUT = route(
  async ({ orgId, user, req }) => {
    const id = Number(new URL(req.url).searchParams.get('id'));
    if (!id) throw badRequest('Which payment? Pass id.');
    const input = await body(req, Pay);
    return transaction(async (trx) => {
      const r = await updateGstr3bPayment(trx, orgId, user.userId, id, input, localToday());
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'gst_tax_payment', targetId: id, targetLabel: `GSTR-3B ${input.period}`,
        detail: `GSTR-3B ${input.period} payment changed: reversed and posted again as the return now stands, paid on ${input.paidOn}`,
        ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const sp = new URL(req.url).searchParams;
    const id = Number(sp.get('id'));
    if (!id) throw badRequest('Which payment? Pass id.');
    const reason = sp.get('reason');
    return transaction(async (trx) => {
      const r = await deleteGstr3bPayment(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'gst_tax_payment', targetId: id, targetLabel: r.label,
        detail: `${r.label} deleted: its entry reversed${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'gst', action: 'void' } },
);
