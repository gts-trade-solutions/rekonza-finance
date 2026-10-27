// GSTR-2B from the portal's JSON download, and IMS actions on it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr2b.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';
import { importGstr2b, parseGstr2b, setImsAction } from '../../lib/server/gst/gstr2b-import';
import { itcReconciliation } from '../../lib/server/gst/compliance';

const OUR_GSTIN = '33AABCR1234M1Z5';
const SUPPLIER = '29AAACS9999K1Z2';

/** A statement shaped like the portal's download, wrapper and all. */
const statement = (period = '092026') => ({
  chksum: 'ignored',
  data: {
    gstin: OUR_GSTIN,
    rtnprd: period,
    gendt: '14-10-2026',
    docdata: {
      b2b: [{
        ctin: SUPPLIER, trdnm: 'Bengaluru Parts',
        inv: [
          // Filed in September, dated July: a late filer.
          { inum: 'BP/101', dt: '15-07-2026', val: 11800, txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' },
          { inum: 'BP/140', dt: '10-09-2026', val: 5900, txval: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' },
          { inum: '', dt: '10-09-2026', val: 1, txval: 1 },
        ],
      }],
      cdnr: [{
        ctin: SUPPLIER, trdnm: 'Bengaluru Parts',
        nt: [{ ntnum: 'CN/7', typ: 'C', dt: '20-09-2026', val: 1180, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' }],
      }],
    },
  },
});

interface Fixture { trx: Trx; orgId: number; branchId: number; vendorId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: '2B Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: OUR_GSTIN }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Bengaluru Parts', gst_treatment: 'registered',
        state_code: '29', gstin: SUPPLIER,
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, vendorId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('the portal file is read whatever its wrapper, and an unreadable line is reported', () => {
  const p = parseGstr2b(statement());
  assert.equal(p.gstin, OUR_GSTIN);
  assert.equal(p.returnPeriod, '092026');
  assert.equal(p.lines.length, 3, 'two invoices and a credit note');
  assert.equal(p.skipped.length, 1, 'the line with no number');
  assert.deepEqual(
    p.lines.map((l) => [l.docType, l.number, l.date]),
    [['invoice', 'BP/101', '2026-07-15'], ['invoice', 'BP/140', '2026-09-10'], ['credit_note', 'CN/7', '2026-09-20']],
  );
  assert.throws(() => parseGstr2b({ hello: 'world' }), /not a GSTR-2B/);
});

test('a statement for another GSTIN is refused', async () => {
  await withFixture(async ({ trx, orgId }) => {
    const other = statement();
    other.data.gstin = '27AABCR1234M1Z9';
    await assert.rejects(importGstr2b(trx, orgId, parseGstr2b(other)), /not one of this book.s registrations/);
  });
});

test('a late-filed invoice matches its old bill, and re-importing keeps the IMS action', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    // The July bill the supplier only filed in September.
    await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'BP/101', date: '2026-07-15', dueDate: '2026-08-14',
      lines: [{ description: 'Parts', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
    });

    const first = await importGstr2b(trx, orgId, parseGstr2b(statement()));
    assert.equal(first.inserted, 3);

    let r = await itcReconciliation(trx, orgId, '2026-09');
    const late = r.rows.find((x) => x.invoiceNo === 'BP/101')!;
    assert.equal(late.matchStatus, 'matched', 'matched to the July bill');
    assert.equal(r.rows.find((x) => x.invoiceNo === 'BP/140')!.matchStatus, 'missing_in_books');
    assert.equal(r.summary.ims_no_action, 3);

    await setImsAction(trx, orgId, null, [Number(late.id)], 'accepted');
    const again = await importGstr2b(trx, orgId, parseGstr2b(statement()));
    assert.equal(again.inserted, 0, 'the same file adds nothing new');

    r = await itcReconciliation(trx, orgId, '2026-09');
    assert.equal(r.rows.find((x) => x.invoiceNo === 'BP/101')!.imsAction, 'accepted');
  });
});

test('a credit note cannot be kept pending in IMS', async () => {
  await withFixture(async ({ trx, orgId }) => {
    await importGstr2b(trx, orgId, parseGstr2b(statement()));
    const note = await trx.selectFrom('gstr2b_entries').select('id')
      .where('org_id', '=', orgId).where('doc_type', '=', 'credit_note').executeTakeFirstOrThrow();
    await assert.rejects(setImsAction(trx, orgId, null, [Number(note.id)], 'pending'), /cannot be kept pending/);
    assert.equal(await setImsAction(trx, orgId, null, [Number(note.id)], 'rejected'), 1);
  });
});

test('credit held back in IMS is counted as at risk', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'BP/140', date: '2026-09-10', dueDate: '2026-10-10',
      lines: [{ description: 'Parts', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
    });
    await importGstr2b(trx, orgId, parseGstr2b(statement()));
    let r = await itcReconciliation(trx, orgId, '2026-09');
    const row = r.rows.find((x) => x.invoiceNo === 'BP/140')!;
    assert.equal(row.matchStatus, 'matched');
    assert.equal(r.summary.atRiskPaise, 0);

    await setImsAction(trx, orgId, null, [Number(row.id)], 'pending');
    r = await itcReconciliation(trx, orgId, '2026-09');
    assert.equal(r.summary.atRiskPaise, 900_00, 'a pending line is not in 2B, so its ₹900 is not claimable yet');
  });
});

test.after(async () => {
  await db.destroy();
});
