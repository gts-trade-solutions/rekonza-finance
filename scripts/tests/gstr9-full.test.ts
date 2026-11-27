// GSTR-9, tables 4 to 19, and its file for the offline tool (status review 7, item 11).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr9-full.test.ts
//
// The annual return restates the year from the same documents the monthly
// returns came from, so each table is checked against what was entered, the
// GL tie-out has nothing unexplained, credit of this year claimed in the next
// (a GSTR-2B "claim later" decision) is in 8C and 13, a composition dealer's
// supplies are in 16A, and the JSON carries the GSTN's keys with fp 03YYYY
// and amounts to two decimals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, type CreateInvoiceInput } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { gstr9 } from '../../lib/server/gst/gstr9';
import { gstr9PortalJson } from '../../lib/server/gst/gstr9-json';
import { setClaimDecision } from '../../lib/server/gst/itc-claims';
import { gstinCheckChar } from '../../lib/gst/withholding';

const gstin = (first14: string) => first14 + gstinCheckChar(first14);

interface Fixture { trx: Trx; orgId: number; branchId: number; buyer: number; consumer: number; vendor: number; compo: number }

test.after(() => db.destroy());

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Annual Return Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: gstin('33AABCA5555A1Z') }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({ org_id: orgId, ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        buyer: await mk({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAACB1111B1Z') }),
        consumer: await mk({ kind: 'customer', display_name: 'Walk-in', gst_treatment: 'consumer', state_code: '33' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAACS2222S1Z') }),
        compo: await mk({ kind: 'vendor', display_name: 'Composition dealer', gst_treatment: 'registered_composition', state_code: '33', gstin: gstin('33AAACC3333C1Z') }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (rupees: number, rate = 18) => ({ description: 'Brake pad set', hsnSac: '870830', qty: 1, ratePaise: rupees * 100, gstRatePct: rate });
const sell = (f: Fixture, customerId: number, date: string, lines: CreateInvoiceInput['lines']) =>
  createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId, date, dueDate: date, status: 'approved', lines });
const buy = (f: Fixture, vendorId: number, no: string, date: string, rupees: number, rate = 18) =>
  createBill(f.trx, f.orgId, null, { branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date, lines: [{ description: 'Stock', hsnSac: '870830', qty: 1, ratePaise: rupees * 100, gstRatePct: rate }] });

const twoDecimals = (v: unknown): boolean => {
  if (typeof v === 'number') return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  if (Array.isArray(v)) return v.every(twoDecimals);
  if (v && typeof v === 'object') return Object.values(v).every(twoDecimals);
  return true;
};

test('tables 4, 5, 6, 16 and 17 from the year\'s documents, and the tie-out with the ledger', async () => {
  await withFixture(async (f) => {
    const inv = await sell(f, f.buyer, '2026-05-10', [line(10_000)]);
    await sell(f, f.consumer, '2026-06-10', [line(4_000)]);
    await createCreditNote(f.trx, f.orgId, null, { branchId: f.branchId, customerId: f.buyer, date: '2026-07-10', reason: 'Rate revised', againstInvoiceId: inv.id, lines: [line(1_000)] });
    await buy(f, f.vendor, 'S/1', '2026-05-12', 6_000);
    await buy(f, f.compo, 'C/1', '2026-05-14', 2_000, 0);

    const g = await gstr9(f.trx, f.orgId, 2026, undefined, { today: '2027-01-15' });
    assert.equal(g.table4.b2b.taxablePaise, 10_000_00, '4B');
    assert.equal(g.table4.b2c.taxablePaise, 4_000_00, '4A');
    assert.equal(g.table4.creditNotes.taxablePaise, -1_000_00, '4I, negative');
    assert.equal(g.table4.total.taxablePaise, 13_000_00, '4N');
    assert.equal(g.table4.total.cgstPaise, 1_170_00);
    assert.equal(g.table6.itc3b.cgstPaise, 540_00, '6A, as GSTR-3B claimed it');
    assert.equal(g.table6.difference.cgstPaise, 0, '6J nil');
    assert.equal(g.table16.composition, 2_000_00, '16A: supplies from a composition dealer');
    // At least four digits up to ₹5 crore of turnover (Notification 78/2020-CT): 8708 or 870830.
    assert.ok(g.table17.some((h) => h.code.startsWith('8708') && h.taxablePaise === 13_000_00), '17: the HSN of what was sold, net of the note');
    assert.ok(g.tieOut.every((l) => l.unexplainedPaise === 0), 'the GL tie-out has nothing unexplained');
    assert.equal(g.table19.dueDate, '2027-12-31');

    const file = gstr9PortalJson(g) as Record<string, unknown>;
    assert.equal(file.fp, '032027', 'fp is March of the year\'s end');
    for (const k of ['table4', 'table5', 'table6', 'table7', 'table8', 'table9', 'table10', 'table14', 'table15', 'table16', 'table17', 'table18']) assert.ok(k in file, k);
    assert.equal((file.table4 as { b2b: { txval: number } }).b2b.txval, 10_000);
    assert.ok(twoDecimals(file), 'two decimals throughout');
  });
});

test('credit of the year claimed in the next (claim later) is in 8C and 13', async () => {
  await withFixture(async (f) => {
    const b = await buy(f, f.vendor, 'S/9', '2027-03-10', 10_000);
    await setClaimDecision(f.trx, f.orgId, null, { billIds: [b.id], decision: 'claim_later', claimPeriod: '2027-04' });
    const g = await gstr9(f.trx, f.orgId, 2026, undefined, { today: '2027-05-15' });
    assert.equal(g.table6.itc3b.cgstPaise, 0, 'not claimed in this year\'s GSTR-3B');
    assert.equal(g.table8.nextYear.cgstPaise, 900_00, '8C');
    assert.equal(g.table13.cgstPaise, 900_00, '13');
  });
});
