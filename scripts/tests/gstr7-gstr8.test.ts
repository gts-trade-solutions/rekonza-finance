// GSTR-7 (GST TDS, CGST Act s.51) and GSTR-8 (e-commerce TCS, s.52).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr7-gstr8.test.ts
//
// What an auditor checks on these returns: that 2% is deducted only above
// ₹2.5 lakh and not where both the supplier and the place of supply are in
// another State; that the heads split by intra- and inter-State supply; that
// every rupee withheld is on GST TDS / TCS Payable and nowhere else; that the
// bill is settled by the deduction; that the portal file carries the GSTN's own
// keys, fp as MMYYYY and rupees to two places; that a filed month refuses
// change and is corrected by amendment in a later month; that the TCS rate is
// the one in force on the date; and that paying the tax clears the payable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { CODE, accountIds, installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';
import {
  amendGstTds, deleteGstTds, gstr7, gstr7PortalJson, gstr7aCertificate, previewGstTds, recordGstTds,
  recordGstr7Payment, snapshotGstr7, undoGstTdsAmendment, updateGstTds,
} from '../../lib/server/gst/gstr7';
import {
  amendEcoSupply, deleteEcoSupply, gstr8, gstr8PortalJson, recordEcoSupply, recordGstr8Payment, snapshotGstr8, updateEcoSupply,
} from '../../lib/server/gst/gstr8';
import { deleteWithholdingPayment } from '../../lib/server/gst/withholding-common';
import { ecoTcsRatePct, gstTdsHeads, gstinCheckChar, roleGstinProblem, GST_TDS_THRESHOLD_PAISE } from '../../lib/gst/withholding';
import { isValidGstin } from '../../lib/tax/gst';

/** A GSTIN with its own check character. */
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const HQ = gstin('33AAACR1111R1Z');
const TDS_REG = gstin('33CHED12345A1D');
const TCS_REG = gstin('33AAACM4321M1C');
const LOCAL = gstin('33AAACS2222S1Z');
const FAR = gstin('29AAACK3333K1Z');
const SELLER = gstin('27AAACB4444B1Z');

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>;
  local: number; far: number; seller: number; unregistered: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({
        name: 'Public Works Dept', gst_tds_deductor: 1, gst_tds_gstin: TDS_REG, gst_eco_operator: 1, gst_eco_gstin: TCS_REG,
      } as never).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: HQ, is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Treasury', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', gst_treatment: 'registered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId, acc,
        local: await contact({ display_name: 'Chennai Builders', gstin: LOCAL, state_code: '33' }),
        far: await contact({ display_name: 'Karnataka Steel', gstin: FAR, state_code: '29' }),
        seller: await contact({ display_name: 'Mumbai Sellers', gstin: SELLER, state_code: '27' }),
        unregistered: await contact({ display_name: 'Corner Eatery', gst_treatment: 'unregistered', state_code: '33' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);

const bill = (f: Fixture, vendorId: number, rupees: number, date = '2026-11-05', no = 'W-1') => createBill(f.trx, f.orgId, null, {
  branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date,
  lines: [{ description: 'Road works', hsnSac: '9954', qty: 1, ratePaise: Math.round(rupees * 100), gstRatePct: 18 }],
});

const fileMonth = (f: Fixture, key: string, period: string) => f.trx.insertInto('compliance_filings')
  .values({ org_id: f.orgId, item_key: key, period, done_on: `${period}-10`, reference: 'AA331126000001X' }).execute();

test('the rule: threshold, heads and the second proviso', () => {
  const base = { taxablePaise: 3_00_000_00, contractValuePaise: 3_00_000_00, recipientState: '33' };
  const intra = gstTdsHeads({ ...base, supplierState: '33', placeOfSupply: '33' });
  assert.equal(intra.applies, true);
  assert.deepEqual([intra.cgstPaise, intra.sgstPaise, intra.igstPaise], [3_000_00, 3_000_00, 0], '1% + 1% within the State');
  const inter = gstTdsHeads({ ...base, supplierState: '29', placeOfSupply: '33' });
  assert.deepEqual([inter.igstPaise, inter.cgstPaise], [6_000_00, 0], '2% IGST across States');
  const proviso = gstTdsHeads({ ...base, supplierState: '29', placeOfSupply: '29' });
  assert.equal(proviso.applies, false, 'supplier and place of supply both in another State: no TDS');
  assert.match(proviso.reason, /second proviso/);
  const small = gstTdsHeads({ ...base, contractValuePaise: GST_TDS_THRESHOLD_PAISE, supplierState: '33', placeOfSupply: '33' });
  assert.equal(small.applies, false, 'exactly ₹2.5 lakh is not above it');
  // Rounded to the paisa, each head on its own.
  const odd = gstTdsHeads({ ...base, taxablePaise: 2_60_000_55, supplierState: '33', placeOfSupply: '33' });
  assert.equal(odd.cgstPaise, Math.round(2_60_000_55 / 100));
});

test('registrations: D for a deductor, C for an operator, and a good check character', () => {
  assert.equal(roleGstinProblem(TDS_REG, 'tds'), null);
  assert.equal(roleGstinProblem(TCS_REG, 'tcs'), null);
  assert.match(roleGstinProblem(TCS_REG, 'tds') ?? '', /14th character/);
  assert.match(roleGstinProblem(TDS_REG.slice(0, 14) + (TDS_REG[14] === 'A' ? 'B' : 'A'), 'tds') ?? '', /check character/);
  assert.ok(isValidGstin(LOCAL) && isValidGstin(FAR) && isValidGstin(SELLER));
});

test('TCS is 1% before 10 July 2024 and 0.5% from it', () => {
  assert.equal(ecoTcsRatePct('2024-07-09'), 1);
  assert.equal(ecoTcsRatePct('2024-07-10'), 0.5);
  assert.equal(ecoTcsRatePct('2026-11-01'), 0.5);
});

test('a deduction posts to GST TDS Payable to the paisa and settles the bill', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, f.local, 3_00_000);                       // ₹3,00,000 + 18% = ₹3,54,000
    const pre = await previewGstTds(f.trx, f.orgId, { billId: b.id, deductionDate: '2026-11-20' });
    assert.equal(pre.totalPaise, 6_000_00);
    const d = await recordGstTds(f.trx, f.orgId, null, { billId: b.id, deductionDate: '2026-11-20', contractRef: 'PWD/RD/42' });
    assert.equal(d.cgstPaise, 3_000_00);
    assert.equal(d.sgstPaise, 3_000_00);
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 6_000_00, 'GST TDS Payable holds exactly the deduction');
    const after = await f.trx.selectFrom('bills').select(['amount_paid', 'status', 'total']).where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(after.amount_paid), 6_000_00);
    assert.equal(after.status, 'partially_paid');
    // The supplier is owed the bill less the TDS.
    const ap = toPaiseFromSql((await sql<{ b: string }>`SELECT COALESCE(SUM(credit - debit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[CODE.AP]} AND contact_id = ${f.local}`.execute(f.trx)).rows[0].b);
    assert.equal(ap, 3_54_000_00 - 6_000_00);

    const g = await gstr7(f.trx, f.orgId, '2026-11', '2026-11-27');
    assert.equal(g.table3.length, 1);
    assert.equal(g.table3[0].gstin, LOCAL);
    assert.equal(g.table3[0].taxablePaise, 3_00_000_00);
    assert.equal(g.tieOut.differencePaise, 0, 'the return ties to the ledger');
    assert.equal(g.pending.length, 0, 'the bill is no longer waiting for a deduction');
  });
});

test('below the threshold, under the proviso, and from an unregistered supplier: refused', async () => {
  await withFixture(async (f) => {
    const small = await bill(f, f.local, 2_00_000, '2026-11-05', 'S-1');
    await assert.rejects(recordGstTds(f.trx, f.orgId, null, { billId: small.id, deductionDate: '2026-11-20' }), /₹2,50,000 or less/);
    const big = await bill(f, f.far, 4_00_000, '2026-11-05', 'K-1');
    await assert.rejects(recordGstTds(f.trx, f.orgId, null, { billId: big.id, deductionDate: '2026-11-20', placeOfSupply: '29' }), /second proviso/);
    await assert.rejects(recordGstTds(f.trx, f.orgId, null, { vendorId: f.unregistered, deductionDate: '2026-11-20', taxablePaise: 3_00_000_00 }), /registered supplier/);
    // Inter-State from Karnataka to Tamil Nadu: 2% IGST.
    const d = await recordGstTds(f.trx, f.orgId, null, { billId: big.id, deductionDate: '2026-11-20' });
    assert.equal(d.igstPaise, 8_000_00);
    assert.equal(d.cgstPaise, 0);
  });
});

test('edit and delete reverse and settle again; a filed month refuses both', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, f.local, 5_00_000, '2026-10-05');
    const d = await recordGstTds(f.trx, f.orgId, null, { billId: b.id, deductionDate: '2026-11-20', taxablePaise: 3_00_000_00 });
    await updateGstTds(f.trx, f.orgId, null, d.id, { deductionDate: '2026-11-21', taxablePaise: 4_00_000_00 });
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 8_000_00);
    assert.equal(toPaiseFromSql((await f.trx.selectFrom('bills').select('amount_paid').where('id', '=', b.id).executeTakeFirstOrThrow()).amount_paid), 8_000_00);
    await deleteGstTds(f.trx, f.orgId, null, d.id, 'entered twice');
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 0);
    assert.equal(toPaiseFromSql((await f.trx.selectFrom('bills').select('amount_paid').where('id', '=', b.id).executeTakeFirstOrThrow()).amount_paid), 0);
    const gone = await f.trx.selectFrom('deleted_documents').select('doc_type').where('org_id', '=', f.orgId).where('doc_id', '=', d.id).executeTakeFirst();
    assert.equal(gone?.doc_type, 'gst_tds');

    const again = await recordGstTds(f.trx, f.orgId, null, { billId: b.id, deductionDate: '2026-10-20', taxablePaise: 3_00_000_00 });
    await fileMonth(f, 'gstr7', '2026-10');
    await assert.rejects(updateGstTds(f.trx, f.orgId, null, again.id, { deductionDate: '2026-10-20', taxablePaise: 3_10_000_00 }), /marked filed/);
    await assert.rejects(deleteGstTds(f.trx, f.orgId, null, again.id), /marked filed/);
    await assert.rejects(recordGstTds(f.trx, f.orgId, null, { vendorId: f.local, deductionDate: '2026-10-25', taxablePaise: 3_00_000_00 }), /marked filed/);
  });
});

test('the portal file: GSTN keys, fp MMYYYY, rupees to two places; and the amendment table', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, f.local, 4_00_000, '2026-10-05');
    await recordGstTds(f.trx, f.orgId, null, { billId: b.id, deductionDate: '2026-10-15', taxablePaise: 3_33_333_33 });
    const file = gstr7PortalJson(await gstr7(f.trx, f.orgId, '2026-10', '2026-10-20'));
    assert.deepEqual(Object.keys(file), ['gstin', 'fp', 'tds']);
    assert.equal(file.gstin, TDS_REG, 'filed under the deductor\'s own registration');
    assert.equal(file.fp, '102026');
    const row = (file.tds as Record<string, number | string>[])[0];
    assert.deepEqual(Object.keys(row), ['gstin_ded', 'amt_ded', 'iamt', 'camt', 'samt']);
    assert.equal(row.amt_ded, 333333.33);
    assert.equal(row.camt, 3333.33);
    for (const v of [row.amt_ded, row.iamt, row.camt, row.samt] as number[]) assert.equal(Math.round(v * 100) / 100, v, 'two decimals at most');

    // Filed, then found wrong: corrected in November's table 4, October untouched.
    await fileMonth(f, 'gstr7', '2026-10');
    assert.equal(await snapshotGstr7(f.trx, f.orgId, '2026-10'), 1);
    const d = await f.trx.selectFrom('gst_tds_deductions').select('id').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    await assert.rejects(amendGstTds(f.trx, f.orgId, null, d.id, { date: '2026-10-28', taxablePaise: 3_50_000_00 }), /later return/);
    const a = await amendGstTds(f.trx, f.orgId, null, d.id, { date: '2026-11-04', taxablePaise: 3_50_000_00 });
    assert.equal(a.deltaPaise, 7_000_00 - 6_666_66, 'the extra tax only');
    const nov = await gstr7(f.trx, f.orgId, '2026-11', '2026-11-27');
    assert.equal(nov.table4.length, 1);
    assert.equal(nov.table4[0].originalMonth, '2026-10');
    assert.equal(nov.table4[0].originalTaxablePaise, 3_33_333_33);
    assert.equal(nov.table4[0].taxablePaise, 3_50_000_00);
    assert.equal(nov.tieOut.differencePaise, 0, 'the amendment posts in the month it is reported');
    const novFile = gstr7PortalJson(nov);
    const tdsa = (novFile.tdsa as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(tdsa), ['ogstin_ded', 'omonth', 'oamt_ded', 'gstin_ded', 'amt_ded', 'iamt', 'camt', 'samt']);
    assert.equal(tdsa.omonth, '102026');
    assert.equal(tdsa.oamt_ded, 333333.33);
    assert.equal(novFile.tds, undefined, 'no deductions of its own: the table is left out');
    const oct = await gstr7(f.trx, f.orgId, '2026-10', '2026-11-27');
    assert.equal(oct.tieOut.ledgerWithheldPaise, 6_666_66, 'October as filed');
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 7_000_00);

    await undoGstTdsAmendment(f.trx, f.orgId, null, d.id, '2026-11');
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 6_666_66);
    assert.equal((await gstr7(f.trx, f.orgId, '2026-11', '2026-11-27')).table4.length, 0);
  });
});

test('GSTR-7A, and paying the tax clears the payable', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, f.local, 3_00_000, '2026-10-05');
    await recordGstTds(f.trx, f.orgId, null, { billId: b.id, deductionDate: '2026-10-15', contractRef: 'PWD/RD/42', contractValuePaise: 9_00_000_00 });
    const cert = await gstr7aCertificate(f.trx, f.orgId, '2026-10', LOCAL);
    assert.equal(cert.deductor.gstin, TDS_REG);
    assert.equal(cert.deductee.gstin, LOCAL);
    assert.equal(cert.lines[0].contractValuePaise, 9_00_000_00);
    assert.equal(cert.totals.taxPaise, 6_000_00);

    await assert.rejects(recordGstr7Payment(f.trx, f.orgId, null, {
      period: '2026-10', paidOn: '2026-11-08', bankAccountId: f.bankId, igstPaise: 0, cgstPaise: 3_000_01, sgstPaise: 3_000_00,
    }), /more than/);
    const pay = await recordGstr7Payment(f.trx, f.orgId, null, {
      period: '2026-10', paidOn: '2026-11-08', cpin: '26113300012345', bankAccountId: f.bankId, igstPaise: 0, cgstPaise: 3_000_00, sgstPaise: 3_000_00,
    });
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 0, 'nothing left owing to the government');
    const g = await gstr7(f.trx, f.orgId, '2026-10', '2026-11-27');
    assert.deepEqual(g.table5.balance, { igstPaise: 0, cgstPaise: 0, sgstPaise: 0 });
    assert.deepEqual(g.table6.interest, { igstPaise: 0, cgstPaise: 0, sgstPaise: 0 }, 'paid before the 10th: no interest');
    assert.equal(g.table6.lateFee.cgstPaise, 17 * 25_00, 'but the return is not marked filed 17 days after the 10th: ₹25 a day each');
    assert.equal(g.tieOut.differencePaise, 0);
    await deleteWithholdingPayment(f.trx, f.orgId, null, pay.id, 'wrong challan');
    assert.equal(await balance(f, CODE.GST_TDS_PAYABLE), 6_000_00);
    const late = await gstr7(f.trx, f.orgId, '2026-10', '2026-11-27');
    assert.ok(late.table6.daysLate === 17 && late.table6.interest.cgstPaise > 0, 'unpaid after the 10th: interest runs');
    assert.equal(late.table6.lateFee.cgstPaise, 17 * 25_00, '₹25 a day each');
  });
});

test('GSTR-8: TCS by seller, the four values kept apart, tied to GST TCS Payable', async () => {
  await withFixture(async (f) => {
    await recordEcoSupply(f.trx, f.orgId, null, {
      supplierId: f.seller, entryDate: '2026-11-30', section: '52', placeOfSupply: '33',
      grossRegisteredPaise: 2_00_000_00, returnsRegisteredPaise: 10_000_00, grossUnregisteredPaise: 3_00_000_00, returnsUnregisteredPaise: 0,
    });
    // An intra-State seller, and a s.9(5) supply that is not in GSTR-8.
    await recordEcoSupply(f.trx, f.orgId, null, {
      supplierId: f.unregistered, entryDate: '2026-11-30', section: '9_5', placeOfSupply: '33', gstRatePct: 5,
      grossRegisteredPaise: 0, returnsRegisteredPaise: 0, grossUnregisteredPaise: 40_000_00, returnsUnregisteredPaise: 0,
    });
    const g = await gstr8(f.trx, f.orgId, '2026-11', '2026-11-30');
    assert.equal(g.ratePct, 0.5);
    assert.equal(g.table3.length, 1);
    const s = g.table3[0];
    assert.equal(s.netPaise, 4_90_000_00);
    assert.equal(s.igstPaise, 2_450_00, 'Maharashtra seller to Tamil Nadu: 0.5% IGST');
    assert.equal(await balance(f, CODE.GST_TCS_PAYABLE), 2_450_00);
    assert.equal(g.tieOut.differencePaise, 0);
    assert.equal(g.section95.count, 1);
    assert.equal(g.section95.cgstPaise, 1_000_00, '5% GST the operator pays itself, half CGST');
    assert.equal(await balance(f, CODE.GST_CGST), 1_000_00, 'on output CGST, not TCS');
    const file = gstr8PortalJson(g);
    assert.deepEqual(Object.keys(file), ['gstin', 'fp', 'tcs']);
    assert.equal(file.fp, '112026');
    assert.equal(file.gstin, TCS_REG);
    assert.deepEqual((file.tcs as Record<string, unknown>[])[0], {
      stin: SELLER, supR: 200000, retsupR: 10000, supU: 300000, retsupU: 0, amt: 490000, iamt: 2450, camt: 0, samt: 0,
    });

    const pay = await recordGstr8Payment(f.trx, f.orgId, null, { period: '2026-11', paidOn: '2026-12-09', bankAccountId: f.bankId, igstPaise: 2_450_00, cgstPaise: 0, sgstPaise: 0 });
    assert.ok(pay.id);
    assert.equal(await balance(f, CODE.GST_TCS_PAYABLE), 0);
  });
});

test('GSTR-8: a filed month is amended in a later one, at the original rate', async () => {
  await withFixture(async (f) => {
    const r = await recordEcoSupply(f.trx, f.orgId, null, {
      supplierId: f.seller, entryDate: '2024-07-05', section: '52', placeOfSupply: '27',
      grossRegisteredPaise: 1_00_000_00, returnsRegisteredPaise: 0, grossUnregisteredPaise: 0, returnsUnregisteredPaise: 0,
    });
    assert.equal(r.cgstPaise, 500_00, '1% before 10 July 2024: 0.5% CGST');
    await fileMonth(f, 'gstr8', '2024-07');
    assert.equal(await snapshotGstr8(f.trx, f.orgId, '2024-07'), 1);
    await assert.rejects(updateEcoSupply(f.trx, f.orgId, null, r.id, {
      supplierId: f.seller, entryDate: '2024-07-05', section: '52', placeOfSupply: '27',
      grossRegisteredPaise: 1_20_000_00, returnsRegisteredPaise: 0, grossUnregisteredPaise: 0, returnsUnregisteredPaise: 0,
    }), /marked filed/);
    await assert.rejects(deleteEcoSupply(f.trx, f.orgId, null, r.id), /marked filed/);
    const a = await amendEcoSupply(f.trx, f.orgId, null, r.id, {
      date: '2024-08-12', grossRegisteredPaise: 1_20_000_00, returnsRegisteredPaise: 0, grossUnregisteredPaise: 0, returnsUnregisteredPaise: 0,
    });
    assert.equal(a.deltaPaise, 200_00, 'the extra ₹20,000 at the original 1%');
    const aug = await gstr8(f.trx, f.orgId, '2024-08', '2024-08-31');
    assert.equal(aug.table4.length, 1);
    const tcsa = (gstr8PortalJson(aug).tcsa as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(tcsa), ['ofp', 'ostin', 'stin', 'supR', 'retsupR', 'supU', 'retsupU', 'amt', 'iamt', 'camt', 'samt']);
    assert.equal(tcsa.ofp, '072024');
    assert.equal(tcsa.amt, 120000);
    assert.equal(aug.tieOut.differencePaise, 0);
  });
});
