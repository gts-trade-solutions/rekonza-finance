import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { accountsWithFigures } from '@/lib/server/services/bank-overview';
import { addBankAccount } from '@/lib/server/services/bank-accounts';
import { AccountInput, accountJson } from '@/lib/server/bank-account-input';

// The bank, card and cash accounts: Zoho's "Active Accounts ▾" (active,
// inactive or all), with what the books hold, what the bank last said and how
// many statement lines wait. An account limited to some users (Zoho's "Users")
// is listed only for them, and for admins.

const ListQuery = z.object({ status: z.enum(['active', 'inactive', 'all']).default('active') });

export const GET = route(
  async ({ orgId, user, role, req }) => {
    const q = query(req, ListQuery);
    const accounts = await accountsWithFigures(db, orgId, { status: q.status, viewer: { userId: user.userId, role } });
    return { accounts: accounts.map(accountJson) };
  },
  { permission: { module: 'banking', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, AccountInput);
    const created = await transaction(async (trx) =>
      addBankAccount(trx, orgId, user.userId, {
        ...input,
        accountNumber: input.accountNumber ?? input.accountLast4 ?? null,
        userIds: input.userIds?.map(Number) ?? null,
      }),
    );

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name,
      action: 'create', targetType: 'bank_account', targetId: created.id,
      targetLabel: input.name.trim(), detail: `Added ${input.kind} account ${input.name.trim()}`,
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
