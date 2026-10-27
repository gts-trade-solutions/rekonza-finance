import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, query, asId, badRequest, conflict } from '@/lib/server/http';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';
import { hsnRateHistory } from '@/lib/server/tax/rates';

// ─────────────────────────────────────────────────────────────────────────────
// The organisation's approved HSN and SAC codes.
//
// This is a curated list, not free text, and that is the whole point. GSTR-1
// Table 12 is validated against the government's master; a code that is not on
// it bounces the entire return, not just the line that used it. So an admin
// approves the handful of codes the business actually trades in, and every
// invoice line is checked against that list on the server.
//
// A SAC always begins 99 and describes a service. An HSN describes goods. The
// two are not interchangeable and the classification decides which GSTR-1 table
// the supply is reported in.
// ─────────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  kind: z.enum(['hsn', 'sac', 'all']).optional(),
  /** Prefix match, as the invoice picker uses: typing 8 lists every 8xxx. */
  prefix: z.string().optional(),
  search: z.string().optional(),
  activeOnly: z.coerce.boolean().optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db.selectFrom('hsn_codes').where('org_id', '=', orgId);
    if (q.kind && q.kind !== 'all') base = base.where('kind', '=', q.kind);
    if (q.activeOnly) base = base.where('is_active', '=', 1);
    if (q.prefix) base = base.where('code', 'like', `${q.prefix}%`);
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) => eb.or([eb('code', 'like', term), eb('description', 'like', term)]));
    }

    const rows = await base
      .select(['id', 'code', 'kind', 'description', 'gst_rate_pct', 'cess_rate_pct', 'uqc', 'is_active'])
      .orderBy('code')
      .execute();

    // How many items and invoice lines lean on each code. A code in use cannot
    // be deactivated without orphaning those lines at filing time.
    const codes = rows.map((r) => r.code);
    const [itemUse, lineUse] = codes.length
      ? await Promise.all([
          db.selectFrom('items')
            .select(['hsn_sac as code', sql<string>`COUNT(*)`.as('n')])
            .where('org_id', '=', orgId).where('hsn_sac', 'in', codes)
            .where('is_archived', '=', 0)
            .groupBy('hsn_sac').execute(),
          db.selectFrom('invoice_lines')
            .innerJoin('invoices', 'invoices.id', 'invoice_lines.invoice_id')
            .select(['invoice_lines.hsn_sac as code', sql<string>`COUNT(*)`.as('n')])
            .where('invoices.org_id', '=', orgId).where('invoice_lines.hsn_sac', 'in', codes)
            .groupBy('invoice_lines.hsn_sac').execute(),
        ])
      : [[], []];
    const history = await hsnRateHistory(db, orgId);
    const itemsBy = new Map(itemUse.map((r) => [r.code, Number(r.n)]));
    const linesBy = new Map(lineUse.map((r) => [r.code, Number(r.n)]));

    return {
      hsnCodes: rows.map((h) => ({
        id: asId(h.id),
        code: h.code,
        kind: h.kind,
        description: h.description,
        gstRatePct: Number(h.gst_rate_pct),
        cessRatePct: Number(h.cess_rate_pct),
        rates: history.get(h.code) ?? [],
        uqc: h.uqc,
        isActive: !!h.is_active,
        itemCount: itemsBy.get(h.code) ?? 0,
        lineCount: linesBy.get(h.code) ?? 0,
      })),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const CodeInput = z.object({
  code: z.string().trim().regex(/^\d{4,8}$/, 'An HSN or SAC is 4 to 8 digits.'),
  description: z.string().trim().min(1, 'Describe what this code covers.').max(300),
  gstRatePct: z.number().min(0).max(50),
  // Ad valorem compensation cess. Some goods have run well above GST itself.
  cessRatePct: z.number().min(0).max(300).optional(),
  uqc: z.string().trim().max(10).nullish(),
});

const UpdateInput = z.object({
  id: z.string(),
  description: z.string().trim().min(1).max(300).optional(),
  gstRatePct: z.number().min(0).max(50).optional(),
  cessRatePct: z.number().min(0).max(300).optional(),
  uqc: z.string().trim().max(10).nullish(),
  isActive: z.boolean().optional(),
});

/** SAC codes begin 99; everything else is an HSN. */
const kindOf = (code: string): 'hsn' | 'sac' => (code.startsWith('99') ? 'sac' : 'hsn');

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CodeInput);

    const dup = await db
      .selectFrom('hsn_codes').select('id')
      .where('org_id', '=', orgId).where('code', '=', input.code).executeTakeFirst();
    if (dup) throw conflict(`${input.code} is already on the list.`);

    const inserted = await db
      .insertInto('hsn_codes')
      .values({
        org_id: orgId,
        code: input.code,
        kind: kindOf(input.code),
        description: input.description,
        gst_rate_pct: input.gstRatePct,
        cess_rate_pct: input.cessRatePct ?? 0,
        uqc: input.uqc ?? null,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'hsn_code', targetId: id, targetLabel: input.code,
      detail: `Approved ${kindOf(input.code).toUpperCase()} ${input.code} — ${input.description}`,
      ...auditMeta(req),
    });

    return { id: asId(id), code: input.code, kind: kindOf(input.code) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, UpdateInput);
    const id = Number(input.id);

    const existing = await db
      .selectFrom('hsn_codes').select(['id', 'code', 'description'])
      .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw badRequest('That code is not on the list.');

    if (input.isActive === false) {
      const inUse = await db
        .selectFrom('items').select(sql<string>`COUNT(*)`.as('n'))
        .where('org_id', '=', orgId).where('hsn_sac', '=', existing.code)
        .where('is_archived', '=', 0).executeTakeFirst();
      if (Number(inUse?.n ?? 0) > 0) {
        throw conflict(
          `${existing.code} is on ${inUse?.n} active item(s). Change those first — deactivating it now would ` +
            'leave them unable to be invoiced.',
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (input.description !== undefined) patch.description = input.description;
    if (input.gstRatePct !== undefined) patch.gst_rate_pct = input.gstRatePct;
    if (input.cessRatePct !== undefined) patch.cess_rate_pct = input.cessRatePct;
    if (input.uqc !== undefined) patch.uqc = input.uqc;
    if (input.isActive !== undefined) patch.is_active = input.isActive ? 1 : 0;

    const before = await snapshot(db, 'hsn_codes', orgId, id, Object.keys(patch));
    if (Object.keys(patch).length) {
      await db.updateTable('hsn_codes').set(patch).where('id', '=', id).where('org_id', '=', orgId).execute();
    }
    const changes = changesBetween(before, patch);

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'hsn_code', targetId: id, targetLabel: existing.code,
      detail: input.isActive === false ? `Deactivated ${existing.code}` : `Updated ${existing.code}: ${describeChanges(changes)}`,
      payload: { changes }, ...auditMeta(req),
    });

    return { id: asId(id) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);

/**
 * Remove a code from the list.
 *
 * Refused the moment anything references it. A posted invoice must always be
 * able to report the code it was filed under, so a code that has ever reached a
 * line is deactivated rather than deleted — that hides it from new documents
 * and leaves every filed one exactly as it was.
 */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.string() }));
    const numeric = Number(id);

    const existing = await db
      .selectFrom('hsn_codes').select(['id', 'code'])
      .where('id', '=', numeric).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw badRequest('That code is not on the list.');

    const [itemRows, lineRows] = await Promise.all([
      db.selectFrom('items').select(sql<string>`COUNT(*)`.as('n'))
        .where('org_id', '=', orgId).where('hsn_sac', '=', existing.code).executeTakeFirst(),
      db.selectFrom('invoice_lines')
        .innerJoin('invoices', 'invoices.id', 'invoice_lines.invoice_id')
        .select(sql<string>`COUNT(*)`.as('n'))
        .where('invoices.org_id', '=', orgId)
        .where('invoice_lines.hsn_sac', '=', existing.code).executeTakeFirst(),
    ]);
    const used = Number(itemRows?.n ?? 0) + Number(lineRows?.n ?? 0);
    if (used > 0) {
      throw conflict(
        `${existing.code} is used on ${used} item(s) or invoice line(s). Turn it off instead — deleting it would ` +
          'leave those documents unable to report the code they were filed under.',
      );
    }

    await db.deleteFrom('hsn_codes').where('id', '=', numeric).where('org_id', '=', orgId).execute();
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'hsn_code', targetId: numeric, targetLabel: existing.code,
      detail: `Removed ${existing.code} from the approved list`, ...auditMeta(req),
    });

    return { id: asId(numeric) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
