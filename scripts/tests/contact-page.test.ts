// A customer's page, as Zoho opens it beside the customer list: the
// Transactions tab (every kind of document at once), the Overview's Income
// chart on the accrual and the cash basis, the Mails tab, Zoho's customer
// fields (migration 112) and the second street line on what is printed
// (lib/server/services/contact-activity.ts, contact-fields.ts, document-print.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/contact-page.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { createEstimate, createRetainer } from '../../lib/server/services/sales-documents';
import { postManualJournal } from '../../lib/server/services/journals';
import { createExpense } from '../../lib/server/services/purchases';
import { partyStatement } from '../../lib/server/reports/party-statement';
import { makePayment, receivePayment } from '../../lib/server/services/payments';
import { createPurchaseOrder, createVendorCredit } from '../../lib/server/services/purchase-documents';
import { createBill } from '../../lib/server/services/purchases';
import { contactIncome, contactMails, contactTransactions, incomeMonths } from '../../lib/server/services/contact-activity';
import { ZOHO_COLUMNS, zohoFields } from '../../lib/server/services/contact-fields';
import { printableDocument } from '../../lib/server/services/document-print';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Contact Page Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Shop', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const acc = await accountIds(trx, orgId);
  const contact = async (kind: string, display_name: string, extra: Record<string, unknown> = {}) => Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind, display_name, state_code: '33', gst_treatment: 'unregistered', ...extra,
  } as never).executeTakeFirstOrThrow()).insertId);
  const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
  return {
    orgId, branchId, bankId,
    customer: await contact('customer', 'Speedwell Garages', { email: 'accounts@speedwell.in' }),
    other: await contact('customer', 'Hosur Auto'),
    vendor: await contact('vendor', 'Brake Works'),
  };
}

const goods = (rupees: number) => [{ description: 'Brake pads', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 }];

test('Transactions: invoices, payments and quotes at once, each with its balance and status; a vendor\'s bills only on its side', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, bankId, customer, other, vendor } = await book(trx);
    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-01', dueDate: '2026-07-31', status: 'approved', lines: goods(1000) });
    await createInvoice(trx, orgId, null, { branchId, customerId: other, date: '2026-07-02', dueDate: '2026-08-01', status: 'approved', lines: goods(500) });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-07-10', mode: 'neft', amountPaise: 1500_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 1180_00 }],
    });
    await createEstimate(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-15', expiryDate: '2026-07-30', lines: goods(200) });
    await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'BW-1', date: '2026-07-03', dueDate: '2026-08-03', status: 'open', lines: [{ description: 'Pads', qty: 1, ratePaise: 300_00, gstRatePct: 18 }] });

    const rows = await contactTransactions(trx, orgId, customer, { sales: true, purchases: false });
    const kinds = [...new Set(rows.map((r) => r.kind))].sort();
    assert.deepEqual(kinds, ['estimate', 'invoice', 'payment_received'], 'only this customer\'s documents');
    const invoice = rows.find((r) => r.kind === 'invoice')!;
    assert.equal(invoice.amountPaise, 1180_00);
    assert.equal(invoice.balancePaise, 0, 'paid in full');
    assert.equal(invoice.status, 'paid');
    const payment = rows.find((r) => r.kind === 'payment_received')!;
    assert.equal(payment.amountPaise, 1500_00);
    assert.equal(payment.balancePaise, 320_00, 'the unused amount');
    assert.equal(payment.extra?.mode, 'neft', 'the payment mode, a column of its own');

    assert.equal((await contactTransactions(trx, orgId, vendor, { sales: true, purchases: true })).filter((r) => r.kind === 'bill').length, 1);
    assert.equal((await contactTransactions(trx, orgId, vendor, { sales: true, purchases: false })).length, 0, 'bills only for those who may see purchases');
  });
});

test('Income: invoiced before tax by month on the accrual basis, received on the cash basis; drafts and voids left out', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, bankId, customer } = await book(trx);
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-05', dueDate: '2026-07-31', status: 'approved', lines: goods(1000) });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-12', dueDate: '2026-09-30', status: 'approved', lines: goods(400) });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-13', dueDate: '2026-09-30', status: 'draft', lines: goods(9000) });
    const mistake = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-14', dueDate: '2026-09-30', status: 'approved', lines: goods(7000) });
    await voidInvoice(trx, orgId, null, mistake.id, 'Raised twice');
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-03-01', dueDate: '2026-03-31', status: 'approved', lines: goods(5000) });
    await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-10-02', mode: 'neft', amountPaise: 600_00, bankAccountId: bankId, allocations: [] });

    const accrual = await contactIncome(trx, orgId, customer, 'customer', 6, 'accrual', '2026-11-18');
    assert.deepEqual(accrual.map((m) => m.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'], 'six months, ending with this one');
    assert.deepEqual(accrual.map((m) => m.amountPaise), [0, 1000_00, 0, 400_00, 0, 0], 'before tax; no draft, no void, nothing before the period');
    const year = await contactIncome(trx, orgId, customer, 'customer', 12, 'accrual', '2026-11-18');
    assert.equal(year.length, 12);
    assert.equal(year.find((m) => m.month === '2026-03')?.amountPaise, 5000_00, 'March is in the last twelve months');
    const cash = await contactIncome(trx, orgId, customer, 'customer', 6, 'cash', '2026-11-18');
    assert.deepEqual(cash.map((m) => m.amountPaise), [0, 0, 0, 0, 600_00, 0], 'what was received, when');
  });
});

test('Mails: those sent to the customer or one of its people, or about its invoices; not another\'s', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, customer, other } = await book(trx);
    await trx.insertInto('contact_persons').values({ org_id: orgId, contact_id: customer, name: 'Anita Rao', email: 'anita@speedwell.in' } as never).execute();
    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-01', dueDate: '2026-07-31', status: 'approved', lines: goods(100) });
    const mail = (to: string, subject: string, extra: Record<string, unknown> = {}) =>
      trx.insertInto('email_log').values({ org_id: orgId, to_address: to, subject, status: 'sent', ...extra } as never).execute();
    await mail('Accounts@Speedwell.in', 'Statement for July');
    await mail('anita@speedwell.in', 'Payment reminder');
    await mail('someone@else.in', `Invoice ${inv.number}`, { doc_type: 'invoice', doc_id: inv.id });
    await mail('hosur@auto.in', 'Hosur statement');

    const subjects = (await contactMails(trx, orgId, customer)).map((m) => m.subject).sort();
    assert.deepEqual(subjects, [`Invoice ${inv.number}`, 'Payment reminder', 'Statement for July']);
    assert.equal((await contactMails(trx, orgId, other)).length, 0);
  });
});

test("Zoho's fields come back under their API names; a printed quote carries the second street line", async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId } = await book(trx);
    const id = Number((await trx.insertInto('contacts').values({
      org_id: orgId, kind: 'customer', display_name: 'Ravi Kumar', state_code: '33', gst_treatment: 'consumer',
      contact_type: 'individual', salutation: 'Mr.', first_name: 'Ravi', last_name: 'Kumar', mobile: '98450 00000',
      billing_address: '12 Residency Road', billing_street2: 'Shanthala Nagar', billing_city: 'Chennai', billing_pincode: '600002',
      shipping_address: '12 Residency Road', shipping_street2: 'Shanthala Nagar',
    } as never).executeTakeFirstOrThrow()).insertId);
    const row = await trx.selectFrom('contacts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const z = zohoFields(row as unknown as Record<string, unknown>);
    assert.equal(Object.keys(z).length, Object.keys(ZOHO_COLUMNS).length);
    assert.equal(z.contactType, 'individual');
    assert.equal(z.firstName, 'Ravi');
    assert.equal(z.billingStreet2, 'Shanthala Nagar');
    assert.equal(z.language, 'English', 'the column default');
    assert.equal(z.taxPreference, 'taxable');

    const est = await createEstimate(trx, orgId, null, { branchId, customerId: id, date: '2026-07-01', expiryDate: '2026-07-15', lines: goods(100) });
    const doc = await printableDocument(trx, orgId, 'estimate', est.id);
    assert.equal(doc.party.address, '12 Residency Road, Shanthala Nagar', 'both street lines, as one');
    assert.equal(doc.shipTo, null, 'the same address is not printed twice');
  });
});


test("Zoho's chart periods: the last six or twelve months, this financial year and the one before, from April", () => {
  assert.deepEqual(incomeMonths('last_6', '2026-11-18'), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.equal(incomeMonths('last_12', '2026-11-18')[0], '2025-12');
  const fy = incomeMonths('this_fy', '2026-11-18');
  assert.equal(fy.length, 12);
  assert.deepEqual([fy[0], fy[11]], ['2026-04', '2027-03']);
  assert.deepEqual([incomeMonths('prev_fy', '2026-11-18')[0], incomeMonths('prev_fy', '2026-11-18')[11]], ['2025-04', '2026-03']);
  assert.deepEqual([incomeMonths('this_fy', '2027-02-10')[0], incomeMonths('this_fy', '2027-02-10')[11]], ['2026-04', '2027-03'], 'February is still the year that began last April');
});

test("Transactions: Zoho's other sections (service invoices, billable expenses, journals), and each row's status filters", async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, bankId, customer } = await book(trx);
    const acc = await accountIds(trx, orgId);
    // An invoice due long ago: unpaid and overdue; a draft; a paid one.
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-01-05', dueDate: '2026-01-20', status: 'approved', lines: goods(100) });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-02-05', dueDate: '2026-02-20', status: 'draft', lines: goods(100) });
    const paid = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-03-05', dueDate: '2026-03-20', status: 'approved', lines: goods(100) });
    await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-03-06', mode: 'upi', amountPaise: 118_00, bankAccountId: bankId, allocations: [{ targetType: 'invoice', targetId: paid.id, amountPaise: 118_00 }] });
    await createRetainer(trx, orgId, null, { branchId, customerId: customer, date: '2026-04-01', description: 'Advance for the annual service contract', amountPaise: 5000_00, status: 'sent' });
    const expenseHead = (await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('type', '=', 'expense').executeTakeFirstOrThrow()).id;
    await createExpense(trx, orgId, null, { branchId, date: '2026-04-02', accountId: expenseHead, paidThroughBankAccountId: bankId, amountPaise: 900_00, isBillable: true, billableCustomerId: customer });
    await postManualJournal(trx, orgId, null, { branchId, date: '2026-04-03', memo: 'Discount allowed', approved: true, lines: [
      { accountId: (await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('type', '=', 'expense').executeTakeFirstOrThrow()).id, debitPaise: 50_00 },
      { accountId: acc[CODE.AR], creditPaise: 50_00, contactId: customer },
    ] });

    const rows = await contactTransactions(trx, orgId, customer, { sales: true, purchases: false });
    const inv = rows.filter((r) => r.kind === 'invoice');
    assert.deepEqual(inv.map((r) => r.filters.sort()), [['paid'], ['draft'], ['overdue', 'unpaid']], 'newest first: paid, draft, the old unpaid one also overdue');
    assert.equal(inv[2].status, 'overdue');
    const ret = rows.find((r) => r.kind === 'retainer_invoice');
    assert.ok(ret, 'the service invoice is listed');
    assert.deepEqual(ret!.filters, ['sent']);
    assert.equal(ret!.balancePaise, 5000_00);
    const exp = rows.find((r) => r.kind === 'expense');
    assert.ok(exp, 'the expense billable to the customer is listed');
    assert.deepEqual(exp!.filters.sort(), ['billable', 'unbilled', 'without receipts']);
    const jv = rows.find((r) => r.kind === 'journal');
    assert.ok(jv, 'the journal naming the customer is listed');
    assert.equal(jv!.extra?.creditPaise, 50_00);
    assert.equal(jv!.ref, 'Discount allowed');
  });
});

test("Statement, Filter By Outstanding: only what is still unpaid, and what is left on each", async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, bankId, customer } = await book(trx);
    const a = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-01', dueDate: '2026-07-31', status: 'approved', lines: goods(1000) });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-05', dueDate: '2026-08-04', status: 'approved', lines: goods(500) });
    const c = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-07-09', dueDate: '2026-08-08', status: 'approved', lines: goods(200) });
    await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-07-10', mode: 'neft', amountPaise: 1180_00 + 100_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: a.id, amountPaise: 1180_00 }, { targetType: 'invoice', targetId: c.id, amountPaise: 100_00 }] });
    const all = await partyStatement(trx, orgId, customer, 'customer', '2026-07-01', '2026-07-31');
    const open = await partyStatement(trx, orgId, customer, 'customer', '2026-07-01', '2026-07-31', 'outstanding');
    assert.ok(all.lines.length > open.lines.length);
    assert.deepEqual(open.lines.map((l) => l.chargePaise), [590_00, 236_00 - 100_00], 'the paid invoice is left out; the part-paid one shows what is left');
    assert.equal(open.closingPaise, 590_00 + 136_00);
    assert.equal(open.closingPaise, all.closingPaise, 'and it adds up to what is owed');
  });
});


test("A vendor's Transactions: Zoho's eight sections, with the vendor's name, the bank paid through and the customer billed", async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, bankId, customer, vendor } = await book(trx);
    const bill = await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'BW-9', date: '2026-01-03', dueDate: '2026-01-20', status: 'open', lines: [{ description: 'Pads', qty: 1, ratePaise: 1000_00, gstRatePct: 18 }] });
    await makePayment(trx, orgId, null, { branchId, contactId: vendor, date: '2026-02-01', mode: 'rtgs', reference: 'UTR42', amountPaise: 500_00, bankAccountId: bankId, allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 500_00 }] } as never);
    const head = (await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('type', '=', 'expense').executeTakeFirstOrThrow()).id;
    await createExpense(trx, orgId, null, { branchId, date: '2026-02-02', accountId: head, paidThroughBankAccountId: bankId, amountPaise: 300_00, vendorId: vendor, isBillable: true, billableCustomerId: customer });
    await trx.insertInto('recurring_purchases').values({ org_id: orgId, branch_id: branchId, kind: 'bill', vendor_id: vendor, profile_name: 'Monthly pads', frequency: 'monthly', start_date: '2026-01-01', next_run: '2026-12-01', template: JSON.stringify([{ qty: 2, ratePaise: 100_00 }]) } as never).execute();
    await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-02-05', expectedDate: '2026-02-20', status: 'open', lines: [{ description: 'Pads', qty: 3, ratePaise: 900_00, gstRatePct: 18 }] });
    await createVendorCredit(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-02-06', reason: 'Two pads damaged', againstBillId: bill.id, amountPaise: 100_00, gstRatePct: 18 });

    const rows = await contactTransactions(trx, orgId, vendor, { sales: false, purchases: true });
    const kinds = [...new Set(rows.map((r) => r.kind))].sort();
    assert.deepEqual(kinds, ['bill', 'expense', 'payment_made', 'purchase_order', 'recurring_bill', 'vendor_credit']);
    const b = rows.find((r) => r.kind === 'bill')!;
    assert.equal(b.number, 'BW-9', "the vendor's own bill number");
    assert.equal(b.extra?.vendorName, 'Brake Works');
    assert.deepEqual(b.filters.sort(), ['open', 'overdue', 'partially paid', 'unpaid'].filter((x) => b.filters.includes(x)).sort());
    assert.ok(b.filters.includes('unpaid') && b.filters.includes('overdue'), 'part-paid and past its due date');
    const pay = rows.find((r) => r.kind === 'payment_made')!;
    assert.equal(pay.extra?.mode, 'rtgs');
    const ex = rows.find((r) => r.kind === 'expense')!;
    assert.equal(ex.extra?.paidThrough, 'Current');
    assert.equal(ex.extra?.customerName, 'Speedwell Garages');
    assert.deepEqual(ex.filters.sort(), ['billable', 'unbilled', 'without receipts']);
    const rec = rows.find((r) => r.kind === 'recurring_bill')!;
    assert.equal(rec.number, 'Monthly pads');
    assert.deepEqual(rec.filters, ['active']);
    assert.equal(rec.amountPaise, 200_00);
    const po = rows.find((r) => r.kind === 'purchase_order')!;
    assert.deepEqual(po.filters, ['issued'], "Zoho calls an open order Issued");
    assert.equal(po.extra?.deliveryDate, '2026-02-20');
    const vc = rows.find((r) => r.kind === 'vendor_credit')!;
    assert.ok(vc.ref, 'the bill it is against');
  });
});

test.after(() => db.destroy());
