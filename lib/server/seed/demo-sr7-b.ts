import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The demo book's records for status review 7, builder B: the reviewers judge
// from the online demo's screens, so each item has real records to open.
//
//   5  a FIFO item bought twice, sold, part sent back to the supplier, part
//      returned by the customer and one written off, on the perpetual book:
//      its Stock Layers, and Stock Valuation vs Ledger reading ₹0.00;
//   8  a supplier's bill saved although it looked like another (with the
//      reason given) on the Possible Duplicate Bills register;
//   7  a credit note waiting for approval under a credit-note rule, and one
//      raised on a paid invoice, applied to another and the rest refunded;
//   6  bulk payments of two vendors' bills, and a payment batch whose bank
//      reply paid one transfer (with its UTR) and returned the other;
//   3  imports in the Import History: customers with rows left out and why.
//
// Run from scripts/seed.ts after the perpetual switch (demo-controls.ts), so
// the stock documents post as a perpetual book posts them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { CODE } from '../ledger/chart-of-accounts';
import { createInvoice } from '../services/sales';
import { createBill } from '../services/purchases';
import { createCreditNote, applyCreditNote, refundCreditNote } from '../services/sales-documents';
import { createVendorCredit } from '../services/purchase-documents';
import { createAdjustment } from '../services/stock-changes';
import { saveRule } from '../services/approvals';
import { recordBulkPayments } from '../services/bulk-payments';
import { applyBankReply, approveBatch, createBatch, submitBatch } from '../services/payment-batches';
import { scanForDuplicates } from '../services/duplicate-reviews';
import { runImport } from '../imports/run';
import { recordImportBatch } from '../services/import-history';

const day = (n: number) => {
  const d = new Date(`${DEMO_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export async function seedDemoSr7B(trx: Trx, ids: IdMap) {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const priya = ids.users.u_priya;
  const branch = ids.branches.br_chennai;
  const bosch = ids.contacts.v_bosch;
  const sharma = ids.contacts.c_sharma;
  const apex = ids.contacts.c_apex;
  const hdfc = ids.bankAccounts.ba_hdfc;
  const sales = ids.accounts[CODE.SALES];
  const purchases = ids.accounts[CODE.PURCHASES];
  // Within this month, so the perpetual book (from the 1st) posts them.
  const monthDay = (n: number) => {
    const d = day(n);
    return d >= `${DEMO_TODAY.slice(0, 7)}-01` ? d : `${DEMO_TODAY.slice(0, 7)}-01`;
  };

  // ── 5: the auditors' FIFO scenario on a FIFO item ──────────────────────────
  const fifoItem = Number((await trx.insertInto('items').values({
    org_id: org, kind: 'goods', name: 'Brake Disc Rotor – Creta (FIFO)', description: 'Front brake disc rotor for Hyundai Creta, valued first-in first-out', sku: 'BDR-CRETA', hsn_sac: '8708', uqc: 'NOS',
    sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1, valuation_method: 'fifo',
    sale_account_id: sales, purchase_account_id: purchases,
  }).executeTakeFirstOrThrow()).insertId);
  const buy = (no: string, date: string, ratePaise: number) => createBill(trx, org, priya, {
    branchId: branch, vendorId: bosch, vendorInvoiceNo: no, date, dueDate: day(-30), lines: [{ itemId: fifoItem, qty: 10, ratePaise }],
  });
  await buy('BOS/FIFO/2601', monthDay(6), 10_000);
  const second = await buy('BOS/FIFO/2602', monthDay(5), 12_000);
  const sale = await createInvoice(trx, org, admin, {
    branchId: branch, customerId: sharma, date: monthDay(4), dueDate: day(-26), status: 'approved',
    lines: [{ itemId: fifoItem, qty: 15, ratePaise: 20_000 }],
  });
  const secondLine = await trx.selectFrom('bill_lines').select('id').where('bill_id', '=', second.id).executeTakeFirstOrThrow();
  await createVendorCredit(trx, org, priya, {
    branchId: branch, vendorId: bosch, date: monthDay(3), reason: 'Goods returned — damaged', againstBillId: second.id, amountPaise: 0,
    lines: [{ itemId: fifoItem, billLineId: secondLine.id, qty: 2 }],
  });
  await createCreditNote(trx, org, admin, {
    branchId: branch, customerId: sharma, date: monthDay(2), reason: 'Sales Return', againstInvoiceId: sale.id,
    lines: [{ itemId: fifoItem, qty: 1, ratePaise: 20_000 }],
  });
  await createAdjustment(trx, org, priya, { itemId: fifoItem, date: monthDay(1), qtyDelta: -1, reason: 'damage', notes: 'Cracked rotor found at the stocktake' });

  // ── 8: a near miss on the Possible Duplicate Bills register ────────────────
  const first = await createBill(trx, org, priya, {
    branchId: branch, vendorId: bosch, vendorInvoiceNo: 'BOS/26-27/0771', date: day(9), dueDate: day(-21),
    lines: [{ description: 'Workshop consumables', qty: 1, ratePaise: 1_850_000, gstRatePct: 18, accountId: purchases }],
  });
  await createBill(trx, org, priya, {
    branchId: branch, vendorId: bosch, vendorInvoiceNo: 'BOS/26-27/0774', date: day(7), dueDate: day(-23),
    lines: [{ description: 'Workshop consumables', qty: 1, ratePaise: 1_850_000, gstRatePct: 18, accountId: purchases }],
    duplicateReason: 'Second delivery of the monthly consumables order; Bosch confirmed on the phone it is a separate invoice',
  });
  await scanForDuplicates(trx, org, priya);
  void first;

  // ── 7: credit notes: one waiting for approval, one on a paid invoice ───────
  await saveRule(trx, org, { documentType: 'credit_note', thresholdPaise: 50_000_00, approverRole: 'accountant', isActive: true });
  const bigSale = await createInvoice(trx, org, admin, {
    branchId: branch, customerId: apex, date: day(12), dueDate: day(-18), status: 'approved',
    lines: [{ description: 'Fleet service package — 20 vehicles', qty: 20, ratePaise: 4_500_00, gstRatePct: 18 }],
  });
  await createCreditNote(trx, org, admin, {
    branchId: branch, customerId: apex, date: day(3), reason: 'Rate reduction agreed after delivery', againstInvoiceId: bigSale.id,
    lines: [{ description: 'Fleet service package — rate cut on 20 vehicles', qty: 20, ratePaise: 3_000_00, gstRatePct: 18 }],
  });
  const paidSale = await createInvoice(trx, org, admin, {
    branchId: branch, customerId: sharma, date: day(15), dueDate: day(0), status: 'approved',
    lines: [{ description: 'Wheel alignment and balancing', qty: 4, ratePaise: 1_200_00, gstRatePct: 18 }],
  });
  const settled = await trx.selectFrom('invoices').select('total').where('id', '=', paidSale.id).executeTakeFirstOrThrow();
  await trx.updateTable('invoices').set({ amount_paid: settled.total, status: 'paid' }).where('id', '=', paidSale.id).execute();
  const late = await createCreditNote(trx, org, admin, {
    branchId: branch, customerId: sharma, date: day(4), reason: 'Service not done on one vehicle', againstInvoiceId: paidSale.id,
    lines: [{ description: 'Wheel alignment — one vehicle not done', qty: 1, ratePaise: 1_200_00, gstRatePct: 18 }],
  });
  const open = await createInvoice(trx, org, admin, {
    branchId: branch, customerId: sharma, date: day(3), dueDate: day(-27), status: 'approved',
    lines: [{ description: 'Brake bleeding service', qty: 1, ratePaise: 800_00, gstRatePct: 18 }],
  });
  await applyCreditNote(trx, org, admin, late.id, { date: day(2), allocations: [{ invoiceId: open.id, amountPaise: 500_00 }] });
  await refundCreditNote(trx, org, admin, late.id, { bankAccountId: hdfc, date: day(1), reference: 'NEFT refund to Sharma Traders' });

  // ── 6: bulk payments, and a batch with the bank's reply ────────────────────
  const lumax = ids.contacts.v_lumax;
  const gabriel = ids.contacts.v_gabriel;
  const b1 = await createBill(trx, org, priya, { branchId: branch, vendorId: lumax, vendorInvoiceNo: 'LMX/26-27/3310', date: day(20), dueDate: day(-10), lines: [{ description: 'Headlamp units', qty: 6, ratePaise: 4_200_00, gstRatePct: 18, accountId: purchases }] });
  const b2 = await createBill(trx, org, priya, { branchId: branch, vendorId: gabriel, vendorInvoiceNo: 'GAB/CHN/0912', date: day(18), dueDate: day(-12), lines: [{ description: 'Shock absorbers', qty: 8, ratePaise: 2_650_00, gstRatePct: 18, accountId: purchases }] });
  const due = async (id: number) => {
    const b = await trx.selectFrom('bills').select(['total', 'amount_paid']).where('id', '=', id).executeTakeFirstOrThrow();
    return Math.round((Number(b.total) - Number(b.amount_paid)) * 100);
  };
  await recordBulkPayments(trx, org, admin, {
    side: 'made', branchId: branch, date: day(2), mode: 'neft', bankAccountId: hdfc, reference: 'Weekly supplier run',
    rows: [{ docId: b1.id, amountPaise: await due(b1.id) }, { docId: b2.id, amountPaise: Math.round((await due(b2.id)) / 2) }],
  });
  const b3 = await createBill(trx, org, priya, { branchId: branch, vendorId: lumax, vendorInvoiceNo: 'LMX/26-27/3388', date: day(10), dueDate: day(-20), lines: [{ description: 'Fog lamp kits', qty: 10, ratePaise: 1_450_00, gstRatePct: 18, accountId: purchases }] });
  const batch = await createBatch(trx, org, priya, { branchId: branch, bankAccountId: hdfc, payDate: day(1), notes: 'Mid-month supplier payments', lines: [{ billId: b3.id, amountPaise: await due(b3.id) }, { billId: b2.id, amountPaise: await due(b2.id) }] });
  // The demo's rule asks a second person to release a batch: Priya made it, Arun releases it.
  const sent = await submitBatch(trx, org, priya, batch.id);
  if (sent.status === 'pending') await approveBatch(trx, org, { userId: admin, role: 'admin' }, batch.id, 'Checked against the bills');
  const number = (await trx.selectFrom('payment_batches').select('number').where('id', '=', batch.id).executeTakeFirstOrThrow()).number;
  await applyBankReply(trx, org, admin, batch.id, [
    ['HDFC ENet — Bulk payment status'],
    ['Customer Reference No', 'Amount', 'Status', 'UTR No', 'Reject Reason'],
    [`${number}/${lumax}`, ((await due(b3.id)) / 100).toFixed(2), 'Success', 'HDFCN52026' + DEMO_TODAY.replace(/-/g, '').slice(2) + '0041', ''],
    [`${number}/${gabriel}`, ((await due(b2.id)) / 100).toFixed(2), 'Rejected', '', 'Beneficiary IFSC changed: bank merged'],
  ]);

  // ── 3: imports in the history ─────────────────────────────────────────────
  const ctx = { orgId: org, userId: priya, branchId: branch, onDuplicate: 'skip' as const, requireBalancedOpenings: true };
  const rows = [
    { type: 'customer', name: 'Ganesh Auto Spares', state: 'Tamil Nadu', email: 'accounts@ganeshauto.in', phone: '9840011223', pincode: '600017', __line: '2' },
    { type: 'customer', name: 'Pollachi Motors', state: '33', phone: '04259 223344', pincode: '642001', __line: '3' },
    { type: 'customer', name: 'Wrong PIN Garage', state: '33', pincode: '06001', __line: '4' },
    { type: 'customer', name: 'Bad Mail Traders', state: '33', email: 'accounts@', __line: '5' },
    { type: 'customer', name: 'Sharma Traders', state: '33', __line: '6' },
    { type: 'customer', name: '', state: '33', __line: '7' },
  ];
  const out = await runImport(trx, ctx, 'contacts', rows);
  await recordImportBatch(trx, org, priya, { module: 'customers', kind: 'contacts', fileName: 'customers-november.xlsx', fileFormat: 'xlsx', mode: 'valid_only', outcome: out });
  const items = await runImport(trx, ctx, 'items', [
    { name: 'Wheel Bearing – Swift Front', description: 'Front wheel bearing for Maruti Swift', kind: 'goods', hsn_sac: '8482', unit: 'NOS', gst_rate: '18', purchase_price: '650', sale_price: '980', __line: '2' },
    { name: 'Brake Fluid DOT4 500ml', description: 'DOT4 brake fluid, 500 ml bottle', kind: 'goods', hsn_sac: '3819', unit: 'BTL', gst_rate: '18', purchase_price: '180', sale_price: '260', __line: '3' },
  ]);
  await recordImportBatch(trx, org, priya, { module: 'items', kind: 'items', fileName: 'new-items.csv', fileFormat: 'csv', mode: 'all', outcome: items });
}
