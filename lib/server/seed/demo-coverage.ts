import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the software checklist, in the demo book. A reviewer opening
// any area finds something in it, entered through the same services a user's
// clicks go through, so every voucher posts and every report reads it as the
// real thing would:
//
//   company      statutory details (TAN, CIN, incorporation, GST dates)
//   security     a finance controller on two-step sign-in; bills over a lakh
//                approved by an admin, the approval history kept
//   masters      cost centres (the divisions), stock groups, employees
//   vouchers     journals, contra entries, a debit note
//   inventory    a goods receipt against an order, a transfer between the
//                godowns, stock issued to the workshop
//   banking      a NEFT payment batch approved and paid; a vendor paid by cheque
//   receivables  collection calls with promises to pay; balance confirmations
//   assets       the fixed asset register, depreciated month by month
//   payroll      five employees, the last four months prepared, posted and paid; leave
//   gst          GSTR-1, GSTR-3B, PF and ESI marked filed for those months, once due
//   banking      the HDFC statement reconciled: receipts matched, charges posted
//   integration  an API key for Power BI, a webhook for the order system
//
// Backups are of the whole server, not of one company: the backup script
// records them when it runs (npm run db:backup), never this seed.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Trx } from '../db';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { CODE } from '../ledger/chart-of-accounts';
import { createInvoice, markInvoiceSent } from '../services/sales';
import { createBill, createExpense, postBill } from '../services/purchases';
import { makePayment, receivePayment } from '../services/payments';
import { createTransfer as bankTransfer } from '../services/banking';
import { createTransfer as godownTransfer, receiveTransfer } from '../services/stock-transfers';
import { postManualJournal } from '../services/journals';
import { saveCostCentre } from '../services/cost-centres';
import { saveRule, approve } from '../services/approvals';
import { createPurchaseOrder } from '../services/purchase-documents';
import { receiveFromPurchaseOrder, billFromGoodsReceipt } from '../services/order-flow';
import { approveBatch, createBatch, markBatchPaid, payableBills, submitBatch } from '../services/payment-batches';
import { logFollowUp } from '../services/collections';
import { recordReply, requestConfirmation } from '../services/balance-confirmations';
import { addAsset, ensureAssetClasses, listAssetClasses, runDepreciation } from '../services/fixed-assets';
import { createEmployee } from '../payroll/employees';
import { payRun, postRun, prepareRun } from '../payroll/payroll';
import { grantLeave, listLeaveTypes, recordLeave } from '../payroll/leave';
import { createApiKey } from '../auth/api-keys';
import { saveWebhook } from '../integrations/webhooks';
import { confirmEnrolment, startEnrolment } from '../auth/mfa';
import { codeAt, stepAt } from '../auth/totp';
import { seal } from '../crypto/fields';
import { trueUpStock } from '../services/stock-ledger';
import { registerInvoice } from '../integrations/gst/einvoice-service';
import { categoriseTransaction, matchToPayment } from '../services/banking';
import { queueReminders } from '../services/reminders';
import { monthLabel } from '../../date-range';

const R = (rupees: number) => Math.round(rupees * 100);
const iso = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
/** n days before the book's date (a negative n is after it). */
const day = (n: number) => {
  const [y, m, d] = DEMO_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
/** The last four whole months before the book's date, oldest first: payroll, depreciation and returns run for these. */
const MONTHS = [4, 3, 2, 1].map((k) => {
  const [y, m] = DEMO_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 7);
});
/** The last quarter-end before the book's date: the balance confirmations are taken there. */
const QUARTER_END = (() => {
  const [y, m] = DEMO_TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 0)).toISOString().slice(0, 10);
})();
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextMonthDay = (month: string, day: number) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
};

export interface CoverageResult {
  costCentres: number; employees: number; payrollMonths: number; assets: number; depreciationRuns: number;
  journals: number; contra: number; debitNotes: number; transfers: number; approvals: number; filings: number;
}

export async function seedDemoCoverage(trx: Trx, ids: IdMap): Promise<CoverageResult> {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const accountant = ids.users.u_priya;
  const chennai = ids.branches.br_chennai;
  const acc = (code: string) => {
    const id = ids.accounts[code];
    if (!id) throw new Error(`The demo chart has no account ${code}.`);
    return id;
  };
  const ledgerOf = async (bankAccountId: number) => Number((await trx.selectFrom('bank_accounts').select('ledger_account_id')
    .where('id', '=', bankAccountId).executeTakeFirstOrThrow()).ledger_account_id);

  // ── Company: the statutory details beside the PAN ─────────────────────────
  await trx.updateTable('organizations').set({
    tan: 'CHER04231F', cin: 'U34300TN2012PTC084231', incorporated_on: '2012-06-14', gst_registered_on: '2017-07-01',
    constitution: 'Private limited company', business_nature: 'Trader (wholesale),Retailer,Service provider',
    // Settings › Statutory: the TDS deductor and the PF and ESI registrations.
    deductor_type: 'K', tds_rp_name: 'Arun Kumar', tds_rp_designation: 'Director', tds_rp_pan: 'AJKPK4231L',
    tds_rp_mobile: '9840012345', tds_rp_email: 'accounts@raceautospares.in',
    pf_establishment_code: 'TNMAS0084231000', esi_employer_code: '51000842310001001',
  }).where('id', '=', org).execute();

  // ── Security: a finance controller who signs in with a code from a phone ──
  const arun = await trx.selectFrom('users').select(['password_hash']).where('id', '=', admin).executeTakeFirstOrThrow();
  const controller = Number((await trx.insertInto('users').values({
    org_id: org, name: 'Ramesh Iyer', email: 'ramesh@raceautospares.in', password_hash: arun.password_hash,
    role: 'admin', home_branch_id: chennai, is_active: 1,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.insertInto('user_branches').values(Object.values(ids.branches).map((b) => ({ user_id: controller, branch_id: b }))).execute();
  const enrol = await startEnrolment(trx, { userId: controller, email: 'ramesh@raceautospares.in' }, 'Rekonza');
  await confirmEnrolment(trx, controller, codeAt(enrol.secret, stepAt(Date.now())));

  // ── Masters: the divisions as cost centres, stock groups ──────────────────
  const centre = {
    spares: await saveCostCentre(trx, org, { code: 'SPARES', name: 'Spare parts trading', category: 'Division' }),
    service: await saveCostCentre(trx, org, { code: 'SERVICE', name: 'Workshop and fitment', category: 'Division' }),
    blr: await saveCostCentre(trx, org, { code: 'BLR', name: 'Bengaluru depot', category: 'Location' }),
    ho: await saveCostCentre(trx, org, { code: 'HO', name: 'Head office', category: 'Overhead' }),
  };
  const GROUPS: [string, string[]][] = [
    ['Brakes and suspension', ['i_brakepad', 'i_clutch', 'i_shocker']],
    ['Engine and filters', ['i_airfilter', 'i_oilfilter', 'i_cabinfilter', 'i_beltkit', 'i_radiator']],
    ['Electricals', ['i_sparkplug', 'i_headlamp', 'i_wiper', 'i_alternator', 'i_hornset', 'i_mirrror']],
    ['Tyres and batteries', ['i_tyre', 'i_battery']],
    ['Lubricants and fluids', ['i_engineoil', 'i_coolant', 'i_greasekit']],
  ];
  for (const [name, items] of GROUPS) {
    const g = Number((await trx.insertInto('stock_groups').values({ org_id: org, name, parent_id: null }).executeTakeFirstOrThrow()).insertId);
    const itemIds = items.map((k) => ids.items[k]).filter(Boolean);
    if (itemIds.length) await trx.updateTable('items').set({ stock_group_id: g }).where('id', 'in', itemIds).execute();
  }

  // Sales and costs booked to the divisions, so profit by cost centre has something to show.
  const DIVISION_SALES = [
    { customer: 'c_sharma', date: day(6), centre: centre.spares, lines: [{ item: 'i_brakepad', qty: 12 }, { item: 'i_oilfilter', qty: 30 }] },
    { customer: 'c_marina', date: day(4), centre: centre.service, lines: [{ item: 'i_fitment', qty: 6 }, { item: 'i_engineoil', qty: 6 }] },
    { customer: 'c_orbit', date: day(2), centre: centre.blr, lines: [{ item: 'i_tyre', qty: 8 }, { item: 'i_battery', qty: 4 }] },
  ];
  for (const s of DIVISION_SALES) {
    const inv = await createInvoice(trx, org, admin, {
      branchId: s.customer === 'c_orbit' ? ids.branches.br_bengaluru : chennai, customerId: ids.contacts[s.customer],
      date: s.date, dueDate: nextMonthDay(s.date.slice(0, 7), 5), status: 'approved', costCentreId: s.centre,
      lines: s.lines.filter((l) => ids.items[l.item]).map((l) => ({ itemId: ids.items[l.item], qty: l.qty })),
    });
    await markInvoiceSent(trx, org, admin, inv.id);
  }
  for (const e of [
    { date: day(5), account: CODE.UTILITIES, amount: 8_450, centre: centre.ho, note: 'Electricity, head office (TNEB)' },
    { date: day(3), account: CODE.UTILITIES, amount: 3_920, centre: centre.service, note: 'Compressor power, workshop' },
  ]) {
    await createExpense(trx, org, accountant, {
      branchId: chennai, date: e.date, accountId: acc(e.account), paidThroughBankAccountId: ids.bankAccounts.ba_hdfc,
      amountPaise: R(e.amount), gstRatePct: 18, notes: e.note, costCentreId: e.centre,
    });
  }

  // ── Vouchers: journals, contra entries, a debit note ──────────────────────
  const JOURNALS = [
    { date: monthEnd(MONTHS[2]), memo: 'Statutory audit fee for the last year, provided for', dr: CODE.PROFESSIONAL, cr: CODE.PROVISIONS, amount: 60_000 },
    { date: monthEnd(MONTHS[3]), memo: 'Rent for the month, Guindy godown, outstanding', dr: CODE.RENT, cr: CODE.PROVISIONS, amount: 45_000 },
    { date: day(21), memo: 'Advance to Karthik S for the Coimbatore trade fair', dr: CODE.LOANS_ADVANCES, cr: CODE.CASH, amount: 10_000 },
  ];
  for (const j of JOURNALS) {
    await postManualJournal(trx, org, accountant, {
      branchId: chennai, date: j.date, memo: j.memo, approved: true,
      lines: [{ accountId: acc(j.dr), debitPaise: R(j.amount) }, { accountId: acc(j.cr), creditPaise: R(j.amount) }],
    });
  }
  await bankTransfer(trx, org, accountant, { fromBankAccountId: ids.bankAccounts.ba_cash, toBankAccountId: ids.bankAccounts.ba_hdfc, date: day(13), amountPaise: R(20_000), reference: 'Counter sales cash deposited' });
  await bankTransfer(trx, org, admin, { fromBankAccountId: ids.bankAccounts.ba_hdfc, toBankAccountId: ids.bankAccounts.ba_icici, date: day(10), amountPaise: R(2_00_000), reference: 'Funds for Bengaluru depot payments' });
  const against = await trx.selectFrom('invoices').select('id').where('org_id', '=', org).where('customer_id', '=', ids.contacts.c_apex)
    .where('doc_kind', '=', 'invoice').orderBy('invoice_date').orderBy('id').executeTakeFirst();
  if (against) {
    await createInvoice(trx, org, admin, {
      branchId: ids.branches.br_bengaluru, customerId: ids.contacts.c_apex, date: day(16), dueDate: day(-14), status: 'approved',
      docKind: 'debit_note', againstInvoiceId: against.id, noteReason: 'Rate revised upward under the annual rate contract',
      lines: [{ description: 'Price difference, brake pad sets (12 nos at ₹120)', hsnSac: '8708', qty: 12, uqc: 'NOS', ratePaise: R(120), gstRatePct: 28 }],
    });
  }

  // ── Inventory: an order received into stock, a godown transfer, issues ────
  const po = await createPurchaseOrder(trx, org, accountant, {
    branchId: chennai, vendorId: ids.contacts.v_bosch, date: day(20), expectedDate: day(14),
    lines: [{ itemId: ids.items.i_brakepad, qty: 40, ratePaise: R(980) }, { itemId: ids.items.i_sparkplug, qty: 20, ratePaise: R(1290) }],
  });
  const grn = await receiveFromPurchaseOrder(trx, org, accountant, po.id, { date: day(14), vendorChallanNo: 'BOS-DC-7781' });
  await billFromGoodsReceipt(trx, org, accountant, grn.id, { vendorInvoiceNo: 'BOS/26-27/2264', date: day(14), dueDate: day(-16) });
  // Goods move between godowns of one GST registration; between Chennai and
  // Bengaluru they would be a supply, invoiced (the service refuses it).
  const chn = (await trx.selectFrom('warehouses').select('id').where('org_id', '=', org).where('code', '=', 'CHN-01').executeTakeFirst())?.id;
  const overflow = Number((await trx.insertInto('warehouses').values({
    org_id: org, branch_id: chennai, name: 'Guindy overflow store', code: 'CHN-02', address: '7 Industrial Estate, Guindy, Chennai 600032',
    is_primary: 0, is_active: 1,
  }).executeTakeFirstOrThrow()).insertId);
  let transfers = 0;
  if (chn) {
    const t = await godownTransfer(trx, org, accountant, {
      fromWarehouseId: chn, toWarehouseId: overflow, date: day(12), vehicleNo: 'TN09BX4417', notes: 'Fast movers to the Guindy store',
      lines: [{ itemId: ids.items.i_brakepad, qty: 10 }, { itemId: ids.items.i_sparkplug, qty: 6 }],
    });
    await receiveTransfer(trx, org, t.id, day(11));
    transfers++;
  }
  for (const a of [
    { item: 'i_engineoil', qty: -4, date: day(26), note: 'Issued to the workshop for fleet servicing' },
    { item: 'i_greasekit', qty: -6, date: day(8), note: 'Issued to the workshop' },
  ]) {
    if (!ids.items[a.item]) continue;
    await trx.insertInto('stock_adjustments').values({
      org_id: org, warehouse_id: chn ?? null, item_id: ids.items[a.item], adjust_date: a.date, qty_delta: String(a.qty),
      reason: 'issued', notes: a.note, journal_entry_id: null, created_by_user_id: accountant,
    }).execute();
  }

  // ── Banking: a NEFT batch approved and paid, a vendor paid by cheque ──────
  // Suppliers paid by bank transfer carry their bank details, sealed as the form seals them.
  const VENDOR_BANKS: [string, string, string, string][] = [
    ['v_bosch', 'Bosch Automotive Distributors', '50200012345671', 'HDFC0001234'],
    ['v_lumax', 'Lumax Lighting Co', '920020034567812', 'UTIB0000456'],
    ['v_mrf', 'MRF Tyres Regional Depot', '1234500067891', 'IOBA0000789'],
    ['v_gabriel', 'Gabriel Shockers Ltd', '30987654321', 'SBIN0001122'],
    ['v_sundaram', 'Sundaram Fasteners Agency', '11223344556677', 'ICIC0000456'],
    ['v_cityprop', 'City Properties', '60011122233344', 'IDIB000G015'],
    ['v_menon', 'Menon & Associates', '78900011122233', 'KKBK0000460'],
    ['v_swift', 'Swift Logistics', '45600078912345', 'CNRB0001023'],
  ];
  for (const [key, name, no, ifsc] of VENDOR_BANKS) {
    if (!ids.contacts[key]) continue;
    await trx.updateTable('contacts').set({ bank_account_name: name, bank_account_no: seal(no), bank_ifsc: ifsc })
      .where('id', '=', ids.contacts[key]).execute();
  }
  const open = (await payableBills(trx, org)).filter((b) => b.balancePaise > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const [chequeBill, ...batchBills] = open;
  if (chequeBill) {
    await makePayment(trx, org, admin, {
      branchId: chennai, contactId: Number(chequeBill.vendorId), date: day(9), mode: 'cheque', amountPaise: chequeBill.balancePaise,
      bankAccountId: ids.bankAccounts.ba_hdfc, reference: '000451',
      allocations: [{ targetType: 'bill', targetId: Number(chequeBill.id), amountPaise: chequeBill.balancePaise }],
    });
  }
  const forBatch = batchBills.slice(0, 2);
  // Every supplier run is released by an admin, so the batch has an approval history.
  await saveRule(trx, org, { documentType: 'payment_batch', thresholdPaise: 0, approverRole: 'admin', isActive: true });
  if (forBatch.length) {
    const batch = await createBatch(trx, org, accountant, {
      branchId: chennai, bankAccountId: ids.bankAccounts.ba_hdfc, payDate: day(2), notes: 'Weekly supplier run',
      lines: forBatch.map((b) => ({ billId: Number(b.id), amountPaise: b.balancePaise })),
    });
    await submitBatch(trx, org, accountant, batch.id);
    await approveBatch(trx, org, { userId: admin, role: 'admin' }, batch.id, 'Checked against the bills due this week');
    await markBatchPaid(trx, org, admin, batch.id);
  }

  // ── Approvals: bills over a lakh need an admin, and one went through ──────
  await saveRule(trx, org, { documentType: 'bill', thresholdPaise: R(1_00_000), approverRole: 'admin', isActive: true });
  const big = await createBill(trx, org, accountant, {
    branchId: chennai, vendorId: ids.contacts.v_mrf, vendorInvoiceNo: 'MRF/CHN/26-27/0912', date: day(4), dueDate: day(-26),
    holdForApproval: true,
    lines: [{ itemId: ids.items.i_tyre, description: 'Tyre 185/65 R15 – MRF ZVTV', qty: 24, ratePaise: R(4600) }],
  });
  if (big.heldForApproval) await approve(trx, org, { userId: admin, role: 'admin' }, 'bill', big.id, postBill, 'Within the quarterly tyre budget');

  // ── Receivables and payables: follow-ups, balance confirmations ───────────
  const overdue = await sql<{ id: number; customer_id: number; balance: string }>`
    SELECT i.id, i.customer_id, i.total - i.amount_paid AS balance FROM invoices i
     WHERE i.org_id = ${org} AND i.doc_kind = 'invoice' AND i.status NOT IN ('draft','void','paid') AND i.due_date < ${DEMO_TODAY}
     ORDER BY i.due_date LIMIT 3`.execute(trx);
  const promises = [
    { kind: 'call' as const, note: 'Spoke to their accounts head; cheque promised after their month-end close', inDays: 6 },
    { kind: 'whatsapp' as const, note: 'Sent the statement on WhatsApp; part payment promised this week', inDays: 3 },
    { kind: 'visit' as const, note: 'Visited the garage; owner disputes one line, will pay the rest', inDays: 10 },
  ];
  for (const [i, inv] of overdue.rows.entries()) {
    const p = promises[i];
    const promised = day(-p.inDays);
    await logFollowUp(trx, org, { id: admin, name: 'Arun Kumar' }, {
      contactId: inv.customer_id, invoiceId: inv.id, kind: p.kind, note: p.note,
      promisedDate: promised, promisedPaise: Math.round(Number(inv.balance) * 100 * (i === 1 ? 0.5 : 1)), nextFollowup: promised,
    });
  }
  const custConf = await requestConfirmation(trx, org, admin, { contactId: ids.contacts.c_apex, side: 'customer', asOf: QUARTER_END, notes: 'Confirmation for the auditors' });
  await recordReply(trx, org, custConf.id, { theirBalancePaise: custConf.ourBalancePaise, notes: 'Confirmed by Apex Motors accounts' });
  const vendConf = await requestConfirmation(trx, org, accountant, { contactId: ids.contacts.v_bosch, side: 'vendor', asOf: QUARTER_END, notes: 'Confirmation for the auditors' });
  await recordReply(trx, org, vendConf.id, { theirBalancePaise: vendConf.ourBalancePaise, notes: 'Agreed; ledger copy received' });

  // ── Fixed assets: the register, depreciated month by month ────────────────
  await ensureAssetClasses(trx, org);
  const classes = await listAssetClasses(trx, org);
  const classId = (name: string) => Number(classes.find((c) => c.name === name)?.id);
  const hdfcLedger = await ledgerOf(ids.bankAccounts.ba_hdfc);
  const ASSETS = [
    { cls: 'Computers & Peripherals', name: 'Dell Vostro laptops (4 nos)', on: `${MONTHS[0]}-08`, cost: 2_36_000, loc: 'Chennai HO, accounts', who: 'Priya Raman', serial: 'DL-VOS-3520' },
    { cls: 'Furniture & Fittings', name: 'Storage racks, main store', on: `${MONTHS[0]}-20`, cost: 1_85_000, loc: 'Chennai main store', who: 'Karthik S', serial: null },
    { cls: 'Plant & Machinery', name: 'Wheel alignment machine', on: `${MONTHS[1]}-12`, cost: 4_75_000, loc: 'Workshop bay 2', who: 'Meena P', serial: 'WA-3D-11902' },
    { cls: 'Vehicles', name: 'Tata Ace delivery van TN09 BX 4417', on: `${MONTHS[2]}-03`, cost: 6_40_000, loc: 'Chennai HO', who: 'Anand K', serial: 'MAT445071R1234' },
  ];
  for (const a of ASSETS) {
    if (!classId(a.cls)) continue;
    await addAsset(trx, org, accountant, {
      branchId: chennai, classId: classId(a.cls), name: a.name, acquiredOn: a.on, putToUseOn: a.on, costPaise: R(a.cost),
      source: { kind: 'paid', fromAccountId: hdfcLedger }, location: a.loc, custodian: a.who, serialNo: a.serial,
    });
  }
  let depreciationRuns = 0;
  for (const m of MONTHS) {
    await runDepreciation(trx, org, accountant, chennai, monthEnd(m));
    depreciationRuns++;
  }

  // ── Payroll: five employees, April to July paid, leave taken ──────────────
  const STAFF = [
    { code: 'E001', name: 'Karthik S', gender: 'male' as const, joined: '2019-06-01', designation: 'Store manager', department: 'Stores', pan: 'BKSPK4471M', basic: 14_000, hra: 5_600, special: 5_400 },
    { code: 'E002', name: 'Lakshmi R', gender: 'female' as const, joined: '2021-02-15', designation: 'Accounts executive', department: 'Accounts', pan: 'CLRPL5582N', basic: 11_000, hra: 4_400, special: 2_600 },
    { code: 'E003', name: 'Suresh M', gender: 'male' as const, joined: '2022-08-01', designation: 'Sales executive', department: 'Sales', pan: 'DSMPS6693P', basic: 9_000, hra: 3_600, special: 2_400 },
    { code: 'E004', name: 'Meena P', gender: 'female' as const, joined: '2023-04-10', designation: 'Workshop technician', department: 'Service', pan: 'EMPPM7714Q', basic: 7_500, hra: 3_000, special: 1_500 },
    { code: 'E005', name: 'Anand K', gender: 'male' as const, joined: '2024-01-05', designation: 'Delivery driver', department: 'Logistics', pan: 'FAKPA8825R', basic: 6_000, hra: 2_400, special: 1_600 },
  ];
  const staff: number[] = [];
  for (const [i, s] of STAFF.entries()) {
    staff.push(await createEmployee(trx, org, {
      branchId: chennai, code: s.code, name: s.name, gender: s.gender, dateOfJoining: s.joined, designation: s.designation,
      department: s.department, pan: s.pan, uan: `1009${String(4471 + i).padStart(8, '0')}`, pfMember: true, ptApplicable: true,
      taxRegime: 'new', metroCity: true, bankAccountName: s.name, bankAccountNo: `5010012${String(3301 + i)}88`, bankIfsc: 'HDFC0000123',
    }, { basic: R(s.basic), da: 0, hra: R(s.hra), special: R(s.special), other: 0, effectiveFrom: `${MONTHS[0]}-01` }));
  }
  let payrollMonths = 0;
  const runMonth = async (month: string) => {
    const run = await prepareRun(trx, org, accountant, month);
    await postRun(trx, org, admin, run);
    await payRun(trx, org, admin, run, { bankAccountId: ids.bankAccounts.ba_hdfc, date: nextMonthDay(month, 1) });
    payrollMonths++;
  };
  for (const m of MONTHS.slice(0, 3)) await runMonth(m);
  const leaveTypes = await listLeaveTypes(trx, org);
  const casual = leaveTypes.find((t) => t.paid && /casual/i.test(t.name)) ?? leaveTypes.find((t) => t.paid);
  const sick = leaveTypes.find((t) => t.paid && /sick/i.test(t.name)) ?? casual;
  // The year's casual and sick leave, credited on 1 April as HR does.
  for (const t of [casual, sick].filter((x, i, all) => x && all.indexOf(x) === i)) {
    for (const e of staff) {
      await grantLeave(trx, org, accountant, { employeeId: e, leaveTypeId: Number(t!.id), kind: 'opening', days: t!.annualDays, date: `${MONTHS[0]}-01`, note: 'The year’s entitlement' });
    }
  }
  if (casual && staff[0]) await recordLeave(trx, org, accountant, { employeeId: staff[0], leaveTypeId: Number(casual.id), from: `${MONTHS[3]}-06`, to: `${MONTHS[3]}-06`, note: 'Family function' });
  if (sick && staff[3]) await recordLeave(trx, org, accountant, { employeeId: staff[3], leaveTypeId: Number(sick.id), from: `${MONTHS[3]}-14`, to: `${MONTHS[3]}-15`, note: 'Fever' });
  await runMonth(MONTHS[3]);

  // ── GST and statutory returns filed for those months, once each was due ───
  let filings = 0;
  for (const m of MONTHS) {
    for (const [key, due, ref] of [['gstr1', 11, 'AA33'], ['gstr3b', 20, 'AB33'], ['pf', 15, 'TRRN'], ['esi', 15, 'ESIC']] as const) {
      if (nextMonthDay(m, due) > DEMO_TODAY) continue;
      await trx.insertInto('compliance_filings').values({
        org_id: org, item_key: key, period: m, done_on: nextMonthDay(m, due),
        reference: `${ref}${m.replace('-', '')}${String(4471 + filings).padStart(6, '0')}`, note: null, created_by_user_id: accountant,
      }).execute();
      filings++;
    }
  }

  // ── Bank reconciliation: the HDFC statement worked through ────────────────
  // Customers' transfers entered as receipts and matched; bank charges posted
  // from the line. The rent and the Bosch payment are left for the screen.
  const hdfc = ids.bankAccounts.ba_hdfc;
  const CREDITS: Record<string, string> = { 'NEFT CR SHARMA TRADERS': 'c_sharma', 'UPI CR MARINA CAR CARE': 'c_marina', 'NEFT CR NATIONAL SPARES': 'c_national' };
  const CHARGES: Record<string, string> = { 'BANK CHARGES QTR': CODE.BANK_CHARGES, 'AIRTEL BROADBAND AUTOPAY': CODE.INTERNET, 'BHARAT PETRO FUEL CARD': CODE.FUEL };
  const lines = await trx.selectFrom('bank_transactions').select(['id', 'narration', 'deposit', 'txn_date'])
    .where('org_id', '=', org).where('bank_account_id', '=', hdfc).where('status', '=', 'unmatched').execute();
  for (const line of lines) {
    const customer = CREDITS[line.narration] ? ids.contacts[CREDITS[line.narration]] : null;
    if (customer) {
      const amount = Math.round(Number(line.deposit) * 100);
      // Only invoices already raised when the money came in: anything over is held as an advance.
      const owing = await sql<{ id: number; balance: string }>`
        SELECT id, total - amount_paid AS balance FROM invoices
         WHERE org_id = ${org} AND customer_id = ${customer} AND doc_kind = 'invoice' AND status NOT IN ('draft','void','paid')
           AND invoice_date <= ${iso(line.txn_date)}
         ORDER BY invoice_date, id`.execute(trx);
      let left = amount;
      const allocations: { targetType: 'invoice'; targetId: number; amountPaise: number }[] = [];
      for (const o of owing.rows) {
        const take = Math.min(Math.round(Number(o.balance) * 100), left);
        if (take > 0) { allocations.push({ targetType: 'invoice', targetId: o.id, amountPaise: take }); left -= take; }
      }
      const receipt = await receivePayment(trx, org, accountant, {
        branchId: chennai, contactId: customer, date: iso(line.txn_date), mode: 'neft', amountPaise: amount, bankAccountId: hdfc,
        reference: line.narration, allocations,
      });
      await matchToPayment(trx, org, accountant, line.id, receipt.id);
    } else if (CHARGES[line.narration]) {
      await categoriseTransaction(trx, org, accountant, line.id, { accountId: acc(CHARGES[line.narration]), description: line.narration });
    }
  }

  // ── Integration: Power BI reads the books; the order system hears of sales ─
  await createApiKey(trx, org, admin, { name: 'Power BI – management dashboard', role: 'viewer' });
  await saveWebhook(trx, org, admin, {
    url: 'https://hooks.example.com/rekonza/orders', events: ['invoice.created', 'payment.received'],
    description: 'Order system (ERP): new invoices and receipts',
  });

  const approvals = Number((await trx.selectFrom('approval_actions').select((eb) => eb.fn.countAll().as('n')).where('org_id', '=', org).executeTakeFirst())?.n ?? 0);
  return {
    costCentres: 4, employees: staff.length, payrollMonths, assets: ASSETS.length, depreciationRuns,
    journals: JOURNALS.length, contra: 2, debitNotes: against ? 1 : 0, transfers, approvals, filings,
  };
}

/**
 * IRNs for the business-to-business invoices of the last weeks, once the book
 * is committed: each in its own transaction, as a user registers them. (The
 * e-invoice service records its call to the IRP over a second connection,
 * which would otherwise wait on the seed's one long transaction.)
 */
export async function seedDemoIrns(ids: IdMap): Promise<number> {
  const recent = await sql<{ id: number }>`
    SELECT i.id FROM invoices i JOIN contacts c ON c.id = i.customer_id
     WHERE i.org_id = ${ids.orgId} AND i.doc_kind = 'invoice' AND i.status NOT IN ('draft','void') AND c.gst_treatment = 'registered'
       AND i.invoice_date >= ${day(25)}
     ORDER BY i.invoice_date DESC, i.id DESC LIMIT 9`.execute(db);
  let irns = 0;
  for (const inv of recent.rows) {
    try {
      await transaction((trx) => registerInvoice(trx, ids.orgId, inv.id));
      irns++;
    } catch { /* one the IRP would refuse stays pending, as it would in use */ }
  }
  return irns;
}

/**
 * After the controls are on: the reminders the book would have queued by the
 * demo date, and the audit trail of the book's history: one line per
 * document, by whoever entered it, on the day it is dated. The services the
 * seed calls do not write the trail themselves (the screens' routes do), so
 * without this a fresh demo book would show an empty trail.
 */
export async function seedDemoHistory(trx: Trx, ids: IdMap): Promise<{ reminders: number; auditEntries: number }> {
  const org = ids.orgId;
  // The book went onto perpetual inventory at the start of this month (demo-controls.ts), after
  // this month's sales were seeded: the stock account is brought into line as at the book's
  // date, as the month-end job does, so the statements show no stray "stock not in the ledger".
  await trueUpStock(trx, org, ids.users.u_priya, DEMO_TODAY);

  // The daily reminder sweep, as it would have run each day of the last month.
  let reminders = 0;
  for (let n = 30; n >= 0; n--) reminders += await queueReminders(trx, org, day(n));
  const names = new Map((await trx.selectFrom('users').select(['id', 'name']).where('org_id', '=', org).execute()).map((u) => [u.id, u.name]));
  const fallback = ids.users.u_arun;
  const at = (day: unknown, n: number) => {
    const d = String(day instanceof Date ? day.toISOString() : day).slice(0, 10);
    return new Date(`${d}T${String(10 + (n % 8)).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}:00+05:30`);
  };
  const rows: { org_id: number; actor_user_id: number; actor_name: string | null; action: string; target_type: string; target_id: string; target_label: string; detail: string; created_at: Date }[] = [];
  const add = (action: string, type: string, id: number, label: string, detail: string, by: number | null, day: unknown) => {
    const who = by ?? fallback;
    rows.push({ org_id: org, actor_user_id: who, actor_name: names.get(who) ?? null, action, target_type: type, target_id: String(id), target_label: label, detail, created_at: at(day, rows.length) });
  };
  const inr = (v: unknown) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  for (const r of (await sql<{ id: number; number: string; doc_kind: string; invoice_date: string; total: string; created_by_user_id: number | null; name: string }>`
    SELECT i.id, i.number, i.doc_kind, i.invoice_date, i.total, i.created_by_user_id, c.display_name AS name FROM invoices i JOIN contacts c ON c.id = i.customer_id WHERE i.org_id = ${org}`.execute(trx)).rows) {
    add('create', 'invoice', r.id, r.number, `${r.doc_kind === 'debit_note' ? 'Debit note' : 'Invoice'} ${r.number} for ${r.name}, ${inr(r.total)}`, r.created_by_user_id, r.invoice_date);
  }
  for (const r of (await sql<{ id: number; internal_no: string; bill_date: string; total: string; created_by_user_id: number | null; name: string; approved_by_user_id: number | null; approved_at: Date | null }>`
    SELECT b.id, b.internal_no, b.bill_date, b.total, b.created_by_user_id, c.display_name AS name, b.approved_by_user_id, b.approved_at FROM bills b JOIN contacts c ON c.id = b.vendor_id WHERE b.org_id = ${org}`.execute(trx)).rows) {
    add('create', 'bill', r.id, r.internal_no, `Bill ${r.internal_no} from ${r.name}, ${inr(r.total)}`, r.created_by_user_id, r.bill_date);
    if (r.approved_by_user_id) add('approve', 'bill', r.id, r.internal_no, `Approved bill ${r.internal_no}`, r.approved_by_user_id, r.bill_date);
  }
  for (const r of (await sql<{ id: number; number: string; kind: string; payment_date: string; amount: string; created_by_user_id: number | null; name: string }>`
    SELECT p.id, p.number, p.kind, p.payment_date, p.amount, p.created_by_user_id, c.display_name AS name FROM payments p JOIN contacts c ON c.id = p.contact_id WHERE p.org_id = ${org}`.execute(trx)).rows) {
    add('create', 'payment', r.id, r.number, `${r.kind === 'received' ? 'Received' : 'Paid'} ${inr(r.amount)} ${r.kind === 'received' ? 'from' : 'to'} ${r.name}`, r.created_by_user_id, r.payment_date);
  }
  for (const r of (await sql<{ id: number; entry_no: number; entry_date: string; memo: string | null; created_by_user_id: number | null }>`
    SELECT e.id, e.entry_no, e.entry_date, e.memo, e.posted_by_user_id AS created_by_user_id FROM journal_entries e WHERE e.org_id = ${org} AND e.source_type = 'manual'`.execute(trx)).rows) {
    add('create', 'journal_entry', r.id, `JV ${r.entry_no}`, `Journal ${r.entry_no}: ${r.memo ?? ''}`, r.created_by_user_id, r.entry_date);
  }
  for (const r of (await sql<{ id: number; month: string; created_by_user_id: number | null }>`
    SELECT id, month, created_by_user_id FROM payroll_runs WHERE org_id = ${org}`.execute(trx)).rows) {
    add('create', 'payroll', r.id, monthLabel(r.month), `Payroll for ${monthLabel(r.month)} prepared, posted and paid`, r.created_by_user_id, `${r.month}-28`);
  }
  for (const r of (await sql<{ id: number; tag_no: string; name: string; acquired_on: string }>`
    SELECT id, tag_no, name, acquired_on FROM fixed_assets WHERE org_id = ${org}`.execute(trx)).rows) {
    add('create', 'fixed_asset', r.id, r.tag_no, `Asset ${r.tag_no} added: ${r.name}`, ids.users.u_priya, r.acquired_on);
  }
  for (const u of [ids.users.u_arun, ids.users.u_priya, ids.users.u_vikram]) {
    if (!u) continue;
    for (const d of [day(4), day(2), day(1)]) add('login', 'user', u, names.get(u) ?? '', 'Signed in', u, d);
  }
  for (let i = 0; i < rows.length; i += 200) await trx.insertInto('audit_log').values(rows.slice(i, i + 200)).execute();
  return { reminders, auditEntries: rows.length };
}
