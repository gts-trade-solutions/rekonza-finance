// Edit and Delete on what the GST & Taxes screens enter or post
// (lib/server/gst/changes.ts), against real MySQL inside rolled-back
// transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gst-edit-delete.test.ts
//
// What has to hold: a challan edit leaves the ledger as if it had been entered
// right, and a delete reverses it and keeps it; a challan paid against a bank
// line stays until unmatched; a lower-deduction certificate bills used keeps
// its rate and is withdrawn, not deleted; goods back from job work can be
// corrected within what was sent and deleted (the challan open again); each
// ITC reversal can be undone, but not from under a reclaim or a true-up; a
// booked CMP-08 can be undone and booked again; a month's GSTR-2B can go.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { createBill } from '../../lib/server/services/purchases';
import { createInvoice } from '../../lib/server/services/sales';
import { makePayment } from '../../lib/server/services/payments';
import { createChallan } from '../../lib/server/services/sales-documents';
import { jobWorkLines, receiveJobWork } from '../../lib/server/services/job-work';
import { recordChallan } from '../../lib/server/tax/tds-returns';
import { addLowerCertificate, cancelLowerCertificate, recordCertificate } from '../../lib/server/tax/tds-certificates';
import { postCommonCredit, postRule37, reclaimRule37, rule37 } from '../../lib/server/gst/itc-reversals';
import { bookCmp08, cmp08 } from '../../lib/server/gst/composition';
import {
  deleteCertificate, deleteChallan, deleteGstr2bPeriod, deleteJobWorkReceipt, deleteLowerCertificate, postedItcReversals,
  undoCmp08, undoCommonCredit, undoReclaim37, undoRule37, updateCertificate, updateChallan, updateJobWorkReceipt, updateLowerCertificate,
} from '../../lib/server/gst/changes';

const R = (rupees: number) => Math.round(rupees * 100);
interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; vendor: number; customer: number; item: number }

async function withFixture(fn: (f: Fixture) => Promise<void>, org: Record<string, unknown> = {}) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'GST Changes Co', ...org } as never).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: '33AAACR1111R1Z1', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '0401', kind: 'hsn', description: 'Milk', gst_rate_pct: 0, is_active: 1 },
        { org_id: orgId, code: '7326', kind: 'hsn', description: 'Steel', gst_rate_pct: 18, is_active: 1 },
      ]).execute();
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const item = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Steel sheet', uqc: 'NOS', hsn_sac: '7326', gst_rate_pct: 18, sale_price: '100.0000', purchase_price: '50.0000', track_inventory: 1,
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId, acc, item,
        vendor: await contact({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', gstin: '33AAACS2222S1Z2', pan: 'AAACS2222S', tds_section: '194C' }),
        customer: await contact({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'consumer' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);

test('a TDS challan: edited on the same record (reversed and posted again), refused while bank-matched, deleted and kept', async () => {
  await withFixture(async (f) => {
    const c = await recordChallan(f.trx, f.orgId, null, f.branchId, {
      kind: 'tds', forMonth: '2026-06', date: '2026-07-05', bsrCode: '0510001', serial: '12', taxPaise: R(5_000), bankAccountId: f.bankId,
    });
    await updateChallan(f.trx, f.orgId, null, c.id, {
      kind: 'tds', forMonth: '2026-06', date: '2026-07-06', bsrCode: '0510001', serial: '13', taxPaise: R(5_200), interestPaise: R(52), bankAccountId: f.bankId,
    });
    assert.equal(await balance(f, CODE.TDS_PAYABLE), R(5_200), 'the old deposit reversed, the new one posted');
    assert.equal(await balance(f, CODE.TAX_INTEREST), R(52));
    assert.equal(await balance(f, CODE.BANK_DEFAULT), -R(5_252));
    const row = await f.trx.selectFrom('tds_challans').select(['challan_serial', 'journal_entry_id']).where('id', '=', c.id).executeTakeFirstOrThrow();
    assert.equal(row.challan_serial, '13');

    const line = Number((await f.trx.insertInto('bank_transactions').values({
      org_id: f.orgId, bank_account_id: f.bankId, txn_date: '2026-07-06', narration: 'TDS', withdrawal: '5252.0000', deposit: '0.0000', dedupe_hash: 'gst-edit-delete-1',
      status: 'matched', matched_type: 'journal_entry', matched_id: row.journal_entry_id,
    } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(deleteChallan(f.trx, f.orgId, null, c.id, null), /matched to a line of the bank statement/);
    await f.trx.deleteFrom('bank_transactions').where('id', '=', line).execute();

    await deleteChallan(f.trx, f.orgId, null, c.id, 'wrong serial');
    for (const code of [CODE.TDS_PAYABLE, CODE.TAX_INTEREST, CODE.BANK_DEFAULT]) assert.equal(await balance(f, code), 0);
    const kept = await f.trx.selectFrom('deleted_documents').select(['number', 'reason']).where('org_id', '=', f.orgId).where('doc_type', '=', 'tds_challan').executeTakeFirstOrThrow();
    assert.deepEqual([kept.number, kept.reason], ['0510001/13', 'wrong serial']);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('certificates: Form 131 corrected and deleted; a lower-deduction certificate bills used keeps its rate and is withdrawn, not deleted', async () => {
  await withFixture(async (f) => {
    const cert = await recordCertificate(f.trx, f.orgId, null, { direction: 'issued', contactId: f.vendor, fy: 2026, quarter: 1, certificateNo: 'ABCD1234', issuedOn: '2026-08-10', taxPaise: R(100) });
    await updateCertificate(f.trx, f.orgId, cert.id, { certificateNo: 'abcd1235', issuedOn: '2026-08-11', taxPaise: R(120) });
    const after = await f.trx.selectFrom('tds_certificates').select(['certificate_no', 'tax']).where('id', '=', cert.id).executeTakeFirstOrThrow();
    assert.deepEqual([after.certificate_no, toPaiseFromSql(after.tax)], ['ABCD1235', R(120)]);
    await deleteCertificate(f.trx, f.orgId, cert.id);
    assert.equal(await f.trx.selectFrom('tds_certificates').select('id').where('id', '=', cert.id).executeTakeFirst(), undefined);

    const lower = await addLowerCertificate(f.trx, f.orgId, null, {
      contactId: f.vendor, sectionCode: '194C', certificateNo: 'LDC123456', ratePct: 0.5, validFrom: '2026-04-01', validTo: '2027-03-31',
    });
    // Unused, everything can change.
    await updateLowerCertificate(f.trx, f.orgId, lower.id, {
      contactId: f.vendor, sectionCode: '194C', certificateNo: 'LDC123456', ratePct: 0.75, validFrom: '2026-04-01', validTo: '2027-03-31',
    });
    const spare = await addLowerCertificate(f.trx, f.orgId, null, {
      contactId: f.vendor, sectionCode: '194J', certificateNo: 'LDC999999', ratePct: 1, validFrom: '2026-04-01', validTo: '2026-09-30',
    });
    await deleteLowerCertificate(f.trx, f.orgId, spare.id);

    // A bill deducted under it.
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'S-1', date: '2026-06-10', dueDate: '2026-06-10', status: 'open',
      lines: [{ description: 'Work', hsnSac: '8708', qty: 1, ratePaise: R(10_000), gstRatePct: 18 }],
    } as never);
    await f.trx.updateTable('bills').set({ tds_lower_cert_id: lower.id }).where('id', '=', bill.id).execute();
    await assert.rejects(updateLowerCertificate(f.trx, f.orgId, lower.id, {
      contactId: f.vendor, sectionCode: '194C', certificateNo: 'LDC123456', ratePct: 1, validFrom: '2026-04-01', validTo: '2027-03-31',
    }), /rate stay/);
    // Its number and end date can still be put right.
    await updateLowerCertificate(f.trx, f.orgId, lower.id, {
      contactId: f.vendor, sectionCode: '194C', certificateNo: 'LDC123457', ratePct: 0.75, validFrom: '2026-04-01', validTo: '2026-12-31',
    });
    await assert.rejects(deleteLowerCertificate(f.trx, f.orgId, lower.id), /Withdraw it instead/);
    await cancelLowerCertificate(f.trx, f.orgId, lower.id);
  });
});

test('goods back from job work: corrected within what was sent, deleted with the challan open again', async () => {
  await withFixture(async (f) => {
    const worker = Number((await f.trx.insertInto('contacts').values({ org_id: f.orgId, kind: 'vendor', display_name: 'Cutter', state_code: '33', gst_treatment: 'registered', gstin: '33AAACJ4444J1Z4' } as never).executeTakeFirstOrThrow()).insertId);
    const dc = await createChallan(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: worker, date: '2026-05-01', challanType: 'job_work',
      lines: [{ itemId: f.item, description: 'Sheet for cutting', hsnSac: '7326', qty: 20, ratePaise: R(50) }],
    } as never);
    const [line] = await jobWorkLines(f.trx, f.orgId, dc.id);
    const a = await receiveJobWork(f.trx, f.orgId, null, { challanId: dc.id, date: '2026-06-01', lines: [{ challanLineId: Number(line.lineId), qtyReceived: 12 }] });
    const b = await receiveJobWork(f.trx, f.orgId, null, { challanId: dc.id, date: '2026-06-05', lines: [{ challanLineId: Number(line.lineId), qtyReceived: 8 }] });
    const status = async () => (await f.trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow()).status;
    assert.equal(await status(), 'returned');

    // Twelve back on the first receipt; it can become ten with two wasted, not thirteen.
    await assert.rejects(updateJobWorkReceipt(f.trx, f.orgId, a.id, { date: '2026-06-01', lines: [{ challanLineId: Number(line.lineId), qtyReceived: 13 }] }), /Only 12/);
    await updateJobWorkReceipt(f.trx, f.orgId, a.id, { date: '2026-06-02', jobWorkerChallanNo: 'JW/1', lines: [{ challanLineId: Number(line.lineId), qtyReceived: 10, qtyWaste: 2 }] });
    assert.equal(await status(), 'returned', 'still all accounted for');
    await updateJobWorkReceipt(f.trx, f.orgId, a.id, { date: '2026-06-02', lines: [{ challanLineId: Number(line.lineId), qtyReceived: 9 }] });
    assert.equal(await status(), 'open', 'three are out again');
    await deleteJobWorkReceipt(f.trx, f.orgId, b.id);
    assert.equal((await jobWorkLines(f.trx, f.orgId, dc.id))[0].outstanding, 11);
  });
});

test('ITC reversals: Rule 37 undone only after its reclaim; Rules 42/43 undone and posted again', async () => {
  await withFixture(async (f) => {
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'S-1', date: '2026-01-10', dueDate: '2026-01-10', status: 'open',
      lines: [{ description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: R(10_000), gstRatePct: 18 }],
    } as never);
    const itcBefore = await balance(f, CODE.ITC_CGST);
    await postRule37(f.trx, f.orgId, null, '2026-07');
    await makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.vendor, date: '2026-08-20', mode: 'neft', amountPaise: R(11_800), bankAccountId: f.bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: R(11_800) }],
    });
    await reclaimRule37(f.trx, f.orgId, null, '2026-08');
    const posted = await postedItcReversals(f.trx, f.orgId);
    assert.deepEqual(posted.reclaims37.map((r) => [r.period, r.amountPaise]), [['2026-08', R(1_800)]]);

    await assert.rejects(undoRule37(f.trx, f.orgId, null, '2026-07'), /taken back against it in Aug 2026/);
    await undoReclaim37(f.trx, f.orgId, null, '2026-08', 'paid by mistake');
    assert.equal((await rule37(f.trx, f.orgId, '2026-08-31'))[0].status, 'reclaimable', 'taken back again: it can be reclaimed again');
    await undoRule37(f.trx, f.orgId, null, '2026-07');
    assert.equal(await balance(f, CODE.ITC_CGST), itcBefore, 'the credit is back as it was');
    assert.equal(await balance(f, CODE.ITC_RECLAIMABLE), 0);

    // Rules 42 and 43.
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
      lines: [
        { description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: R(75_000), gstRatePct: 18 },
        { description: 'Milk', hsnSac: '0401', qty: 1, ratePaise: R(25_000), gstRatePct: 0 },
      ],
    });
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'IN-1', date: '2026-06-05', dueDate: '2026-06-05', status: 'open',
      lines: [{ description: 'Inputs', hsnSac: '8708', qty: 1, ratePaise: R(10_000), gstRatePct: 18 }],
    } as never);
    await postCommonCredit(f.trx, f.orgId, null, '2026-06');
    const reversed = await balance(f, CODE.ITC_REVERSED_EXEMPT);
    assert.ok(reversed > 0);
    await undoCommonCredit(f.trx, f.orgId, null, '2026-06');
    assert.equal(await balance(f, CODE.ITC_REVERSED_EXEMPT), 0);
    await postCommonCredit(f.trx, f.orgId, null, '2026-06');
    assert.equal(await balance(f, CODE.ITC_REVERSED_EXEMPT), reversed, 'posted again, once');
    await f.trx.insertInto('itc_reversals').values({ org_id: f.orgId, rule: '42-annual', period: '2026', cgst: '0', sgst: '0', igst: '0', cess: '0' }).execute();
    await assert.rejects(undoCommonCredit(f.trx, f.orgId, null, '2026-06'), /Delete the true-up first/);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a booked CMP-08 is undone and booked again', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-05-10', dueDate: '2026-05-10', status: 'approved',
      lines: [{ description: 'Parts', hsnSac: '8708', qty: 100, ratePaise: R(100), gstRatePct: 18 }],
    });
    await bookCmp08(f.trx, f.orgId, null, 2026, 1);
    assert.equal(await balance(f, CODE.COMPOSITION_TAX), R(100));
    await undoCmp08(f.trx, f.orgId, null, 2026, 1, 'booked before the last invoice');
    assert.equal(await balance(f, CODE.COMPOSITION_TAX), 0);
    assert.equal((await cmp08(f.trx, f.orgId, 2026, 1)).booked, null);
    await bookCmp08(f.trx, f.orgId, null, 2026, 1);
    assert.equal(await balance(f, CODE.COMPOSITION_TAX), R(100));
  }, { gst_registration_type: 'composition', composition_category: 'trader' });
});

test('a month of GSTR-2B brought in can be taken out', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('gstr2b_entries').values({
      org_id: f.orgId, return_period: '062026', vendor_gstin: '33AAACS2222S1Z2', doc_type: 'invoice', invoice_no: 'S-1', vendor_name: 'Supplier',
      recipient_gstin: '33AAACR1111R1Z1', invoice_date: '2026-06-10', taxable: '100.0000', cgst: '9.0000', sgst: '9.0000', igst: '0', cess: '0',
      itc_available: 1, is_reverse_charge: 0, source: 'upload',
    } as never).execute();
    assert.deepEqual(await deleteGstr2bPeriod(f.trx, f.orgId, '062026'), { lines: 1 });
    await assert.rejects(deleteGstr2bPeriod(f.trx, f.orgId, '062026'), /No GSTR-2B/);
  });
});
