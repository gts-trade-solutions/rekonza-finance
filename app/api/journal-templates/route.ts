import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteJournalTemplate, listJournalTemplates, saveJournalTemplate } from '@/lib/server/services/accountant-tools';

// Journal templates (services/accountant-tools.ts): kept to fill the journal form again.

export const GET = route(
  async ({ orgId }) => ({ templates: await listJournalTemplates(db, orgId) }),
  { permission: { module: 'accountant', action: 'view' } },
);

const ID = z.union([z.string(), z.number()]).transform(Number);
const Line = z.object({
  accountId: ID, debitPaise: z.number().int().min(0).default(0), creditPaise: z.number().int().min(0).default(0),
  description: z.string().max(300).nullish(), contactId: ID.nullish(), costCentreId: ID.nullish(),
});
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: ID.nullish(), name: z.string().trim().min(1).max(150), memo: z.string().max(500).nullish(), withAmounts: z.boolean(), lines: z.array(Line).min(2).max(50) }),
  z.object({ action: z.literal('delete'), id: ID }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Input);
  if (!hasPermission(role, 'accountant', 'create')) throw forbidden('You cannot change journal templates.');
  if (input.action === 'delete') {
    return transaction(async (trx) => {
      const name = await deleteJournalTemplate(trx, orgId, input.id);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'journal_template', targetId: input.id, targetLabel: name, detail: `Deleted journal template ${name}`, ...auditMeta(req) });
      return { ok: true };
    });
  }
  return transaction(async (trx) => {
    const id = await saveJournalTemplate(trx, orgId, user.userId, {
      id: input.id ?? null, name: input.name, memo: input.memo ?? null, withAmounts: input.withAmounts,
      lines: input.lines.map((l) => ({ accountId: l.accountId, debitPaise: l.debitPaise, creditPaise: l.creditPaise, description: l.description ?? null, contactId: l.contactId ?? null, costCentreId: l.costCentreId ?? null })),
    });
    await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'journal_template', targetId: id, targetLabel: input.name, detail: `${input.id ? 'Changed' : 'Saved'} journal template ${input.name}`, ...auditMeta(req) });
    return { id: String(id) };
  });
});
