// Quotes, sales orders, delivery challans and credit notes with Zoho's fields
// (migration 120) and the record their split view reads
// (services/sales-doc-record.ts), against real MySQL in rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sales-docs-zoho.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import {
  convertToInvoice, createChallan, createCreditNote, createEstimate, createSalesOrder, salesOrderFromEstimate, updateSalesDocument,
} from '../../lib/server/services/sales-documents';
import { salesDocRecord } from '../../lib/server/services/sales-doc-record';
import { toSalesDocInput, CreateInput } from '../../lib/server/sales-doc-input';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; itemId: number; userId: number; projectId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Zoho Docs Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita Motors', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '1000.0000', purchase_price: '600.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const userId = Number((await trx.insertInto('users').values({
        org_id: orgId, name: 'Priya Salesperson', email: `priya-${Date.now()}@zoho-docs.test`, password_hash: 'x', role: 'sales',
      } as never).executeTakeFirstOrThrow()).insertId);
      const projectId = Number((await trx.insertInto('projects').values({
        org_id: orgId, customer_id: customerId, name: 'Fleet refit',
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, itemId, userId, projectId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const line = (f: Fixture, qty = 2) => [{ itemId: f.itemId, qty, ratePaise: 100_000, gstRatePct: 18 }];

test('a quote keeps Zoho’s Reference#, Salesperson, Project and Terms, and its record names them', async () => {
  await withFixture(async (f) => {
    const q = await createEstimate(f.trx, f.orgId, f.userId, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', expiryDate: '2026-11-30', lines: line(f),
      referenceNumber: ' PO-7781 ', salespersonId: f.userId, projectId: f.projectId, notes: 'Thanks', terms: 'Valid for 30 days', status: 'draft',
    });
    const r = await salesDocRecord(f.orgId, 'estimate', q.id, f.trx);
    assert.equal(r.referenceNumber, 'PO-7781', 'trimmed');
    assert.equal(r.salespersonName, 'Priya Salesperson');
    assert.equal(r.projectName, 'Fleet refit');
    assert.equal(r.terms, 'Valid for 30 days');
    assert.equal(r.notes, 'Thanks');
    assert.equal(r.customerName, 'Bonita Motors');
    assert.equal(r.createdByName, 'Priya Salesperson');
    assert.equal(r.totalPaise, 236_000);
    assert.equal(r.subtotalPaise, 200_000);
    assert.equal(r.cgstPaise + r.sgstPaise, 36_000);
    assert.equal(r.lines[0].itemName, 'Widget');
    assert.equal(r.lines[0].amountPaise, 200_000);

    // Edited through the route's own mapping: the fields go back over it, number kept.
    const body = CreateInput.parse({
      kind: 'estimate', branchId: f.branchId, customerId: f.customerId, date: '2026-11-02', expiryDate: '2026-12-02',
      lines: line(f, 3), referenceNumber: 'PO-7782', salespersonId: null, terms: null,
    });
    const edited = await updateSalesDocument(f.trx, f.orgId, null, q.id, toSalesDocInput(body, f.branchId));
    assert.equal(edited.number, q.number);
    const r2 = await salesDocRecord(f.orgId, 'estimate', q.id, f.trx);
    assert.equal(r2.referenceNumber, 'PO-7782');
    assert.equal(r2.salespersonName, null, 'cleared');
    assert.equal(r2.terms, null);
    assert.equal(r2.totalPaise, 354_000);

    // Converted: the record says what it became.
    const inv = await convertToInvoice(f.trx, f.orgId, null, { type: 'estimate', id: q.id }, { date: '2026-11-05', dueDate: '2026-12-05', status: 'draft' });
    const r3 = await salesDocRecord(f.orgId, 'estimate', q.id, f.trx);
    assert.equal(r3.status, 'converted');
    assert.deepEqual(r3.convertedTo, { type: 'invoice', id: String(inv.id), number: inv.number });
  });
});

test('a salesperson or project from another business is refused', async () => {
  await withFixture(async (f) => {
    const other = Number((await f.trx.insertInto('organizations').values({ name: 'Someone Else' }).executeTakeFirstOrThrow()).insertId);
    const stranger = Number((await f.trx.insertInto('users').values({
      org_id: other, name: 'Stranger', email: `stranger-${Date.now()}@zoho-docs.test`, password_hash: 'x', role: 'sales',
    } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', expiryDate: '2026-11-30', lines: line(f), salespersonId: stranger,
    }), /not one of this business/);
    await assert.rejects(createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: line(f), salespersonId: stranger,
    }), /not one of this business/);
    await assert.rejects(createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', expiryDate: '2026-11-30', lines: line(f), projectId: 999_999_999,
    }), /project does not exist/);
  });
});

test('a sales order keeps payment terms, delivery method, notes and terms; its record lists the quote and the invoices', async () => {
  await withFixture(async (f) => {
    const q = await createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', expiryDate: '2026-11-30', lines: line(f),
    });
    const so = await salesOrderFromEstimate(f.trx, f.orgId, null, q.id, { date: '2026-11-03' });
    const body = CreateInput.parse({
      kind: 'sales-order', branchId: f.branchId, customerId: f.customerId, date: '2026-11-03', expectedShipDate: '2026-11-20',
      lines: line(f, 4), referenceNumber: 'PO-55', salespersonId: f.userId, paymentTerms: 'net_15', deliveryMethod: 'Courier',
      notes: 'Deliver to the back gate', terms: 'Advance 50%',
    });
    await updateSalesDocument(f.trx, f.orgId, null, so.id, toSalesDocInput(body, f.branchId));
    const r = await salesDocRecord(f.orgId, 'sales-order', so.id, f.trx);
    assert.equal(r.paymentTerms, 'net_15');
    assert.equal(r.deliveryMethod, 'Courier');
    assert.equal(r.notes, 'Deliver to the back gate');
    assert.equal(r.terms, 'Advance 50%');
    assert.equal(r.salespersonName, 'Priya Salesperson');
    assert.deepEqual(r.sourceEstimate, { id: String(q.id), number: q.number }, 'an edit keeps the quote it came from');
    assert.equal(r.expectedShipDate, '2026-11-20');
    assert.equal(r.stage, 'order');
    assert.deepEqual(r.invoices, []);
  });
});

test('a challan keeps Reference# and Terms; a credit note keeps Reference#, Salesperson, notes and terms, and its balance', async () => {
  await withFixture(async (f) => {
    const dc = await createChallan(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-04', challanType: 'supply_on_approval',
      lines: [{ itemId: f.itemId, qty: 2 }], referenceNumber: 'GATE-12', terms: 'Return within 7 days', notes: 'On approval',
    });
    const rc = await salesDocRecord(f.orgId, 'challan', dc.id, f.trx);
    assert.equal(rc.referenceNumber, 'GATE-12');
    assert.equal(rc.terms, 'Return within 7 days');
    assert.equal(rc.challanType, 'supply_on_approval');
    assert.equal(rc.lines[0].amountPaise, 200_000, 'a challan line is valued at its rate');

    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-04', dueDate: '2026-12-04', status: 'approved', lines: line(f, 3),
    });
    const cn = await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-06', reason: 'Sales Return', againstInvoiceId: inv.id,
      lines: line(f, 1), referenceNumber: 'RMA-3', salespersonId: f.userId, notes: 'One returned', terms: 'Credit valid 90 days',
    });
    const r = await salesDocRecord(f.orgId, 'credit-note', cn.id, f.trx);
    assert.equal(r.referenceNumber, 'RMA-3');
    assert.equal(r.salespersonName, 'Priya Salesperson');
    assert.equal(r.notes, 'One returned');
    assert.equal(r.terms, 'Credit valid 90 days');
    assert.deepEqual(r.againstInvoice, { id: String(inv.id), number: inv.number });
    assert.equal(r.totalPaise, 118_000);
    assert.equal(r.appliedPaise, 118_000, 'raised against an invoice, it is set against it at once');
    assert.equal(r.balancePaise, 0);
    assert.ok(r.journalEntryId, 'a credit note posts');
  });
});

test('a draft sales order or challan is not invoiced, delivered or staged until it is confirmed', async () => {
  await withFixture(async (f) => {
    const { invoiceFromSalesOrder, challanFromSalesOrder, invoiceFromChallan } = await import('../../lib/server/services/order-flow');
    const { setOrderStage } = await import('../../lib/server/services/order-stages');
    const so = await createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: line(f), status: 'draft',
    });
    assert.equal((await salesDocRecord(f.orgId, 'sales-order', so.id, f.trx)).status, 'draft');
    await assert.rejects(invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-11-02', dueDate: '2026-12-02' }), /is a draft/);
    await assert.rejects(challanFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-11-02' }), /is a draft/);
    await assert.rejects(setOrderStage(f.trx, f.orgId, null, so.id, 'in_process', '2026-11-02'), /is a draft/);
    // Confirmed (Zoho's Mark as Confirmed): the order goes on as any other.
    await f.trx.updateTable('sales_orders').set({ status: 'open' }).where('id', '=', so.id).execute();
    const inv = await invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-11-02', dueDate: '2026-12-02' });
    assert.ok(inv.id);
    // An edit keeps the status the order has.
    const body = CreateInput.parse({ kind: 'sales-order', branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: line(f), status: 'draft' });
    const so2 = await createSalesOrder(f.trx, f.orgId, null, toSalesDocInput(body, f.branchId).input as never);
    await updateSalesDocument(f.trx, f.orgId, null, so2.id, toSalesDocInput(CreateInput.parse({ kind: 'sales-order', branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: line(f), status: 'open' }), f.branchId));
    assert.equal((await salesDocRecord(f.orgId, 'sales-order', so2.id, f.trx)).status, 'draft', 'Save on a draft keeps it a draft');

    const dc = await createChallan(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-04', lines: [{ itemId: f.itemId, qty: 1 }], status: 'draft',
    });
    await assert.rejects(invoiceFromChallan(f.trx, f.orgId, null, dc.id, { date: '2026-11-05', dueDate: '2026-12-05' }), /is a draft/);
  });
});
