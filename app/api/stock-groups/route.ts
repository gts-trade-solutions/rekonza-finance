import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, badRequest, conflict, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

// Stock groups: how items are gathered in the stock reports (Spares, Lubricants,
// Tyres), one inside another where that helps.

export const GET = route(
  async ({ orgId }) => {
    const rows = await db.selectFrom('stock_groups as g')
      .leftJoin('items as i', (j) => j.onRef('i.stock_group_id', '=', 'g.id').on('i.is_archived', '=', 0))
      .select((eb) => ['g.id', 'g.name', 'g.parent_id', eb.fn.count<number>('i.id').as('items')])
      .where('g.org_id', '=', orgId).groupBy(['g.id', 'g.name', 'g.parent_id']).orderBy('g.name').execute();
    return { groups: rows.map((r) => ({ id: asId(r.id), name: r.name, parentId: r.parent_id ? asId(r.parent_id) : null, items: Number(r.items) })) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      id: z.coerce.number().int().positive().optional(), name: z.string().trim().min(1, 'Give the group a name.').max(100),
      parentId: z.coerce.number().int().positive().nullish(),
    }));
    return transaction(async (trx) => {
      if (input.parentId) {
        const parent = await trx.selectFrom('stock_groups').select(['id', 'parent_id']).where('id', '=', input.parentId).where('org_id', '=', orgId).executeTakeFirst();
        if (!parent) throw notFound('That parent group does not exist.');
        // A group cannot sit inside itself, however far down.
        for (let at: number | null = parent.id, n = 0; at && n < 20; n++) {
          if (at === input.id) throw badRequest('A group cannot sit inside itself.');
          at = (await trx.selectFrom('stock_groups').select('parent_id').where('id', '=', at).executeTakeFirst())?.parent_id ?? null;
        }
      }
      const clash = await trx.selectFrom('stock_groups').select('id').where('org_id', '=', orgId).where('name', '=', input.name)
        .$if(!!input.id, (q) => q.where('id', '<>', input.id!)).executeTakeFirst();
      if (clash) throw conflict(`There is already a group called ${input.name}.`);
      let id = input.id;
      if (id) {
        const r = await trx.updateTable('stock_groups').set({ name: input.name, parent_id: input.parentId ?? null })
          .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw notFound('That group does not exist.');
      } else {
        id = Number((await trx.insertInto('stock_groups').values({ org_id: orgId, name: input.name, parent_id: input.parentId ?? null }).executeTakeFirstOrThrow()).insertId);
      }
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'stock_group', targetId: id, targetLabel: input.name, detail: `Stock group ${input.name}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);
