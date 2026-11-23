import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { addAccountTransaction } from '@/lib/server/services/bank-match';
import { BANK_CATEGORIES } from '@/lib/bank-categories';

// Zoho's "Add Transaction ▾" on a bank account: money in or out recorded
// straight from the account (services/bank-match.ts addAccountTransaction),
// through the same postings as categorising a statement line would. When the
// statement arrives, its line is matched to what was entered here.

const KINDS = ['credit_note_refund', 'retainer_payment', ...BANK_CATEGORIES.map((c) => c.key)] as [string, ...string[]];
const Id = z.union([z.string(), z.number()]).transform(Number);

const Input = z.object({
  kind: z.enum(KINDS),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  reference: z.string().max(100).nullish(),
  notes: z.string().max(500).nullish(),
  contactId: Id.nullish(),
  accountId: Id.nullish(),
  otherBankAccountId: Id.nullish(),
  gstRatePct: z.number().min(0).max(40).nullish(),
  itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).optional(),
  paymentId: Id.nullish(),
  creditNoteId: Id.nullish(),
  retainerId: Id.nullish(),
  allocations: z.array(z.object({ targetId: Id, amountPaise: z.number().int().nonnegative() })).max(200).optional(),
  bankChargesPaise: z.number().int().nonnegative().optional(),
  tdsPaise: z.number().int().nonnegative().optional(),
});

export const POST = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Input);
    const r = await transaction((trx) => addAccountTransaction(trx, orgId, user.userId, id, {
      ...input,
      kind: input.kind as Parameters<typeof addAccountTransaction>[4]['kind'],
    }));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'bank_account', targetId: id,
      targetLabel: r.created ?? input.kind, detail: `Add Transaction: ${input.kind.replace(/_/g, ' ')} of ${(input.amountPaise / 100).toFixed(2)} on ${input.date}`,
      ...auditMeta(req),
    });
    return r;
  },
  { permission: { module: 'banking', action: 'create' } },
);
