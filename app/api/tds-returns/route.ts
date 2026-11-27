import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { quarterReturn, recordChallan, type Quarter } from '@/lib/server/tax/tds-returns';
import { deleteChallan, updateChallan } from '@/lib/server/gst/changes';
import { changeReason } from '@/lib/server/request-context';

// ─────────────────────────────────────────────────────────────────────────────
// TDS and TCS returns, and the challans that deposit the tax.
//
// GET builds a quarter's return from the bills and invoices that deducted or
// collected tax, with each month's deposits checked against what was due.
// POST records a challan and posts the payment.
// ─────────────────────────────────────────────────────────────────────────────

const currentFy = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0);
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      fy: z.coerce.number().int().min(2017).max(2100).optional(),
      quarter: z.coerce.number().int().min(1).max(4).optional(),
    }));
    const fy = q.fy ?? currentFy();
    const quarter = (q.quarter ?? 1) as Quarter;
    const [ret, challans] = await Promise.all([
      quarterReturn(db, orgId, fy, quarter),
      db.selectFrom('tds_challans as c')
        .leftJoin('bank_accounts as b', 'b.id', 'c.bank_account_id')
        .select(['c.id', 'c.kind', 'c.for_month', 'c.challan_date', 'c.bsr_code', 'c.challan_serial',
          'c.tax', 'c.interest', 'c.fee', 'c.total', 'c.notes', 'c.bank_account_id', 'b.name as bank_name'])
        .where('c.org_id', '=', orgId)
        .orderBy('c.challan_date', 'desc').limit(200).execute(),
    ]);
    return {
      ...ret,
      challans: challans.map((c) => ({
        id: asId(c.id),
        kind: c.kind,
        forMonth: c.for_month,
        date: String(c.challan_date).slice(0, 10),
        bsrCode: c.bsr_code,
        serial: c.challan_serial,
        taxPaise: toPaiseFromSql(c.tax),
        interestPaise: toPaiseFromSql(c.interest),
        feePaise: toPaiseFromSql(c.fee),
        totalPaise: toPaiseFromSql(c.total),
        bankName: c.bank_name,
        bankAccountId: c.bank_account_id ? asId(c.bank_account_id) : null,
        notes: c.notes,
      })),
    };
  },
  { permission: { module: 'gst', action: 'view' } },
);

const ChallanInput = z.object({
  kind: z.enum(['tds', 'tcs']),
  forMonth: z.string().regex(/^\d{4}-\d{2}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bsrCode: z.string().trim(),
  serial: z.string().trim(),
  taxPaise: z.number().int().min(0),
  interestPaise: z.number().int().min(0).optional(),
  feePaise: z.number().int().min(0).optional(),
  bankAccountId: z.union([z.string(), z.number()]),
  notes: z.string().trim().max(300).nullish(),
});

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, ChallanInput);
    const result = await transaction((trx) =>
      recordChallan(trx, orgId, user.userId, branchId, { ...input, bankAccountId: Number(input.bankAccountId) }));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'tds_challan', targetId: result.id, targetLabel: `${input.bsrCode}/${input.serial}`,
      detail: `${input.kind.toUpperCase()} challan for ${input.forMonth}: ₹${(result.totalPaise / 100).toLocaleString('en-IN')}`,
      ...auditMeta(req),
    });
    return { id: asId(result.id), journalEntryId: asId(result.journalEntryId) };
  },
  { permission: { module: 'gst', action: 'create' } },
);

/** Correct a challan: its entry reversed and the deposit posted again on the same record (gst/changes.ts). */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, ChallanInput.extend({ id: z.union([z.string(), z.number()]).transform(Number) }));
    return transaction(async (trx) => {
      const r = await updateChallan(trx, orgId, user.userId, input.id, { ...input, bankAccountId: Number(input.bankAccountId) });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'tds_challan', targetId: input.id, targetLabel: `${input.bsrCode}/${input.serial}`,
        detail: `${input.kind.toUpperCase()} challan for ${input.forMonth} changed to ₹${(r.totalPaise / 100).toLocaleString('en-IN')}; its entry reversed and posted again`,
        ...auditMeta(req),
      });
      return { id: asId(input.id), journalEntryId: asId(r.journalEntryId) };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

/** Delete a challan entered in error: its entry reversed, the challan kept in deleted_documents (gst/changes.ts). */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.coerce.number().int().positive() }));
    const reason = changeReason();
    return transaction(async (trx) => {
      const r = await deleteChallan(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'tds_challan', targetId: id,
        targetLabel: r.label, detail: `${r.kind.toUpperCase()} challan ${r.label} deleted; its entry reversed${reason ? `: ${reason}` : ''}`, ...auditMeta(req),
      });
      return { id: asId(id), deleted: true };
    });
  },
  { permission: { module: 'gst', action: 'void' } },
);
