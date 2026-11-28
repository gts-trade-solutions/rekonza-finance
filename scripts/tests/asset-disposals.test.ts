// Status review 7, item 9: the asset disposal workflow, as the auditors test it.
//
//   Add an asset, depreciate it for some months, then dispose of it each way —
//   sold by tax invoice, sold into a bank, scrapped, part of it — and expect:
//   depreciation to the day before it left posted first, pro rata; one clear
//   disposal entry; GST on an invoiced sale; the asset shown Disposed and out
//   of later runs; Undo with a reason reversing it all; a Disposals report and
//   the Schedule III note that tie to the ledger; the Income-tax block reduced
//   by the sale (section 43(6)); and disposal approval when it is switched on.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/asset-disposals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import {
  addAsset, approveDisposal, assetRegister, assetSchedule, depreciationFor, disposalsReport, disposeAsset, ensureAssetClasses,
  itDepreciation, listAssetClasses, previewDepreciation, rejectDisposal, runDepreciation, setDisposalApproval, splitAsset,
  undoDisposal,
} from '../../lib/server/services/fixed-assets';
import { deleteAsset } from '../../lib/server/services/accountant-changes';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; bankLedger: number; bankId: number;
  customer: number; cls: Record<string, number>; maker: number; checker: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Disposals Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Works', state_code: '33', is_primary: 1, gstin: '33AAAAA0000A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await setBooksStartDate(trx, orgId, '2026-04-01');
      await ensureAssetClasses(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, name: 'Current account', kind: 'bank', ledger_account_id: acc[CODE.BANK_DEFAULT],
      } as never).executeTakeFirstOrThrow()).insertId);
      const user = async (email: string, role: 'admin' | 'accountant') =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name: email, email, role, is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
      const classes = await listAssetClasses(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Used Machinery Traders', state_code: '33', gst_treatment: 'registered', gstin: '33BBBBB0000B1Z5',
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankLedger: acc[CODE.BANK_DEFAULT], bankId, customer,
        cls: Object.fromEntries(classes.map((c) => [c.name, Number(c.id)])),
        maker: await user(`maker-${orgId}@t.in`, 'accountant'), checker: await user(`checker-${orgId}@t.in`, 'admin'),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function balance(f: Fixture, code: string, to = '2099-12-31') {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.org_id = ${f.orgId} AND a.code = ${code} AND l.entry_date <= ${to}`.execute(f.trx);
  return Math.round(Number(rows[0].v) * 100);
}

async function entryLines(f: Fixture, entryId: number) {
  const { rows } = await sql<{ code: string; debit: string; credit: string }>`
    SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(f.trx);
  return rows.map((r) => ({ code: r.code, debit: Math.round(Number(r.debit) * 100), credit: Math.round(Number(r.credit) * 100) }));
}

/** A machine costing ₹6,00,000, SLM over 10 years, 5% residual, in use from 1 April, depreciated to 31 August. */
async function machine(f: Fixture, name = 'CNC lathe', cost = 6_00_000_00) {
  const a = await addAsset(f.trx, f.orgId, null, {
    branchId: f.branchId, classId: f.cls['Plant & Machinery'], name, acquiredOn: '2026-04-01', putToUseOn: '2026-04-01',
    costPaise: cost, usefulLifeYears: 10, hsnSac: '8458', itcClaimedPaise: Math.round(cost * 0.18),
    source: { kind: 'paid', fromAccountId: f.bankLedger },
  });
  for (const m of ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31']) await runDepreciation(f.trx, f.orgId, null, f.branchId, m);
  return a.id;
}

const slm = (cost: number) => ({ costPaise: cost, residualPaise: Math.round(cost * 0.05), lifeYears: 10, method: 'slm' as const, putToUseOn: '2026-04-01' });

test('sold by tax invoice: depreciation to the day before first, one disposal entry, GST, Disposed, out of later runs', async () => {
  await withFixture(async (f) => {
    const id = await machine(f);
    // Five monthly runs, each rounded to the paisa.
    const charged = -(await balance(f, CODE.ACCUMULATED_DEPRECIATION));
    assert.ok(Math.abs(charged - depreciationFor(slm(6_00_000_00), '2026-04-01', '2026-08-31', 0).amountPaise) <= 5);

    // Not before the last run.
    await assert.rejects(disposeAsset(f.trx, f.orgId, null, id, { date: '2026-08-20', kind: 'scrapped' }), /charged up to 2026-08-31/);
    const r = await disposeAsset(f.trx, f.orgId, null, id, {
      date: '2026-09-16', kind: 'sold', proceedsVia: 'invoice', customerId: f.customer, salePaise: 5_00_000_00, gstRatePct: 18,
    });
    // 1 to 15 September: fifteen days, pro rata, posted first and on the 15th.
    const catchUp = depreciationFor(slm(6_00_000_00), '2026-09-01', '2026-09-15', charged).amountPaise;
    assert.equal(r.catchUpPaise, catchUp);
    assert.ok(r.depreciationEntryId && r.entryId && r.depreciationEntryId < r.entryId, 'the depreciation entry posts before the disposal');
    const { rows: [dep] } = await sql<{ d: string }>`SELECT DATE_FORMAT(entry_date, '%Y-%m-%d') d FROM journal_entries WHERE id = ${r.depreciationEntryId}`.execute(f.trx);
    assert.equal(dep.d, '2026-09-15', 'dated the day before it left');

    // One entry: Dr Accumulated Depreciation, Dr Disposal Clearing (the invoice), Cr cost, gain or loss.
    const acc = charged + catchUp;
    const gain = 5_00_000_00 + acc - 6_00_000_00;
    assert.equal(r.accumulatedPaise, acc);
    assert.equal(r.gainPaise, gain);
    const lines = await entryLines(f, r.entryId!);
    assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [
      [CODE.ACCUMULATED_DEPRECIATION, acc, 0],
      [CODE.ASSET_DISPOSAL, 5_00_000_00, 0],
      [CODE.PLANT_MACHINERY, 0, 6_00_000_00],
      gain >= 0 ? [CODE.PROFIT_ON_ASSET_SALE, 0, gain] : [CODE.LOSS_ON_ASSET_SALE, -gain, 0],
    ]);

    // GST on the sale of a used asset: 18% CGST + SGST on the invoice, not less than the section 18(6) minimum.
    assert.equal(r.invoiceTaxPaise, 90_000_00);
    // Credit of 1,08,000 was taken; sold in the second quarter: at least 90% of it, 97,200, is due — 7,200 short.
    assert.equal(r.minimumTaxPaise, 97_200_00);
    assert.equal(r.shortTaxPaise, 7_200_00);
    const inv = await f.trx.selectFrom('invoices').select(['cgst', 'sgst', 'subtotal', 'status']).where('id', '=', r.invoiceId!).executeTakeFirstOrThrow();
    assert.equal(Number(inv.cgst) + Number(inv.sgst), 90_000);
    assert.equal(await balance(f, CODE.ASSET_DISPOSAL), 0, 'the clearing account empties');
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), 0);
    assert.equal(await balance(f, CODE.ACCUMULATED_DEPRECIATION), 0);

    // Disposed, with its date, proceeds and gain; and out of the next run.
    const [reg] = (await assetRegister(f.trx, f.orgId, '2026-10-31')).filter((x) => x.id === String(id));
    assert.equal(reg.status, 'disposed');
    assert.equal(reg.disposedOn, '2026-09-16');
    assert.equal((await previewDepreciation(f.trx, f.orgId, f.branchId, '2026-10-31')).totalPaise, 0, 'a disposed asset leaves later runs');

    // The Disposals report ties to the ledger.
    const rep = await disposalsReport(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    assert.equal(rep.rows.length, 1);
    assert.equal(rep.rows[0].proceedsPaise, 5_00_000_00);
    assert.equal(rep.rows[0].gstPaise, 90_000_00);
    assert.equal(rep.rows[0].gainPaise, gain);
    assert.equal(rep.ledger.netGainPaise, gain);
    assert.ok(rep.ties);

    // The Schedule III note: added and disposed of in the year, nothing at the close; every tie holds.
    const sch = await assetSchedule(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    const pm = sch.rows.find((x) => x.label === 'Plant & Machinery')!;
    assert.equal(pm.additionsPaise, 6_00_000_00);
    assert.equal(pm.disposalsPaise, 6_00_000_00);
    assert.equal(pm.grossClosingPaise, 0);
    assert.equal(pm.depForYearPaise, acc);
    assert.equal(pm.depOnDisposalsPaise, acc);
    assert.equal(pm.depClosingPaise, 0);
    assert.ok(sch.ties.every((t) => t.differencePaise === 0), JSON.stringify(sch.ties));

    // Income tax: the sale comes out of the block (section 43(6)); the block is then empty.
    const [blk] = (await itDepreciation(f.trx, f.orgId, 2026)).filter((b) => b.block.startsWith('Plant'));
    assert.equal(blk.additionsFullPaise, 6_00_000_00);
    assert.equal(blk.salesPaise, 5_00_000_00);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('sold into a bank without an invoice, and scrapped: the bank is debited, a scrap is a loss of the written-down value', async () => {
  await withFixture(async (f) => {
    const a = await machine(f, 'Compressor', 2_00_000_00);
    const bankBefore = await balance(f, CODE.BANK_DEFAULT);
    const r = await disposeAsset(f.trx, f.orgId, null, a, { date: '2026-09-01', kind: 'sold', proceedsVia: 'bank', bankAccountId: f.bankId, salePaise: 1_50_000_00 });
    assert.equal(r.invoiceId, null);
    assert.equal(r.catchUpPaise, 0, 'disposed the day after the last run: nothing more to charge');
    assert.equal(await balance(f, CODE.BANK_DEFAULT) - bankBefore, 1_50_000_00);
    const lines = await entryLines(f, r.entryId!);
    assert.ok(lines.some((l) => l.code === CODE.BANK_DEFAULT && l.debit === 1_50_000_00));

    const b = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Computers & Peripherals'], name: 'Old server', acquiredOn: '2026-04-01', putToUseOn: '2026-04-01',
      costPaise: 90_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-09-30');
    const s = await disposeAsset(f.trx, f.orgId, null, b.id, { date: '2026-10-10', kind: 'scrapped' });
    assert.equal(s.salePaise, 0);
    assert.equal(s.gainPaise, -(90_000_00 - s.accumulatedPaise), 'the whole written-down value is lost');
    const sl = await entryLines(f, s.entryId!);
    assert.ok(sl.some((l) => l.code === CODE.LOSS_ON_ASSET_SALE && l.debit === 90_000_00 - s.accumulatedPaise));
    const rep = await disposalsReport(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    assert.equal(rep.rows.length, 2);
    assert.ok(rep.ties);
    assert.equal(rep.ledger.netGainPaise, r.gainPaise + s.gainPaise);
    assert.ok((await assetSchedule(f.trx, f.orgId, '2026-04-01', '2027-03-31')).ties.every((t) => t.differencePaise === 0));
  });
});

test('part of an asset: split, the part disposed of, the rest stays in use with its share', async () => {
  await withFixture(async (f) => {
    const id = await machine(f, 'Moulding line', 10_00_000_00);
    const charged = -(await balance(f, CODE.ACCUMULATED_DEPRECIATION));
    // Dispose of 30% of it (one of its three moulds), scrapped.
    const r = await disposeAsset(f.trx, f.orgId, null, id, { date: '2026-09-11', kind: 'scrapped', partCostPaise: 3_00_000_00 });
    assert.notEqual(r.assetId, id, 'the part is an asset of its own');
    assert.equal(r.costPaise, 3_00_000_00);
    const part = await f.trx.selectFrom('fixed_assets').selectAll().where('id', '=', r.assetId).executeTakeFirstOrThrow();
    assert.equal(part.split_from_asset_id, id);
    assert.equal(part.status, 'disposed');
    const rest = (await assetRegister(f.trx, f.orgId, '2026-09-30')).find((x) => x.id === String(id))!;
    assert.equal(rest.status, 'in_use');
    assert.equal(rest.costPaise, 7_00_000_00);
    assert.equal(rest.accumulatedPaise, charged - Math.round(charged * 0.3));
    // Ledger: 7,00,000 left in Plant & Machinery; schedule ties.
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), 7_00_000_00);
    assert.ok((await assetSchedule(f.trx, f.orgId, '2026-04-01', '2027-03-31')).ties.every((t) => t.differencePaise === 0));
    // The rest keeps depreciating, on its own cost.
    const p = await previewDepreciation(f.trx, f.orgId, f.branchId, '2026-09-30');
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].amountPaise, depreciationFor(slm(7_00_000_00), '2026-09-01', '2026-09-30', rest.accumulatedPaise).amountPaise);
    // A split is not more than the asset; a split asset is not deleted (nothing posted the move to take back).
    await assert.rejects(splitAsset(f.trx, f.orgId, null, id, { partCostPaise: 7_00_000_00 }), /below/);
    const fresh = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Twin pump set', acquiredOn: '2026-09-20', putToUseOn: '2026-09-20',
      costPaise: 2_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    const half = await splitAsset(f.trx, f.orgId, null, fresh.id, { partCostPaise: 1_00_000_00, name: 'Pump 2' });
    assert.equal(half.tagNo, `${fresh.tagNo}-1`);
    await assert.rejects(deleteAsset(f.trx, f.orgId, null, fresh.id), /split/);
    await assert.rejects(deleteAsset(f.trx, f.orgId, null, half.id), /split/);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('undo a disposal with a reason: entries reversed, invoice voided, asset back with the depreciation it missed', async () => {
  await withFixture(async (f) => {
    const id = await machine(f);
    // A second machine keeps the branch's runs going while the first is out.
    await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Drill press', acquiredOn: '2026-09-01', putToUseOn: '2026-09-01',
      costPaise: 1_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    const r = await disposeAsset(f.trx, f.orgId, null, id, {
      date: '2026-09-16', kind: 'sold', proceedsVia: 'invoice', customerId: f.customer, salePaise: 5_00_000_00, gstRatePct: 18,
    });
    // A run after the disposal leaves it out.
    const run = await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-10-31');
    const runLines = await f.trx.selectFrom('depreciation_lines').select('asset_id').where('run_id', '=', run.runId!).execute();
    assert.ok(!runLines.some((l) => l.asset_id === id), 'the disposed asset is not in the run');
    const lathe = async () => {
      const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(amount), 0) v FROM depreciation_lines WHERE asset_id = ${id} AND reversed = 0`.execute(f.trx);
      return Math.round(Number(rows[0].v) * 100);
    };
    await assert.rejects(undoDisposal(f.trx, f.orgId, null, id, ''), /reason/);
    const u = await undoDisposal(f.trx, f.orgId, null, id, 'Buyer backed out; machine still on the floor');
    assert.ok(u.invoiceVoided);
    const inv = await f.trx.selectFrom('invoices').select('status').where('id', '=', r.invoiceId!).executeTakeFirstOrThrow();
    assert.equal(inv.status, 'void');
    const a = await f.trx.selectFrom('fixed_assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(a.status, 'in_use');
    assert.equal(a.disposed_on, null);
    // Back where it would have been: cost in the ledger, depreciation to 31 October (the branch's last run).
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), 7_00_000_00);
    const full = depreciationFor(slm(6_00_000_00), '2026-04-01', '2026-10-31', 0).amountPaise;
    assert.ok(Math.abs((await lathe()) - full) <= 5, `the lathe carries ${await lathe()}, a straight ${full}`);
    assert.equal(u.missedDepreciationPaise, depreciationFor(slm(6_00_000_00), '2026-09-01', '2026-10-31', 0).amountPaise);
    assert.equal(await balance(f, CODE.ASSET_DISPOSAL), 0);
    assert.equal(await balance(f, CODE.PROFIT_ON_ASSET_SALE), 0);
    assert.equal(await balance(f, CODE.LOSS_ON_ASSET_SALE), 0);
    // The report leaves it out and lists the undo with its reason.
    const rep = await disposalsReport(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    assert.equal(rep.rows.length, 0);
    assert.equal(rep.undone.length, 1);
    assert.match(rep.undone[0].reason ?? '', /Buyer backed out/);
    assert.ok(rep.ties);
    assert.ok((await assetSchedule(f.trx, f.orgId, '2026-04-01', '2027-03-31')).ties.every((t) => t.differencePaise === 0));
    // It can be disposed of again, and is in the next run.
    const p = await previewDepreciation(f.trx, f.orgId, f.branchId, '2026-11-30');
    assert.ok(p.lines.some((l) => l.assetId === id && l.from === '2026-11-01'), 'back in the next run, from where the branch left off');
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('disposal approval: above the amount it waits, nothing posts, the asker cannot approve, another person can', async () => {
  await withFixture(async (f) => {
    const id = await machine(f);
    await setDisposalApproval(f.trx, f.orgId, f.checker, { isActive: true, thresholdPaise: 1_00_000_00, approverRole: 'admin' });
    const before = await balance(f, CODE.PLANT_MACHINERY);
    const r = await disposeAsset(f.trx, f.orgId, f.maker, id, { date: '2026-09-10', kind: 'scrapped', reason: 'Burnt out motor' });
    assert.ok(r.pending);
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), before, 'nothing posts while it waits');
    await assert.rejects(disposeAsset(f.trx, f.orgId, f.maker, id, { date: '2026-09-10', kind: 'scrapped' }), /waiting for approval/);
    await assert.rejects(approveDisposal(f.trx, f.orgId, { userId: f.maker, role: 'admin' }, r.disposalId), /Someone else/);
    await assert.rejects(approveDisposal(f.trx, f.orgId, { userId: f.checker, role: 'accountant' }, r.disposalId), /an admin/);
    const done = await approveDisposal(f.trx, f.orgId, { userId: f.checker, role: 'admin' }, r.disposalId);
    assert.ok(!done.pending && done.entryId);
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), 0);
    const d = await f.trx.selectFrom('asset_disposals').selectAll().where('id', '=', r.disposalId).executeTakeFirstOrThrow();
    assert.equal(d.status, 'posted');
    assert.equal(d.approved_by_user_id, f.checker);

    // Below the amount, or sent back.
    const small = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Furniture & Fittings'], name: 'Chair', acquiredOn: '2026-09-01', putToUseOn: '2026-09-01',
      costPaise: 8_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    const s = await disposeAsset(f.trx, f.orgId, f.maker, small.id, { date: '2026-09-20', kind: 'scrapped' });
    assert.ok(!s.pending, 'under the threshold it posts at once');
    const big = (await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Second lathe', acquiredOn: '2026-09-01', putToUseOn: '2026-09-01',
      costPaise: 4_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    })).id;
    const p = await disposeAsset(f.trx, f.orgId, f.maker, big, { date: '2026-10-05', kind: 'scrapped' });
    assert.ok(p.pending);
    await rejectDisposal(f.trx, f.orgId, f.checker, p.disposalId, 'Still in use at Unit 2');
    const still = await f.trx.selectFrom('fixed_assets').select('status').where('id', '=', big).executeTakeFirstOrThrow();
    assert.equal(still.status, 'in_use');
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('written-down value: depreciation to the day before uses the WDV rate on what is left', async () => {
  await withFixture(async (f) => {
    const cls = f.cls['Vehicles'];
    await f.trx.updateTable('asset_classes').set({ method: 'wdv' }).where('id', '=', cls).execute();
    const a = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: cls, name: 'Delivery van', acquiredOn: '2026-04-01', putToUseOn: '2026-04-01',
      costPaise: 8_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-06-30');
    const charged = -(await balance(f, CODE.ACCUMULATED_DEPRECIATION));
    const r = await disposeAsset(f.trx, f.orgId, null, a.id, { date: '2026-07-21', kind: 'sold', proceedsVia: 'bank', bankAccountId: f.bankId, salePaise: 6_50_000_00 });
    const basis = { costPaise: 8_00_000_00, residualPaise: 40_000_00, lifeYears: 8, method: 'wdv' as const, putToUseOn: '2026-04-01' };
    assert.equal(r.catchUpPaise, depreciationFor(basis, '2026-07-01', '2026-07-20', charged).amountPaise);
    assert.equal(r.gainPaise, 6_50_000_00 + charged + r.catchUpPaise - 8_00_000_00);
    assert.ok((await disposalsReport(f.trx, f.orgId, '2026-04-01', '2027-03-31')).ties);
  });
});

test.after(async () => {
  await db.destroy();
});
