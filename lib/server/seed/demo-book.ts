import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The demo trading history.
//
// Every document here is created through the real services, so each one posts a
// genuine balanced journal entry and the trial balance ties from the first
// render. Writing rows straight into the tables would be faster and would
// produce a book that looks right and proves nothing.
//
// The dates are anchored to a fixed "today" so ageing buckets, overdue flags
// and the 45-day MSME tracker stay stable — a demo where the overdue count
// changes every morning is a demo nobody can screenshot.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import { CODE } from '../ledger/chart-of-accounts';
import { createInvoice, markInvoiceSent } from '../services/sales';
import { createBill, createExpense } from '../services/purchases';
import { receivePayment, makePayment } from '../services/payments';
import { importStatement } from '../services/banking';

/** The book is built as at this date. Matches the frontend demo exactly. */
export const DEMO_TODAY = '2026-08-07';

function daysAgo(n: number): string {
  const d = new Date(DEMO_TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const R = (rupees: number) => Math.round(rupees * 100);

interface Sale {
  customer: string;
  daysAgo: number;
  terms: number;
  lines: { item: string; qty: number }[];
  pay?: 'full' | 'part';
  tds?: boolean;
}

/**
 * Five months of trading. Without history the trend charts have nothing to
 * trend and every "vs previous period" comparison reads as no comparison,
 * which makes a working dashboard look broken.
 */
const SALES: Sale[] = [
  // Prior quarter — April to June.
  { customer: 'c_sharma', daysAgo: 128, terms: 30, lines: [{ item: 'i_tyre', qty: 12 }, { item: 'i_fitment', qty: 12 }], pay: 'full' },
  { customer: 'c_national', daysAgo: 121, terms: 30, lines: [{ item: 'i_battery', qty: 14 }], pay: 'full' },
  { customer: 'c_marina', daysAgo: 114, terms: 15, lines: [{ item: 'i_engineoil', qty: 30 }, { item: 'i_oilfilter', qty: 40 }], pay: 'full' },
  { customer: 'c_deccan', daysAgo: 110, terms: 30, lines: [{ item: 'i_radiator', qty: 3 }, { item: 'i_coolant', qty: 20 }] },
  { customer: 'c_apex', daysAgo: 103, terms: 30, lines: [{ item: 'i_clutch', qty: 15 }], pay: 'full', tds: true },
  { customer: 'c_velocity', daysAgo: 96, terms: 30, lines: [{ item: 'i_shocker', qty: 22 }, { item: 'i_beltkit', qty: 8 }], pay: 'full' },
  { customer: 'c_hosur', daysAgo: 88, terms: 30, lines: [{ item: 'i_alternator', qty: 5 }] },
  { customer: 'c_speedwell', daysAgo: 81, terms: 30, lines: [{ item: 'i_headlamp', qty: 10 }, { item: 'i_fitment', qty: 10 }], pay: 'full' },
  { customer: 'c_kochi', daysAgo: 74, terms: 30, lines: [{ item: 'i_sparkplug', qty: 24 }, { item: 'i_cabinfilter', qty: 30 }], pay: 'full' },
  { customer: 'c_orbit', daysAgo: 66, terms: 30, lines: [{ item: 'i_mirrror', qty: 8 }, { item: 'i_hornset', qty: 16 }], pay: 'full', tds: true },
  { customer: 'c_bluehill', daysAgo: 59, terms: 30, lines: [{ item: 'i_tyre', qty: 18 }], pay: 'full' },
  { customer: 'c_trichy', daysAgo: 52, terms: 30, lines: [{ item: 'i_brakepad', qty: 30 }, { item: 'i_greasekit', qty: 25 }], pay: 'part' },
  { customer: 'c_national', daysAgo: 45, terms: 30, lines: [{ item: 'i_wiper', qty: 35 }, { item: 'i_airfilter', qty: 28 }], pay: 'full' },
  { customer: 'c_ridez', daysAgo: 40, terms: 0, lines: [{ item: 'i_engineoil', qty: 6 }, { item: 'i_fitment', qty: 3 }], pay: 'full' },

  // Current quarter — July and August.
  { customer: 'c_sharma', daysAgo: 34, terms: 30, lines: [{ item: 'i_brakepad', qty: 20 }, { item: 'i_oilfilter', qty: 30 }], pay: 'full' },
  { customer: 'c_apex', daysAgo: 30, terms: 30, lines: [{ item: 'i_battery', qty: 25 }, { item: 'i_fitment', qty: 25 }], pay: 'full', tds: true },
  { customer: 'c_velocity', daysAgo: 27, terms: 30, lines: [{ item: 'i_tyre', qty: 16 }], pay: 'part' },
  { customer: 'c_speedwell', daysAgo: 24, terms: 30, lines: [{ item: 'i_clutch', qty: 8 }, { item: 'i_fitment', qty: 8 }], pay: 'full' },
  { customer: 'c_national', daysAgo: 22, terms: 45, lines: [{ item: 'i_headlamp', qty: 12 }, { item: 'i_wiper', qty: 40 }], pay: 'full' },
  { customer: 'c_marina', daysAgo: 20, terms: 15, lines: [{ item: 'i_engineoil', qty: 24 }, { item: 'i_airfilter', qty: 20 }], pay: 'full' },
  { customer: 'c_deccan', daysAgo: 18, terms: 30, lines: [{ item: 'i_alternator', qty: 6 }] },
  { customer: 'c_hosur', daysAgo: 16, terms: 30, lines: [{ item: 'i_shocker', qty: 18 }, { item: 'i_beltkit', qty: 6 }], pay: 'part' },
  { customer: 'c_kochi', daysAgo: 14, terms: 30, lines: [{ item: 'i_radiator', qty: 4 }, { item: 'i_coolant', qty: 30 }] },
  { customer: 'c_orbit', daysAgo: 12, terms: 30, lines: [{ item: 'i_sparkplug', qty: 30 }, { item: 'i_fitment', qty: 15 }], tds: true },
  { customer: 'c_sez', daysAgo: 11, terms: 30, lines: [{ item: 'i_brakepad', qty: 40 }] },
  { customer: 'c_lanka', daysAgo: 10, terms: 45, lines: [{ item: 'i_clutch', qty: 25 }] },
  { customer: 'c_bluehill', daysAgo: 9, terms: 30, lines: [{ item: 'i_engineoil', qty: 12 }, { item: 'i_cabinfilter', qty: 18 }] },
  { customer: 'c_trichy', daysAgo: 7, terms: 30, lines: [{ item: 'i_mirrror', qty: 6 }, { item: 'i_hornset', qty: 10 }] },
  { customer: 'c_ridez', daysAgo: 6, terms: 0, lines: [{ item: 'i_wiper', qty: 2 }, { item: 'i_fitment', qty: 1 }], pay: 'full' },
  { customer: 'c_sharma', daysAgo: 5, terms: 30, lines: [{ item: 'i_greasekit', qty: 40 }, { item: 'i_oilfilter', qty: 25 }] },
  { customer: 'c_apex', daysAgo: 4, terms: 30, lines: [{ item: 'i_tyre', qty: 20 }] },
  { customer: 'c_velocity', daysAgo: 3, terms: 30, lines: [{ item: 'i_battery', qty: 10 }] },
  { customer: 'c_marina', daysAgo: 2, terms: 15, lines: [{ item: 'i_sparkplug', qty: 12 }] },
  { customer: 'c_speedwell', daysAgo: 1, terms: 30, lines: [{ item: 'i_airfilter', qty: 25 }, { item: 'i_fitment', qty: 10 }] },
];

interface Purchase {
  vendor: string;
  daysAgo: number;
  terms: number;
  vendorNo: string;
  lines: { item?: string; qty: number; rate: number; desc?: string; account?: string }[];
  rcm?: boolean;
  pay?: boolean;
}

const PURCHASES: Purchase[] = [
  { vendor: 'v_bosch', daysAgo: 20, terms: 30, vendorNo: 'BOS/26-27/1187', pay: true,
    lines: [{ item: 'i_sparkplug', qty: 100, rate: 1290 }, { item: 'i_alternator', qty: 18, rate: 6800 }] },
  { vendor: 'v_mrf', daysAgo: 18, terms: 30, vendorNo: 'MRF/8842', pay: true,
    lines: [{ item: 'i_tyre', qty: 30, rate: 4600 }] },
  { vendor: 'v_lumax', daysAgo: 15, terms: 45, vendorNo: 'LMX-4471',
    lines: [{ item: 'i_headlamp', qty: 20, rate: 3400 }, { item: 'i_hornset', qty: 40, rate: 520 }] },
  { vendor: 'v_gabriel', daysAgo: 12, terms: 30, vendorNo: 'GS/26/0912',
    lines: [{ item: 'i_shocker', qty: 42, rate: 1500 }] },
  // MSME, deliberately aged past 40 days so the 43B(h) tracker has something.
  { vendor: 'v_sundaram', daysAgo: 41, terms: 30, vendorNo: 'SF/2026/331',
    lines: [{ item: 'i_beltkit', qty: 12, rate: 2500 }] },
  { vendor: 'v_menon', daysAgo: 10, terms: 15, vendorNo: 'MA/26-27/044',
    lines: [{ qty: 1, rate: 45_000, desc: 'Statutory audit & GST advisory — Q1', account: CODE.PROFESSIONAL }] },
  { vendor: 'v_swift', daysAgo: 8, terms: 15, vendorNo: 'SL/2026/2231',
    lines: [{ qty: 1, rate: 38_000, desc: 'Freight — July consignments', account: CODE.FREIGHT }] },
  { vendor: 'v_kamal', daysAgo: 6, terms: 15, vendorNo: 'KE/771',
    lines: [{ item: 'i_greasekit', qty: 60, rate: 150 }] },
  // Unregistered landlord: we owe the GST ourselves under reverse charge.
  { vendor: 'v_cityprop', daysAgo: 5, terms: 7, vendorNo: 'RENT/AUG/26', rcm: true,
    lines: [{ qty: 1, rate: 85_000, desc: 'Office & godown rent — August 2026', account: CODE.RENT }] },
  { vendor: 'v_bosch', daysAgo: 3, terms: 30, vendorNo: 'BOS/26-27/1244',
    lines: [{ item: 'i_clutch', qty: 30, rate: 2250 }] },
];

const EXPENSES = [
  { account: CODE.UTILITIES, amount: 12_400, gst: 18, note: 'EB bill — Guindy godown (Jul)', days: 9, bank: 'ba_hdfc' },
  { account: CODE.INTERNET, amount: 1_500, gst: 18, note: 'Airtel broadband — August', days: 7, bank: 'ba_hdfc' },
  { account: CODE.FUEL, amount: 4_500, gst: 0, note: 'Fuel — delivery van TN09 AB 1234', days: 3, bank: 'ba_card' },
  { account: CODE.OFFICE, amount: 3_200, gst: 18, note: 'Stationery & printer toner', days: 6, bank: 'ba_cash' },
  { account: CODE.MARKETING, amount: 25_000, gst: 18, note: 'Google Ads — August campaign', days: 5, bank: 'ba_card' },
  { account: CODE.SALARIES, amount: 2_85_000, gst: 0, note: 'Staff salaries — July 2026', days: 6, bank: 'ba_hdfc' },
];

/** Statement lines: some will match seeded payments, some deliberately will not. */
const STATEMENT = [
  { date: daysAgo(30), narration: 'NEFT CR SHARMA TRADERS', depositPaise: R(2_15_000) },
  { date: daysAgo(24), narration: 'BHARAT PETRO FUEL CARD', withdrawalPaise: R(4_500) },
  { date: daysAgo(20), narration: 'UPI CR MARINA CAR CARE', depositPaise: R(48_000) },
  { date: daysAgo(15), narration: 'CITY PROPERTIES RENT AUG', withdrawalPaise: R(85_000) },
  { date: daysAgo(12), narration: 'NEFT DR BOSCH AUTOMOTIVE', withdrawalPaise: R(3_20_000) },
  { date: daysAgo(9), narration: 'BANK CHARGES QTR', withdrawalPaise: R(590) },
  { date: daysAgo(6), narration: 'AIRTEL BROADBAND AUTOPAY', withdrawalPaise: R(1_500) },
  { date: daysAgo(4), narration: 'NEFT CR NATIONAL SPARES', depositPaise: R(1_12_000) },
];

export interface BookResult {
  invoices: number;
  bills: number;
  expenses: number;
  payments: number;
  statementLines: number;
}

export async function seedDemoBook(trx: Trx, ids: IdMap): Promise<BookResult> {
  const branch = (customerKey: string) =>
    ['c_apex', 'c_orbit'].includes(customerKey) ? ids.branches.br_bengaluru : ids.branches.br_chennai;

  const chennai = ids.branches.br_chennai;
  let payments = 0;

  // ── Sales ──────────────────────────────────────────────────────────────────
  for (const sale of SALES) {
    const inv = await createInvoice(trx, ids.orgId, ids.users.u_arun, {
      branchId: branch(sale.customer),
      customerId: ids.contacts[sale.customer],
      date: daysAgo(sale.daysAgo),
      dueDate: daysAgo(sale.daysAgo - sale.terms),
      status: 'approved',
      terms: 'Goods once sold will not be taken back. Interest @18% p.a. on overdue amounts.',
      // No rate given, so each line takes the item's catalogue price.
      lines: sale.lines.map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
    });
    await markInvoiceSent(trx, ids.orgId, ids.users.u_arun, inv.id);

    if (sale.pay) {
      const gross = sale.pay === 'full' ? inv.totalPaise : Math.round(inv.totalPaise * 0.4);
      // A customer who deducts TDS sends less cash but settles the same amount.
      const tds = sale.tds ? Math.round(gross * 0.02) : 0;
      await receivePayment(trx, ids.orgId, ids.users.u_arun, {
        branchId: branch(sale.customer),
        contactId: ids.contacts[sale.customer],
        date: daysAgo(Math.max(0, sale.daysAgo - 12)),
        mode: gross > R(50_000) ? 'neft' : 'upi',
        amountPaise: gross - tds,
        tdsPaise: tds,
        bankAccountId: ids.bankAccounts.ba_hdfc,
        reference: `Ref ${inv.number}`,
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: gross }],
      });
      payments++;
    }
  }

  // ── Purchases ──────────────────────────────────────────────────────────────
  for (const p of PURCHASES) {
    const bill = await createBill(trx, ids.orgId, ids.users.u_priya, {
      branchId: chennai,
      vendorId: ids.contacts[p.vendor],
      vendorInvoiceNo: p.vendorNo,
      date: daysAgo(p.daysAgo),
      dueDate: daysAgo(p.daysAgo - p.terms),
      isRcm: p.rcm,
      lines: p.lines.map((l) => ({
        itemId: l.item ? ids.items[l.item] : null,
        accountId: l.account ? ids.accounts[l.account] : null,
        description: l.desc,
        qty: l.qty,
        ratePaise: R(l.rate),
      })),
    });

    if (p.pay) {
      await makePayment(trx, ids.orgId, ids.users.u_priya, {
        branchId: chennai,
        contactId: ids.contacts[p.vendor],
        date: daysAgo(Math.max(0, p.daysAgo - 10)),
        mode: 'neft',
        amountPaise: bill.totalPaise,
        bankAccountId: ids.bankAccounts.ba_hdfc,
        reference: `Paid ${bill.internalNo}`,
        allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
      });
      payments++;
    }
  }

  // ── Expenses ───────────────────────────────────────────────────────────────
  for (const e of EXPENSES) {
    await createExpense(trx, ids.orgId, ids.users.u_priya, {
      branchId: chennai,
      date: daysAgo(e.days),
      accountId: ids.accounts[e.account],
      paidThroughBankAccountId: ids.bankAccounts[e.bank],
      amountPaise: R(e.amount),
      gstRatePct: e.gst,
      notes: e.note,
    });
  }

  // ── Bank statement ─────────────────────────────────────────────────────────
  const imported = await importStatement(
    trx, ids.orgId, ids.users.u_arun, ids.bankAccounts.ba_hdfc, 'HDFC-Aug-2026.csv', STATEMENT,
  );

  return {
    invoices: SALES.length,
    bills: PURCHASES.length,
    expenses: EXPENSES.length,
    payments,
    statementLines: imported.imported,
  };
}
