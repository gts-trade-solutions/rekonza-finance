import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, notFound, forbidden, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { accountsWithFigures, canSeeAccount, type Viewer } from '@/lib/server/services/bank-overview';
import { bestMatchesFor } from '@/lib/server/services/bank-match';
import { deleteBankAccount, setBankAccountActive, updateBankAccount } from '@/lib/server/services/bank-accounts';
import { AccountInput, accountJson } from '@/lib/server/bank-account-input';

// One bank or card account, as Zoho's account page heads it: the account and
// its figures, the other accounts for the switcher (with what the books hold
// in each), and the counts on its tabs and pills — Uncategorized, Best
// Matches, Recognized (lines a rule recognised), Excluded, and the cheques
// still waiting to clear. Edit, Mark as Active/Inactive and Delete too.

export const GET = route(
  async ({ orgId, user, role, params }) => {
    const id = idParam(params);
    const all = await accountsWithFigures(db, orgId, { status: 'all', viewer: { userId: user.userId, role } });
    const account = all.find((a) => a.id === id);
    if (!account) {
      const exists = await db.selectFrom('bank_accounts').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (exists) throw forbidden('This account is limited to some users, and you are not one of them.');
      throw notFound('That account does not exist.');
    }
    const lines = await db.selectFrom('bank_transactions').select(['id', 'status', 'applied_rule_id'])
      .where('org_id', '=', orgId).where('bank_account_id', '=', id).where('status', 'in', ['unmatched', 'excluded']).execute();
    const open = lines.filter((l) => l.status === 'unmatched');
    const best = await bestMatchesFor(db, orgId, open.map((l) => l.id));
    const { rows: cheques } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cheques WHERE org_id = ${orgId} AND status IN ('in_hand', 'deposited')`.execute(db);
    return {
      account: accountJson(account),
      others: all.filter((a) => a.isActive && a.id !== id).map((a) => ({
        id: asId(a.id), name: a.name, kind: a.kind, accountNumber: a.accountNumber ?? (a.accountLast4 ? `••••${a.accountLast4}` : null),
        amountInBooksPaise: a.amountInBooksPaise,
      })),
      counts: {
        uncategorized: open.length,
        bestMatches: open.filter((l) => (best.get(l.id)?.length ?? 0) > 0).length,
        recognized: open.filter((l) => l.applied_rule_id).length,
        excluded: lines.length - open.length,
        chequesPending: Number(cheques[0]?.n ?? 0),
      },
    };
  },
  { permission: { module: 'banking', action: 'view' } },
);

async function visible(orgId: number, id: number, viewer: Viewer) {
  const all = await accountsWithFigures(db, orgId, { status: 'all' });
  const a = all.find((x) => x.id === id);
  if (!a) throw notFound('That account does not exist.');
  if (!canSeeAccount(a, viewer)) throw forbidden('This account is limited to some users, and you are not one of them.');
  return a;
}

export const PUT = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    await visible(orgId, id, { userId: user.userId, role });
    const input = await body(req, AccountInput.omit({ kind: true, openingBalancePaise: true, openingDate: true }));
    await transaction((trx) => updateBankAccount(trx, orgId, id, {
      ...input, accountNumber: input.accountNumber ?? input.accountLast4 ?? null, userIds: input.userIds?.map(Number) ?? null,
    }));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bank_account', targetId: id,
      targetLabel: input.name.trim(), detail: 'Account details edited', ...auditMeta(req),
    });
    return { id: asId(id) };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

export const PATCH = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    await visible(orgId, id, { userId: user.userId, role });
    const input = await body(req, z.object({ isActive: z.boolean() }));
    const r = await transaction((trx) => setBankAccountActive(trx, orgId, id, input.isActive));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bank_account', targetId: id,
      targetLabel: r.name, detail: input.isActive ? 'Marked as active' : 'Marked as inactive', ...auditMeta(req),
    });
    return { id: asId(id), isActive: r.isActive };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    await visible(orgId, id, { userId: user.userId, role });
    const r = await transaction((trx) => deleteBankAccount(trx, orgId, id));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'bank_account', targetId: id,
      targetLabel: r.name, detail: 'Account deleted (nothing had been posted to it)', ...auditMeta(req),
    });
    return { id: asId(id) };
  },
  { permission: { module: 'banking', action: 'void' } },
);
