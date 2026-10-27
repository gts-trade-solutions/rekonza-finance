// Advances: money received before the invoice, applied to it later.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/advances.test.ts
//
// GST on an advance for services is owed the month the money arrives and
// taken back the month the advance meets its invoice, so across the two
// months the tax is paid once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { applyPayment, receivePayment, unapplyAllocation, voidPayment } from '../../lib/server/services/payments';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>;
  client: number; otherClient: number; vendor: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Advances Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCA2222A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998311', kind: 'sac', description: 'Management consulting', gst_rate_pct: 18, is_active: 1 }).execute();
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        client: await mk({ kind: 'customer', display_name: 'Client', gst_treatment: 'registered', gstin: '33AAACL1111L1Z1' }),
        otherClient: await mk({ kind: 'customer', display_name: 'Other client', gst_treatment: 'unregistered' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', gstin: '33AAACS3333S1Z3' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const invoice = (f: Fixture, customerId: number, date: string, rupees: number) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId, date, dueDate: date, status: 'approved',
    lines: [{ description: 'Consulting', hsnSac: '998311', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 }],
  });
const receive = (f: Fixture, date: string, rupees: number, extra: Partial<Parameters<typeof receivePayment>[3]> = {}) =>
  receivePayment(f.trx, f.orgId, null, {
    branchId: f.branchId, contactId: f.client, date, mode: 'neft', amountPaise: rupees * 100, bankAccountId: f.bankId, ...extra,
  });
const balance = async (f: Fixture, code: string) => {
  const r = await sql<{ b: string }>`
    SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]}
  `.execute(f.trx);
  return toPaiseFromSql(r.rows[0].b);
};
const invoiceRow = (f: Fixture, id: number) =>
  f.trx.selectFrom('invoices').select(['amount_paid', 'status']).where('id', '=', id).executeTakeFirstOrThrow();

test('money on account is applied to an invoice raised later', async () => {
  await withFixture(async (f) => {
    const r = await receive(f, '2026-08-01', 50_000);
    assert.equal(r.unappliedPaise, 50_000_00);
    const arBefore = await balance(f, CODE.AR);

    const inv = await invoice(f, f.client, '2026-08-10', 30_000);   // 35,400 with GST
    const applied = await applyPayment(f.trx, f.orgId, null, r.id, {
      date: '2026-08-10', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 35_400_00 }],
    });
    assert.equal(applied.unappliedPaise, 14_600_00);
    const row = await invoiceRow(f, inv.id);
    assert.equal(row.status, 'paid');
    assert.equal(await balance(f, CODE.AR), arBefore + 35_400_00, 'only the invoice posts; applying moves nothing');

    await assert.rejects(
      applyPayment(f.trx, f.orgId, null, r.id, {
        date: '2026-08-10', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 20_000_00 }],
      }),
      /Only 14600\.00/,
    );
  });
});

test('an advance cannot settle another party, or the wrong kind of document', async () => {
  await withFixture(async (f) => {
    const r = await receive(f, '2026-08-01', 10_000);
    const theirs = await invoice(f, f.otherClient, '2026-08-02', 1_000);
    await assert.rejects(
      applyPayment(f.trx, f.orgId, null, r.id, {
        date: '2026-08-02', allocations: [{ targetType: 'invoice', targetId: theirs.id, amountPaise: 1_000_00 }],
      }),
      /another customer/,
    );
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'S-1', date: '2026-08-02', dueDate: '2026-08-02',
      lines: [{ description: 'Stock', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
    });
    await assert.rejects(
      applyPayment(f.trx, f.orgId, null, r.id, {
        date: '2026-08-02', allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 1_000_00 }],
      }),
      /receipt cannot be set against a bill/,
    );
    await assert.rejects(
      receive(f, '2026-08-03', 500, { allocations: [{ targetType: 'invoice', targetId: theirs.id, amountPaise: 500_00 }] }),
      /another customer/,
    );
  });
});

test('GST on an advance for services: paid on arrival, taken back when invoiced', async () => {
  await withFixture(async (f) => {
    // August: ₹1,18,000 arrives for work not yet billed. ₹18,000 of it is GST.
    const r = await receive(f, '2026-08-20', 1_18_000, { advanceGst: { ratePct: 18 } });
    assert.equal(await balance(f, CODE.GST_ON_ADVANCES), 18_000_00);

    const aug = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(aug.outward.cgstPaise, 9_000_00);
    assert.equal(aug.outward.sgstPaise, 9_000_00);
    assert.equal(aug.outward.taxablePaise, 1_00_000_00);
    const augFile = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    assert.deepEqual(augFile.at, [{
      pos: '33', sply_ty: 'INTRA',
      itms: [{ rt: 18, ad_amt: 1_00_000, iamt: 0, camt: 9_000, samt: 9_000, csamt: 0 }],
    }]);

    // September: the invoice charges the tax, and the advance is applied to it.
    const inv = await invoice(f, f.client, '2026-09-05', 1_00_000);
    const applied = await applyPayment(f.trx, f.orgId, null, r.id, {
      date: '2026-09-05', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 1_18_000_00 }],
    });
    assert.equal(await balance(f, CODE.GST_ON_ADVANCES), 0, 'nothing left waiting');

    const sep = await gstr3b(f.trx, f.orgId, '2026-09');
    assert.equal(sep.outward.cgstPaise + sep.outward.sgstPaise, 0, 'the tax was paid in August');
    assert.equal(sep.advances.adjustedTaxPaise, 18_000_00);
    const sepFile = await gstr1PortalFile(f.trx, f.orgId, '2026-09');
    assert.equal((sepFile.txpd as { itms: { ad_amt: number }[] }[])[0].itms[0].ad_amt, 1_00_000);
    assert.equal(sepFile.at, undefined);

    // Undone by mistake: the tax goes back to waiting, and the invoice is owed again.
    await unapplyAllocation(f.trx, f.orgId, null, applied.allocationIds[0]);
    assert.equal(await balance(f, CODE.GST_ON_ADVANCES), 18_000_00);
    assert.equal((await invoiceRow(f, inv.id)).status, 'sent');
  });
});

test('an advance received and applied in the same month is not an advance at the return', async () => {
  await withFixture(async (f) => {
    const r = await receive(f, '2026-08-02', 11_800, { advanceGst: { ratePct: 18 } });
    const inv = await invoice(f, f.client, '2026-08-25', 10_000);
    await applyPayment(f.trx, f.orgId, null, r.id, {
      date: '2026-08-25', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 11_800_00 }],
    });
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    assert.equal(file.at, undefined);
    assert.equal(file.txpd, undefined);
    const g = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(g.outward.cgstPaise + g.outward.sgstPaise, 1_800_00, 'the invoice tax, once');
  });
});

test('voiding a payment reopens what it settled and undoes the advance tax', async () => {
  await withFixture(async (f) => {
    const r = await receive(f, '2026-08-01', 23_600, { advanceGst: { ratePct: 18 } });
    const inv = await invoice(f, f.client, '2026-08-05', 10_000);
    await applyPayment(f.trx, f.orgId, null, r.id, {
      date: '2026-08-05', allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 11_800_00 }],
    });
    await voidPayment(f.trx, f.orgId, null, r.id, 'Cheque bounced');
    assert.equal((await invoiceRow(f, inv.id)).status, 'sent');
    assert.equal(await balance(f, CODE.GST_ON_ADVANCES), 0);
    const g = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(g.outward.cgstPaise + g.outward.sgstPaise, 1_800_00, 'only the invoice tax remains');
  });
});

test.after(async () => {
  await db.destroy();
});
