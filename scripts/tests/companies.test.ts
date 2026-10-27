// Several companies, one person: moving between them with each company's own
// rules, making a new one, and their statements together.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/companies.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createCompany, myCompanies, switchCompany } from '../../lib/server/auth/companies';
import { consolidatedStatements } from '../../lib/server/reports/consolidated';
import type { SessionUser } from '../../lib/server/auth/session';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function company(trx: Trx, name: string) {
  const orgId = Number((await trx.insertInto('organizations').values({ name }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name, state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  return { orgId, branchId };
}

test('moving between companies, each on its own terms; a new company with the same password; statements together', async () => {
  await rolledBack(async (trx) => {
    const email = `owner-${Date.now()}@example.test`;
    const a = await company(trx, 'Alpha Traders');
    const b = await company(trx, 'Beta Exports');
    const c = await company(trx, 'Gamma Stores');
    const user = async (orgId: number, role: 'admin' | 'accountant' | 'staff') => Number((await trx.insertInto('users').values({
      org_id: orgId, name: 'Owner', email, role, password_hash: 'argon-hash-1',
    }).executeTakeFirstOrThrow()).insertId);
    const ua = await user(a.orgId, 'admin');
    const ub = await user(b.orgId, 'accountant');
    await user(c.orgId, 'staff');
    const me = { userId: ua, orgId: a.orgId, name: 'Owner', email, role: 'admin', homeBranchId: a.branchId, activeBranchId: a.branchId } as SessionUser;

    assert.deepEqual((await myCompanies(trx, email)).map((x) => [x.name, x.role]), [['Alpha Traders', 'admin'], ['Beta Exports', 'accountant'], ['Gamma Stores', 'staff']]);

    await trx.insertInto('sessions').values({ token_hash: `s-${ua}`, user_id: ua, org_id: a.orgId, expires_at: new Date(Date.now() + 3_600_000) } as never).execute();
    await switchCompany(trx, me, `s-${ua}`, b.orgId, { ip: null, userAgent: null });
    const moved = await trx.selectFrom('sessions').select(['user_id', 'org_id', 'active_branch_id']).where('token_hash', '=', `s-${ua}`).executeTakeFirstOrThrow();
    assert.deepEqual([moved.user_id, moved.org_id, moved.active_branch_id], [ub, b.orgId, b.branchId], 'now their user in Beta, at its branch');

    const stranger = await company(trx, 'Delta');
    await assert.rejects(switchCompany(trx, me, `s-${ua}`, stranger.orgId, { ip: null, userAgent: null }), /do not have access/);
    await trx.updateTable('users').set({ mfa_enabled_at: new Date() }).where('id', '=', ub).execute();
    await assert.rejects(switchCompany(trx, me, `s-${ua}`, b.orgId, { ip: null, userAgent: null }), /code from your authenticator/);

    const made = await createCompany(trx, me, { name: 'Epsilon Pvt Ltd', stateCode: '29', gstin: null });
    const admin = await trx.selectFrom('users').select(['role', 'password_hash']).where('org_id', '=', made.orgId).where('email', '=', email).executeTakeFirstOrThrow();
    assert.deepEqual([admin.role, admin.password_hash], ['admin', 'argon-hash-1'], 'their admin, with the password they use');

    // Sales in Alpha and Beta; Gamma's staff role sees no statements, so it is left out.
    const customer = async (orgId: number) => Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    for (const [co, rupees] of [[a, 10_000], [b, 4_000]] as const) {
      await createInvoice(trx, co.orgId, null, {
        branchId: co.branchId, customerId: await customer(co.orgId), date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
        lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
      });
    }
    const all = await consolidatedStatements(trx, email, '2026-04-01', '2027-03-31');
    assert.deepEqual(all.companies.map((x) => x.name), ['Alpha Traders', 'Beta Exports', 'Epsilon Pvt Ltd']);
    assert.equal(all.totalIncome.total, 14_000_00);
    assert.deepEqual([all.totalIncome.by[String(a.orgId)], all.totalIncome.by[String(b.orgId)]], [10_000_00, 4_000_00]);
    const sales = all.income.find((r) => r.total === 14_000_00);
    assert.ok(sales, 'one sales line, the two companies side by side');
  });
});

test.after(async () => {
  await db.destroy();
});
