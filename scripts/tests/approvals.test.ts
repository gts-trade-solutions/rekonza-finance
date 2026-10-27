// Maker and checker: a rule holds big documents for a second person.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/approvals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createBill, postBill } from '../../lib/server/services/purchases';
import { createInvoice, postInvoice } from '../../lib/server/services/sales';
import { approve, reject, saveRule, submitForApproval } from '../../lib/server/services/approvals';
import { createPurchaseOrder } from '../../lib/server/services/purchase-documents';
import { billFromPurchaseOrder } from '../../lib/server/services/order-flow';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; vendor: number; customer: number;
  maker: number; clerk: number; accountant: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Approvals Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998719', kind: 'sac', description: 'Repair services', gst_rate_pct: 18, is_active: 1 }).execute();
      const user = async (name: string, role: 'admin' | 'accountant' | 'staff') =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role }).executeTakeFirstOrThrow()).insertId);
      const contact = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        vendor: await contact({ kind: 'vendor', display_name: 'Supplier' }),
        customer: await contact({ kind: 'customer', display_name: 'Buyer' }),
        maker: await user('maker', 'accountant'),
        clerk: await user('clerk', 'staff'),
        accountant: await user('checker', 'accountant'),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const bill = (f: Fixture, rupees: number, status: 'draft' | 'open') => createBill(f.trx, f.orgId, f.maker, {
  branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: `S-${rupees}-${status}`, date: '2026-08-01', dueDate: '2026-08-31', status,
  lines: [{ description: 'Stock', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
});

test('with no rules, documents post as they always have', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, 5_00_000, 'open');
    assert.ok(b.journalEntryId);
  });
});

test('a bill a rule catches cannot post until someone else approves it', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'bill', thresholdPaise: 50_000_00, approverRole: 'accountant', isActive: true });

    await assert.rejects(bill(f, 1_00_000, 'open'), /need approval by an accountant/);
    const small = await bill(f, 10_000, 'open');
    assert.ok(small.journalEntryId, 'below the amount it posts directly');

    const b = await bill(f, 1_00_000, 'draft');
    await assert.rejects(postBill(f.trx, f.orgId, f.maker, b.id), /need approval/);
    await submitForApproval(f.trx, f.orgId, f.maker, 'bill', b.id);

    await assert.rejects(
      approve(f.trx, f.orgId, { userId: f.maker, role: 'accountant' }, 'bill', b.id, postBill),
      /You submitted/,
    );
    await assert.rejects(
      approve(f.trx, f.orgId, { userId: f.clerk, role: 'staff' }, 'bill', b.id, postBill),
      /needs approval by an accountant/,
    );
    await approve(f.trx, f.orgId, { userId: f.accountant, role: 'accountant' }, 'bill', b.id, postBill);
    const row = await f.trx.selectFrom('bills').select(['status', 'journal_entry_id', 'approval_status', 'approved_by_user_id'])
      .where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(row.approval_status, 'approved');
    assert.equal(row.status, 'open');
    assert.ok(row.journal_entry_id, 'posted on approval');
    assert.equal(row.approved_by_user_id, f.accountant);
  });
});

test('a document sent back can be submitted again', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'invoice', thresholdPaise: 0, approverRole: 'admin', isActive: true });
    const inv = await createInvoice(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, customerId: f.customer, date: '2026-08-01', dueDate: '2026-08-31', status: 'draft',
      lines: [{ description: 'Service', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    await submitForApproval(f.trx, f.orgId, f.maker, 'invoice', inv.id);
    await reject(f.trx, f.orgId, { userId: f.accountant, role: 'admin' }, 'invoice', inv.id, 'Wrong customer');
    let row = await f.trx.selectFrom('invoices').select(['approval_status', 'rejection_reason']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.approval_status, 'rejected');
    assert.equal(row.rejection_reason, 'Wrong customer');

    await submitForApproval(f.trx, f.orgId, f.maker, 'invoice', inv.id);
    await approve(f.trx, f.orgId, { userId: f.accountant, role: 'admin' }, 'invoice', inv.id, postInvoice);
    row = await f.trx.selectFrom('invoices').select(['approval_status', 'rejection_reason']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.approval_status, 'approved');
  });
});

test('a bill raised from an order is held for approval rather than refused', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'bill', thresholdPaise: 0, approverRole: 'accountant', isActive: true });
    const po = await createPurchaseOrder(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, vendorId: f.vendor, date: '2026-08-01',
      lines: [{ description: 'Service', hsnSac: '998719', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
    });
    const bill = await billFromPurchaseOrder(f.trx, f.orgId, f.maker, po.id, { vendorInvoiceNo: 'S-9', date: '2026-08-02', dueDate: '2026-09-01' });
    assert.equal(bill.heldForApproval, true);
    const row = await f.trx.selectFrom('bills').select(['status', 'approval_status', 'journal_entry_id']).where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'draft');
    assert.equal(row.approval_status, 'pending');
    assert.equal(row.journal_entry_id, null, 'nothing posted yet');
  });
});

test.after(async () => {
  await db.destroy();
});
