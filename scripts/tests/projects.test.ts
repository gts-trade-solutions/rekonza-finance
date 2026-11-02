// Projects and timesheets: hours billed at the rate their billing method
// says, billable expenses re-charged at cost, nothing billed twice, and a
// voided invoice giving its hours back.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/projects.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { voidInvoice } from '../../lib/server/services/sales';
import { createExpense } from '../../lib/server/services/purchases';
import { billProject, chargeExpenses, logTime, projectFigures, saveProject, unbilled, deleteTime } from '../../lib/server/services/projects';
import { createInvoice } from '../../lib/server/services/sales';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; asha: number; ravi: number; bankId: number; travel: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Studio Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCP2222P1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998311', kind: 'sac', description: 'Management consulting', gst_rate_pct: 18, is_active: 1 }).execute();
      const acc = await accountIds(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Apex Motors', state_code: '33', gst_treatment: 'registered', gstin: '33AAACA1111A1Z1' } as never).executeTakeFirstOrThrow()).insertId);
      const person = (name: string) => trx.insertInto('users').values({ org_id: orgId, name, email: `${name.toLowerCase()}@studio.test`, password_hash: 'x', role: 'staff' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer, asha: await person('Asha'), ravi: await person('Ravi'), bankId, travel: acc[CODE.FUEL] });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('billed by each person\'s rate, with a re-charged expense; nothing billed twice; a void gives the hours back', async () => {
  await withBook(async (b) => {
    const pid = await saveProject(b.trx, b.orgId, null, {
      customerId: b.customer, name: 'ERP rollout', billingMethod: 'staff_hours', sacCode: '998311', gstRatePct: 18,
      users: [{ userId: b.asha, ratePaise: 2_000_00, costRatePaise: 800_00 }, { userId: b.ravi, ratePaise: 1_200_00, costRatePaise: 500_00 }],
    });
    await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.asha, date: '2026-10-01', minutes: 90 });
    await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.asha, date: '2026-10-02', minutes: 30 });
    await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.ravi, date: '2026-10-02', minutes: 240 });
    await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.ravi, date: '2026-10-02', minutes: 60, billable: false });
    const exp = await createExpense(b.trx, b.orgId, null, {
      branchId: b.branchId, date: '2026-10-03', accountId: b.travel, paidThroughBankAccountId: b.bankId,
      amountPaise: 0, mileage: { km: 100, ratePaise: 10_00 }, isBillable: true, billableCustomerId: b.customer, notes: 'Site visit',
    });
    await b.trx.updateTable('expenses').set({ project_id: pid }).where('id', '=', exp.id).execute();

    const u = await unbilled(b.trx, b.orgId, pid);
    assert.deepEqual(u.time.map((t) => [t.label, t.minutes, t.amountPaise]).sort(), [['Asha', 120, 4_000_00], ['Ravi', 240, 4_800_00]]);
    assert.deepEqual(u.expenses.map((x) => x.amountPaise), [1_000_00], 'at cost: 100 km at ₹10');
    assert.equal(u.totalPaise, 9_800_00);

    const r = await billProject(b.trx, b.orgId, null, { projectId: pid, branchId: b.branchId, date: '2026-10-05', dueDate: '2026-10-20', status: 'approved' });
    const inv = await b.trx.selectFrom('invoices').select(['subtotal', 'total', 'project_id', 'status']).where('id', '=', r.invoice.id).executeTakeFirstOrThrow();
    assert.equal(Number(inv.subtotal), 9_800);
    assert.equal(Number(inv.total), 11_564, 'GST at 18% on the hours and the re-charge');
    assert.equal(inv.project_id, pid);
    assert.equal((await unbilled(b.trx, b.orgId, pid)).totalPaise, 0, 'nothing left to bill');
    await assert.rejects(billProject(b.trx, b.orgId, null, { projectId: pid, branchId: b.branchId, date: '2026-10-06', dueDate: '2026-10-20' }), /nothing unbilled/);
    const billedEntry = await b.trx.selectFrom('time_entries').select('id').where('project_id', '=', pid).where('invoice_id', 'is not', null).executeTakeFirstOrThrow();
    await assert.rejects(deleteTime(b.trx, b.orgId, billedEntry.id), /has been billed/);

    const f = (await projectFigures(b.trx, b.orgId, [pid])).get(pid)!;
    assert.equal(f.loggedMinutes, 420);
    assert.equal(f.unbilledMinutes, 0, 'the non-billable hour is not "unbilled"');
    assert.equal(f.billedPaise, 9_800_00);
    assert.equal(f.timeCostPaise, 2 * 800_00 + 5 * 500_00, 'Asha 2 h at ₹800, Ravi 5 h at ₹500');
    assert.equal(f.profitPaise, 9_800_00 - 4_100_00 - 1_000_00);

    await voidInvoice(b.trx, b.orgId, null, r.invoice.id, 'Wrong rates');
    assert.equal((await unbilled(b.trx, b.orgId, pid)).totalPaise, 9_800_00, 'the void gives back the hours and the expense');
  });
});

test('billed by task, or a fixed fee in parts', async () => {
  await withBook(async (b) => {
    const byTask = await saveProject(b.trx, b.orgId, null, {
      customerId: b.customer, name: 'Audit support', billingMethod: 'task_hours',
      tasks: [{ name: 'Fieldwork', ratePaise: 1_500_00 }, { name: 'Internal review', ratePaise: 0, billable: false }],
    });
    const tasks = await b.trx.selectFrom('project_tasks').select(['id', 'name']).where('project_id', '=', byTask).orderBy('id').execute();
    await assert.rejects(logTime(b.trx, b.orgId, null, { projectId: byTask, userId: b.asha, date: '2026-10-01', minutes: 60 }), /pick the task/);
    await logTime(b.trx, b.orgId, null, { projectId: byTask, taskId: tasks[0].id, userId: b.asha, date: '2026-10-01', minutes: 150 });
    await logTime(b.trx, b.orgId, null, { projectId: byTask, taskId: tasks[1].id, userId: b.asha, date: '2026-10-01', minutes: 60 });
    const u = await unbilled(b.trx, b.orgId, byTask);
    assert.deepEqual(u.time.map((t) => [t.label, t.amountPaise]), [['Fieldwork', 3_750_00]], 'a non-billable task is not billed');

    const fixed = await saveProject(b.trx, b.orgId, null, { customerId: b.customer, name: 'Website', billingMethod: 'fixed', fixedAmountPaise: 1_00_000_00 });
    await logTime(b.trx, b.orgId, null, { projectId: fixed, userId: b.ravi, date: '2026-10-01', minutes: 300 });
    const first = await billProject(b.trx, b.orgId, null, { projectId: fixed, branchId: b.branchId, date: '2026-10-02', dueDate: '2026-10-17', fixedPaise: 40_000_00, status: 'approved' });
    assert.equal(first.invoice.totalPaise, 47_200_00);
    const left = await unbilled(b.trx, b.orgId, fixed);
    assert.deepEqual(left.fixed, { feePaise: 1_00_000_00, billedPaise: 40_000_00, leftPaise: 60_000_00 });
    assert.equal(left.time.length, 0, 'a fixed fee does not bill hours');
    await assert.rejects(billProject(b.trx, b.orgId, null, { projectId: fixed, branchId: b.branchId, date: '2026-10-03', dueDate: '2026-10-17', fixedPaise: 70_000_00 }), /Only ₹60,000 of the fee is left/);
    await billProject(b.trx, b.orgId, null, { projectId: fixed, branchId: b.branchId, date: '2026-10-03', dueDate: '2026-10-17', status: 'approved' });
    assert.equal((await unbilled(b.trx, b.orgId, fixed)).fixed?.leftPaise, 0);

    await saveProject(b.trx, b.orgId, null, { id: fixed, customerId: b.customer, name: 'Website', billingMethod: 'fixed', fixedAmountPaise: 1_00_000_00, status: 'completed' });
    await assert.rejects(logTime(b.trx, b.orgId, null, { projectId: fixed, userId: b.ravi, date: '2026-10-04', minutes: 30 }), /not active/);
  });
});

test('a billable expense needs its customer; one re-charged on a hand-raised invoice is not offered again', async () => {
  await withBook(async (b) => {
    const spend = (extra: Record<string, unknown>) => createExpense(b.trx, b.orgId, null, {
      branchId: b.branchId, date: '2026-10-03', accountId: b.travel, paidThroughBankAccountId: b.bankId, amountPaise: 500_00, gstRatePct: 0, ...extra,
    });
    await assert.rejects(spend({ isBillable: true }), /which customer/);
    const x = await spend({ isBillable: true, billableCustomerId: b.customer, notes: 'Courier' });
    const other = Number((await b.trx.insertInto('contacts').values({ org_id: b.orgId, kind: 'customer', display_name: 'Other', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const sell = (customerId: number) => createInvoice(b.trx, b.orgId, null, {
      branchId: b.branchId, customerId, date: '2026-10-04', dueDate: '2026-10-04', status: 'approved',
      lines: [{ description: 'Re-charge: Courier', qty: 1, ratePaise: 500_00, gstRatePct: 18 }],
    });
    await assert.rejects(chargeExpenses(b.trx, b.orgId, (await sell(other)).id, other, [x.id]), /not billable to this customer/);
    const inv = await sell(b.customer);
    await chargeExpenses(b.trx, b.orgId, inv.id, b.customer, [x.id]);
    await assert.rejects(chargeExpenses(b.trx, b.orgId, inv.id, b.customer, [x.id]), /already been re-charged/);
    // A project's expense goes to the project's customer, whoever is named.
    const pid = await saveProject(b.trx, b.orgId, null, { customerId: b.customer, name: 'P', billingMethod: 'project_hours', ratePaise: 100_00 });
    await assert.rejects(spend({ isBillable: true, billableCustomerId: other, projectId: pid }), /project's customer/);
    const y = await spend({ isBillable: true, projectId: pid });
    assert.equal((await b.trx.selectFrom('expenses').select('billable_customer_id').where('id', '=', y.id).executeTakeFirstOrThrow()).billable_customer_id, b.customer);
  });
});

test.after(() => db.destroy());
