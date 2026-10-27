import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { bankBalances, createBankAccount } from '@/lib/server/services/banking';
import { logAudit, auditMeta } from '@/lib/server/audit';

export const GET = route(
  async ({ orgId }) => {
    const [accounts, balances] = await Promise.all([
      db.selectFrom('bank_accounts')
        .select(['id', 'kind', 'name', 'bank_name', 'account_last4', 'ifsc',
                 'ledger_account_id', 'opening_balance', 'is_primary', 'feed_connected'])
        .where('org_id', '=', orgId).where('is_active', '=', 1)
        .orderBy('is_primary', 'desc').orderBy('name').execute(),
      db.transaction().execute((trx) => bankBalances(trx, orgId)),
    ]);
    const byId = new Map(balances.map((b) => [b.id, b]));

    return {
      accounts: accounts.map((a) => ({
        id: asId(a.id),
        kind: a.kind,
        name: a.name,
        bankName: a.bank_name,
        accountLast4: a.account_last4,
        ifsc: a.ifsc,
        ledgerAccountId: asId(a.ledger_account_id),
        isPrimary: !!a.is_primary,
        // Automatic feeds need a licensed aggregator; always false for now.
        feedConnected: !!a.feed_connected,
        balancePaise: byId.get(a.id)?.balancePaise ?? 0,
        unmatchedCount: byId.get(a.id)?.unmatched ?? 0,
      })),
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

const CreateInput = z.object({
  kind: z.enum(['bank', 'card', 'cash', 'wallet']),
  name: z.string().min(1, 'Give the account a name.'),
  bankName: z.string().nullish(),
  accountLast4: z.string().max(4).nullish(),
  ifsc: z.string().max(15).nullish(),
  openingBalancePaise: z.number().int().optional(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, CreateInput);
    const created = await transaction(async (trx) =>
      createBankAccount(trx, orgId, user.userId, input),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name,
      action: 'create', targetType: 'bank_account', targetId: created.id,
      targetLabel: input.name, detail: `Added ${input.kind} account ${input.name}`,
      ...auditMeta(req),
    });

    return {
      id: asId(created.id),
      ledgerAccountId: asId(created.ledgerAccountId),
      journalEntryId: created.journalEntryId ? asId(created.journalEntryId) : null,
    };
  },
  { permission: { module: 'banking', action: 'create' } },
);
