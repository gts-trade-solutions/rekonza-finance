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
import { indiaToday } from '../services/held-journals';

/**
 * The book is built as at the day it is seeded, so whoever opens the demo
 * sees a current book: this month's sales, last month's payroll, invoices
 * young enough for an IRN. DEMO_AS_OF=YYYY-MM-DD builds it as at another day.
 */
export const DEMO_TODAY = /^\d{4}-\d{2}-\d{2}$/.test(process.env.DEMO_AS_OF ?? '') ? process.env.DEMO_AS_OF! : indiaToday();

function daysAgo(n: number): string {
  const d = new Date(DEMO_TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const R = (rupees: number) => Math.round(rupees * 100);

// Month words in the book's narrations follow its dates, so a bill dated in
// October is not for "August" when the book is built in November.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (day: string) => MONTH_NAMES[Number(day.slice(5, 7)) - 1];
const monShort = (day: string) => monthOf(day).slice(0, 3);
const yearOf = (day: string) => day.slice(0, 4);

interface Sale {
  customer: string;
  daysAgo: number;
  terms: number;
  lines: { item: string; qty: number }[];
  pay?: 'full' | 'part';
  tds?: boolean;
  /** An export with IGST paid; left out, an export goes under the LUT with IGST nil. */
  exportWithTax?: boolean;
  /** An export of goods: its shipping bill, two days after the invoice. */
  shippingBill?: boolean;
}

/**
 * Five months of trading. Without history the trend charts have nothing to
 * trend and every "vs previous period" comparison reads as no comparison,
 * which makes a working dashboard look broken.
 */
const SALES: Sale[] = [
  // The months before.
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
  // Exports: goods with IGST paid (refund claimed), and services under the LUT.
  { customer: 'c_lanka', daysAgo: 48, terms: 45, lines: [{ item: 'i_sparkplug', qty: 20 }], pay: 'full', exportWithTax: true, shippingBill: true },
  { customer: 'c_gulf', daysAgo: 38, terms: 30, lines: [{ item: 'i_advisory', qty: 4 }], pay: 'full' },

  // The last five weeks.
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
  { customer: 'c_lanka', daysAgo: 10, terms: 45, lines: [{ item: 'i_clutch', qty: 25 }], shippingBill: true },
  // An export of services with IGST paid.
  { customer: 'c_gulf', daysAgo: 8, terms: 30, lines: [{ item: 'i_advisory', qty: 2 }], exportWithTax: true },
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
  { vendor: 'v_sundaram', daysAgo: 41, terms: 30, vendorNo: `SF/${yearOf(daysAgo(41))}/331`,
    lines: [{ item: 'i_beltkit', qty: 12, rate: 2500 }] },
  { vendor: 'v_menon', daysAgo: 10, terms: 15, vendorNo: 'MA/26-27/044',
    lines: [{ qty: 1, rate: 45_000, desc: 'Statutory audit & GST advisory — Q1', account: CODE.PROFESSIONAL }] },
  { vendor: 'v_swift', daysAgo: 8, terms: 15, vendorNo: `SL/${yearOf(daysAgo(8))}/2231`,
    lines: [{ qty: 1, rate: 38_000, desc: `Freight — ${monthOf(daysAgo(38))} consignments`, account: CODE.FREIGHT }] },
  { vendor: 'v_kamal', daysAgo: 6, terms: 15, vendorNo: 'KE/771',
    lines: [{ item: 'i_greasekit', qty: 60, rate: 150 }] },
  // Unregistered landlord: we owe the GST ourselves under reverse charge.
  { vendor: 'v_cityprop', daysAgo: 5, terms: 7, vendorNo: `RENT/${monShort(daysAgo(5)).toUpperCase()}/${yearOf(daysAgo(5)).slice(2)}`, rcm: true,
    lines: [{ qty: 1, rate: 85_000, desc: `Office & godown rent — ${monthOf(daysAgo(5))} ${yearOf(daysAgo(5))}`, account: CODE.RENT }] },
  { vendor: 'v_bosch', daysAgo: 3, terms: 30, vendorNo: 'BOS/26-27/1244',
    lines: [{ item: 'i_clutch', qty: 30, rate: 2250 }] },
];

const EXPENSES = [
  { account: CODE.UTILITIES, amount: 12_400, gst: 18, note: `EB bill — Guindy godown (${monShort(daysAgo(39))})`, days: 9, bank: 'ba_hdfc' },
  { account: CODE.INTERNET, amount: 1_500, gst: 18, note: `Airtel broadband — ${monthOf(daysAgo(7))}`, days: 7, bank: 'ba_hdfc' },
  { account: CODE.FUEL, amount: 4_500, gst: 0, note: 'Fuel — delivery van TN09 AB 1234', days: 3, bank: 'ba_card' },
  { account: CODE.OFFICE, amount: 3_200, gst: 18, note: 'Stationery & printer toner', days: 6, bank: 'ba_cash' },
  { account: CODE.MARKETING, amount: 25_000, gst: 18, note: `Google Ads — ${monthOf(daysAgo(5))} campaign`, days: 5, bank: 'ba_card' },
];

/** Statement lines: some will match seeded payments, some deliberately will not. */
const STATEMENT = [
  { date: daysAgo(30), narration: 'NEFT CR SHARMA TRADERS', depositPaise: R(2_15_000) },
  { date: daysAgo(24), narration: 'BHARAT PETRO FUEL CARD', withdrawalPaise: R(4_500) },
  { date: daysAgo(20), narration: 'UPI CR MARINA CAR CARE', depositPaise: R(48_000) },
  { date: daysAgo(15), narration: `CITY PROPERTIES RENT ${monShort(daysAgo(15)).toUpperCase()}`, withdrawalPaise: R(85_000) },
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

  // ── Sales and exports ──────────────────────────────────────────────────────
  // The business sells within India and abroad, goods and services, and has
  // filed its LUT for the year: exports go with IGST nil unless chosen otherwise.
  const [ty, tm] = DEMO_TODAY.split('-').map(Number);
  const fyStart = tm >= 4 ? ty : ty - 1;
  await trx.updateTable('organizations').set({
    trade_scope: 'both', supplies: 'both', lut_declared: 1, export_igst: 'nil_lut',
    lut_arn: `AD3303${String(fyStart).slice(2)}0456781`,
    lut_valid_from: `${fyStart}-04-01`, lut_valid_to: `${fyStart + 1}-03-31`,
  }).where('id', '=', ids.orgId).execute();

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
      ...(sale.exportWithTax ? { exportWithTax: true } : {}),
      ...(sale.shippingBill ? {
        exportDetails: {
          shippingBillNo: String(4_100_000 + sale.daysAgo * 137), shippingBillDate: daysAgo(Math.max(0, sale.daysAgo - 2)),
          portCode: 'INMAA1', countryCode: 'LK',
        },
      } : {}),
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
    trx, ids.orgId, ids.users.u_arun, ids.bankAccounts.ba_hdfc, `HDFC-${monShort(DEMO_TODAY)}-${yearOf(DEMO_TODAY)}.csv`, STATEMENT,
  );

  return {
    invoices: SALES.length,
    bills: PURCHASES.length,
    expenses: EXPENSES.length,
    payments,
    statementLines: imported.imported,
  };
}
