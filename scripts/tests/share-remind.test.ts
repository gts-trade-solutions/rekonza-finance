// Share links that open one invoice without signing in, and payment
// reminders queued on the chosen days, once each.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/share-remind.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { setPolicies } from '../../lib/server/services/org-settings';
import { createShareLink, openShareLink, revokeShareLinks } from '../../lib/server/services/sharing';
import { listReminders, markReminder, queueReminders, reminderText } from '../../lib/server/services/reminders';
import { importStatement } from '../../lib/server/services/banking';
import { receivePayment } from '../../lib/server/services/payments';
import { accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';

async function withBook(fn: (f: { trx: Trx; orgId: number; branchId: number; customer: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Remind Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Kumar Stores', state_code: '33', gst_treatment: 'unregistered', phone: '98400 12345' } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a share link opens its invoice until it lapses or is withdrawn; a draft is not shared', async () => {
  await withBook(async ({ trx, orgId, branchId, customer }) => {
    const sell = (status: 'approved' | 'draft') => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status, lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    const inv = await sell('approved');
    const link = await createShareLink(trx, orgId, null, { invoiceId: inv.id });
    const token = link.path.replace('/share/', '');
    assert.deepEqual(await openShareLink(trx, token), { orgId, docType: 'invoice', docId: inv.id, subId: null });
    await openShareLink(trx, token);
    assert.equal((await trx.selectFrom('share_links').select('opens').where('doc_id', '=', inv.id).executeTakeFirstOrThrow()).opens, 2);
    assert.equal(await openShareLink(trx, 'x'.repeat(32)), null, 'an unknown token opens nothing');
    assert.equal((await trx.selectFrom('share_links').select('token_hash').executeTakeFirstOrThrow()).token_hash.includes(token), false, 'only the hash is kept');

    await trx.updateTable('share_links').set({ expires_at: new Date(Date.now() - 1000) }).where('doc_id', '=', inv.id).execute();
    assert.equal(await openShareLink(trx, token), null, 'lapsed');
    const again = (await createShareLink(trx, orgId, null, { invoiceId: inv.id })).path.replace('/share/', '');
    assert.equal(await revokeShareLinks(trx, orgId, inv.id), 1, 'the live one');
    assert.equal(await openShareLink(trx, again), null, 'withdrawn');

    await assert.rejects(createShareLink(trx, orgId, null, { invoiceId: (await sell('draft')).id }), /A draft is not an invoice yet/);
  });
});

test('reminders: the latest stage reached in the last week, once, with the link to come', async () => {
  await withBook(async ({ trx, orgId, branchId, customer }) => {
    const sell = (due: string, rupees: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-05-01', dueDate: due, status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
    });
    const today = '2026-07-10';
    const soon = await sell('2026-07-12', 5_000); // due in two days: the three-days-before stage
    const late = await sell('2026-07-01', 3_000); // nine days late: the seven-days stage
    await sell('2026-05-15', 1_000); // long overdue: its stages are all more than a week old
    assert.equal(await queueReminders(trx, orgId, today), 0, 'off until switched on');

    await setPolicies(trx, orgId, null, { reminders: { enabled: true, stages: [-3, 0, 7], channel: 'whatsapp' } });
    assert.equal(await queueReminders(trx, orgId, today), 2);
    assert.equal(await queueReminders(trx, orgId, today), 0, 'never twice');
    const queued = await listReminders(trx, orgId, 'queued');
    assert.deepEqual(queued.map((r) => [r.number, r.stageDays, r.to]).sort(), [
      [(await trx.selectFrom('invoices').select('number').where('id', '=', late.id).executeTakeFirstOrThrow()).number, 7, '98400 12345'],
      [(await trx.selectFrom('invoices').select('number').where('id', '=', soon.id).executeTakeFirstOrThrow()).number, -3, '98400 12345'],
    ].sort());
    const lateOne = queued.find((r) => r.stageDays === 7)!;
    assert.match(lateOne.message, /for ₹3,000\.00 fell due on 1 Jul 2026\. You can see it and pay here: \{link\}/);
    await markReminder(trx, orgId, null, Number(lateOne.id), 'sent');
    await assert.rejects(markReminder(trx, orgId, null, Number(lateOne.id), 'skipped'), /already sent/);

    // A week later the soon one has reached its due day: a new stage, a new reminder.
    assert.equal(await queueReminders(trx, orgId, '2026-07-12'), 1);
    await assert.rejects(setPolicies(trx, orgId, null, { reminders: { stages: [-60] } as never }), /-30 to 180/);
  });
  assert.equal(
    reminderText({ org: 'Remind Co', customer: 'A', number: 'INV-1', balancePaise: 12_345_00, dueDate: '2026-07-10', today: '2026-07-10' }),
    'Dear A, a reminder that invoice INV-1 for ₹12,345.00 falls due today. You can see it and pay here: {link}\n— Remind Co',
  );
});

test('money in that names an open invoice is its receipt; one already entered is matched, not doubled', async () => {
  await withBook(async ({ trx, orgId, branchId, customer }) => {
    const acc = await accountIds(trx, orgId);
    const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
    const sell = (rupees: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
    });
    const a = await sell(1_000);
    const b = await sell(2_000);
    const c = await sell(500);
    const num = async (id: number) => (await trx.selectFrom('invoices').select('number').where('id', '=', id).executeTakeFirstOrThrow()).number;
    // Entered by hand before the statement came: matched, not recorded twice.
    await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-06-09', mode: 'upi', amountPaise: 500_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: c.id, amountPaise: 500_00 }] });
    const before = (await trx.selectFrom('payments').select('id').where('org_id', '=', orgId).execute()).length;
    const r = await importStatement(trx, orgId, null, bankId, 'june.csv', [
      // The bank keeps the letters and digits of the number and drops the rest.
      { date: '2026-06-10', narration: `UPI/CR/41234567/KUMAR STORES/${(await num(a.id)).replace(/[/-]/g, '')}`, depositPaise: 1_000_00 },
      { date: '2026-06-11', narration: `NEFT KUMAR ${await num(b.id)}`, depositPaise: 2_500_00 },
      { date: '2026-06-12', narration: 'UPI/CR/41239999/KUMAR STORES', reference: await num(c.id), depositPaise: 500_00 },
      { date: '2026-06-12', narration: 'CASH DEPOSIT', depositPaise: 700_00 },
    ]);
    assert.equal(r.autoMatched, 2, 'the UPI receipt and the one entered by hand; not the overpayment, not the unnamed cash');
    const paid = async (id: number) => (await trx.selectFrom('invoices').select(['amount_paid', 'status']).where('id', '=', id).executeTakeFirstOrThrow());
    assert.equal(Number((await paid(a.id)).amount_paid), 1_000);
    assert.equal(Number((await paid(b.id)).amount_paid), 0, 'more than it owes: left for a person');
    const after = (await trx.selectFrom('payments').select(['id', 'mode']).where('org_id', '=', orgId).orderBy('id').execute());
    assert.equal(after.length, before + 1, 'one new receipt only');
    assert.equal(after.at(-1)!.mode, 'upi');
  });
});

test.after(async () => {
  await db.destroy();
});
