import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

// The document library: contracts, agreements, certificates, licences and the
// like that belong to the business rather than to one voucher. Each holds its
// files (attached to type 'document') and, where it has one, an expiry date
// that the exceptions register watches (services/exceptions.ts).

const CATEGORY = z.enum(['contract', 'agreement', 'certificate', 'licence', 'policy', 'statutory', 'other']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null));

export const GET = route(async ({ orgId, req }) => {
  const q = query(req, z.object({ category: CATEGORY.optional(), archived: z.coerce.boolean().optional(), search: z.string().max(100).optional() }));
  const rows = await db.selectFrom('documents as d').leftJoin('contacts as c', 'c.id', 'd.contact_id')
    .select(['d.id', 'd.title', 'd.category', 'd.reference', 'd.issued_on', 'd.expires_on', 'd.notes', 'd.contact_id', 'd.created_at', 'd.archived_at', 'c.display_name as party',
      sql<string>`(SELECT COUNT(*) FROM files f WHERE f.org_id = d.org_id AND f.attached_to_type = 'document' AND f.attached_to_id = d.id AND f.deleted_at IS NULL)`.as('files')])
    .where('d.org_id', '=', orgId)
    .$if(!q.archived, (b) => b.where('d.archived_at', 'is', null))
    .$if(!!q.category, (b) => b.where('d.category', '=', q.category!))
    .$if(!!q.search, (b) => b.where((eb) => eb.or([eb('d.title', 'like', `%${q.search}%`), eb('d.reference', 'like', `%${q.search}%`), eb('c.display_name', 'like', `%${q.search}%`)])))
    .orderBy('d.created_at', 'desc').limit(500).execute();
  return {
    documents: rows.map((r) => ({
      id: asId(r.id), title: r.title, category: r.category, reference: r.reference, notes: r.notes,
      issuedOn: r.issued_on ? String(r.issued_on).slice(0, 10) : null, expiresOn: r.expires_on ? String(r.expires_on).slice(0, 10) : null,
      contactId: r.contact_id ? asId(r.contact_id) : null, party: r.party ?? null, files: Number(r.files),
      createdAt: new Date(r.created_at).toISOString(), archived: !!r.archived_at,
    })),
  };
}, { permission: { module: 'accountant', action: 'view' } });

const Input = z.object({
  title: z.string().trim().min(2, 'Give the document a title.').max(200),
  category: CATEGORY,
  contactId: z.coerce.number().int().positive().nullish(),
  reference: z.string().trim().max(100).nullish(),
  issuedOn: date,
  expiresOn: date,
  notes: z.string().trim().max(1000).nullish(),
});

export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, Input);
  const id = Number((await db.insertInto('documents').values({
    org_id: orgId, title: input.title, category: input.category, contact_id: input.contactId ?? null, reference: input.reference ?? null,
    issued_on: input.issuedOn ?? null, expires_on: input.expiresOn ?? null, notes: input.notes ?? null, created_by_user_id: user.userId,
  }).executeTakeFirstOrThrow()).insertId);
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'document', targetId: id, targetLabel: input.title,
    detail: `Added ${input.category} "${input.title}" to the document library`, ...auditMeta(req),
  });
  return { id: asId(id) };
}, { permission: { module: 'accountant', action: 'create' } });
