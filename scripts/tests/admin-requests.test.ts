// Admin approval (lib/server/services/admin-requests.ts): someone who is not an
// admin reverses, voids, deletes or uncategorises posted work, or changes a
// saved invoice: it is kept, the admins are told, and only an admin's Approve
// carries it out (as the person who asked); Reject leaves it. Run against a
// company of its own, wiped afterwards (the service writes as a request does,
// so it cannot ride in a rolled-back transaction).

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { approvedRequestUser, decide, requireAdminApproval, type Executor } from '../../lib/server/services/admin-requests';
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
  const o = await db.insertInto('organizations').values({ name: `Admin Approval Test ${Date.now()}`, fiscal_year_start_month: 4, base_currency: 'INR' } as never).executeTakeFirstOrThrow();
  orgId = Number(o.insertId);
  const b = await db.insertInto('branches').values({ org_id: orgId, name: 'Head office', state_code: '33', is_primary: 1 } as never).executeTakeFirstOrThrow();
  branchId = Number(b.insertId);
  const mk = async (name: string, role: 'admin' | 'accountant') => {
    const r = await db.insertInto('users').values({ org_id: orgId, name, email: `${role}-${orgId}@example.test`, password_hash: 'x', role, is_active: 1, home_branch_id: branchId } as never).executeTakeFirstOrThrow();
    return { userId: Number(r.insertId), orgId, name, email: `${role}-${orgId}@example.test`, role, homeBranchId: branchId, activeBranchId: branchId } as SessionUser;
  };
  admin = await mk('Asha Admin', 'admin');
  clerk = await mk('Kumar Clerk', 'accountant');
});

test.after(async () => {
  if (orgId) await wipeOrganizations(db, [orgId]);
  await db.destroy();
});

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const pathOf = (r: Request) => new URL(r.url).pathname;
const ask = (who: SessionUser, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const r = req(method, path, body, headers);
  return requireAdminApproval(r, pathOf(r), who).then(() => null, (e: { status?: number; code?: string; message: string; details?: { requestId?: string } }) => e);
};
const latestNotice = async (userId: number) => db.selectFrom('notifications').select(['kind', 'title', 'body', 'href']).where('org_id', '=', orgId).where('user_id', '=', userId).orderBy('id', 'desc').executeTakeFirstOrThrow();

test('an admin acts directly; a request that undoes nothing asks nobody', async () => {
  for (const [m, p, b] of [
    ['DELETE', '/api/invoices/12', undefined], ['PUT', '/api/invoices/12', { lines: [] }],
  ] as const) assert.equal(await ask(admin, m, p, b), null);
  for (const [m, p, b] of [
    ['POST', '/api/invoices', { customerId: 1 }], ['PATCH', '/api/invoices/12', { action: 'send' }],
    ['DELETE', '/api/banking/rules/3', undefined], ['DELETE', '/api/saved-views/9', undefined],
  ] as const) assert.equal(await ask(clerk, m, p, b), null, `${m} ${p}`);
  assert.equal((await db.selectFrom('admin_requests').select('id').where('org_id', '=', orgId).execute()).length, 0);
});

test('a reversal by someone who is not an admin is kept and sent to the admins; asking again does not ask twice', async () => {
  const e = await ask(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' }, { 'x-change-reason': encodeURIComponent('Posted to the wrong account') });
  assert.equal(e?.status, 409);
  assert.equal(e?.code, 'sent_for_approval');
  assert.match(e!.message, /Sent to Asha Admin for approval/);
  const n = await latestNotice(admin.userId);
  assert.equal(n.kind, 'admin_request');
  assert.match(n.title, /Kumar Clerk asks to reverse journal entry/);
  assert.match(n.body ?? '', /Posted to the wrong account/);
  assert.match(n.href ?? '', new RegExp(`request=${e!.details!.requestId}$`));
  const again = await ask(clerk, 'PATCH', '/api/journal', { entryId: 41, date: '2026-11-28', reason: 'wrong account' });
  assert.equal(again?.details?.requestId, e!.details!.requestId, 'the same request waiting is not asked twice');
});

test('Reject: nothing is carried out, and the person is told', async () => {
  const e = await ask(clerk, 'DELETE', '/api/bills/7?reason=duplicate');
  const id = Number(e!.details!.requestId);
  let ran = 0;
  const exec: Executor = async () => { ran++; return { status: 200, message: null }; };
  await assert.rejects(decide(req('POST', '/api/admin-requests'), clerk, id, 'approve', null, exec), /Only an admin/);
  const r = await decide(req('POST', '/api/admin-requests'), admin, id, 'reject', 'It is not a duplicate', exec);
  assert.equal(r.status, 'rejected');
  assert.equal(ran, 0, 'nothing was carried out');
  const told = await latestNotice(clerk.userId);
  assert.match(told.title, /Rejected: delete bill/);
  assert.match(told.body ?? '', /It is not a duplicate/);
  await assert.rejects(decide(req('POST', '/api/admin-requests'), admin, id, 'approve', null, exec), /already rejected/);
});

test('Approve: the same request is carried out once, as the person who asked, under a one-time pass', async () => {
  const body = { action: 'void', id: 9, reason: 'Entered twice' };
  const e = await ask(clerk, 'POST', '/api/payments', body);
  const id = Number(e!.details!.requestId);
  let seen: { method: string; path: string; body: string | null; pass: string } | null = null;
  let asUser: SessionUser | null = null;
  const exec: Executor = async (r) => {
    seen = r;
    // What route() does with the pass: the person who asked, for that exact request only.
    const wrongBody = new Request('http://localhost/api/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-approval': r.pass }, body: JSON.stringify({ ...body, id: 10 }) });
    assert.equal(await approvedRequestUser(wrongBody, '/api/payments'), null, 'the pass does not open another request');
    const right = new Request(`http://localhost${r.path}`, { method: r.method, headers: { 'content-type': 'application/json', 'x-admin-approval': r.pass }, body: r.body ?? undefined });
    asUser = await approvedRequestUser(right, '/api/payments');
    const twice = new Request(`http://localhost${r.path}`, { method: r.method, headers: { 'content-type': 'application/json', 'x-admin-approval': r.pass }, body: r.body ?? undefined });
    assert.equal(await approvedRequestUser(twice, '/api/payments'), null, 'the pass works once');
    return { status: 200, message: null };
  };
  const r = await decide(req('POST', '/api/admin-requests'), admin, id, 'approve', null, exec);
  assert.equal(r.status, 'done');
  assert.equal(seen!.method, 'POST');
  assert.deepEqual(JSON.parse(seen!.body!), body);
  assert.equal(asUser!.userId, clerk.userId, 'carried out as Kumar, with his own rights');
  assert.match((await latestNotice(clerk.userId)).title, /Approved and done: void payment/);
  const trail = await db.selectFrom('audit_log').select(['action', 'detail']).where('org_id', '=', orgId).where('target_type', '=', 'admin_request').orderBy('id').execute();
  assert.ok(trail.some((t) => t.action === 'create' && /asked to void payment/.test(t.detail ?? '')));
  assert.ok(trail.some((t) => t.action === 'approve' && /it was carried out/.test(t.detail ?? '')));
  assert.ok(trail.some((t) => t.action === 'reject'));
});

test('approved but refused by the books: the person is told why', async () => {
  const e = await ask(clerk, 'PUT', '/api/invoices/12', { lines: [] });
  assert.match((await latestNotice(admin.userId)).title, /asks to change invoice/);
  const r = await decide(req('POST', '/api/admin-requests'), admin, Number(e!.details!.requestId), 'approve', null,
    async () => ({ status: 409, message: 'This invoice has an IRN: cancel the e-invoice first.' }));
  assert.equal(r.status, 'failed');
  assert.match((await latestNotice(clerk.userId)).body ?? '', /cancel the e-invoice first/);
});

test('uncategorising a bank line and voiding a credit note are asked about', async () => {
  for (const [method, path, body, words] of [
    ['POST', '/api/banking/transactions', { action: 'unmatch', id: 5 }, /uncategorise bank transaction/],
    ['PATCH', '/api/sales-documents', { action: 'void-credit-note', id: 3, reason: 'x' }, /void credit note/],
  ] as const) {
    const e = await ask(clerk, method, path, body);
    assert.equal(e?.code, 'sent_for_approval', `${method} ${path}`);
    assert.match((await latestNotice(admin.userId)).title, words);
  }
});

test('each half can be switched off in Settings → Controls', async () => {
  await setPolicies(db as never, orgId, admin.userId, { controls: { adminApprovalInvoiceEdit: false } } as never);
  assert.equal(await ask(clerk, 'PUT', '/api/invoices/13', { lines: [] }), null);
  assert.equal((await ask(clerk, 'DELETE', '/api/invoices/13'))?.code, 'sent_for_approval', 'undo is still asked about');
  await setPolicies(db as never, orgId, admin.userId, { controls: { adminApprovalUndo: false } } as never);
  assert.equal(await ask(clerk, 'DELETE', '/api/invoices/14'), null);
});

test('the ledger leaves out an entry undone on its own date, and shows it when asked; a later reversal always shows', async () => {
  await db.transaction().execute(async (trx) => {
    await installChartOfAccounts(trx as never, orgId);
    const acc = await accountIds(trx as never, orgId);
    const post = (date: string, paise: number, memo: string) => postEntry(trx as never, {
      orgId, branchId, date, memo, sourceType: 'manual', sourceId: null,
      lines: [{ accountId: acc[CODE.BANK_DEFAULT]!, debit: paise }, { accountId: acc[CODE.SALES]!, credit: paise }],
    } as never);
    await post('2026-11-10', 100_00, 'stands');
    const undone = await post('2026-11-12', 250_00, 'categorised by mistake');
    await reverseEntry(trx as never, orgId, (undone as { id: number }).id, { date: '2026-11-12' });
    const accrual = await post('2026-11-15', 400_00, 'accrual');
    await reverseEntry(trx as never, orgId, (accrual as { id: number }).id, { date: '2026-11-20' });

    const shown = await generalLedger(trx as never, orgId, acc[CODE.BANK_DEFAULT]!, '2026-11-01', '2026-11-30');
    assert.equal(shown.lines.length, 3, 'the same-day pair is left out; the accrual and its later reversal stay');
    assert.equal(shown.hiddenReversed, 2);
    assert.equal(shown.closingPaise, 100_00, 'the balance is the same either way');
    const all = await generalLedger(trx as never, orgId, acc[CODE.BANK_DEFAULT]!, '2026-11-01', '2026-11-30', null, { showReversed: true });
    assert.equal(all.lines.length, 5);
    assert.equal(all.closingPaise, 100_00);
  });
});
