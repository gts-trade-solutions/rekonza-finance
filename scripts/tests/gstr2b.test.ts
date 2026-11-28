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

// ── The portal's own GSTR-2B layout (auditor check, 2026-11-28) ─────────────
// GSTN's GSTR-2B JSON gives each invoice and note its figures in items[], with
// nothing at the document level but the value. The import used to read only
// the document level, so a real 2B came in with no tax on any line.

/** GSTR-2B exactly as GSTN issues it: items[] on every document, and the other sections. */
const portal2b = () => ({
  chksum: 'x',
  data: {
    gstin: OUR_GSTIN, rtnprd: '102026', gendt: '14-11-2026', version: '1.0',
    itcsumm: { itcavl: { nonrevsup: { b2b: { txval: 0 } } } },
    docdata: {
      b2b: [{
        ctin: SUPPLIER, trdnm: 'Bengaluru Parts', supfildt: '11-11-2026', supprd: '102026',
        inv: [{
          inum: 'BP/301', typ: 'R', dt: '05-10-2026', val: 17700, pos: '33', rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 1, srctyp: 'e-Invoice',
          items: [
            { num: 1, rt: 18, txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 },
            { num: 2, rt: 18, txval: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 },
          ],
        }],
      }],
      b2ba: [{
        ctin: SUPPLIER, trdnm: 'Bengaluru Parts',
        inv: [{ oinum: 'BP/290', oidt: '28-09-2026', inum: 'BP/290A', typ: 'R', dt: '28-09-2026', val: 1180, rev: 'N', itcavl: 'Y',
          items: [{ num: 1, rt: 18, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] }],
      }],
      cdnr: [{
        ctin: SUPPLIER, trdnm: 'Bengaluru Parts',
        nt: [{ ntnum: 'BP-CN/9', typ: 'C', suptyp: 'R', dt: '20-10-2026', val: 2360, pos: '33', rev: 'N', itcavl: 'Y',
          items: [{ num: 1, rt: 18, txval: 2000, igst: 360, cgst: 0, sgst: 0, cess: 0 }] }],
      }],
      isd: [{
        ctin: '33AABCH5555Q1ZQ', trdnm: 'Head office (ISD)',
        doclist: [
          { doctyp: 'ISD', docnum: 'ISD/12', docdt: '15-10-2026', igst: 0, cgst: 450, sgst: 450, cess: 0, itcelg: 'Y' },
          { doctyp: 'ISDC', docnum: 'ISDC/3', docdt: '25-10-2026', oinvnum: 'ISD/12', oinvdt: '15-10-2026', igst: 0, cgst: 50, sgst: 50, cess: 0, itcelg: 'Y' },
        ],
      }],
      impg: [{ refdt: '12-10-2026', portcode: 'INMAA1', boenum: '7654321', boedt: '10-10-2026', isamd: 'N', txval: 50000, igst: 9000, cess: 0 }],
      impgsez: [{ ctin: '33AAACZ7777R1Z9', trdnm: 'MEPZ unit', boe: [{ refdt: '18-10-2026', portcode: 'INMAA6', boenum: '7654400', boedt: '17-10-2026', isamd: 'N', txval: 10000, igst: 1800, cess: 0 }] }],
    } as Record<string, unknown>,
  },
});

test('GSTR-2B in the portal layout is read with its tax: items[] are added up, in every section', () => {
  const p = parseGstr2b(portal2b());
  assert.equal(p.layout, '2B');
  assert.equal(p.generatedOn, '2026-11-14');
  assert.equal(p.skipped.length, 0);
  const by = (n: string) => p.lines.find((l) => l.number === n)!;
  assert.deepEqual([by('BP/301').taxable, by('BP/301').igst], [15000, 2700], 'both items of the invoice');
  assert.equal(by('BP/290A').docType, 'invoice');
  assert.equal(by('BP/290A').igst, 180, 'an amended invoice carries its current figures');
  assert.deepEqual([by('BP-CN/9').docType, by('BP-CN/9').taxable, by('BP-CN/9').igst], ['credit_note', 2000, 360], 'a credit note in 2B layout');
  assert.deepEqual([by('ISD/12').docType, by('ISD/12').cgst, by('ISD/12').sgst], ['isd', 450, 450]);
  assert.equal(by('ISDC/3').docType, 'isd_credit');
  assert.deepEqual([by('7654321').docType, by('7654321').vendorGstin, by('7654321').igst, by('7654321').vendorName], ['bill_of_entry', '', 9000, 'Imported through INMAA1']);
  assert.deepEqual([by('7654400').docType, by('7654400').vendorGstin], ['bill_of_entry', '33AAACZ7777R1Z9']);
  assert.ok(p.lines.every((l) => l.itcAvailable));
});

test('the same invoice in the GSTR-2A layout (itms[].itm_det) reads the same figures', () => {
  const twoA = {
    gstin: OUR_GSTIN, fp: '102026',
    b2b: [{ ctin: SUPPLIER, trdnm: 'Bengaluru Parts', cfs: 'Y',
      inv: [{ inum: 'BP/301', idt: '05-10-2026', val: 17700, rchrg: 'N',
        itms: [{ num: 1, itm_det: { rt: 18, txval: 10000, iamt: 1800, csamt: 0 } }, { num: 2, itm_det: { rt: 18, txval: 5000, iamt: 900, csamt: 0 } }] }] }],
    cdn: [{ ctin: SUPPLIER, cfs: 'Y', nt: [{ ntty: 'C', nt_num: 'BP-CN/9', nt_dt: '20-10-2026', itms: [{ num: 1, itm_det: { rt: 18, txval: 2000, iamt: 360 } }] }] }],
  };
  const a = parseGstr2b(twoA);
  const b = parseGstr2b(portal2b());
  assert.equal(a.layout, '2A');
  for (const n of ['BP/301', 'BP-CN/9']) {
    const x = a.lines.find((l) => l.number === n)!;
    const y = b.lines.find((l) => l.number === n)!;
    assert.deepEqual([x.docType, x.taxable, x.igst, x.cgst, x.sgst], [y.docType, y.taxable, y.igst, y.cgst, y.sgst], n);
  }
});

test('a file in neither layout is refused with a message saying which file to take', () => {
  // A GSTR-1 of our own.
  assert.throws(() => parseGstr2b({ gstin: OUR_GSTIN, fp: '102026', b2b: [], b2cs: [], hsn: {} }), /GSTR-1 file.*not a GSTR-2B/);
  // A 2B summary with no documents.
  assert.throws(() => parseGstr2b({ data: { gstin: OUR_GSTIN, rtnprd: '102026', itcsumm: {} } }), /summary only/);
  // Anything else.
  assert.throws(() => parseGstr2b({ invoices: [] }), /not a GSTR-2B or GSTR-2A JSON download.*Returns → GSTR-2B/);
  // A 2B whose documents carry no figures in any layout: nothing is guessed.
  const empty = portal2b();
  empty.data.docdata = { b2b: [{ ctin: SUPPLIER, trdnm: 'X', inv: [{ inum: 'Z/1', dt: '05-10-2026', val: 100 }] }] };
  assert.throws(() => parseGstr2b(empty), /None of the 1 document\(s\).*no taxable value or tax/);
});

test('a portal-layout 2B matches the bill, lists the credit note, and matches the bill of entry with customs', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'BP/301', date: '2026-10-05', dueDate: '2026-11-04',
      lines: [{ description: 'Parts', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }, { description: 'More parts', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
    });
    // The bill of entry for the import, as recorded in the books.
    const purchases = await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('code', '=', '5200').executeTakeFirstOrThrow();
    const cashAcc = await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('type', '=', 'asset').executeTakeFirstOrThrow();
    const bank = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'cash', name: 'Cash', ledger_account_id: cashAcc.id } as never).executeTakeFirstOrThrow()).insertId);
    await trx.insertInto('bills_of_entry').values({
      org_id: orgId, branch_id: branchId, boe_no: '7654321', boe_date: '2026-10-10', port_code: 'INMAA1',
      assessable_value: '50000', customs_duty: '5000', igst: '9000', cess: '0', duty_account_id: purchases.id, paid_through_bank_account_id: bank,
    }).execute();

    const r0 = await importGstr2b(trx, orgId, parseGstr2b(portal2b()));
    assert.equal(r0.layout, '2B');
    assert.deepEqual(r0.byType, { invoice: 2, credit_note: 1, isd: 1, isd_credit: 1, bill_of_entry: 2 });

    const r = await itcReconciliation(trx, orgId, '2026-10');
    const inv = r.rows.find((x) => x.invoiceNo === 'BP/301')!;
    assert.equal(inv.portalTaxPaise, 2700_00, 'the portal column has the tax, not a dash');
    assert.equal(inv.matchStatus, 'matched', 'and it agrees with the bill to the paisa');
    const cn = r.rows.find((x) => x.invoiceNo === 'BP-CN/9')!;
    assert.deepEqual([cn.docType, cn.portalTaxPaise], ['credit_note', 360_00]);
    const boe = r.rows.find((x) => x.invoiceNo === '7654321')!;
    assert.deepEqual([boe.docType, boe.matchStatus, boe.portalTaxPaise, boe.booksTaxPaise], ['bill_of_entry', 'matched', 9000_00, 9000_00]);
    assert.equal(r.rows.find((x) => x.invoiceNo === '7654400')!.matchStatus, 'missing_in_books', 'the SEZ bill of entry was never recorded');

    // A bill of entry or ISD document is not in IMS.
    await assert.rejects(setImsAction(trx, orgId, null, [Number(boe.id)], 'accepted'), /not in IMS/);
  });
});

test.after(async () => {
  await db.destroy();
});
