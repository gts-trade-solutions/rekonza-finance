// Consolidation as the auditors test it (status review 7, item 1): a parent
// and an 80% subsidiary linked by hand (no PANs), the parent selling stock to
// the subsidiary that partly sells it on, a part payment between them, and the
// parent's investment against the subsidiary's share capital. Expected (AS 21 /
// Ind AS 110): inter-company balances and trade out, unrealised profit in the
// stock still held out, goodwill, non-controlling interest's share of profit
// and net assets, a balanced group balance sheet and trial balance, and the
// drill-down to a company's ledger.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sr7-consolidation.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment, receivePayment } from '../../lib/server/services/payments';
import { companyLedger, consolidatedStatements, saveGroup, setupOptions } from '../../lib/server/reports/consolidated';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function company(trx: Trx, name: string, email: string) {
  const orgId = Number((await trx.insertInto('organizations').values({ name, legal_name: name }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const acc = await accountIds(trx, orgId);
  const bank = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0', is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
  const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email, role: 'admin', password_hash: 'h' }).executeTakeFirstOrThrow()).insertId);
  const contact = async (display_name: string, kind: string) => Number((await trx.insertInto('contacts').values({ org_id: orgId, kind, display_name, state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
  const item = async (openingQty: number, openingRate: number) => Number((await trx.insertInto('items').values({
    org_id: orgId, name: 'Brake kit', sku: 'BK-1', kind: 'goods', track_inventory: 1, opening_stock_qty: String(openingQty), opening_stock_rate: String(openingRate), purchase_price: String(openingRate || 1000), sale_price: '1500',
  } as never).executeTakeFirstOrThrow()).insertId);
  return { orgId, branchId, acc, bank, userId, contact, item };
}

test('parent and 80% subsidiary: eliminations, unrealised profit, goodwill, NCI, a balanced group', async () => {
  await rolledBack(async (trx) => {
    const email = `group-${Date.now()}@example.test`;
    const p = await company(trx, 'Parent Motors Pvt Ltd', email);
    const s = await company(trx, 'Spares Sub Pvt Ltd', email);
    // Neither has a PAN: the group companies are linked by hand.
    const subInParent = await p.contact('Spares Sub (group)', 'customer');
    const parentInSub = await s.contact('Parent Motors (group)', 'vendor');
    const outsider = await s.contact('Walk-in buyer', 'customer');
    const pItem = await p.item(20, 600);
    const sItem = await s.item(0, 0);
    // Share capital ₹1,00,000 in the subsidiary on 1 April; the parent pays ₹85,000 for 80% of it.
    await postEntry(trx, { orgId: s.orgId, branchId: s.branchId, date: '2026-04-01', sourceType: 'manual', memo: 'Shares issued', lines: [
      { accountId: s.acc[CODE.BANK_DEFAULT], debit: 1_00_000_00 }, { accountId: s.acc[CODE.CAPITAL], credit: 1_00_000_00 }] });
    await postEntry(trx, { orgId: p.orgId, branchId: p.branchId, date: '2026-04-01', sourceType: 'manual', memo: 'Investment in Spares Sub', lines: [
      { accountId: p.acc[CODE.INVESTMENTS], debit: 85_000_00 }, { accountId: p.acc[CODE.CAPITAL], credit: 85_000_00 }] });
    // The parent sells 10 brake kits at ₹1,000 (its cost ₹600); the subsidiary enters the bill; sells 4 on at ₹1,500; holds 6.
    await createInvoice(trx, p.orgId, null, { branchId: p.branchId, customerId: subInParent, date: '2026-05-10', dueDate: '2026-06-10', status: 'approved', lines: [{ itemId: pItem, description: 'Brake kit', qty: 10, ratePaise: 1_000_00, gstRatePct: 0 }] } as never);
    await createBill(trx, s.orgId, null, { branchId: s.branchId, vendorId: parentInSub, vendorInvoiceNo: 'P-1', date: '2026-05-11', dueDate: '2026-06-11', status: 'open', lines: [{ itemId: sItem, description: 'Brake kit', qty: 10, ratePaise: 1_000_00, gstRatePct: 0 }] } as never);
    await createInvoice(trx, s.orgId, null, { branchId: s.branchId, customerId: outsider, date: '2026-05-20', dueDate: '2026-05-20', status: 'approved', lines: [{ itemId: sItem, description: 'Brake kit', qty: 4, ratePaise: 1_500_00, gstRatePct: 0 }] } as never);
    // Part payment of ₹4,000, recorded on both sides.
    await makePayment(trx, s.orgId, null, { branchId: s.branchId, contactId: parentInSub, date: '2026-06-01', mode: 'neft', amountPaise: 4_000_00, bankAccountId: s.bank });
    await receivePayment(trx, p.orgId, null, { branchId: p.branchId, contactId: subInParent, date: '2026-06-01', mode: 'neft', amountPaise: 4_000_00, bankAccountId: p.bank });

    // Before the set-up: added as equals, and the screen says what to do.
    const plain = await consolidatedStatements(trx, email, '2026-04-01', '2027-03-31');
    assert.equal(plain.interCompany.length, 0, 'without PANs or links nothing is found');
    assert.match(plain.notes.join(' '), /No parent is set up/);

    await saveGroup(trx, email, p.userId, {
      parentOrgId: String(p.orgId), name: 'Parent Motors group',
      members: [{ orgId: String(s.orgId), ownershipPct: 80, acquiredOn: '2026-04-01', investmentAccountId: String(p.acc[CODE.INVESTMENTS]) }],
      links: [{ orgId: String(p.orgId), contactId: String(subInParent), counterpartOrgId: String(s.orgId) }, { orgId: String(s.orgId), contactId: String(parentInSub), counterpartOrgId: String(p.orgId) }],
    });
    const opts = await setupOptions(trx, email);
    assert.equal(opts.group?.members[0].ownershipPct, 80);
    assert.equal(opts.companies.find((c) => c.orgId === String(p.orgId))!.contacts.find((c) => c.id === String(subInParent))!.groupCompanyOrgId, String(s.orgId));

    const g = await consolidatedStatements(trx, email, '2026-04-01', '2027-03-31');
    // 1. Inter-company balances and trade, both sides agreeing after the part payment.
    assert.equal(g.interCompany.length, 1);
    const pair = g.interCompany[0];
    assert.deepEqual([pair.receivablePaise, pair.counterpartPayablePaise, pair.balanceDifferencePaise], [6_000_00, 6_000_00, 0]);
    assert.deepEqual([pair.salesPaise, pair.counterpartPurchasesPaise], [10_000_00, 10_000_00]);
    assert.equal(g.totalIncome.total, 6_000_00, 'only the sale to the outsider is group income');
    assert.equal(g.assets.find((r) => r.code === CODE.AR)!.total, 6_000_00, 'only the outsider's ₹6,000 is owed to the group');
    assert.equal(g.assets.find((r) => r.code === CODE.AR)!.elimination, -6_000_00);
    assert.equal(g.liabilities.find((r) => r.code === CODE.AP)!.elimination, -6_000_00);
    // 2. Unrealised profit: 6 kits still held, bought at ₹1,000, cost the parent ₹600.
    assert.equal(g.unrealisedProfit.closingPaise, 2_400_00);
    const up = g.unrealisedProfit.closing[0];
    assert.deepEqual([up.qtyHeld, up.unitPricePaise, up.sellerUnitCostPaise, up.basis], [6, 1_000_00, 600_00, 'item']);
    assert.equal(g.assets.find((r) => r.name.startsWith('Less: unrealised profit'))!.elimination, -2_400_00);
    // Profits: parent ₹4,000 (sold 10 that cost ₹6,000), subsidiary ₹2,000; less ₹2,400 unrealised: ₹3,600.
    assert.equal(g.netProfit.by[String(p.orgId)], 4_000_00);
    assert.equal(g.netProfit.by[String(s.orgId)], 2_000_00);
    assert.equal(g.netProfit.total, 3_600_00);
    // 3. Investment ₹85,000 against 80% of ₹1,00,000 capital: goodwill ₹5,000.
    const inv = g.investments[0];
    assert.deepEqual([inv.identified, inv.investmentPaise, inv.shareCapitalPaise, inv.goodwillPaise, inv.capitalReservePaise], [true, 85_000_00, 1_00_000_00, 5_000_00, 0]);
    assert.equal(g.assets.find((r) => r.name === 'Goodwill on consolidation')!.total, 5_000_00);
    // 4. Non-controlling interest: 20% of the subsidiary's ₹2,000 profit and of its ₹1,02,000 net assets.
    assert.deepEqual([g.nci[0].pct, g.nci[0].profitSharePaise, g.nci[0].netAssetsSharePaise], [20, 400_00, 20_400_00]);
    assert.deepEqual(g.profitAttributable, { ownersPaise: 3_200_00, nciPaise: 400_00 });
    // The group balance sheet balances; so does each company's, and the consolidated trial balance.
    assert.equal(g.check.group.balanced, true, `assets ${g.check.group.assets} vs ${g.check.group.liabilitiesAndEquity}`);
    assert.ok(g.check.companies.every((c) => c.balanced && c.tbBalanced));
    assert.equal(g.totalAssets.total, g.totalLiabilities.total + g.totalEquity.total);
    assert.equal(g.trialBalance.debit.total, g.trialBalance.credit.total);
    assert.equal(g.trialBalance.debit.elimination, g.trialBalance.credit.elimination, 'the eliminations balance');
    // 5. Drill-down: the parent's receivable ledger, without moving into the company.
    const led = await companyLedger(trx, email, String(p.orgId), CODE.AR, '2026-04-01', '2027-03-31');
    assert.equal(led.company, 'Parent Motors Pvt Ltd');
    assert.equal(led.closingPaise, 6_000_00);
    await assert.rejects(companyLedger(trx, 'someone-else@example.test', String(p.orgId), CODE.AR, '2026-04-01', '2027-03-31'), /cannot see/);
  });
});

test('a subsidiary selling to its parent: the minority bears its share of the unrealised profit; a mismatch is shown', async () => {
  await rolledBack(async (trx) => {
    const email = `up-${Date.now()}@example.test`;
    const p = await company(trx, 'Alpha Holdings', email);
    const s = await company(trx, 'Beta Works', email);
    const parentInSub = await s.contact('Alpha Holdings', 'customer');
    const subInParent = await p.contact('Beta Works', 'vendor');
    const sItem = await s.item(10, 500);
    const pItem = await p.item(0, 0);
    await createInvoice(trx, s.orgId, null, { branchId: s.branchId, customerId: parentInSub, date: '2026-07-01', dueDate: '2026-07-31', status: 'approved', lines: [{ itemId: sItem, description: 'Brake kit', qty: 10, ratePaise: 800_00, gstRatePct: 0 }] } as never);
    // The parent has entered only ₹7,200 of the ₹8,000 bill: 9 kits.
    await createBill(trx, p.orgId, null, { branchId: p.branchId, vendorId: subInParent, vendorInvoiceNo: 'B-1', date: '2026-07-02', dueDate: '2026-07-31', status: 'open', lines: [{ itemId: pItem, description: 'Brake kit', qty: 9, ratePaise: 800_00, gstRatePct: 0 }] } as never);
    await saveGroup(trx, email, p.userId, {
      parentOrgId: String(p.orgId), name: 'Alpha group', members: [{ orgId: String(s.orgId), ownershipPct: 60 }],
      links: [{ orgId: String(p.orgId), contactId: String(subInParent), counterpartOrgId: String(s.orgId) }, { orgId: String(s.orgId), contactId: String(parentInSub), counterpartOrgId: String(p.orgId) }],
    });
    const g = await consolidatedStatements(trx, email, '2026-04-01', '2027-03-31');
    // 9 kits held by the parent, bought at ₹800, cost Beta ₹500: ₹2,700 unrealised, all of it Beta's (upstream).
    assert.equal(g.unrealisedProfit.closingPaise, 2_700_00);
    // Beta's profit ₹3,000; the minority's 40% of (₹3,000 − ₹2,700) = ₹120.
    assert.equal(g.nci[0].profitSharePaise, 120_00);
    // The ₹800 not yet billed is shown, not hidden.
    assert.equal(g.interCompany[0].tradeDifferencePaise, 800_00);
    assert.equal(g.unreconciledPaise, 800_00);
    // No investment account: the screen says what to map.
    assert.equal(g.investments[0].identified, false);
    assert.match(g.notes.join(' '), /name the investment account in Group set-up/);
  });
});

test.after(() => db.destroy());
