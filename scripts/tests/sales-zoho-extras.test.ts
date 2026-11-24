// Zoho Books' sales extras (migration 124): shipping and adjustment on quotes,
// orders, challans and credit notes; draft credit notes; reverse charge; Cancel
// Items and Convert to Purchase Order on a sales order; Create Project and the
// automatic retainer on a quote; the credit note's ACCOUNT column; the bill of
// supply. Against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sales-zoho-extras.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import {
  applyCreditNote, convertToInvoice, createChallan, createCreditNote, createEstimate, createSalesOrder,
} from '../../lib/server/services/sales-documents';
import { invoiceFromSalesOrder } from '../../lib/server/services/order-flow';
import {
  cancelSalesOrderItems, openCreditNote, projectFromEstimate, purchaseOrderFromSalesOrder, retainerFromEstimate,
} from '../../lib/server/services/sales-extras';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { reverseChargeProblem, reverseChargeTax } from '../../lib/tax/reverse-charge';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>;
  customerId: number; walkInId: number; vendorId: number; itemId: number; exemptItemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Sales Extras Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita Transport', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const walkInId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Walk-in', gst_treatment: 'consumer', state_code: '33',
      }).executeTakeFirstOrThrow()).insertId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Parts Supplier', gst_treatment: 'registered', state_code: '33', gstin: '33BBBBB2222B1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '1000.0000', purchase_price: '600.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
      }).executeTakeFirstOrThrow()).insertId);
      const exemptItemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Fresh vegetables', sku: 'V-1', hsn_sac: '0709', uqc: 'KGS',
        sale_price: '50.0000', purchase_price: '30.0000', gst_rate_pct: 0, tax_pref: 'exempt', sale_account_id: acc[CODE.SALES],
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '0709', kind: 'hsn', description: 'Vegetables', gst_rate_pct: 0, is_active: 1 },
      ]).execute();
      await fn({ trx, orgId, branchId, acc, customerId, walkInId, vendorId, itemId, exemptItemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** An account's balance (debit minus credit) over the ledger. */
async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}

test.after(() => db.destroy());

const line = (f: Fixture, qty = 2) => ({ itemId: f.itemId, qty, ratePaise: 100_000, gstRatePct: 18 });

test('shipping and an adjustment are added to a quote, order, challan and credit note, and credited back on the note', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const extras = { shippingChargePaise: 15_000, adjustmentPaise: -500, adjustmentLabel: 'Discount for prompt payment' };
    // 2 × ₹1,000 + 18% = ₹2,360; + ₹150 shipping − ₹5 = ₹2,505.
    const q = await createEstimate(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', expiryDate: '2026-11-30', lines: [line(f)], ...extras });
    assert.equal(q.totalPaise, 250_500);
    const qRow = await trx.selectFrom('estimates').select(['shipping_charge', 'adjustment', 'adjustment_label']).where('id', '=', q.id).executeTakeFirstOrThrow();
    assert.deepEqual([toPaiseFromSql(qRow.shipping_charge), toPaiseFromSql(qRow.adjustment), qRow.adjustment_label], [15_000, -500, 'Discount for prompt payment']);
    const so = await createSalesOrder(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', lines: [line(f)], ...extras });
    assert.equal(so.totalPaise, 250_500);
    const dc = await createChallan(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', lines: [{ itemId: f.itemId, qty: 2, ratePaise: 100_000 }], shippingChargePaise: 10_000 });
    assert.equal(dc.totalPaise, 210_000, 'a challan: the goods’ value, then shipping');

    // A credit note takes shipping back out of Shipping Income and the adjustment out of Discount Allowed.
    const shipBefore = await balance(trx, orgId, f.acc[CODE.SHIPPING_INCOME]);
    const cn = await createCreditNote(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-12', reason: 'Sales Return', lines: [line(f, 1)], shippingChargePaise: 5_000, adjustmentPaise: -200 });
    assert.equal(cn.totalPaise, 122_800, '₹1,180 + ₹50 − ₹2');
    assert.equal(await balance(trx, orgId, f.acc[CODE.SHIPPING_INCOME]) - shipBefore, 5_000, 'Shipping Income debited');
    assert.equal(await balance(trx, orgId, f.acc[CODE.DISCOUNT_ALLOWED]), -200, 'Discount Allowed credited');
    assert.equal(await balance(trx, orgId, f.acc[CODE.AR]), -122_800);
  });
});

test('a quote turned into an invoice carries its shipping, adjustment and reverse charge', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const q = await createEstimate(trx, orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', expiryDate: '2026-11-30', lines: [line(f)],
      shippingChargePaise: 10_000, reverseCharge: true,
    });
    assert.equal(q.totalPaise, 210_000, 'under reverse charge the quote charges no GST');
    const inv = await convertToInvoice(trx, orgId, null, { type: 'estimate', id: q.id }, { date: '2026-11-15', dueDate: '2026-12-15' });
    const row = await trx.selectFrom('invoices').select(['total', 'shipping_charge', 'reverse_charge', 'cgst', 'sgst']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.total), 210_000);
    assert.equal(toPaiseFromSql(row.shipping_charge), 10_000);
    assert.equal(Number(row.reverse_charge), 1);
    assert.equal(toPaiseFromSql(row.cgst) + toPaiseFromSql(row.sgst), 0);
  });
});

test('a reverse-charge invoice posts no output GST and GSTR-1 reports it with rchrg Y and the recipient’s tax', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    await assert.rejects(
      createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.walkInId, date: '2026-11-05', dueDate: '2026-12-05', status: 'approved', reverseCharge: true, lines: [line(f)] }),
      /only to a registered buyer/,
    );
    const inv = await createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-05', dueDate: '2026-12-05', status: 'approved', reverseCharge: true, lines: [line(f)] });
    assert.equal(inv.totalPaise, 200_000);
    assert.equal(await balance(trx, orgId, f.acc[CODE.GST_CGST]) + await balance(trx, orgId, f.acc[CODE.GST_SGST]), 0, 'no output tax');
    const file = await gstr1PortalFile(trx, orgId, '2026-11') as unknown as { b2b: { ctin: string; inv: { inum: string; rchrg: string; itms: { itm_det: { txval: number; camt: number; samt: number; rt: number } }[] }[] }[] };
    const row = file.b2b.flatMap((b) => b.inv).find((i) => i.inum === inv.number);
    assert.ok(row, 'reported in B2B');
    assert.equal(row!.rchrg, 'Y');
    assert.equal(row!.itms[0].itm_det.rt, 18);
    assert.equal(row!.itms[0].itm_det.camt + row!.itms[0].itm_det.samt, 360, 'the ₹360 the recipient pays');
  });
});

test('the reverse-charge rules: a registered buyer and an ordinary taxable supply; the tax at the line’s rate', () => {
  assert.match(reverseChargeProblem({ buyerGstin: null, supplyType: 'intra' }) ?? '', /registered buyer/);
  assert.match(reverseChargeProblem({ buyerGstin: '33AAAAA1111A1Z5', supplyType: 'export_lut' }) ?? '', /export/);
  assert.equal(reverseChargeProblem({ buyerGstin: '33AAAAA1111A1Z5', supplyType: 'inter' }), null);
  assert.deepEqual(reverseChargeTax(100_000 as never, 18, true), { cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0 });
  assert.deepEqual(reverseChargeTax(100_000 as never, 18, false), { cgstPaise: 0, sgstPaise: 0, igstPaise: 18_000 });
});

test('a draft credit note posts nothing, is not in GSTR-1, cannot be applied; opened, it posts and credits its invoice', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const inv = await createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-05', dueDate: '2026-12-05', status: 'approved', lines: [line(f)] });
    const draft = await createCreditNote(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-08', reason: 'Sales Return', againstInvoiceId: inv.id, lines: [line(f, 1)], status: 'draft' });
    const row = await trx.selectFrom('credit_notes').select(['status', 'journal_entry_id']).where('id', '=', draft.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.status, row.journal_entry_id], ['draft', null]);
    assert.equal(await balance(trx, orgId, f.acc[CODE.AR]), 236_000, 'the receivable is untouched');
    await assert.rejects(applyCreditNote(trx, orgId, null, draft.id, { date: '2026-11-09', allocations: [{ invoiceId: inv.id, amountPaise: 100 }] }), /is a draft/);
    const file = await gstr1PortalFile(trx, orgId, '2026-11') as unknown as { cdnr?: { nt: { nt_num: string }[] }[] };
    assert.ok(!(file.cdnr ?? []).some((c) => c.nt.some((n) => n.nt_num === draft.number)), 'a draft is not reported');

    const opened = await openCreditNote(trx, orgId, null, draft.id);
    assert.equal(opened.number, draft.number, 'same number');
    assert.ok(opened.journalEntryId);
    assert.equal(await balance(trx, orgId, f.acc[CODE.AR]), 236_000 - 118_000);
    const after = await trx.selectFrom('credit_notes').select(['status']).where('id', '=', draft.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'applied', 'set against its invoice when opened');
    await assert.rejects(openCreditNote(trx, orgId, null, draft.id), /not a draft/);
  });
});

test('a credit note line comes back out of the income account chosen in its ACCOUNT column', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const other = f.acc[CODE.OTHER_INCOME];
    await createCreditNote(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-08', reason: 'Post Sale Discount', lines: [{ ...line(f, 1), accountId: other }] });
    assert.equal(await balance(trx, orgId, other), 100_000, 'Other Income debited with the taxable value');
    await assert.rejects(
      createCreditNote(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-08', reason: 'Sales Return', lines: [{ ...line(f, 1), accountId: f.acc[CODE.AR] }] }),
      /only out of an income account/,
    );
  });
});

test('Cancel Items takes what is left off a sales order; the order is then invoiced or void', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const so = await createSalesOrder(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', lines: [line(f, 5)] });
    const soLine = await trx.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', so.id).executeTakeFirstOrThrow();
    await invoiceFromSalesOrder(trx, orgId, null, so.id, { date: '2026-11-11', dueDate: '2026-12-11', lines: [{ lineId: soLine.id, qty: 2 }] });
    await assert.rejects(cancelSalesOrderItems(trx, orgId, so.id, [{ lineId: soLine.id, qty: 4 }]), /only 3 is left/);
    const r = await cancelSalesOrderItems(trx, orgId, so.id, [{ lineId: soLine.id, qty: 3 }]);
    assert.deepEqual(r, { cancelled: 3, status: 'invoiced' });
    await assert.rejects(invoiceFromSalesOrder(trx, orgId, null, so.id, { date: '2026-11-12', dueDate: '2026-12-12' }), /./, 'nothing left to invoice');

    const so2 = await createSalesOrder(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', lines: [line(f, 2)] });
    assert.equal((await cancelSalesOrderItems(trx, orgId, so2.id)).status, 'cancelled', 'all cancelled and nothing invoiced: void');
  });
});

test('Convert to Purchase Order buys in the order’s items from the vendor at the purchase price, linked to the order', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const so = await createSalesOrder(trx, orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-10',
      lines: [line(f, 3), { description: 'Fitting charge', qty: 1, ratePaise: 50_000, gstRatePct: 18 }],
    });
    await assert.rejects(purchaseOrderFromSalesOrder(trx, orgId, null, so.id, { vendorId: f.customerId, date: '2026-11-11' }), /Choose a vendor/);
    const po = await purchaseOrderFromSalesOrder(trx, orgId, null, so.id, { vendorId: f.vendorId, date: '2026-11-11' });
    assert.equal(po.skipped, 1, 'the line with no item is left off');
    assert.equal(po.totalPaise, 212_400, '3 × ₹600 + 18%');
    const row = await trx.selectFrom('purchase_orders').select(['source_sales_order_id', 'vendor_id']).where('id', '=', po.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.source_sales_order_id, row.vendor_id], [so.id, f.vendorId]);
  });
});

test('Create Project puts the quote on a new project; the automatic retainer is raised for its per cent', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const q = await createEstimate(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', expiryDate: '2026-11-30', lines: [line(f)], retainerPct: 25 });
    const p = await projectFromEstimate(trx, orgId, null, q.id);
    assert.match(p.name, /Bonita Transport – /);
    const est = await trx.selectFrom('estimates').select('project_id').where('id', '=', q.id).executeTakeFirstOrThrow();
    assert.equal(est.project_id, p.id);
    await assert.rejects(projectFromEstimate(trx, orgId, null, q.id), /already on a project/);

    const r = await retainerFromEstimate(trx, orgId, null, q.id);
    assert.ok(r);
    assert.equal(r!.amountPaise, 59_000, '25% of ₹2,360');
    const ret = await trx.selectFrom('retainer_invoices').select(['source_estimate_id', 'project_id', 'reference']).where('id', '=', r!.id).executeTakeFirstOrThrow();
    assert.deepEqual([ret.source_estimate_id, ret.project_id, ret.reference], [q.id, p.id, q.number]);
    assert.equal(await retainerFromEstimate(trx, orgId, null, q.id), null, 'raised once');
    await assert.rejects(
      createEstimate(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', expiryDate: '2026-11-30', lines: [line(f)], retainerPct: 150 }),
      /above 0 and up to 100/,
    );
  });
});

test('a bill of supply carries no tax: refused for a taxable line, raised for exempt goods', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    await assert.rejects(
      createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.walkInId, date: '2026-11-05', dueDate: '2026-12-05', status: 'approved', billOfSupply: true, lines: [line(f)] }),
      /carries no tax/,
    );
    const bos = await createInvoice(trx, orgId, null, {
      branchId: f.branchId, customerId: f.walkInId, date: '2026-11-05', dueDate: '2026-12-05', status: 'approved', billOfSupply: true,
      lines: [{ itemId: f.exemptItemId, qty: 10, ratePaise: 5_000, gstRatePct: 0 }],
    });
    const row = await trx.selectFrom('invoices').select(['bill_of_supply', 'total', 'cgst', 'igst']).where('id', '=', bos.id).executeTakeFirstOrThrow();
    assert.equal(Number(row.bill_of_supply), 1);
    assert.equal(toPaiseFromSql(row.total), 50_000);
    assert.equal(toPaiseFromSql(row.cgst) + toPaiseFromSql(row.igst), 0);
  });
});

test('goods coming back on a credit note get an inward sales-return e-way bill; a draft does not', async () => {
  const { generateEwayBill } = await import('../../lib/server/integrations/gst/eway-service');
  const call = (async (_r: unknown, _p: unknown, fn: () => Promise<unknown>) => fn()) as never;
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    await trx.updateTable('branches').set({ address: '14 Anna Salai', city: 'Chennai', pincode: '600002' }).where('id', '=', f.branchId).execute();
    await trx.updateTable('contacts').set({ billing_address: '9 Mount Road', billing_city: 'Chennai', billing_pincode: '600006' }).where('id', '=', f.customerId).execute();
    const draft = await createCreditNote(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: new Date().toISOString().slice(0, 10), reason: 'Sales Return', lines: [line(f, 60)], status: 'draft' });
    await assert.rejects(generateEwayBill(trx, orgId, { kind: 'credit_note', id: draft.id }, { vehicleNo: 'TN01AB1234', distanceKm: 20 }, { call }), /convert a draft to open/);
    await openCreditNote(trx, orgId, null, draft.id);
    const gen = await generateEwayBill(trx, orgId, { kind: 'credit_note', id: draft.id }, { vehicleNo: 'TN01AB1234', distanceKm: 20 }, { call });
    assert.ok(gen.ewayBillNo);
    const row = await trx.selectFrom('eway_bills').select(['credit_note_id', 'sub_supply_type', 'status']).where('credit_note_id', '=', draft.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.credit_note_id, row.sub_supply_type, row.status], [draft.id, 'sales_return', 'generated']);
  });
});
