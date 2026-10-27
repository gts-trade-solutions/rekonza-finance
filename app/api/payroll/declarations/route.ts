import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { SECTIONS, listDeclarations, reviewProof, saveDeclaration, submitProof } from '@/lib/server/payroll/declarations';

// Investment declarations for the year, and the proofs that follow them.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ fy: z.coerce.number().int().min(2020).max(2100) }));
    return { fy: q.fy, sections: SECTIONS, declarations: await listDeclarations(db, orgId, q.fy) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const SECTION = z.enum(['80C', '80CCD1B', '80D', '80E', '80G', '80TTA', '24B', 'HRA', 'other']);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      id: Id.optional(), employeeId: Id, fyStart: z.number().int().min(2020).max(2100), section: SECTION,
      description: z.string().max(200).nullish(), declaredPaise: z.number().int().min(0),
    }));
    return transaction(async (trx) => {
      const id = await saveDeclaration(trx, orgId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'tax_declaration', targetId: id, targetLabel: `${input.section} declaration`,
        detail: `Declared ₹${(input.declaredPaise / 100).toFixed(2)} under ${input.section} for ${input.fyStart}-${String(input.fyStart + 1).slice(2)}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

const Patch = z.discriminatedUnion('action', [
  z.object({ action: z.literal('proof'), id: Id, provedPaise: z.number().int().min(0) }),
  z.object({ action: z.literal('review'), id: Id, accept: z.boolean(), provedPaise: z.number().int().min(0).optional(), note: z.string().max(300).nullish() }),
]);

export const PATCH = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Patch);
    if (input.action === 'review' && !hasPermission(role, 'payroll', 'approve')) throw forbidden('Checking proofs needs approval rights in payroll.');
    return transaction(async (trx) => {
      if (input.action === 'proof') await submitProof(trx, orgId, input.id, input.provedPaise);
      else await reviewProof(trx, orgId, user.userId, input.id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'review' && input.accept ? 'approve' : 'update',
        targetType: 'tax_declaration', targetId: input.id, targetLabel: 'Investment declaration',
        detail: input.action === 'proof' ? `Proof for ₹${(input.provedPaise / 100).toFixed(2)} submitted`
          : input.accept ? 'Proof accepted' : `Proof not accepted: ${input.note}`,
        ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);
