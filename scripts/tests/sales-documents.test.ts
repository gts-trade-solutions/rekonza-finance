// The documents around an invoice, against real MySQL, inside rolled-back
// transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sales-documents.test.ts
//
// The thing worth proving here is the dividing line: quotes, orders and
// challans move no money at all, while credit notes and retainers move it in
// specific directions that are easy to get backwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import {
  applyRetainer, convertToInvoice, createChallan, createCreditNote, createEstimate,
  createRetainer, createSalesOrder, refundCreditNote, voidCreditNote,
} from '../../lib/server/services/sales-documents';
import { invoiceFromSalesOrder } from '../../lib/server/services/order-flow';
import { ageing } from '../../lib/server/reports/statements';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx;
  orgId: number;
  branchId: number;
  acc: Record<string, number>;
  customerId: number;
  bankId: number;
  itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'Sales Docs Test Co' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 })
        .executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const customer = await trx.insertInto('contacts')
        .values({
          org_id: orgId, kind: 'customer', display_name: 'Local Customer',
          gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A',
        })
        .executeTakeFirstOrThrow();
      const customerId = Number(customer.insertId);

      const bank = await trx.insertInto('bank_accounts')
        .values({
          org_id: orgId, kind: 'bank', name: 'Test Bank',
          ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        })
        .executeTakeFirstOrThrow();
      const bankId = Number(bank.insertId);

      const item = await trx.insertInto('items')
        .values({
          org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708',
          uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
          gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
        })
        .executeTakeFirstOrThrow();
      const itemId = Number(item.insertId);

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      await fn({ trx, orgId, branchId, acc, customerId, bankId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** Sum a posted entry's lines per account code. */
async function entryByCode(trx: Trx, entryId: number) {
  const rows = await trx
    .selectFrom('journal_lines')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select(['accounts.code', 'journal_lines.debit', 'journal_lines.credit'])
    .where('journal_lines.entry_id', '=', entryId)
    .execute();
  const out: Record<string, { dr: number; cr: number }> = {};
  for (const r of rows) {
    out[r.code] ??= { dr: 0, cr: 0 };
    out[r.code].dr += toPaiseFromSql(r.debit);
    out[r.code].cr += toPaiseFromSql(r.credit);
  }
  return out;
}

/** How many journal entries exist for the organisation. */
async function entryCount(trx: Trx, orgId: number): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*) AS n FROM journal_entries WHERE org_id = ${orgId}
  `.execute(trx);
  return Number(rows[0].n);
}

// ── Nothing before the sale touches the ledger ───────────────────────────────

test('an estimate posts nothing', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const before = await entryCount(trx, orgId);
    const est = await createEstimate(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', expiryDate: '2026-09-06',
      lines: [{ itemId, qty: 10 }],
    });

    // 10 x 1,000 = 10,000 taxable, 18% intra-state = 1,800 tax.
    assert.equal(est.totalPaise, 1_180_000);
    assert.equal(est.journalEntryId, null);
    assert.equal(await entryCount(trx, orgId), before);
  });
});

test('a sales order posts nothing', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const before = await entryCount(trx, orgId);
    const so = await createSalesOrder(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', lines: [{ itemId, qty: 5 }],
    });
    assert.equal(so.journalEntryId, null);
    assert.equal(await entryCount(trx, orgId), before);
  });
});

test('a delivery challan posts nothing — ownership has not changed', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const before = await entryCount(trx, orgId);
    const dc = await createChallan(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', challanType: 'job_work',
      lines: [{ itemId, qty: 3 }],
    });
    assert.equal(dc.totalPaise, 300_000);
    assert.equal(dc.journalEntryId, null);
    assert.equal(await entryCount(trx, orgId), before);
  });
});

// ── Conversion is where it becomes real ─────────────────────────────────────

test('converting an estimate raises an invoice and marks the estimate converted', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const est = await createEstimate(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', expiryDate: '2026-08-31',
      lines: [{ itemId, qty: 10 }],
    });

    const inv = await convertToInvoice(trx, orgId, null, { type: 'estimate', id: est.id }, {
      date: '2026-08-07', dueDate: '2026-09-06',
    });

    assert.equal(inv.totalPaise, est.totalPaise);
    assert.ok(inv.journalEntryId, 'the invoice posts, unlike the estimate');

    const row = await trx.selectFrom('estimates')
      .select(['status', 'converted_to_type', 'converted_to_id'])
      .where('id', '=', est.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'converted');
    assert.equal(row.converted_to_type, 'invoice');
    assert.equal(Number(row.converted_to_id), inv.id);
  });
});

test('an estimate cannot be converted twice', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const est = await createEstimate(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', expiryDate: '2026-08-31',
      lines: [{ itemId, qty: 2 }],
    });
    await convertToInvoice(trx, orgId, null, { type: 'estimate', id: est.id }, {
      date: '2026-08-07', dueDate: '2026-09-06',
    });
    await assert.rejects(
      () => convertToInvoice(trx, orgId, null, { type: 'estimate', id: est.id }, {
        date: '2026-08-08', dueDate: '2026-09-07',
      }),
      /already been converted/,
    );
  });
});

test('part-invoicing a sales order leaves it partially invoiced', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const so = await createSalesOrder(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', lines: [{ itemId, qty: 10 }],
    });

    // Invoice half the order.
    const line = await trx.selectFrom('sales_order_lines').select('id')
      .where('sales_order_id', '=', so.id).executeTakeFirstOrThrow();
    await invoiceFromSalesOrder(trx, orgId, null, so.id, {
      date: '2026-08-07', dueDate: '2026-09-06', lines: [{ lineId: line.id, qty: 5 }],
    });

    const row = await trx.selectFrom('sales_orders')
      .select(['status', 'total', 'invoiced_amount'])
      .where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'partially_invoiced');
    assert.ok(toPaiseFromSql(row.invoiced_amount) < toPaiseFromSql(row.total));
  });
});

// ── Credit notes ────────────────────────────────────────────────────────────

test('a credit note reverses revenue and output tax, and reduces the receivable', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07',
      reason: 'Two units returned',
      lines: [{ itemId, qty: 2 }],
    });

    assert.ok(cn.journalEntryId);
    const e = await entryByCode(trx, cn.journalEntryId!);

    // 2 x 1,000 = 2,000 taxable, 9% + 9% = 360 tax, 2,360 total.
    assert.equal(e[CODE.SALES].dr, 200_000, 'revenue comes back out');
    assert.equal(e[CODE.GST_CGST].dr, 18_000);
    assert.equal(e[CODE.GST_SGST].dr, 18_000);
    assert.equal(e[CODE.AR].cr, 236_000, 'the customer owes that much less');
    assert.equal(e[CODE.SALES].cr, 0);
  });
});

test('cess on goods is output tax of its own, posted on the invoice and reversed by the credit note', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId }) => {
    await trx.insertInto('hsn_codes').values({
      org_id: orgId, code: '2202', kind: 'hsn', description: 'Aerated waters',
      gst_rate_pct: 28, cess_rate_pct: 12, is_active: 1,
    }).execute();

    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31', status: 'approved',
      lines: [{ description: 'Soda crate', hsnSac: '2202', qty: 1, ratePaise: 100_000, gstRatePct: 28 }],
    });
    // 1,000 + 28% GST (280) + 12% cess (120).
    assert.equal(inv.totalPaise, 140_000);

    const e = await entryByCode(trx, inv.journalEntryId!);
    assert.equal(e[CODE.GST_CESS].cr, 12_000);
    assert.equal(e[CODE.SALES].cr, 100_000, 'cess collected is not revenue');
    assert.equal(e[CODE.AR].dr, 140_000);

    const line = await trx.selectFrom('invoice_lines').select(['cess', 'cess_rate_pct'])
      .where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(line.cess), 12_000);
    assert.equal(Number(line.cess_rate_pct), 12, 'the line keeps the rate it was raised at');

    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', reason: 'Crate returned',
      againstInvoiceId: inv.id,
      lines: [{ description: 'Soda crate', hsnSac: '2202', qty: 1, ratePaise: 100_000, gstRatePct: 28 }],
    });
    const c = await entryByCode(trx, cn.journalEntryId!);
    assert.equal(c[CODE.GST_CESS].dr, 12_000);
    assert.equal(c[CODE.AR].cr, 140_000);

    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a credit note applied to an invoice settles it', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 2 }],
    });

    await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07',
      reason: 'Whole order returned',
      againstInvoiceId: inv.id,
      lines: [{ itemId, qty: 2 }],
    });

    const row = await trx.selectFrom('invoices')
      .select(['status', 'total', 'amount_paid'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'paid');
    assert.equal(toPaiseFromSql(row.amount_paid), toPaiseFromSql(row.total));
  });
});

test('a credit note cannot exceed what is still owed on the invoice it names', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 2 }],
    });
    await assert.rejects(
      () => createCreditNote(trx, orgId, null, {
        branchId, customerId, date: '2026-08-07', reason: 'Too much',
        againstInvoiceId: inv.id, lines: [{ itemId, qty: 5 }],
      }),
      /larger than what is still owed/,
    );
  });
});

test('a credit note needs a reason — GSTR-1 reports it', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    await assert.rejects(
      () => createCreditNote(trx, orgId, null, {
        branchId, customerId, date: '2026-08-07', reason: '   ',
        lines: [{ itemId, qty: 1 }],
      }),
      /needs a reason/,
    );
  });
});

test('refunding a credit note takes cash out and puts the receivable back', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId, acc }) => {
    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', reason: 'Refund requested',
      lines: [{ itemId, qty: 2 }],
    });

    const refund = await refundCreditNote(trx, orgId, null, cn.id, {
      bankAccountId: bankId, date: '2026-08-08',
    });
    assert.equal(refund.refundedPaise, 236_000);

    const e = await entryByCode(trx, refund.journalEntryId);
    assert.equal(e[CODE.AR].dr, 236_000, 'the credit is used up');
    assert.equal(e[CODE.BANK_DEFAULT].cr, 236_000, 'and the cash leaves');
    void acc;
  });
});

test('a credit note already applied has nothing left to refund', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 2 }],
    });
    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', reason: 'Returned',
      againstInvoiceId: inv.id, lines: [{ itemId, qty: 2 }],
    });
    await assert.rejects(
      () => refundCreditNote(trx, orgId, null, cn.id, { bankAccountId: bankId, date: '2026-08-08' }),
      /nothing left/,
    );
  });
});

test('voiding a credit note gives the invoice its balance back', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 2 }],
    });
    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', reason: 'Raised in error',
      againstInvoiceId: inv.id, lines: [{ itemId, qty: 2 }],
    });

    await voidCreditNote(trx, orgId, null, cn.id, 'Wrong customer');

    const row = await trx.selectFrom('invoices')
      .select(['status', 'total', 'amount_paid'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.amount_paid), 0, 'the invoice is owed again');
    assert.notEqual(row.status, 'paid');

    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced);
  });
});

// ── Retainers ───────────────────────────────────────────────────────────────

test('a retainer is a liability on the day it is raised, never income', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId }) => {
    const r = await createRetainer(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07',
      description: 'Annual maintenance contract', amountPaise: 5_000_000,
    });

    assert.ok(r.journalEntryId);
    const e = await entryByCode(trx, r.journalEntryId!);
    assert.equal(e[CODE.AR].dr, 5_000_000, 'the customer owes the advance');
    assert.equal(e[CODE.UNEARNED].cr, 5_000_000, 'and we owe them the work');
    assert.equal(e[CODE.SALES]?.cr ?? 0, 0, 'nothing has been earned yet');
  });
});

test('an unpaid retainer cannot be applied — the money has not arrived', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    const r = await createRetainer(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01',
      description: 'Advance', amountPaise: 5_000_000,
    });
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 10 }],
    });

    await assert.rejects(
      () => applyRetainer(trx, orgId, null, r.id, inv.id),
      /has not been paid yet/,
    );
  });
});

test('applying a paid retainer moves it out of unearned revenue and settles the invoice', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const r = await createRetainer(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01',
      description: 'Advance', amountPaise: 5_000_000,
    });

    await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-02', mode: 'neft',
      amountPaise: 5_000_000, bankAccountId: bankId,
      allocations: [{ targetType: 'retainer', targetId: r.id, amountPaise: 5_000_000 }],
    });

    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 10 }],
    });

    const applied = await applyRetainer(trx, orgId, null, r.id, inv.id);
    assert.equal(applied.appliedPaise, inv.totalPaise);

    const e = await entryByCode(trx, applied.journalEntryId);
    assert.equal(e[CODE.UNEARNED].dr, inv.totalPaise, 'the liability is released');
    assert.equal(e[CODE.AR].cr, inv.totalPaise, 'and the invoice is settled by it');

    const row = await trx.selectFrom('invoices').select(['status'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'paid');
  });
});

test('a retainer can only settle invoices for the customer who paid it', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const other = Number((await trx.insertInto('contacts').values({
      org_id: orgId, kind: 'customer', display_name: 'Someone Else',
      gst_treatment: 'registered', state_code: '33',
    }).executeTakeFirstOrThrow()).insertId);

    const r = await createRetainer(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', description: 'Advance', amountPaise: 5_000_000,
    });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-02', mode: 'neft',
      amountPaise: 5_000_000, bankAccountId: bankId,
      allocations: [{ targetType: 'retainer', targetId: r.id, amountPaise: 5_000_000 }],
    });

    const theirInvoice = await createInvoice(trx, orgId, null, {
      branchId, customerId: other, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1 }],
    });

    await assert.rejects(
      () => applyRetainer(trx, orgId, null, r.id, theirInvoice.id),
      /only settle invoices for the customer who paid it/,
    );
  });
});

// ── The reports still tie ───────────────────────────────────────────────────

test('the AR ageing still equals the receivable control account with credits and retainers open', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, acc }) => {
    await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31',
      status: 'approved', lines: [{ itemId, qty: 10 }],
    });
    // A credit note left on account, and a retainer nobody has paid.
    await createCreditNote(trx, orgId, null, {
      branchId, customerId, date: '2026-08-05', reason: 'Goodwill credit',
      lines: [{ itemId, qty: 1 }],
    });
    await createRetainer(trx, orgId, null, {
      branchId, customerId, date: '2026-08-06', description: 'Advance', amountPaise: 2_500_000,
    });

    const report = await ageing(trx, orgId, 'receivable', '2026-08-31');

    const { rows } = await sql<{ v: string }>`
      SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines
       WHERE org_id = ${orgId} AND account_id = ${acc[CODE.AR]} AND entry_date <= '2026-08-31'
    `.execute(trx);

    assert.equal(
      report.grandTotalPaise,
      toPaiseFromSql(rows[0].v),
      'the ageing report and the control account are one figure looked at two ways',
    );
  });
});

test('quotes and orders leave the ledger balanced and untouched', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId }) => {
    await createEstimate(trx, orgId, null, {
      branchId, customerId, date: '2026-08-01', expiryDate: '2026-08-31',
      lines: [{ itemId, qty: 40 }],
    });
    await createSalesOrder(trx, orgId, null, {
      branchId, customerId, date: '2026-08-02', lines: [{ itemId, qty: 25 }],
    });
    await createChallan(trx, orgId, null, {
      branchId, customerId, date: '2026-08-03', lines: [{ itemId, qty: 5 }],
    });

    assert.equal(await entryCount(trx, orgId), 0, 'not one entry between them');
    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
