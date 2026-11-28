import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { emptyGstr9Inputs, gstr9, gstr9Inputs, inputsAreEmpty, TABLE15_KEYS } from '@/lib/server/gst/gstr9';
import { gstr9PortalJson } from '@/lib/server/gst/gstr9-json';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-9, the annual return (CGST Act s.44, Rule 80): the return itself, as
// worked out from the year's documents (lib/server/gst/gstr9.ts), the file the
// GST portal's offline tool takes, and the rows no document can supply —
// transition credit, other credit and reversals, demands and refunds (table
// 15), the late fee paid (19) — which the preparer enters here. Those are
// kept in the settings table, one row per financial year, so the return is
// still recomputed from the documents every time it is opened.
// ─────────────────────────────────────────────────────────────────────────────

const FY = z.coerce.number().int().min(2017).max(2100);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** The last financial year that has ended: annual returns are filed for it. */
const lastFullYear = () => {
  const d = new Date();
  return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0) - 1;
};

const Q = z.object({
  view: z.enum(['gstr9', 'gstr9-file', 'gstr9-inputs']).default('gstr9'),
  fy: FY.optional(),
  branchId: z.string().optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const fy = q.fy ?? lastFullYear();
    const branchId = q.branchId ? Number(q.branchId) : undefined;
    switch (q.view) {
      case 'gstr9':
        return { view: q.view, ...(await gstr9(db, orgId, fy, branchId, { today: localToday() })) };
      // Exactly the GSTN's schema, with nothing of ours mixed in.
      case 'gstr9-file':
        return gstr9PortalJson(await gstr9(db, orgId, fy, branchId, { today: localToday() }));
      case 'gstr9-inputs':
        return { view: q.view, fy, inputs: await gstr9Inputs(db, orgId, fy) };
    }
  },
  { permission: { module: 'gst', action: 'view' } },
);

const PAISE = z.number().int('Amounts are in whole paise.').min(0, 'Enter the amount, not a negative figure.').max(1e15);
const CS = z.object({ cgstPaise: PAISE, sgstPaise: PAISE });
const OTHER = z.object({
  description: z.string().trim().min(2, 'Say what it is.').max(100),
  igstPaise: PAISE, cgstPaise: PAISE, sgstPaise: PAISE, cessPaise: PAISE,
});
const AMOUNTS = z.object({
  igstPaise: PAISE, cgstPaise: PAISE, sgstPaise: PAISE, cessPaise: PAISE,
  interestPaise: PAISE, penaltyPaise: PAISE, lateFeePaise: PAISE,
});
const Inputs = z.object({
  tran1: CS, tran2: CS, tran1Reversed: CS, tran2Reversed: CS,
  otherItc: z.array(OTHER).max(20),
  otherReversals: z.array(OTHER).max(20),
  table15: z.object(Object.fromEntries(TABLE15_KEYS.map((k) => [k, AMOUNTS])) as Record<(typeof TABLE15_KEYS)[number], typeof AMOUNTS>),
  lateFeePaid: CS,
  penaltyPaise: PAISE,
  otherPaidPaise: PAISE,
});

const rs = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Save (or correct) the preparer's rows for a year. */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ fy: FY, inputs: Inputs }));
    return transaction(async (trx) => {
      const before = await gstr9Inputs(trx, orgId, input.fy);
      const value = JSON.stringify(input.inputs);
      await trx.insertInto('settings')
        .values({ org_id: orgId, scope: 'gstr9', setting_key: String(input.fy), value, updated_by_user_id: user.userId })
        .onDuplicateKeyUpdate({ value, updated_by_user_id: user.userId })
        .execute();
      const t15 = TABLE15_KEYS.reduce((t, k) => {
        const a = input.inputs.table15[k];
        return t + a.igstPaise + a.cgstPaise + a.sgstPaise + a.cessPaise + a.interestPaise + a.penaltyPaise + a.lateFeePaise;
      }, 0);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: inputsAreEmpty(before) ? 'create' : 'update',
        targetType: 'gstr9', targetId: input.fy, targetLabel: `GSTR-9 FY ${input.fy}-${String((input.fy + 1) % 100).padStart(2, '0')}`,
        detail: `GSTR-9 entries saved: table 15 ${rs(t15)}, TRAN credit ${rs(input.inputs.tran1.cgstPaise + input.inputs.tran1.sgstPaise + input.inputs.tran2.cgstPaise + input.inputs.tran2.sgstPaise)}, `
          + `${input.inputs.otherItc.length} other credit and ${input.inputs.otherReversals.length} other reversal line(s), late fee paid ${rs(input.inputs.lateFeePaid.cgstPaise + input.inputs.lateFeePaid.sgstPaise)}`,
        payload: { changes: { before, after: input.inputs } },
        ...auditMeta(req),
      });
      return { fy: input.fy, inputs: await gstr9Inputs(trx, orgId, input.fy) };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);

/** Take the preparer's rows for a year off: the return goes back to the documents alone. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ fy: FY }));
    return transaction(async (trx) => {
      const before = await gstr9Inputs(trx, orgId, q.fy);
      const r = await trx.deleteFrom('settings')
        .where('org_id', '=', orgId).where('scope', '=', 'gstr9').where('setting_key', '=', String(q.fy))
        .executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw notFound('Nothing has been entered for that year.');
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'gstr9', targetId: q.fy, targetLabel: `GSTR-9 FY ${q.fy}-${String((q.fy + 1) % 100).padStart(2, '0')}`,
        detail: 'GSTR-9 entries deleted: tables 6K–6M, 7F–7H, 15 and 19 are back to nil',
        payload: { changes: { before, after: emptyGstr9Inputs() } },
        ...auditMeta(req),
      });
      return { fy: q.fy, deleted: true };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
