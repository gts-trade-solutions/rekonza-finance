import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest, conflict } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { assertFresh } from '@/lib/server/concurrency';
import { logAudit, auditMeta, snapshot, changesBetween, describeChanges } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// The chart of accounts.
//
// Two things here are deliberately not editable. A system account's code and
// type are referenced by the posting engine — Accounts Receivable is found by
// looking up '1100', not by name — so renaming is fine and retyping is not.
// And an account that has ever been posted to cannot change type either: doing
// so would silently move history between the balance sheet and the P&L.
// ─────────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense', 'all']).optional(),
  search: z.string().optional(),
  /** Include accounts somebody has switched off. */
  inactive: z.coerce.boolean().optional(),
  /** Balances as at this date. Omitted means no balances are computed. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, ListQuery);

    let base = db.selectFrom('accounts').where('org_id', '=', orgId);
    if (!q.inactive) base = base.where('is_active', '=', 1);
    if (q.type && q.type !== 'all') base = base.where('type', '=', q.type);
    if (q.search) {
      const term = `%${q.search}%`;
      base = base.where((eb) => eb.or([eb('name', 'like', term), eb('code', 'like', term)]));
    }

    const rows = await base
      .select(['id', 'code', 'name', 'type', 'subtype', 'parent_id', 'description', 'is_system', 'is_active'])
      .orderBy('code')
      .execute();

    // Movement per account, so the screen can say which accounts are actually
    // in use — and refuse to delete the ones that are.
    const { rows: movement } = await sql<{ id: number; dr: string; cr: string; n: string }>`
      SELECT account_id AS id,
             COALESCE(SUM(debit), 0) AS dr,
             COALESCE(SUM(credit), 0) AS cr,
             COUNT(*) AS n
        FROM journal_lines
       WHERE org_id = ${orgId}
         ${q.asOf ? sql`AND entry_date <= ${q.asOf}` : sql``}
       GROUP BY account_id
    `.execute(db);
    const moveBy = new Map(movement.map((m) => [m.id, m]));

    return {
      accounts: rows.map((a) => {
        const m = moveBy.get(a.id);
        const dr = toPaiseFromSql(m?.dr ?? '0');
        const cr = toPaiseFromSql(m?.cr ?? '0');
        // Shown in the account's own direction so nothing reads negative merely
        // because it is credit-normal.
        const debitNormal = a.type === 'asset' || a.type === 'expense';
        return {
          id: asId(a.id),
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          parentId: a.parent_id === null ? null : asId(a.parent_id),
          description: a.description,
          isSystem: !!a.is_system,
          isActive: !!a.is_active,
          debitPaise: dr,
          creditPaise: cr,
          balancePaise: debitNormal ? dr - cr : cr - dr,
          lineCount: Number(m?.n ?? 0),
        };
      }),
    };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const AccountInput = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z.-]{2,20}$/, 'A code is 2–20 characters, digits or letters.'),
  name: z.string().trim().min(1, 'An account needs a name.').max(150),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  subtype: z.string().trim().max(50).nullish(),
  parentId: z.union([z.string(), z.number()]).nullish(),
  description: z.string().trim().max(500).nullish(),
});

const UpdateInput = AccountInput.partial().extend({
  id: z.string(),
  isActive: z.boolean().optional(),
  /** The record's updatedAt as it was read: the edit is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, AccountInput);

    const dup = await db
      .selectFrom('accounts').select('id')
      .where('org_id', '=', orgId).where('code', '=', input.code).executeTakeFirst();
    if (dup) throw conflict(`Account code ${input.code} is already in use.`);

    if (input.parentId) {
      const parent = await db
        .selectFrom('accounts').select(['id', 'type'])
        .where('id', '=', Number(input.parentId)).where('org_id', '=', orgId).executeTakeFirst();
      if (!parent) throw badRequest('That parent account does not exist.');
      if (parent.type !== input.type) {
        throw badRequest(
          `A ${input.type} account cannot sit under a ${parent.type} one — the totals would not add up.`,
        );
      }
    }

    const inserted = await db
      .insertInto('accounts')
      .values({
        org_id: orgId,
        code: input.code,
        name: input.name,
        type: input.type,
        subtype: input.subtype ?? null,
        parent_id: input.parentId ? Number(input.parentId) : null,
        description: input.description ?? null,
        is_system: 0,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'account', targetId: id, targetLabel: `${input.code} ${input.name}`,
      detail: `Added ${input.type} account ${input.code} — ${input.name}`, ...auditMeta(req),
    });

    return { id: asId(id), code: input.code, name: input.name };
  },
  { permission: { module: 'accountant', action: 'create' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, UpdateInput);
    const id = Number(input.id);

    const existing = await db
      .selectFrom('accounts')
      .select(['id', 'code', 'name', 'type', 'is_system'])
      .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw badRequest('That account does not exist.');
    await assertFresh(db, 'accounts', orgId, id, input.expectedUpdatedAt, existing.name);

    const used = await db
      .selectFrom('journal_lines').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('account_id', '=', id).executeTakeFirst();
    const hasPostings = Number(used?.n ?? 0) > 0;

    if (input.type && input.type !== existing.type) {
      if (existing.is_system) {
        throw conflict(
          `${existing.code} is a system account — the posting engine finds it by code and expects it to be ` +
            `a ${existing.type}. Its name can change; its type cannot.`,
        );
      }
      if (hasPostings) {
        throw conflict(
          `${existing.code} has ${used?.n} posting(s) against it. Changing its type would move that history ` +
            'between the balance sheet and the profit and loss. Create a new account instead.',
        );
      }
    }

    if (input.code && input.code !== existing.code && existing.is_system) {
      throw conflict(`${existing.code} is a system account and is found by its code. The code cannot change.`);
    }

    if (input.isActive === false && hasPostings) {
      // Deactivating is fine — it only hides the account from pickers — but a
      // system account must stay available or the next posting fails.
      if (existing.is_system) {
        throw conflict(`${existing.code} is used by the posting engine and cannot be switched off.`);
      }
    }

    const patch: Record<string, unknown> = {};
    const set = (col: string, v: unknown) => { if (v !== undefined) patch[col] = v; };
    set('code', input.code);
    set('name', input.name);
    set('type', input.type);
    set('subtype', input.subtype);
    set('parent_id', input.parentId === undefined ? undefined : input.parentId ? Number(input.parentId) : null);
    set('description', input.description);
    set('is_active', input.isActive === undefined ? undefined : input.isActive ? 1 : 0);

    const before = await snapshot(db, 'accounts', orgId, id, Object.keys(patch));
    if (Object.keys(patch).length) {
      await db.updateTable('accounts').set(patch).where('id', '=', id).where('org_id', '=', orgId).execute();
    }
    const changes = changesBetween(before, patch);

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'account', targetId: id, targetLabel: `${existing.code} ${existing.name}`,
      detail: input.isActive === false ? `Switched off ${existing.code}` : `Updated ${existing.code}: ${describeChanges(changes)}`,
      payload: { changes }, ...auditMeta(req),
    });

    return { id: asId(id) };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);

/**
 * Delete an account.
 *
 * Only ever possible for one nobody has posted to. An account with history is
 * part of the audit trail, and removing it would leave entries pointing at
 * nothing — switch it off instead, which hides it from pickers and leaves every
 * report exactly as it was.
 */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const { id } = query(req, z.object({ id: z.string() }));
    const numeric = Number(id);

    const existing = await db
      .selectFrom('accounts').select(['id', 'code', 'name', 'is_system'])
      .where('id', '=', numeric).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw badRequest('That account does not exist.');
    if (existing.is_system) throw conflict(`${existing.code} is a system account and cannot be deleted.`);

    const [lines, children] = await Promise.all([
      db.selectFrom('journal_lines').select(sql<string>`COUNT(*)`.as('n'))
        .where('org_id', '=', orgId).where('account_id', '=', numeric).executeTakeFirst(),
      db.selectFrom('accounts').select(sql<string>`COUNT(*)`.as('n'))
        .where('org_id', '=', orgId).where('parent_id', '=', numeric).executeTakeFirst(),
    ]);

    if (Number(lines?.n ?? 0) > 0) {
      throw conflict(
        `${existing.code} has ${lines?.n} posting(s) against it. Switch it off instead — deleting it would ` +
          'leave those entries pointing at nothing.',
      );
    }
    if (Number(children?.n ?? 0) > 0) {
      throw conflict(`${existing.code} has sub-accounts under it. Move or remove those first.`);
    }

    await transaction(async (trx) => {
      await trx.deleteFrom('accounts').where('id', '=', numeric).where('org_id', '=', orgId).execute();
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'account', targetId: numeric, targetLabel: `${existing.code} ${existing.name}`,
        detail: `Deleted unused account ${existing.code}`, trx, ...auditMeta(req),
      });
    });

    return { id: asId(numeric) };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
