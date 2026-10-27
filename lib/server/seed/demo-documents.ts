import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The documents around the invoices: quotes, orders, challans, credit notes and
// retainers.
//
// These are seeded through the real services too, so the ones that post — the
// credit notes and retainers — put balanced entries in the same ledger as
// everything else, and the trial balance still ties afterwards. The ones that
// do not post stay out of it, which is the point worth demonstrating: a quote
// for four lakh does not move a single rupee until somebody accepts it.
//
// The chain runs end to end on purpose: one estimate is accepted and becomes an
// order, that order is part-invoiced, and one older estimate simply expires.
// That is what the pipeline actually looks like.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import {
  applyRetainer, convertToInvoice, createChallan, createCreditNote,
  createEstimate, createRetainer, createSalesOrder, refundCreditNote,
} from '../services/sales-documents';
import { receivePayment } from '../services/payments';
import {
  convertPoToBill, createPurchaseOrder, createVendorCredit, refundVendorCredit,
} from '../services/purchase-documents';

/** The book is built as at this date. Matches the invoices seeder exactly. */
const DEMO_TODAY = '2026-08-07';

function daysAgo(n: number): string {
  const d = new Date(DEMO_TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const R = (rupees: number) => Math.round(rupees * 100);

interface Quote {
  customer: string;
  daysAgo: number;
  validFor: number;
  lines: { item: string; qty: number }[];
  /** What happened to it. 'won' becomes an order; 'lost' and 'stale' do not. */
  outcome: 'won' | 'sent' | 'lost' | 'stale';
}

const QUOTES: Quote[] = [
  { customer: 'c_sharma', daysAgo: 62, validFor: 30, outcome: 'stale', lines: [{ item: 'i_tyre', qty: 20 }, { item: 'i_fitment', qty: 20 }] },
  { customer: 'c_national', daysAgo: 41, validFor: 30, outcome: 'won', lines: [{ item: 'i_battery', qty: 24 }, { item: 'i_alternator', qty: 6 }] },
  { customer: 'c_deccan', daysAgo: 33, validFor: 21, outcome: 'lost', lines: [{ item: 'i_radiator', qty: 8 }, { item: 'i_coolant', qty: 40 }] },
  { customer: 'c_marina', daysAgo: 19, validFor: 30, outcome: 'won', lines: [{ item: 'i_engineoil', qty: 60 }, { item: 'i_oilfilter', qty: 80 }] },
  { customer: 'c_velocity', daysAgo: 11, validFor: 30, outcome: 'sent', lines: [{ item: 'i_shocker', qty: 30 }, { item: 'i_beltkit', qty: 12 }] },
  { customer: 'c_apex', daysAgo: 6, validFor: 30, outcome: 'sent', lines: [{ item: 'i_clutch', qty: 18 }] },
  { customer: 'c_kochi', daysAgo: 3, validFor: 15, outcome: 'sent', lines: [{ item: 'i_sparkplug', qty: 48 }, { item: 'i_cabinfilter', qty: 60 }] },
];

/** Orders raised directly, without a quote in front of them. */
const DIRECT_ORDERS: { customer: string; daysAgo: number; ship: number; invoice: boolean; lines: { item: string; qty: number }[] }[] = [
  { customer: 'c_speedwell', daysAgo: 27, ship: 14, invoice: true, lines: [{ item: 'i_headlamp', qty: 16 }, { item: 'i_hornset', qty: 24 }] },
  { customer: 'c_hosur', daysAgo: 15, ship: 10, invoice: false, lines: [{ item: 'i_brakepad', qty: 40 }, { item: 'i_greasekit', qty: 30 }] },
  { customer: 'c_orbit', daysAgo: 8, ship: 12, invoice: false, lines: [{ item: 'i_mirrror', qty: 12 }, { item: 'i_wiper', qty: 40 }] },
];

const CHALLANS: { customer: string; daysAgo: number; type: 'job_work' | 'supply_on_approval' | 'other'; note: string; lines: { item: string; qty: number }[] }[] = [
  { customer: 'c_deccan', daysAgo: 22, type: 'job_work', note: 'Radiators sent out for re-coring', lines: [{ item: 'i_radiator', qty: 6 }] },
  { customer: 'c_velocity', daysAgo: 12, type: 'supply_on_approval', note: 'Trial fitment at customer workshop', lines: [{ item: 'i_shocker', qty: 8 }] },
  { customer: 'c_trichy', daysAgo: 4, type: 'other', note: 'Samples for evaluation', lines: [{ item: 'i_wiper', qty: 20 }, { item: 'i_hornset', qty: 10 }] },
];

/** Orders placed with suppliers, and whether the goods have arrived and been billed. */
const PURCHASE_ORDERS: { vendor: string; daysAgo: number; expect: number; bill: string | null; lines: { item: string; qty: number; rate: number }[] }[] = [
  { vendor: 'v_bosch', daysAgo: 34, expect: 14, bill: 'BOS/26-27/1204',
    lines: [{ item: 'i_sparkplug', qty: 120, rate: 1290 }, { item: 'i_cabinfilter', qty: 80, rate: 640 }] },
  { vendor: 'v_mrf', daysAgo: 21, expect: 10, bill: null,
    lines: [{ item: 'i_tyre', qty: 40, rate: 4600 }] },
  { vendor: 'v_lumax', daysAgo: 13, expect: 12, bill: null,
    lines: [{ item: 'i_headlamp', qty: 24, rate: 3400 }, { item: 'i_mirrror', qty: 30, rate: 900 }] },
  { vendor: 'v_gabriel', daysAgo: 6, expect: 15, bill: null,
    lines: [{ item: 'i_shocker', qty: 50, rate: 1500 }, { item: 'i_beltkit', qty: 20, rate: 2500 }] },
];

export interface DocumentsResult {
  estimates: number;
  salesOrders: number;
  challans: number;
  creditNotes: number;
  retainers: number;
  purchaseOrders: number;
  vendorCredits: number;
}

/**
 * Add the surrounding documents to a book that already has its invoices.
 *
 * Runs after seedDemoBook, because the credit notes attach to real invoices and
 * the retainer is applied against one.
 */
export async function seedDemoDocuments(trx: Trx, ids: IdMap): Promise<DocumentsResult> {
  const bengaluru = ['c_apex', 'c_orbit'];
  const branch = (customerKey: string) =>
    bengaluru.includes(customerKey) ? ids.branches.br_bengaluru : ids.branches.br_chennai;

  const admin = ids.users.u_arun;
  let salesOrders = 0;

  // ── Estimates, and what became of them ─────────────────────────────────────
  for (const q of QUOTES) {
    const est = await createEstimate(trx, ids.orgId, admin, {
      branchId: branch(q.customer),
      customerId: ids.contacts[q.customer],
      date: daysAgo(q.daysAgo),
      expiryDate: daysAgo(q.daysAgo - q.validFor),
      status: 'sent',
      notes: 'Prices hold until the expiry date. Delivery 3–5 working days from order.',
      lines: q.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
    });

    if (q.outcome === 'won') {
      // Accepted, so it becomes an order — and the estimate is marked converted
      // by the service, not by hand.
      await createSalesOrder(trx, ids.orgId, admin, {
        branchId: branch(q.customer),
        customerId: ids.contacts[q.customer],
        date: daysAgo(q.daysAgo - 4),
        expectedShipDate: daysAgo(q.daysAgo - 18),
        sourceEstimateId: est.id,
        lines: q.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
      });
      salesOrders++;
    } else if (q.outcome !== 'sent') {
      // Declined, or simply never answered and now past its expiry date.
      await sql`
        UPDATE estimates SET status = ${q.outcome === 'lost' ? 'declined' : 'expired'}
         WHERE id = ${est.id} AND org_id = ${ids.orgId}
      `.execute(trx);
    }
  }

  // ── Orders raised directly ─────────────────────────────────────────────────
  for (const o of DIRECT_ORDERS) {
    const so = await createSalesOrder(trx, ids.orgId, admin, {
      branchId: branch(o.customer),
      customerId: ids.contacts[o.customer],
      date: daysAgo(o.daysAgo),
      expectedShipDate: daysAgo(o.daysAgo - o.ship),
      lines: o.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
    });
    salesOrders++;

    if (o.invoice) {
      // Shipped and billed — this is where the order finally becomes revenue.
      await convertToInvoice(
        trx, ids.orgId, admin,
        { type: 'sales_order', id: so.id },
        { date: daysAgo(o.daysAgo - 9), dueDate: daysAgo(o.daysAgo - 39), status: 'approved' },
      );
    }
  }

  // ── Delivery challans ──────────────────────────────────────────────────────
  for (const c of CHALLANS) {
    await createChallan(trx, ids.orgId, admin, {
      branchId: branch(c.customer),
      customerId: ids.contacts[c.customer],
      date: daysAgo(c.daysAgo),
      challanType: c.type,
      notes: c.note,
      lines: c.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
    });
  }

  // ── Credit notes ───────────────────────────────────────────────────────────
  // Attached to invoices that are actually open, so the credit has something
  // to reduce. Three shapes: one applied, one left on account, one refunded in
  // cash — which is the only one of the three where money moves.
  const openInvoices = await trx
    .selectFrom('invoices')
    .select(['id', 'number', 'branch_id', 'customer_id', 'invoice_date', 'total', 'amount_paid'])
    .where('org_id', '=', ids.orgId)
    .where('status', 'not in', ['draft', 'void'])
    .where((eb) => eb(eb.ref('total'), '>', eb.ref('amount_paid')))
    .orderBy('invoice_date', 'desc')
    .limit(3)
    .execute();

  const REASONS = [
    'Two units returned — wrong variant supplied',
    'Post-sale discount agreed on bulk order',
    'Damaged in transit, replacement not required',
  ];

  let creditNotes = 0;
  for (const [i, inv] of openInvoices.entries()) {
    const line = await trx
      .selectFrom('invoice_lines')
      .select(['item_id', 'description', 'hsn_sac', 'qty', 'uqc', 'rate', 'gst_rate_pct'])
      .where('invoice_id', '=', inv.id)
      .orderBy('line_no')
      .executeTakeFirst();
    if (!line) continue;

    const cn = await createCreditNote(trx, ids.orgId, admin, {
      branchId: inv.branch_id,
      customerId: inv.customer_id,
      date: daysAgo(2 + i),
      reason: REASONS[i] ?? 'Adjustment',
      againstInvoiceId: i === 1 ? null : inv.id,
      // Only the first is set against its invoice. The second stays open on the
      // customer's account; the third is settled in cash below, so applying it
      // first would leave nothing to refund.
      applyImmediately: i === 0,
      lines: [{
        itemId: line.item_id,
        description: line.description,
        hsnSac: line.hsn_sac,
        qty: Math.max(1, Math.floor(Number(line.qty) / 4)),
        uqc: line.uqc,
        ratePaise: Math.round(Number(line.rate) * 100),
        gstRatePct: Number(line.gst_rate_pct),
      }],
    });
    creditNotes++;

    // The third is settled in cash — the customer wanted the money back rather
    // than a credit against a future order.
    if (i === 2) {
      await refundCreditNote(trx, ids.orgId, admin, cn.id, {
        bankAccountId: ids.bankAccounts.ba_hdfc,
        date: daysAgo(1),
        reference: `Refund against ${cn.number}`,
      });
    }
  }

  // ── Retainers ──────────────────────────────────────────────────────────────
  // An annual maintenance contract billed in advance. The money is a liability
  // until the work behind it is done.
  const amc = await createRetainer(trx, ids.orgId, admin, {
    branchId: ids.branches.br_chennai,
    customerId: ids.contacts.c_marina,
    date: daysAgo(45),
    description: 'Annual maintenance contract — fleet servicing, FY 2026-27',
    amountPaise: R(1_50_000),
    status: 'sent',
  });

  // The customer pays the advance. Until this happens the retainer is a
  // receivable, not money in hand — and nothing can be applied against it.
  await receivePayment(trx, ids.orgId, admin, {
    branchId: ids.branches.br_chennai,
    contactId: ids.contacts.c_marina,
    date: daysAgo(40),
    mode: 'neft',
    amountPaise: R(1_50_000),
    bankAccountId: ids.bankAccounts.ba_hdfc,
    reference: `Advance against ${amc.number}`,
    allocations: [{ targetType: 'retainer', targetId: amc.id, amountPaise: R(1_50_000) }],
  });

  const retainerCustomerInvoice = await trx
    .selectFrom('invoices')
    .select(['id', 'total', 'amount_paid'])
    .where('org_id', '=', ids.orgId)
    .where('customer_id', '=', ids.contacts.c_marina)
    .where('status', 'not in', ['draft', 'void'])
    .where((eb) => eb(eb.ref('total'), '>', eb.ref('amount_paid')))
    .orderBy('invoice_date', 'desc')
    .executeTakeFirst();

  if (retainerCustomerInvoice) {
    // Part of the advance has now been earned, so that much moves out of
    // unearned revenue and settles a real invoice.
    const owing = Math.round(
      Number(retainerCustomerInvoice.total) * 100 - Number(retainerCustomerInvoice.amount_paid) * 100,
    );
    await applyRetainer(
      trx, ids.orgId, admin, amc.id, retainerCustomerInvoice.id,
      Math.min(R(1_50_000), owing),
    );
  }

  // The second is raised and sent but not yet paid, so it shows on the ageing
  // report as something to chase — which is exactly what it is.
  await createRetainer(trx, ids.orgId, admin, {
    branchId: ids.branches.br_chennai,
    customerId: ids.contacts.c_national,
    date: daysAgo(18),
    description: 'Advance against Q3 parts supply agreement',
    amountPaise: R(75_000),
    status: 'sent',
  });

  // ── Purchase orders ────────────────────────────────────────────────────────
  // An order commits us to buy; it is not a payable until the goods and the
  // supplier's bill arrive. One of these has arrived and been billed.
  for (const po of PURCHASE_ORDERS) {
    const order = await createPurchaseOrder(trx, ids.orgId, ids.users.u_priya, {
      branchId: ids.branches.br_chennai,
      vendorId: ids.contacts[po.vendor],
      date: daysAgo(po.daysAgo),
      expectedDate: daysAgo(po.daysAgo - po.expect),
      lines: po.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty, ratePaise: R(l.rate) })),
    });

    if (po.bill) {
      await convertPoToBill(trx, ids.orgId, ids.users.u_priya, order.id, {
        vendorInvoiceNo: po.bill,
        date: daysAgo(po.daysAgo - po.expect),
        dueDate: daysAgo(po.daysAgo - po.expect - 30),
      });
    }
  }

  // ── Vendor credits ─────────────────────────────────────────────────────────
  // A supplier's credit note to us. Note the third line of the entry: the input
  // credit claimed on the cost has to be given back, because the supplier will
  // reverse the supply in their own return too.
  const openBills = await trx
    .selectFrom('bills')
    .select(['id', 'internal_no', 'branch_id', 'vendor_id', 'total', 'amount_paid'])
    .where('org_id', '=', ids.orgId)
    .where('status', 'not in', ['draft', 'void'])
    .where((eb) => eb(eb.ref('total'), '>', eb.ref('amount_paid')))
    .orderBy('bill_date', 'desc')
    .limit(2)
    .execute();

  const VC_REASONS = ['Short supply — 4 units not received', 'Rate correction agreed after delivery'];
  let vendorCredits = 0;
  for (const [i, bill] of openBills.entries()) {
    const owing = Number(bill.total) * 100 - Number(bill.amount_paid) * 100;
    const credit = await createVendorCredit(trx, ids.orgId, ids.users.u_priya, {
      branchId: bill.branch_id,
      vendorId: bill.vendor_id,
      date: daysAgo(3 + i),
      reason: VC_REASONS[i] ?? 'Adjustment',
      againstBillId: i === 0 ? bill.id : null,
      // Sized to stay inside what is still owed on the bill.
      amountPaise: Math.max(R(1_000), Math.round(Math.min(owing / 3, R(12_000)) / 118 * 100)),
      gstRatePct: 18,
      applyImmediately: i === 0,
    });
    vendorCredits++;

    // The second one comes back as cash instead of being set off.
    if (i === 1) {
      await refundVendorCredit(trx, ids.orgId, ids.users.u_priya, credit.id, {
        bankAccountId: ids.bankAccounts.ba_hdfc,
        date: daysAgo(1),
        reference: `Refund on ${credit.number}`,
      });
    }
  }

  // ── Budgets ────────────────────────────────────────────────────────────────
  // Annual figures for the accounts a business actually watches. The actuals
  // beside them are read from the journal, never stored twice.
  const BUDGETS: { code: string; amount: number }[] = [
    { code: '5200', amount: 30_00_000 },  // Purchases
    { code: '6200', amount: 9_00_000 },   // Salaries
    { code: '6100', amount: 3_00_000 },   // Rent
    { code: '5300', amount: 1_50_000 },   // Freight
    { code: '6300', amount: 2_00_000 },   // Professional fees
    { code: '6700', amount: 1_00_000 },   // Marketing
    { code: '6400', amount: 60_000 },     // Utilities
    { code: '6500', amount: 50_000 },     // Fuel
    { code: '6600', amount: 30_000 },     // Office
    { code: '6450', amount: 25_000 },     // Internet
  ];

  for (const b of BUDGETS) {
    const account = ids.accounts[b.code];
    if (!account) continue;
    await trx
      .insertInto('budgets')
      .values({
        org_id: ids.orgId,
        branch_id: 0,
        account_id: account,
        fy_label: '2026-27',
        amount: (b.amount).toFixed(4),
        created_by_user_id: admin,
      })
      .execute();
  }

  // ── Recurring journals ─────────────────────────────────────────────────────
  // The three entries almost every business repeats. They are templates: none
  // of them has posted anything yet.
  const RECURRING: { name: string; freq: 'monthly' | 'quarterly'; next: string; dr: string; cr: string; amount: number; memo: string; active: boolean }[] = [
    { name: 'Monthly depreciation — furniture & equipment', freq: 'monthly', next: '2026-09-01',
      dr: '6900', cr: '1600', amount: 12_500, memo: 'Depreciation for the month', active: true },
    { name: 'Prepaid insurance amortisation', freq: 'monthly', next: '2026-09-01',
      dr: '6600', cr: '1600', amount: 4_200, memo: 'Insurance expense for the month', active: true },
    { name: 'Accrued audit fee', freq: 'quarterly', next: '2026-10-01',
      dr: '6300', cr: '2100', amount: 25_000, memo: 'Audit fee accrual', active: false },
  ];

  for (const r of RECURRING) {
    if (!ids.accounts[r.dr] || !ids.accounts[r.cr]) continue;
    await trx.insertInto('recurring_journals').values({
      org_id: ids.orgId,
      branch_id: ids.branches.br_chennai,
      name: r.name,
      frequency: r.freq,
      next_run: r.next,
      debit_account_id: ids.accounts[r.dr],
      credit_account_id: ids.accounts[r.cr],
      amount: r.amount.toFixed(4),
      memo: r.memo,
      is_active: r.active ? 1 : 0,
    }).execute();
  }

  // ── Bank rules ─────────────────────────────────────────────────────────────
  // The lines that repeat every month. Auto-confirm is on only for the two
  // that are unambiguous; the fuel one is left to be reviewed.
  const RULES: { name: string; contains: string; code: string; auto: boolean }[] = [
    { name: 'Bank charges → Bank Charges', contains: 'BANK CHARGES', code: '6800', auto: true },
    { name: 'Freight payments → Freight', contains: 'FREIGHT', code: '5300', auto: true },
    { name: 'Fuel purchases → Fuel', contains: 'BHARAT PETRO', code: '6500', auto: false },
  ];

  for (const [i, r] of RULES.entries()) {
    if (!ids.accounts[r.code]) continue;
    await trx.insertInto('bank_rules').values({
      org_id: ids.orgId,
      name: r.name,
      priority: i + 1,
      conditions: JSON.stringify([{ field: 'narration', op: 'contains', value: r.contains }]),
      action_account_id: ids.accounts[r.code],
      auto_confirm: r.auto ? 1 : 0,
      is_active: 1,
    }).execute();
  }

  // ── Cheques ────────────────────────────────────────────────────────────────
  // Paper in a drawer. None of these has posted anything: a post-dated cheque
  // changes no balance until it clears.
  const CHEQUES: { kind: 'received' | 'issued'; party: string; no: string; bank: string; amount: number; maturesIn: number; status: 'in_hand' | 'deposited' | 'bounced' }[] = [
    { kind: 'received', party: 'c_sharma', no: '004512', bank: 'HDFC Bank', amount: 1_25_000, maturesIn: 12, status: 'in_hand' },
    { kind: 'received', party: 'c_deccan', no: '771903', bank: 'Canara Bank', amount: 84_500, maturesIn: 26, status: 'in_hand' },
    { kind: 'received', party: 'c_hosur', no: '220418', bank: 'Axis Bank', amount: 46_000, maturesIn: -4, status: 'deposited' },
    { kind: 'received', party: 'c_kochi', no: '556201', bank: 'Federal Bank', amount: 31_200, maturesIn: -11, status: 'bounced' },
    { kind: 'issued', party: 'v_lumax', no: '900771', bank: 'HDFC Bank', amount: 92_000, maturesIn: 8, status: 'in_hand' },
    { kind: 'issued', party: 'v_sundaram', no: '900772', bank: 'HDFC Bank', amount: 35_400, maturesIn: 19, status: 'in_hand' },
  ];

  for (const c of CHEQUES) {
    if (!ids.contacts[c.party]) continue;
    await trx.insertInto('cheques').values({
      org_id: ids.orgId,
      kind: c.kind,
      contact_id: ids.contacts[c.party],
      cheque_no: c.no,
      bank_name: c.bank,
      amount: c.amount.toFixed(4),
      is_pdc: c.maturesIn > 0 ? 1 : 0,
      maturity_date: daysAgo(-c.maturesIn),
      status: c.status,
    }).execute();
  }

  // ── GSTR-2B ────────────────────────────────────────────────────────────────
  // What the portal says our suppliers filed. Deliberately imperfect: most
  // entries match the bills exactly, one is short by a rounding-sized amount,
  // and one bill we hold was never filed at all. Those two cases are the whole
  // reason the reconciliation screen exists.
  const filedBills = await trx
    .selectFrom('bills as b')
    .innerJoin('contacts as c', 'c.id', 'b.vendor_id')
    .select([
      'b.id', 'b.vendor_invoice_no', 'b.bill_date', 'b.subtotal',
      'b.cgst', 'b.sgst', 'b.igst', 'c.gstin', 'c.display_name',
    ])
    .where('b.org_id', '=', ids.orgId)
    .where('b.status', 'not in', ['draft', 'void'])
    .where('b.is_rcm', '=', 0)
    .execute();

  for (const [i, b] of filedBills.entries()) {
    if (!b.gstin) continue;
    // The last one is left out entirely: the supplier has not filed it, so the
    // credit we claimed on it is not actually available.
    if (i === filedBills.length - 1) continue;

    // One entry is filed a little short of what we booked.
    const shortfall = i === 1 ? 0.98 : 1;
    const money = (v: string) => (Number(v) * shortfall).toFixed(4);

    const d = String(b.bill_date).slice(0, 10);
    await trx.insertInto('gstr2b_entries').values({
      org_id: ids.orgId,
      return_period: d.slice(5, 7) + d.slice(0, 4),
      vendor_gstin: b.gstin,
      vendor_name: b.display_name,
      invoice_no: b.vendor_invoice_no,
      invoice_date: d,
      taxable: money(String(b.subtotal)),
      cgst: money(String(b.cgst)),
      sgst: money(String(b.sgst)),
      igst: money(String(b.igst)),
      cess: '0.0000',
      itc_available: 1,
      matched_bill_id: null,
      match_status: 'unmatched',
    }).execute();
  }

  // ── Recurring invoice profiles ─────────────────────────────────────────────
  // Contracts that bill the same amount every period. Templates only — nothing
  // has been raised from them yet.
  const RECURRING_SALES: { name: string; customer: string; freq: 'monthly' | 'quarterly'; next: string; item: string; qty: number; rate: number; auto: boolean; active: boolean }[] = [
    { name: 'Monthly fleet maintenance retainer', customer: 'c_bluehill', freq: 'monthly', next: '2026-09-01',
      item: 'i_engineoil', qty: 24, rate: 4_800, auto: true, active: true },
    { name: 'Quarterly parts supply contract', customer: 'c_orbit', freq: 'quarterly', next: '2026-10-01',
      item: 'i_brakepad', qty: 60, rate: 2_100, auto: false, active: true },
    { name: 'AMC — workshop consumables', customer: 'c_marina', freq: 'monthly', next: '2026-09-05',
      item: 'i_greasekit', qty: 20, rate: 1_400, auto: true, active: false },
  ];

  for (const r of RECURRING_SALES) {
    if (!ids.contacts[r.customer] || !ids.items[r.item]) continue;
    await trx.insertInto('recurring_invoices').values({
      org_id: ids.orgId,
      branch_id: branch(r.customer),
      profile_name: r.name,
      customer_id: ids.contacts[r.customer],
      frequency: r.freq,
      start_date: r.next,
      next_run: r.next,
      payment_terms: 'net_30',
      template: JSON.stringify([{
        itemId: ids.items[r.item],
        description: null,
        qty: r.qty,
        ratePaise: R(r.rate),
        gstRatePct: 18,
        hsnSac: null,
      }]),
      auto_send: r.auto ? 1 : 0,
      is_active: r.active ? 1 : 0,
    }).execute();
  }

  // ── Warehouses & stock ─────────────────────────────────────────────────────
  // Stock quantities are derived from the bills and invoices, so nothing has to
  // be seeded for them. What does need seeding is what has no document behind
  // it: an opening quantity, and the handful of write-offs every workshop has.
  await trx.insertInto('warehouses').values([
    {
      org_id: ids.orgId, branch_id: ids.branches.br_chennai, name: 'Chennai main store',
      code: 'CHN-01', address: '12 Mount Road, Chennai 600002', is_primary: 1, is_active: 1,
    },
    {
      org_id: ids.orgId, branch_id: ids.branches.br_bengaluru, name: 'Bengaluru depot',
      code: 'BLR-01', address: '4 MG Road, Bengaluru 560001', is_primary: 0, is_active: 1,
    },
  ]).execute();

  // Opening quantities are sized to cover the trading history plus a working
  // buffer. A business that sold 66 tyres over five months did in fact have
  // them; seeding less would leave the stock report showing negatives that say
  // nothing except that the seed was too small.
  const OPENING: Record<string, number> = {
    i_airfilter: 100, i_alternator: 20, i_battery: 70, i_beltkit: 20,
    i_brakepad: 120, i_cabinfilter: 40, i_clutch: 30, i_coolant: 70,
    i_engineoil: 100, i_greasekit: 30, i_headlamp: 30, i_hornset: 30,
    i_mirrror: 25, i_oilfilter: 130, i_radiator: 15, i_shocker: 20,
    i_sparkplug: 60, i_tyre: 60, i_wiper: 100,
  };

  const ADJUSTMENTS: { item: string; qty: number; reason: 'damage' | 'stocktake' | 'sample'; days: number; note: string }[] = [
    { item: 'i_headlamp', qty: -2, reason: 'damage', days: 24, note: 'Two units cracked in the store room' },
    { item: 'i_coolant', qty: -3, reason: 'stocktake', days: 9, note: 'Physical count short by three' },
    { item: 'i_wiper', qty: -4, reason: 'sample', days: 5, note: 'Given to Trichy Spare Point for evaluation' },
  ];

  // Opening stock belongs on the item, not in the adjustments log — it is where
  // the count starts, not a correction to it.
  for (const [key, qty] of Object.entries(OPENING)) {
    if (!ids.items[key]) continue;
    await trx
      .updateTable('items')
      .set({ opening_stock_qty: String(qty), track_inventory: 1, reorder_level: String(Math.round(qty / 5)) })
      .where('id', '=', ids.items[key])
      .execute();
  }

  for (const a of ADJUSTMENTS) {
    if (!ids.items[a.item]) continue;
    await trx.insertInto('stock_adjustments').values({
      org_id: ids.orgId,
      warehouse_id: null,
      item_id: ids.items[a.item],
      adjust_date: daysAgo(a.days),
      qty_delta: String(a.qty),
      reason: a.reason,
      notes: a.note,
      journal_entry_id: null,
      created_by_user_id: ids.users.u_priya,
    }).execute();
  }

  return {
    estimates: QUOTES.length,
    salesOrders,
    challans: CHALLANS.length,
    creditNotes,
    retainers: 2,
    purchaseOrders: PURCHASE_ORDERS.length,
    vendorCredits,
  };
}
