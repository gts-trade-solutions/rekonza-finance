import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  addOpeningDocument, listOpeningDocuments, openingSummary, setAccountOpenings, setBooksStartDate,
  voidOpeningDocument,
} from '@/lib/server/services/opening-balances';

// Opening balances. The summary and the changes belong to the accountant; the
// list of a party's open opening bills is also read by the receipt and
// payment screens, so it follows sales and purchases permissions.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

const Q = z.object({
  view: z.enum(['summary', 'documents']).default('summary'),
  contactId: z.string().optional(),
  kind: z.enum(['receivable', 'payable']).optional(),
  open: z.string().optional(),
});

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, Q);
  if (q.view === 'documents') {
    const area = q.kind === 'payable' ? 'purchases' : q.kind === 'receivable' ? 'sales' : 'accountant';
    if (!hasPermission(role, area, 'view')) throw forbidden('You cannot see these opening bills.');
    return {
      documents: await listOpeningDocuments(db, orgId, {
        contactId: q.contactId ? Number(q.contactId) : undefined,
        kind: q.kind,
        open: q.open === '1' || q.open === 'true',
      }),
    };
  }
  if (!hasPermission(role, 'accountant', 'view')) throw forbidden('Opening balances are for the accountant.');
  const [summary, documents] = await Promise.all([openingSummary(db, orgId), listOpeningDocuments(db, orgId)]);
  return { ...summary, documents };
});

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start-date'), date: DATE }),
  z.object({
    action: z.literal('accounts'),
    lines: z.array(z.object({ accountId: z.string(), netPaise: z.number().int() })).min(1),
  }),
  z.object({
    action: z.literal('document'),
    contactId: z.string(),
    kind: z.enum(['receivable', 'payable']),
    refNo: z.string().trim().min(1, 'Give the bill number.').max(50),
    docDate: DATE,
    dueDate: DATE,
    amountPaise: z.number().int().positive('Enter an amount above zero.'),
    notes: z.string().trim().max(500).nullish(),
  }),
  z.object({ action: z.literal('void-document'), id: z.string(), reason: z.string().trim().max(200).nullish() }),
]);

export const POST = route(
  async ({ orgId, user, branchId, req }) => {
    const input = await body(req, Input);
    const audit = (detail: string, payload?: unknown) => ({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update' as const,
      targetType: 'opening_balances', targetId: orgId, detail, payload, ...auditMeta(req),
    });

    switch (input.action) {
      case 'start-date':
        await transaction(async (trx) => {
          await setBooksStartDate(trx, orgId, input.date);
          await logAudit({ trx, ...audit(`Books start on ${input.date}`) });
        });
        return { ok: true };

      case 'accounts': {
        const r = await transaction(async (trx) => {
          const res = await setAccountOpenings(trx, orgId, user.userId, {
            branchId,
            lines: input.lines.map((l) => ({ accountId: Number(l.accountId), netPaise: l.netPaise })),
          });
          if (res.changed) await logAudit({ trx, ...audit(`Changed ${res.changed} ledger opening balance(s)`, input.lines) });
          return res;
        });
        return { changed: r.changed, entryId: r.entryId ? asId(r.entryId) : null };
      }

      case 'document': {
        const r = await transaction(async (trx) => {
          const res = await addOpeningDocument(trx, orgId, user.userId, {
            branchId, contactId: Number(input.contactId), kind: input.kind, refNo: input.refNo,
            docDate: input.docDate, dueDate: input.dueDate, amountPaise: input.amountPaise, notes: input.notes,
          });
          await logAudit({ trx, ...audit(`Opening ${input.kind} ${input.refNo} for ${(input.amountPaise / 100).toFixed(2)}`) });
          return res;
        });
        return { id: asId(r.id) };
      }

      case 'void-document':
        await transaction(async (trx) => {
          await voidOpeningDocument(trx, orgId, user.userId, Number(input.id), input.reason ?? undefined);
          await logAudit({ trx, ...audit(`Withdrew opening bill ${input.id}${input.reason ? ` — ${input.reason}` : ''}`) });
        });
        return { ok: true };
    }
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
