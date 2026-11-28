// Fixes from the independent auditor check (2026-11-28), builder fx-c:
//
//   1. a stock adjustment's value is the FIFO (or average) cost that actually
//      left stock, kept on the adjustment on a periodic book as on a perpetual
//      one — never the catalogue price;
//   2. every delete or void of posted work keeps its reason on the reversing
//      entry, the Reversed Vouchers register shows it, and a person's request
//      without one is asked for it (428 reason_required);
//   3. a vendor credit against a bill is not rounded to the rupee (bills are not);
//   4. stock and cash going below zero are warned about (or refused), naming the
//      item or account and the shortfall, and the statements say so;
//   5. a discarded journal is a decision in the approval history;
//   6. a General Ledger row with no party of its own shows its entry's.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-c-fixes.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { withChangeReason } from '../../lib/server/request-context';
import { createInvoice, markInvoiceSent } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote, voidCreditNote } from '../../lib/server/services/sales-documents';
import { createVendorCredit } from '../../lib/server/services/purchase-documents';
import { createAdjustment, updateAdjustment } from '../../lib/server/services/stock-changes';
import { adjustmentValuesNow, switchToPerpetual } from '../../lib/server/services/stock-ledger';
import { makePayment, deletePayment } from '../../lib/server/services/payments';
import { createTransfer } from '../../lib/server/services/banking';
import { deleteTransfer } from '../../lib/server/services/banking-changes';
import { reversalRegister } from '../../lib/server/services/voucher-reversals';
import { saveJournal, discardHeldJournal } from '../../lib/server/services/held-journals';
import { recentDecisions, saveRule } from '../../lib/server/services/approvals';
import { setPolicies } from '../../lib/server/services/org-settings';
import { generalLedger } from '../../lib/server/reports/statements';
import { belowZero } from '../../lib/server/reports/below-zero';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { logAudit } from '../../lib/server/audit';
import { ApiError } from '../../lib/server/http';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>;
  customerId: number; vendorId: number; itemId: number; bank: number; cash: number; maker: number; checker: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'FX-C Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      const bankAcc = async (name: string, code: string, kind: 'bank' | 'cash') =>
        Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind, name, ledger_account_id: acc[code], opening_balance: '0', is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
      const user = async (name: string) =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'FIFO Widget', sku: 'FW-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1, valuation_method: 'fifo',
        sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, itemId,
        customerId: await mk({ kind: 'customer', display_name: 'Kaveri Retail' }),
        vendorId: await mk({ kind: 'vendor', display_name: 'Nila Suppliers' }),
        bank: await bankAcc('HDFC Current', CODE.BANK_DEFAULT, 'bank'),
        cash: await bankAcc('Cash in Hand', CODE.CASH, 'cash'),
        maker: await user('maker'), checker: await user('checker'),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const buy = (f: Fixture, date: string, qty: number, ratePaise: number, no: string, gstRatePct?: number) =>
  createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: no, date, dueDate: date,
    lines: [{ itemId: f.itemId, qty, ratePaise, ...(gstRatePct === undefined ? {} : { gstRatePct }) }],
  });
const sell = (f: Fixture, date: string, qty: number) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.customerId, date, dueDate: date, status: 'approved', lines: [{ itemId: f.itemId, qty, ratePaise: 20_000 }],
});
/** Run as a person's request does (route() sets the change reason, even to none). */
const asRequest = <T>(reason: string | null, fn: () => Promise<T>) => withChangeReason(reason, fn);

// ── 1. Adjustment value ─────────────────────────────────────────────────────

for (const perpetual of [false, true]) {
  test(`${perpetual ? 'perpetual' : 'periodic'} book: −1 damaged is valued at the FIFO cost that left (₹120), not the catalogue price (₹100)`, async () => {
    await withFixture(async (f) => {
      if (perpetual) await switchToPerpetual(f.trx, f.orgId, null, '2026-04-01');
      await buy(f, '2026-04-02', 10, 10_000, 'A1');
      await buy(f, '2026-04-03', 10, 12_000, 'A2');
      await sell(f, '2026-04-05', 15); // 5 left, all from the ₹120 layer
      const made = await createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, date: '2026-04-08', qtyDelta: -1, reason: 'damage' });
      assert.equal(made.valuePaise, -12_000, 'what the stock valuation lost');
      const row = await f.trx.selectFrom('stock_adjustments').select(['value', 'journal_entry_id']).where('id', '=', made.id).executeTakeFirstOrThrow();
      assert.equal(toPaiseFromSql(row.value!), -12_000, 'kept on the adjustment, for the list and its export');
      if (perpetual) {
        const posted = await f.trx.selectFrom('journal_lines as jl').innerJoin('accounts as a', 'a.id', 'jl.account_id')
          .select((eb) => eb.fn.sum<string>(eb.ref('jl.credit')).as('c')).where('jl.entry_id', '=', row.journal_entry_id!).where('a.code', '=', CODE.INVENTORY).executeTakeFirstOrThrow();
        assert.equal(toPaiseFromSql(posted.c), 12_000, 'the same figure posted out of Inventory');
      } else {
        assert.equal(row.journal_entry_id, null, 'a periodic book posts nothing at the adjustment');
      }
      // An adjustment from before the value was kept is worked out the same way, never at ₹100.
      await f.trx.updateTable('stock_adjustments').set({ value: null }).where('id', '=', made.id).execute();
      const legacy = await adjustmentValuesNow(f.trx, f.orgId, [{ id: made.id, itemId: f.itemId, date: '2026-04-08', qtyDelta: -1 }]);
      assert.equal(legacy.get(made.id), -12_000);
      // Edited to −2: both units come from the ₹120 layer.
      const edited = await updateAdjustment(f.trx, f.orgId, null, made.id, { itemId: f.itemId, date: '2026-04-08', qtyDelta: -2, reason: 'damage' });
      assert.equal(edited.valuePaise, -24_000);
    });
  });
}

test('a write-off that spans two layers takes the older one first', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-04-02', 2, 10_000, 'B1');
    await buy(f, '2026-04-03', 2, 12_000, 'B2');
    const made = await createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, date: '2026-04-04', qtyDelta: -3, reason: 'theft' });
    assert.equal(made.valuePaise, -32_000, '2 × ₹100 + 1 × ₹120');
  });
});

// ── 2. Reasons on reversals ─────────────────────────────────────────────────

test('a payment and a bank transfer deleted with a reason: it is on the reversal and in Reversed Vouchers; without one a request is asked (428)', async () => {
  await withFixture(async (f) => {
    const pay = await makePayment(f.trx, f.orgId, f.maker, { branchId: f.branchId, contactId: f.vendorId, date: '2026-11-04', mode: 'neft', amountPaise: 1_000_00, bankAccountId: f.bank });
    const tr = await createTransfer(f.trx, f.orgId, f.maker, { fromBankAccountId: f.bank, toBankAccountId: f.cash, date: '2026-11-05', amountPaise: 2_000_00 });
    // A person's delete with no reason anywhere: refused with reason_required, so the browser asks
    // (the route's transaction is rolled back; here a payment of its own is used).
    const other = await makePayment(f.trx, f.orgId, f.maker, { branchId: f.branchId, contactId: f.vendorId, date: '2026-11-04', mode: 'neft', amountPaise: 300_00, bankAccountId: f.bank });
    await assert.rejects(asRequest(null, () => deletePayment(f.trx, f.orgId, f.maker, other.id)),
      (e: unknown) => e instanceof ApiError && e.status === 428 && e.code === 'reason_required');
    // The reason typed in the window (?reason=) is the request's change reason.
    await asRequest('Paid to the wrong vendor', () => deletePayment(f.trx, f.orgId, f.maker, pay.id, 'Paid to the wrong vendor'));
    // Answered to the browser's own question (X-Change-Reason), with nothing passed to the service.
    await asRequest('Moved in error', () => deleteTransfer(f.trx, f.orgId, f.maker, tr.id));
    const reversals = await f.trx.selectFrom('journal_entries').select(['reversal_of_entry_id', 'reversal_reason'])
      .where('org_id', '=', f.orgId).where('reversal_of_entry_id', 'is not', null).execute();
    const byOriginal = new Map(reversals.map((r) => [r.reversal_of_entry_id, r.reversal_reason]));
    assert.equal(byOriginal.get(pay.journalEntryId), 'Paid to the wrong vendor');
    assert.equal(byOriginal.get(tr.journalEntryId), 'Moved in error');
    const reg = await reversalRegister(f.trx, f.orgId);
    assert.equal(reg.find((r) => r.entryId === String(pay.journalEntryId))?.reason, 'Paid to the wrong vendor');
    assert.equal(reg.find((r) => r.entryId === String(tr.journalEntryId))?.reason, 'Moved in error');
    const dd = await f.trx.selectFrom('deleted_documents').select('reason').where('org_id', '=', f.orgId).where('doc_type', '=', 'transfer').executeTakeFirstOrThrow();
    assert.equal(dd.reason, 'Moved in error', 'the deleted record keeps the reason given to the browser too');
  });
});

test('a credit note voided with a reason shows it in Reversed Vouchers (it was "Not given")', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', dueDate: '2026-11-30', status: 'approved',
      lines: [{ description: 'Service', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    const cn = await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-02', reason: 'Sales return', againstInvoiceId: inv.id,
      lines: [{ description: 'Service', qty: 1, ratePaise: 500_00, gstRatePct: 0 }],
    });
    // As the route does it: the reason in the body is the request's change reason.
    await asRequest('Raised against the wrong invoice', async () => {
      await voidCreditNote(f.trx, f.orgId, null, cn.id, 'Raised against the wrong invoice');
      await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: null, actorName: 't', action: 'void', targetType: 'credit-note', targetId: cn.id, detail: 'x' });
    });
    const reg = await reversalRegister(f.trx, f.orgId);
    assert.equal(reg.find((r) => r.sourceType === 'credit_note')?.reason, 'Raised against the wrong invoice');
    // A void made outside a request (no change reason) still shows it, from the credit note's own void_reason.
    const cn2 = await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-03', reason: 'Sales return', againstInvoiceId: inv.id,
      lines: [{ description: 'Service', qty: 1, ratePaise: 100_00, gstRatePct: 0 }],
    });
    await voidCreditNote(f.trx, f.orgId, null, cn2.id, 'Duplicate credit note');
    const reg2 = await reversalRegister(f.trx, f.orgId);
    assert.equal(reg2.find((r) => r.sourceType === 'credit_note' && r.sourceId === String(cn2.id))?.reason, 'Duplicate credit note');
    // A void asked for with no reason in a request: 428, so the browser asks.
    const cn3 = await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-03', reason: 'Sales return', againstInvoiceId: inv.id,
      lines: [{ description: 'Service', qty: 1, ratePaise: 100_00, gstRatePct: 0 }],
    });
    await assert.rejects(asRequest(null, () => voidCreditNote(f.trx, f.orgId, null, cn3.id)), (e: unknown) => e instanceof ApiError && e.status === 428);
  });
});

// ── 3. Vendor credit rounding ───────────────────────────────────────────────

test('a vendor credit of ₹141.60 against a bill is ₹141.60, with nothing to Rounding Off', async () => {
  await withFixture(async (f) => {
    const bill = await buy(f, '2026-11-01', 10, 12_000, 'NS-1', 18); // 10 × ₹120 + 18% = ₹1,416.00
    const line = await f.trx.selectFrom('bill_lines').select('id').where('bill_id', '=', bill.id).executeTakeFirstOrThrow();
    const vc = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-11-02', reason: 'Goods returned', againstBillId: bill.id,
      amountPaise: 0, lines: [{ itemId: f.itemId, billLineId: line.id, qty: 1 }],
    });
    assert.equal(vc.totalPaise, 14_160, '₹120 + 18% GST, not rounded to ₹142');
    const rounding = await f.trx.selectFrom('journal_lines').select('id').where('entry_id', '=', vc.journalEntryId!).where('account_id', '=', f.acc[CODE.ROUNDING]).execute();
    assert.equal(rounding.length, 0);
    const b = await f.trx.selectFrom('bills').select(['total', 'amount_paid']).where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid), 141_600 - 14_160, 'the bill owes exactly the rest');
  });
});

// ── 4. Negative stock and cash ──────────────────────────────────────────────

test('overselling, writing off and moving stock that is not there: warned by default with the shortfall, refused on block', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-11-01', 10, 10_000, 'S1');
    const inv = await sell(f, '2026-11-02', 15);
    assert.ok(inv.warnings.some((w) => /FIFO Widget: 10 in stock, 15 going out, short by 5/.test(w)), inv.warnings.join(' | '));
    const adj = await createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, date: '2026-11-03', qtyDelta: -2, reason: 'damage' });
    assert.ok(adj.warnings.some((w) => /FIFO Widget would be at -7/.test(w)), adj.warnings.join(' | '));
    // The statements say so.
    const bz = await belowZero(f.trx, f.orgId, '2026-11-30');
    assert.equal(bz.stock.length, 1);
    assert.equal(bz.stock[0].qty, -7);
    assert.ok(bz.stockValuePaise < 0);
    // A draft sent later is asked as well.
    const draft = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-11-04', dueDate: '2026-11-04', status: 'draft', lines: [{ itemId: f.itemId, qty: 1, ratePaise: 20_000 }],
    });
    const sent = await markInvoiceSent(f.trx, f.orgId, null, draft.id);
    assert.ok(sent.warnings.some((w) => /FIFO Widget: -7 in stock, 1 going out, short by 8/.test(w)), sent.warnings.join(' | '));
    // Block: refused, naming the item.
    await setPolicies(f.trx, f.orgId, null, { negativeStock: 'block' });
    await assert.rejects(sell(f, '2026-11-05', 1), /Not enough stock — FIFO Widget/);
    await assert.rejects(createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, date: '2026-11-05', qtyDelta: -1, reason: 'damage' }), /too little stock/);
  });
});

test('a sale dated before a later sale that already used the stock is caught on today too', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-04-01', 10, 10_000, 'T1');
    await sell(f, '2026-04-10', 8);
    const back = await sell(f, '2026-04-05', 5); // 10 on hand on 5 April, but 2 by today
    assert.ok(back.warnings.some((w) => /short by 3/.test(w)), back.warnings.join(' | '));
  });
});

test('cash in hand going below nil: a payment, an expense and a transfer are warned about with the shortfall; block refuses', async () => {
  await withFixture(async (f) => {
    await createTransfer(f.trx, f.orgId, null, { fromBankAccountId: f.bank, toBankAccountId: f.cash, date: '2026-11-01', amountPaise: 5_000_00 });
    const pay = await makePayment(f.trx, f.orgId, null, { branchId: f.branchId, contactId: f.vendorId, date: '2026-11-02', mode: 'cash', amountPaise: 6_000_00, bankAccountId: f.cash });
    assert.ok(pay.warnings?.some((w) => /Cash in Hand would go below nil: ₹5,000\.00 in hand .*₹6,000\.00 going out — short by ₹1,000\.00/.test(w)), pay.warnings?.join(' | '));
    const exp = await createExpense(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-11-03', accountId: f.acc[CODE.RENT], paidThroughBankAccountId: f.cash, amountPaise: 500_00,
    });
    assert.ok(exp.warnings?.some((w) => /short by ₹1,500\.00/.test(w)), exp.warnings?.join(' | '));
    const tr = await createTransfer(f.trx, f.orgId, null, { fromBankAccountId: f.cash, toBankAccountId: f.bank, date: '2026-11-04', amountPaise: 100_00 });
    assert.ok(tr.warnings.some((w) => /Cash in Hand would go below nil/.test(w)));
    // A bank account may be overdrawn: not checked.
    const fromBank = await makePayment(f.trx, f.orgId, null, { branchId: f.branchId, contactId: f.vendorId, date: '2026-11-04', mode: 'neft', amountPaise: 90_000_00, bankAccountId: f.bank });
    assert.ok(!(fromBank.warnings ?? []).some((w) => /below nil/.test(w)));
    const bz = await belowZero(f.trx, f.orgId, '2026-11-30');
    assert.deepEqual(bz.cash.map((c) => [c.name, c.balancePaise]), [['Cash in Hand', -1_600_00]]);
    await setPolicies(f.trx, f.orgId, null, { negativeCash: 'block' });
    await assert.rejects(createExpense(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-11-05', accountId: f.acc[CODE.RENT], paidThroughBankAccountId: f.cash, amountPaise: 100_00,
    }), /Cash in Hand would go below nil/);
  });
});

// ── 5. Discarded journals in the approval history ───────────────────────────

test('a journal held for approval and then discarded is a "discarded" decision in the approval history', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'journal', thresholdPaise: 10_000_00, approverRole: 'accountant', isActive: true });
    const saved = await saveJournal(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, date: '2026-10-31', memo: 'Rent for October',
      lines: [{ accountId: f.acc[CODE.RENT], debitPaise: 50_000_00 }, { accountId: f.acc[CODE.BANK_DEFAULT], creditPaise: 50_000_00 }],
    });
    assert.equal(saved.held, true);
    if (!saved.held) return;
    await discardHeldJournal(f.trx, f.orgId, f.checker, saved.id, 'Booked twice');
    const recent = await recentDecisions(f.trx, f.orgId);
    const d = recent.find((r) => r.documentType === 'journal' && r.action === 'discarded');
    assert.ok(d, JSON.stringify(recent));
    assert.equal(d!.note, 'Booked twice');
    assert.match(d!.number, /Journal H-/);
  });
});

// ── 6. Contact on every General Ledger row ──────────────────────────────────

test('General Ledger rows with no party of their own (cost of goods sold, sales) show the document\'s customer', async () => {
  await withFixture(async (f) => {
    await switchToPerpetual(f.trx, f.orgId, null, '2026-04-01');
    await buy(f, '2026-04-02', 10, 10_000, 'G1');
    await sell(f, '2026-04-05', 2);
    for (const code of [CODE.COGS, CODE.SALES]) {
      const gl = await generalLedger(f.trx, f.orgId, f.acc[code], '2026-04-01', '2026-04-30');
      assert.ok(gl.lines.length > 0, code);
      for (const l of gl.lines) assert.equal(l.contactName, 'Kaveri Retail', `${code}: ${l.description}`);
    }
  });
});
test.after(() => db.destroy());
