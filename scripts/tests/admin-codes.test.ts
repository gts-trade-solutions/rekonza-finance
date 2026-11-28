// The admin code (lib/server/services/admin-codes.ts): someone who is not an
// admin reverses, voids, deletes or uncategorises posted work, or changes a
// saved invoice, only with a one-time code the admins were sent. Run against a
// company of its own, which is wiped afterwards (the service uses the database
// directly, as a request does, so it cannot ride in a rolled-back transaction).

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { requireAdminCode } from '../../lib/server/services/admin-codes';
import { setPolicies } from '../../lib/server/services/org-settings';
import { wipeOrganizations } from '../../lib/server/seed/wipe';
import { generalLedger } from '../../lib/server/reports/statements';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry, reverseEntry } from '../../lib/server/ledger/posting';
import type { SessionUser } from '../../lib/server/auth/session';

let orgId = 0;
let branchId = 0;
let admin: SessionUser;
let clerk: SessionUser;

test.before(async () => {
  const o = await db.insertInto('organizations').values({ name: `Admin Code Test ${Date.now()}`, fiscal_year_start_month: 4, base_currency: 'INR' } as never).executeTakeFirstOrThrow();
  orgId = Number(o.insertId);
  const mk = async (name: string, role: 'admin' | 'accountant') => {
    const r = await db.insertInto('users').values({ org_id: orgId, name, email: `${role}-${orgId}@example.test`, password_hash: 'x', role, is_active: 1 } as never).executeTakeFirstOrThrow();
    return { userId: Number(r.insertId), orgId, name, email: `${role}-${orgId}@example.test`, role, homeBranchId: null, activeBranchId: null } as SessionUser;
  };
  const b = await db.insertInto('branches').values({ org_id: orgId, name: 'Head office', state_code: '33', is_primary: 1 } as never).executeTakeFirstOrThrow();
  branchId = Number(b.insertId);
  admin = await mk('Asha Admin', 'admin');
  clerk = await mk('Kumar Clerk', 'accountant');
});

test.after(async () => {
  if (orgId) await wipeOrganizations(db, [orgId]);
  await db.destroy();
});

const req = (method: string, path: string, body?: unknown, code?: string) => new Request(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', ...(code ? { 'x-admin-code': code } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const pathOf = (r: Request) => new URL(r.url).pathname;
const go = (who: SessionUser, method: string, path: string, body?: unknown, code?: string) => { const r = req(method, path, body, code); return requireAdminCode(r, pathOf(r), who); };
const refused = async (p: Promise<void>) => p.then(() => null, (e: { status?: number; code?: string; message: string }) => e);
/** The code as the admin reads it in their notifications. */
const latestCode = async () => {
  const n = await db.selectFrom('notifications').select(['title', 'body']).where('org_id', '=', orgId).where('user_id', '=', admin.userId).where('kind', '=', 'admin_code').orderBy('id', 'desc').executeTakeFirstOrThrow();
  return { code: /Code (\d{6})/.exec(n.title)![1], title: n.title };
};

test('an admin acts directly; a request that undoes nothing asks nobody', async () => {
  await go(admin, 'DELETE', '/api/invoices/12');
  await go(admin, 'PUT', '/api/invoices/12', { lines: [] });
  await go(clerk, 'POST', '/api/invoices', { customerId: 1 });            // creating an invoice
  await go(clerk, 'PATCH', '/api/invoices/12', { action: 'send' });       // sending it
  await go(clerk, 'DELETE', '/api/banking/rules/3');                      // a rule is not posted work
  await go(clerk, 'DELETE', '/api/saved-views/9');
  assert.equal((await db.selectFrom('admin_codes').select('id').where('org_id', '=', orgId).execute()).length, 0);
});

test('a reversal by someone who is not an admin waits for the code the admin was sent', async () => {
  const e = await refused(go(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' }));
  assert.equal(e?.status, 428);
  assert.equal(e?.code, 'admin_code_required');
  assert.match(e!.message, /Asha Admin/);
  const sent = await latestCode();
  assert.match(sent.title, /Kumar Clerk wants to reverse journal entry/);

  // A wrong code is refused and counted; the right one lets it through, once.
  const wrong = await refused(go(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' }, sent.code === '000000' ? '000001' : '000000'));
  assert.equal(wrong?.code, 'admin_code_wrong');
  await go(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' }, sent.code);
  const again = await refused(go(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' }, sent.code));
  assert.equal(again?.code, 'admin_code_required', 'a used code does not work twice');

  const trail = await db.selectFrom('audit_log').select(['action', 'detail']).where('org_id', '=', orgId).where('target_type', '=', 'admin_code').orderBy('id').execute();
  assert.ok(trail.some((t) => t.action === 'create' && /asked to reverse/.test(t.detail ?? '')), 'asking is in the audit trail');
  assert.ok(trail.some((t) => t.action === 'approve' && /admin code was given/.test(t.detail ?? '')), 'so is the admin agreeing');
});

test('a code is for one action: it does not open another', async () => {
  await refused(go(clerk, 'DELETE', '/api/bills/7'));
  const forBill = (await latestCode()).code;
  const other = await refused(go(clerk, 'DELETE', '/api/bills/8', undefined, forBill));
  assert.equal(other?.status, 428, 'the code for bill 7 does not delete bill 8');
  await go(clerk, 'DELETE', '/api/bills/7', undefined, forBill);
});

test('uncategorising a bank line, voiding a payment and changing an invoice are asked about; creating is not', async () => {
  for (const [method, path, body, words] of [
    ['POST', '/api/banking/transactions', { action: 'unmatch', id: 5 }, /uncategorise bank transaction/],
    ['POST', '/api/payments', { action: 'void', id: 9, reason: 'x' }, /void payment/],
    ['PATCH', '/api/sales-documents', { action: 'void-credit-note', id: 3, reason: 'x' }, /void credit note/],
    ['PUT', '/api/invoices/12', { lines: [] }, /change invoice/],
  ] as const) {
    const e = await refused(go(clerk, method, path, body));
    assert.equal(e?.code, 'admin_code_required', `${method} ${path}`);
    assert.match((await latestCode()).title, words);
  }
});

test('each half can be switched off in Settings → Controls', async () => {
  // The tests above asked for more codes in a minute than one person may in a quarter of an hour.
  await db.deleteFrom('admin_codes').where('org_id', '=', orgId).execute();
  await setPolicies(db as never, orgId, admin.userId, { controls: { adminCodeInvoiceEdit: false } } as never);
  await go(clerk, 'PUT', '/api/invoices/12', { lines: [] });
  assert.equal((await refused(go(clerk, 'DELETE', '/api/invoices/13')))?.code, 'admin_code_required', 'undo is still asked about');
  await setPolicies(db as never, orgId, admin.userId, { controls: { adminCodeUndo: false } } as never);
  await go(clerk, 'DELETE', '/api/invoices/13');
});

test('the ledger leaves out an entry undone on its own date, and shows it when asked; a later reversal always shows', async () => {
  await db.transaction().execute(async (trx) => {
    await installChartOfAccounts(trx as never, orgId);
    const acc = await accountIds(trx as never, orgId);
    const post = (date: string, paise: number, memo: string) => postEntry(trx as never, {
      orgId, branchId, date, memo, sourceType: 'manual', sourceId: null,
      lines: [{ accountId: acc[CODE.BANK_DEFAULT]!, debit: paise }, { accountId: acc[CODE.SALES]!, credit: paise }],
    } as never);
    const kept = await post('2026-11-10', 100_00, 'stands');
    const undone = await post('2026-11-12', 250_00, 'categorised by mistake');
    await reverseEntry(trx as never, orgId, (undone as { id: number }).id, { date: '2026-11-12' });
    const accrual = await post('2026-11-15', 400_00, 'accrual');
    await reverseEntry(trx as never, orgId, (accrual as { id: number }).id, { date: '2026-11-20' });
    void kept;

    const shown = await generalLedger(trx as never, orgId, acc[CODE.BANK_DEFAULT]!, '2026-11-01', '2026-11-30');
    assert.deepEqual(shown.lines.map((l) => l.memo ?? l.description), ['stands', 'accrual', shown.lines[2].memo ?? shown.lines[2].description]);
    assert.equal(shown.lines.length, 3, 'the same-day pair is left out; the accrual and its later reversal stay');
    assert.equal(shown.hiddenReversed, 2);
    assert.equal(shown.closingPaise, 100_00, 'the balance is the same either way');
    const all = await generalLedger(trx as never, orgId, acc[CODE.BANK_DEFAULT]!, '2026-11-01', '2026-11-30', null, { showReversed: true });
    assert.equal(all.lines.length, 5);
    assert.equal(all.closingPaise, 100_00);
  });
});
