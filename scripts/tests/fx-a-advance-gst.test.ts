// GST on a customer advance for services (auditor check, 2026-11-28).
//
// The reviewer recorded a customer advance of ₹11,800 on Payments Received →
// Customer Advance. The tick box "The excess is an advance for services, so GST
// is due on it now" was off unless ticked, so no tax was posted and GSTR-1
// table 11A and GSTR-3B 3.1(a) left the advance out. CGST Act s.13(2) makes
// the tax due on receipt for services (goods are exempt from this since
// Notification 66/2017-CT). The receipt now has to say what the advance is for,
// and an advance for services carries its tax into the books, GSTR-1 11A (and
// its JSON `at`), 3B 3.1(a) and the tie-outs; applied to an invoice in a later
// month it moves to 11B (`txpd`) and comes off 3.1(a) so it is paid once.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-a-advance-gst.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { applyPayment, receivePayment } from '../../lib/server/services/payments';
import { PaymentInput, toPaymentInput } from '../../lib/server/payment-input';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { gstr1Report } from '../../lib/server/gst/gstr1-report';
import { gstr3bForm } from '../../lib/server/gst/gstr3b-form';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { advanceGstField, advanceProblem, defaultAdvanceFor, advanceTaxPaise } from '../../lib/gst/advance-for';
import { gstinCheckChar } from '../../lib/gst/withholding';

// A GSTIN unique to this run: branches.gstin is unique across the whole database,
// so a fixed one collides with a company an earlier test or e2e run committed.
const runGstin = (() => { const t = Date.now(); const first14 = `33ADVCE${String(t % 10000).padStart(4, '0')}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[t % 24]}1Z`; return first14 + gstinCheckChar(first14); })();

// ── The receipt form's rules ────────────────────────────────────────────────

test('a GST-registered book cannot save an advance without saying what it is for', () => {
  const base = { excessPaise: 11_800_00, foreign: false, gstRegistration: 'regular', ratePct: 18 };
  assert.match(advanceProblem({ ...base, advanceFor: null })!, /services \(GST is due on it now\) or goods/);
  assert.equal(advanceProblem({ ...base, advanceFor: 'goods' }), null);
  assert.equal(advanceProblem({ ...base, advanceFor: 'services' }), null);
  // Nothing to ask: no excess, an unregistered or composition book, or a foreign-currency receipt.
  assert.equal(advanceProblem({ ...base, excessPaise: 0, advanceFor: null }), null);
  assert.equal(advanceProblem({ ...base, gstRegistration: 'unregistered', advanceFor: null }), null);
  assert.equal(advanceProblem({ ...base, gstRegistration: 'composition', advanceFor: null }), null);
  assert.equal(advanceProblem({ ...base, foreign: true, advanceFor: null }), null);
});

test('an advance for services carries GST to the server; one for goods does not', () => {
  const base = { excessPaise: 11_800_00, foreign: false, gstRegistration: 'regular', ratePct: 18 };
  assert.deepEqual(advanceGstField({ ...base, advanceFor: 'services' }), { ratePct: 18 });
  assert.equal(advanceGstField({ ...base, advanceFor: 'goods' }), undefined);
  assert.equal(advanceGstField({ ...base, advanceFor: 'services', gstRegistration: 'unregistered' }), undefined);
  assert.equal(advanceTaxPaise(11_800_00, 18), 1_800_00);
  // A book that sells only one kind is answered in advance; one that sells both is asked.
  assert.equal(defaultAdvanceFor('services'), 'services');
  assert.equal(defaultAdvanceFor('goods'), 'goods');
  assert.equal(defaultAdvanceFor('both'), null);
  assert.equal(defaultAdvanceFor(undefined), null);
});

// ── Books, GSTR-1 and GSTR-3B agree ─────────────────────────────────────────

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; walkIn: number; karnataka: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Auditor Alpha Traders', gst_registration_type: 'regular' } as never).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: runGstin }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC Current A/c', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId),
        walkIn: await mk({ display_name: 'Walk-in Consumer TN', state_code: '33' }),
        karnataka: await mk({ display_name: 'Bengaluru client', state_code: '29' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** The receipt as the form sends it, through the route's own parsing. */
const receiveAdvance = (f: Fixture, contactId: number, date: string, rupees: number, advanceFor: 'goods' | 'services') =>
  receivePayment(f.trx, f.orgId, null, toPaymentInput(PaymentInput.parse({
    kind: 'received', branchId: String(f.branchId), contactId: String(contactId), date, mode: 'neft',
    amountPaise: rupees * 100, bankAccountId: String(f.bankId), allocations: [],
    advanceGst: advanceGstField({ excessPaise: rupees * 100, foreign: false, gstRegistration: 'regular', advanceFor, ratePct: 18 }),
  })));

const outputTaxPosted = async (f: Fixture, from: string, to: string) => {
  const r = await sql<{ n: string }>`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS n FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
     WHERE e.org_id = ${f.orgId} AND jl.account_id IN (${f.acc[CODE.GST_CGST]}, ${f.acc[CODE.GST_SGST]}, ${f.acc[CODE.GST_IGST]})
       AND e.entry_date BETWEEN ${from} AND ${to}`.execute(f.trx);
  return toPaiseFromSql(r.rows[0].n);
};

test('the ₹11,800 advance for services: posted, in GSTR-1 11A and its JSON, in 3B 3.1(a), tied to the ledger', async () => {
  await withFixture(async (f) => {
    await receiveAdvance(f, f.walkIn, '2026-10-24', 11_800, 'services');
    // An advance from another state, so 11A(2) has its own row.
    await receiveAdvance(f, f.karnataka, '2026-10-25', 5_900, 'services');
    // An advance for goods carries no tax.
    await receiveAdvance(f, f.walkIn, '2026-10-26', 2_000, 'goods');

    assert.equal(await outputTaxPosted(f, '2026-10-01', '2026-10-31'), 1_800_00 + 900_00, 'the books post the tax on receipt');

    // GSTR-1 table 11A, by place of supply and rate, intra and inter-state.
    const report = await gstr1Report(f.trx, f.orgId, '2026-10');
    const at = report.tables.at.rows.map((r) => [r.pos, r.splyType, r.ratePct, r.taxablePaise, r.cgstPaise, r.sgstPaise, r.igstPaise]);
    assert.deepEqual(at.sort(), [
      ['29', 'INTER', 18, 5_000_00, 0, 0, 900_00],
      ['33', 'INTRA', 18, 10_000_00, 900_00, 900_00, 0],
    ]);
    assert.ok(report.tieOut.ledger.every((l) => l.differencePaise === 0), 'GSTR-1 ties to the ledger head by head');

    // Its JSON, in the portal's at section.
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-10');
    assert.deepEqual([...(file.at as { pos: string }[])].sort((x, y) => x.pos.localeCompare(y.pos)), [
      { pos: '29', sply_ty: 'INTER', itms: [{ rt: 18, ad_amt: 5_000, iamt: 900, camt: 0, samt: 0, csamt: 0 }] },
      { pos: '33', sply_ty: 'INTRA', itms: [{ rt: 18, ad_amt: 10_000, iamt: 0, camt: 900, samt: 900, csamt: 0 }] },
    ]);

    // GSTR-3B 3.1(a).
    const g = await gstr3b(f.trx, f.orgId, '2026-10');
    assert.equal(g.outward.taxablePaise, 15_000_00);
    assert.deepEqual([g.outward.cgstPaise, g.outward.sgstPaise, g.outward.igstPaise], [900_00, 900_00, 900_00]);
    const form = await gstr3bForm(f.trx, f.orgId, '2026-10', { today: '2026-11-28' });
    const r31a = form.rows['3.1a'];
    assert.deepEqual([r31a.taxablePaise, r31a.cgstPaise + r31a.sgstPaise + r31a.igstPaise], [15_000_00, 2_700_00]);
  });
});

test('applied to an invoice next month, the advance moves to 11B (txpd) and comes off 3.1(a): tax paid once', async () => {
  await withFixture(async (f) => {
    const r = await receiveAdvance(f, f.walkIn, '2026-10-24', 11_800, 'services');
    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.walkIn, date: '2026-11-05', dueDate: '2026-11-05', status: 'approved',
      lines: [{ description: 'Installation service', hsnSac: '998729', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
    });
    await applyPayment(f.trx, f.orgId, null, r.id, { date: '2026-11-05', allocations: [{ targetType: 'invoice', targetId: Number(inv.id), amountPaise: 11_800_00 }] });

    const nov = await gstr1Report(f.trx, f.orgId, '2026-11');
    assert.equal(nov.tables.at.rows.length, 0, 'nothing new in 11A');
    assert.deepEqual(nov.tables.atadj.rows.map((x) => [x.pos, x.taxablePaise, x.cgstPaise, x.sgstPaise]), [['33', 10_000_00, 900_00, 900_00]]);
    assert.ok(nov.tieOut.ledger.every((l) => l.differencePaise === 0));
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-11');
    assert.equal(file.at, undefined);
    assert.deepEqual(file.txpd, [{ pos: '33', sply_ty: 'INTRA', itms: [{ rt: 18, ad_amt: 10_000, iamt: 0, camt: 900, samt: 900, csamt: 0 }] }]);

    // November's 3.1(a): the invoice's ₹1,800 less the ₹1,800 already paid in October.
    const g = await gstr3b(f.trx, f.orgId, '2026-11');
    assert.equal(g.outward.cgstPaise + g.outward.sgstPaise, 0);
    assert.equal(g.advances.adjustedTaxPaise, 1_800_00);
    assert.equal(await outputTaxPosted(f, '2026-11-01', '2026-11-30'), 0, 'the ledger agrees: the invoice tax less the advance tax taken back');
    // Across the two months the tax is paid once.
    const oct = await gstr3b(f.trx, f.orgId, '2026-10');
    assert.equal(oct.outward.cgstPaise + oct.outward.sgstPaise + g.outward.cgstPaise + g.outward.sgstPaise, 1_800_00);
  });
});

test.after(() => db.destroy());
