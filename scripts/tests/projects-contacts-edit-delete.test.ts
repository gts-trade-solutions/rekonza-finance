// Edit and Delete on projects, their tasks and time, and on a contact's
// people (services/projects.ts, services/contact-persons.ts), against real
// MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/projects-contacts-edit-delete.test.ts
//
// What has to hold: a project is deleted only while nothing is logged, booked
// or billed to it, and is refused with `in_use` otherwise (the screen then
// offers archiving); a task with time on it is set inactive, an unused one
// goes; billed time cannot be edited, and edited approved time waits for
// approval again; a contact has one primary person, and a removed person is
// no longer a document recipient.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { ApiError } from '../../lib/server/http';
import {
  billProject, decideTime, deleteProject, deleteTask, deleteTime, logTime, saveProject, updateTask, updateTime,
} from '../../lib/server/services/projects';
import { deletePerson, updatePerson } from '../../lib/server/services/contact-persons';
import { documentRecipients } from '../../lib/server/mail/mailer';
import { setPolicies } from '../../lib/server/services/org-settings';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; asha: number; ravi: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Edit Delete Studio' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCP2222P1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998311', kind: 'sac', description: 'Management consulting', gst_rate_pct: 18, is_active: 1 }).execute();
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Apex Motors', state_code: '33', gst_treatment: 'registered', gstin: '33AAACA1111A1Z1', email: 'accounts@apex.test',
      } as never).executeTakeFirstOrThrow()).insertId);
      const person = (name: string) => trx.insertInto('users').values({ org_id: orgId, name, email: `${name.toLowerCase()}@studio-ed.test`, password_hash: 'x', role: 'staff' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      await fn({ trx, orgId, branchId, customer, asha: await person('Asha'), ravi: await person('Ravi') });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const project = (b: Book, extra: Partial<Parameters<typeof saveProject>[3]> = {}) => saveProject(b.trx, b.orgId, null, {
  customerId: b.customer, name: 'ERP rollout', billingMethod: 'task_hours', sacCode: '998311', gstRatePct: 18,
  tasks: [{ name: 'Design', ratePaise: 1_500_00 }, { name: 'Build', ratePaise: 1_000_00 }], ...extra,
});
const taskIds = async (b: Book, pid: number) =>
  (await b.trx.selectFrom('project_tasks').select(['id', 'name', 'is_active']).where('project_id', '=', pid).orderBy('id').execute());
const inUse = (re: RegExp) => (e: unknown) => e instanceof ApiError && e.code === 'in_use' && re.test(e.message);

test('a project with nothing on it is deleted with its tasks and people; one with time or an invoice on it is refused in_use', async () => {
  await withBook(async (b) => {
    const empty = await project(b, { users: [{ userId: b.asha, ratePaise: 0, costRatePaise: 500_00 }] });
    await b.trx.insertInto('comments').values({ org_id: b.orgId, target_type: 'project', target_id: empty, body: 'Kick-off on Monday', user_id: null, author_name: 'Asha' } as never).execute();
    const gone = await deleteProject(b.trx, b.orgId, empty);
    assert.equal(gone.name, 'ERP rollout');
    assert.equal((await b.trx.selectFrom('projects').select('id').where('id', '=', empty).execute()).length, 0);
    assert.equal((await taskIds(b, empty)).length, 0, 'its tasks went with it');
    assert.equal((await b.trx.selectFrom('project_users').select('id').where('project_id', '=', empty).execute()).length, 0);
    assert.equal((await b.trx.selectFrom('comments').select('id').where('target_type', '=', 'project').where('target_id', '=', empty).execute()).length, 0);

    // Time on it: refused, and the message says what is on it.
    const timed = await project(b, { name: 'Support' });
    const [design] = await taskIds(b, timed);
    await logTime(b.trx, b.orgId, null, { projectId: timed, taskId: design.id, userId: b.asha, date: '2026-10-01', minutes: 60 });
    await assert.rejects(deleteProject(b.trx, b.orgId, timed), inUse(/1 time entry/));
    assert.equal((await b.trx.selectFrom('projects').select('id').where('id', '=', timed).execute()).length, 1, 'still there');

    // An expense booked to it, or an invoice raised for it, is refused the same way.
    const booked = await project(b, { name: 'Audit' });
    await b.trx.insertInto('invoices').values({
      org_id: b.orgId, branch_id: b.branchId, number: 'INV-T-1', customer_id: b.customer, invoice_date: '2026-10-02', due_date: '2026-10-17',
      place_of_supply: '33', supply_type: 'intra', status: 'draft', subtotal: '0', total: '0', amount_paid: '0', project_id: booked,
    } as never).execute();
    await assert.rejects(deleteProject(b.trx, b.orgId, booked), inUse(/1 invoice/));
  });
});

test('saving a completed project from its Edit window keeps it completed', async () => {
  await withBook(async (b) => {
    const pid = await project(b, { status: 'completed' });
    await project(b, { id: pid, name: 'ERP rollout, phase 2' });
    const p = await b.trx.selectFrom('projects').select(['name', 'status']).where('id', '=', pid).executeTakeFirstOrThrow();
    assert.deepEqual([p.name, p.status], ['ERP rollout, phase 2', 'completed']);
  });
});

test('a task is edited on its own; deleted, an unused one goes and one with time is set inactive', async () => {
  await withBook(async (b) => {
    const pid = await project(b);
    const [design, build] = await taskIds(b, pid);
    await updateTask(b.trx, b.orgId, pid, design.id, { name: 'UX design', ratePaise: 1_800_00, billable: false });
    const t = await b.trx.selectFrom('project_tasks').select(['name', 'rate', 'billable']).where('id', '=', design.id).executeTakeFirstOrThrow();
    assert.deepEqual([t.name, Number(t.rate), t.billable], ['UX design', 1_800, 0]);
    await assert.rejects(updateTask(b.trx, b.orgId, pid, design.id, { name: '  ' }), /name/);

    await logTime(b.trx, b.orgId, null, { projectId: pid, taskId: build.id, userId: b.asha, date: '2026-10-01', minutes: 120 });
    assert.deepEqual(await deleteTask(b.trx, b.orgId, pid, build.id), { name: 'Build', removed: false });
    assert.equal((await taskIds(b, pid)).find((x) => x.id === build.id)?.is_active, 0, 'kept for its time, no longer offered');
    assert.deepEqual(await deleteTask(b.trx, b.orgId, pid, design.id), { name: 'UX design', removed: true });
    assert.equal((await taskIds(b, pid)).some((x) => x.id === design.id), false);
    // A task of another project is not this one's to delete.
    const other = await project(b, { name: 'Other' });
    const [otherTask] = await taskIds(b, other);
    await assert.rejects(deleteTask(b.trx, b.orgId, pid, otherTask.id), /not on this project/);
  });
});

test('time is edited in place; billed time is refused; edited approved time waits for approval again; delete keeps its rules', async () => {
  await withBook(async (b) => {
    const pid = await project(b, { billingMethod: 'project_hours', ratePaise: 1_000_00, tasks: [] });
    const t1 = await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.asha, date: '2026-10-01', minutes: 60, notes: 'Workshop' });

    const r = await updateTime(b.trx, b.orgId, t1, { date: '2026-10-02', minutes: 90, notes: 'Workshop and notes', billable: false });
    assert.equal(r.before.minutes, 60);
    const row = await b.trx.selectFrom('time_entries').select(['entry_date', 'minutes', 'notes', 'billable', 'project_id', 'user_id']).where('id', '=', t1).executeTakeFirstOrThrow();
    assert.deepEqual([String(row.entry_date).slice(0, 10), row.minutes, row.notes, row.billable, row.project_id, row.user_id],
      ['2026-10-02', 90, 'Workshop and notes', 0, pid, b.asha], 'same project and person');
    await assert.rejects(updateTime(b.trx, b.orgId, t1, { date: '2026-10-02', minutes: 0 }), /one minute/);

    // Approval on: approved time, once edited, waits again; rejected time too.
    await setPolicies(b.trx, b.orgId, null, { controls: { timesheetApproval: true } as never });
    const t2 = await logTime(b.trx, b.orgId, null, { projectId: pid, userId: b.asha, date: '2026-10-03', minutes: 30 });
    await decideTime(b.trx, b.orgId, b.ravi, [t2], 'approved');
    const again = await updateTime(b.trx, b.orgId, t2, { date: '2026-10-03', minutes: 45 });
    assert.equal(again.approvalStatus, 'pending');
    const t2row = await b.trx.selectFrom('time_entries').select(['approved_by_user_id', 'approved_at']).where('id', '=', t2).executeTakeFirstOrThrow();
    assert.deepEqual([t2row.approved_by_user_id, t2row.approved_at], [null, null], 'the old approval is cleared');

    // Billed: refused for edit and delete alike.
    await decideTime(b.trx, b.orgId, b.ravi, [t2], 'approved');
    await b.trx.updateTable('time_entries').set({ billable: 1 }).where('id', '=', t2).execute();
    const billed = await billProject(b.trx, b.orgId, null, { projectId: pid, branchId: b.branchId, date: '2026-10-05', dueDate: '2026-10-20' });
    assert.ok(billed.invoice.id);
    await assert.rejects(updateTime(b.trx, b.orgId, t2, { date: '2026-10-03', minutes: 60 }), /Void or delete the invoice first/);
    await assert.rejects(deleteTime(b.trx, b.orgId, t2), /has been billed/);

    // Unbilled time is deleted.
    await deleteTime(b.trx, b.orgId, t1);
    assert.equal((await b.trx.selectFrom('time_entries').select('id').where('id', '=', t1).execute()).length, 0);
  });
});

test('a task-billed project needs a task on edited time, and keeps an inactive task the time already had', async () => {
  await withBook(async (b) => {
    const pid = await project(b);
    const [design, build] = await taskIds(b, pid);
    const t = await logTime(b.trx, b.orgId, null, { projectId: pid, taskId: build.id, userId: b.asha, date: '2026-10-01', minutes: 60 });
    await assert.rejects(updateTime(b.trx, b.orgId, t, { taskId: null, date: '2026-10-01', minutes: 60 }), /billed by task/);
    await deleteTask(b.trx, b.orgId, pid, build.id); // inactive: time is on it
    await updateTime(b.trx, b.orgId, t, { taskId: build.id, date: '2026-10-01', minutes: 75 });
    await deleteTask(b.trx, b.orgId, pid, design.id); // unused: removed
    const other = await logTime(b.trx, b.orgId, null, { projectId: pid, taskId: build.id, userId: b.asha, date: '2026-10-02', minutes: 10 }).catch((e) => e);
    assert.ok(other instanceof Error && /not on this project/.test(other.message), 'an inactive task is not offered for new time');
  });
});

test('a contact person is edited on their own: one primary only; deleted, they no longer receive documents', async () => {
  await withBook(async (b) => {
    const add = (name: string, email: string, primary: boolean) => b.trx.insertInto('contact_persons').values({
      org_id: b.orgId, contact_id: b.customer, name, email, is_primary: primary ? 1 : 0, receives_documents: 1,
    }).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
    const meena = await add('Meena Iyer', 'meena@apex.test', true);
    const karthik = await add('Karthik R', 'karthik@apex.test', false);

    const r = await updatePerson(b.trx, b.orgId, b.customer, karthik, {
      salutation: 'Mr.', firstName: 'Karthik', lastName: 'Raman', email: 'karthik.raman@apex.test', mobile: '98400 12345',
      designation: 'Accounts head', isPrimary: true, receivesDocuments: true,
    });
    assert.equal(r.name, 'Karthik Raman');
    const people = await b.trx.selectFrom('contact_persons').select(['id', 'name', 'email', 'is_primary', 'mobile']).where('contact_id', '=', b.customer).orderBy('id').execute();
    assert.deepEqual(people.map((p) => [p.name, p.is_primary]), [['Meena Iyer', 0], ['Karthik Raman', 1]], 'one primary');
    assert.equal(people[1].mobile, '98400 12345');
    await assert.rejects(updatePerson(b.trx, b.orgId, b.customer, karthik, { firstName: '', lastName: '' }), /name/);
    await assert.rejects(updatePerson(b.trx, b.orgId, b.customer, karthik, { firstName: 'K', email: 'not-an-email' }), /email/);

    assert.deepEqual((await documentRecipients(b.trx, b.orgId, b.customer)).sort(), ['karthik.raman@apex.test', 'meena@apex.test']);
    await deletePerson(b.trx, b.orgId, b.customer, meena);
    assert.deepEqual(await documentRecipients(b.trx, b.orgId, b.customer), ['karthik.raman@apex.test'], 'Meena no longer gets documents');
    await assert.rejects(deletePerson(b.trx, b.orgId, b.customer, meena), /does not exist/);

    // Someone else's contact's person is not reachable through this one.
    const other = Number((await b.trx.insertInto('contacts').values({ org_id: b.orgId, kind: 'customer', display_name: 'Other', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(deletePerson(b.trx, b.orgId, other, karthik), /does not exist/);
  });
});
