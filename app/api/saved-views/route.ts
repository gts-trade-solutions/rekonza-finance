import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, query, asId, notFound, forbidden } from '@/lib/server/http';

// Saved views: a list's filters under a name — "Overdue, this quarter" — for
// the person who saved it, or shared with everyone in the company.

const LIST = z.enum(['invoices', 'bills', 'expenses', 'payments-received', 'payments-made', 'contacts']);

export const GET = route(async ({ orgId, user, req }) => {
  const { list } = query(req, z.object({ list: LIST }));
  const rows = await db.selectFrom('saved_views').selectAll()
    .where('org_id', '=', orgId).where('list', '=', list)
    .where((eb) => eb.or([eb('user_id', '=', user.userId), eb('is_shared', '=', 1)]))
    .orderBy('name').execute();
  return {
    views: rows.map((v) => ({
      id: asId(v.id), name: v.name, shared: !!v.is_shared, mine: v.user_id === user.userId,
      filters: typeof v.filters === 'string' ? JSON.parse(v.filters) : v.filters,
    })),
  };
});

const Input = z.object({
  list: LIST,
  name: z.string().trim().min(1, 'Name the view.').max(80),
  filters: z.record(z.string(), z.unknown()),
  shared: z.boolean().optional(),
});

export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, Input);
  if (JSON.stringify(input.filters).length > 4000) throw forbidden('That view holds too much.');
  const r = await db.insertInto('saved_views').values({
    org_id: orgId, user_id: user.userId, list: input.list, name: input.name, filters: JSON.stringify(input.filters), is_shared: input.shared ? 1 : 0,
  }).executeTakeFirstOrThrow();
  return { id: asId(Number(r.insertId)) };
});

export const DELETE = route(async ({ orgId, user, req }) => {
  const { id } = query(req, z.object({ id: z.coerce.number().int().positive() }));
  const v = await db.selectFrom('saved_views').select(['user_id']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!v) throw notFound('That view does not exist.');
  if (v.user_id !== user.userId) throw forbidden('Only the person who saved a view can delete it.');
  await db.deleteFrom('saved_views').where('id', '=', id).execute();
  return { id: asId(id) };
});
