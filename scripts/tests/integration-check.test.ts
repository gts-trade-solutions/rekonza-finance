// Status review 7, item 14: payroll and inventory integration with the
// general ledger — the integration check, and payroll imported from another
// system.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/integration-check.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry, verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createEmployee } from '../../lib/server/payroll/employees';
import { postRun, prepareRun, reopenRun } from '../../lib/server/payroll/payroll';
import { payStatutory, statutoryRegister } from '../../lib/server/payroll/statutory-dues';
import { paySalaries } from '../../lib/server/payroll/salary-payments';
import { recordSalaryChallan } from '../../lib/server/payroll/salary-tds';
import { importPayroll, reverseImport } from '../../lib/server/payroll/payroll-import';
import { integrationCheck, inventoryVsLedger, payrollVsLedger } from '../../lib/server/services/integration-check';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { switchToPerpetual, trueUpStock } from '../../lib/server/services/stock-ledger';
import { stockPosition } from '../../lib/server/reports/stock';

const R = (rupees: number) => Math.round(rupees * 100);

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; customerId: number; vendorId: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Integration Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Pune', state_code: '27', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '27', gst_treatment: 'registered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', sku: 'BP-1', hsn_sac: '8708', uqc: 'NOS', sale_price: '200.0000', purchase_price: '120.0000', gst_rate_pct: 18,
        track_inventory: 1, opening_stock_qty: '10', opening_stock_rate: '100.0000', sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      for (const [code, basic] of [['E1', 20_000], ['E2', 12_000]] as const) {
        await createEmployee(trx, orgId, { branchId, code, name: `Employee ${code}`, dateOfJoining: '2025-01-01' }, { basic: R(basic), da: 0, hra: R(basic * 0.4), special: R(3_000), other: 0 });
      }
      await fn({ trx, orgId, branchId, bankId, acc, customerId: await mk({ kind: 'customer', display_name: 'Garage' }), vendorId: await mk({ kind: 'vendor', display_name: 'Supplier' }), itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('payroll vs GL: runs, imports, dues paid and salaries paid all tie; a stray journal is found and named', async () => {
  await withFixture(async (f) => {
    const runs: number[] = [];
    for (const m of ['2026-04', '2026-05', '2026-06']) {
      const id = await prepareRun(f.trx, f.orgId, null, m);
      await postRun(f.trx, f.orgId, null, id);
      runs.push(id);
    }
    // May reopened and posted again: the check reads the run's entries net of the reversal.
    await reopenRun(f.trx, f.orgId, null, runs[1], 'correct days');
    await postRun(f.trx, f.orgId, null, runs[1]);
    await paySalaries(f.trx, f.orgId, null, runs[0], { bankAccountId: f.bankId, date: '2026-05-01', employeeIds: null });
    const { dues } = await statutoryRegister(f.trx, f.orgId, '2026-04', '2026-04');
    for (const d of dues) await payStatutory(f.trx, f.orgId, null, { component: d.component, period: '2026-04', amountPaise: d.balancePaise, date: '2026-05-14', bankAccountId: f.bankId });

    // July's payroll ran in another system and was imported, paid the same day.
    const rows = [
      { code: 'X1', name: 'Contract staff', department: 'Stores', basicPaise: R(15_000), hraPaise: R(6_000), otherPaise: R(4_000), grossPaise: R(25_000), pfEmployeePaise: R(1_800), pfEmployerPaise: R(1_950), esiEmployeePaise: 0, esiEmployerPaise: 0, ptPaise: R(200), lwfEmployeePaise: 0, lwfEmployerPaise: 0, tdsPaise: R(500), advancePaise: R(1_000), netPaise: R(21_500) },
    ];
    const bad = await importPayroll(f.trx, f.orgId, null, { month: '2026-07', rows: [{ ...rows[0], netPaise: R(21_000) }] }, true);
    assert.match(bad.problems[0].message, /not the net pay/);
    const imp = await importPayroll(f.trx, f.orgId, null, { month: '2026-07', sourceSystem: 'greytHR', rows, paidFromBankAccountId: f.bankId, paidOn: '2026-07-31' }, false);
    assert.ok(imp.posted && imp.importId);
    const again = await importPayroll(f.trx, f.orgId, null, { month: '2026-07', rows }, true);
    assert.ok(again.problems.some((p) => /already imported/.test(p.message)), 'the same month twice is refused');
    const twice = await importPayroll(f.trx, f.orgId, null, { month: '2026-04', rows }, true);
    assert.ok(twice.problems.some((p) => /already run here/.test(p.message)), 'a month run here is not imported as well');
    // Its dues are payable like a run's.
    const july = (await statutoryRegister(f.trx, f.orgId, '2026-07', '2026-07')).dues.find((d) => d.component === 'pf')!;
    assert.equal(july.duePaise, R(3_750));
    // TDS for April deposited by challan.
    const aprTds = (await f.trx.selectFrom('payroll_lines').select(sql<string>`SUM(tds)`.as('t')).where('run_id', '=', runs[0]).executeTakeFirstOrThrow()).t;
    if (Number(aprTds) > 0) await recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-04', date: '2026-05-07', bsrCode: '0002390', serial: '00101', taxPaise: Math.round(Number(aprTds) * 100), bankAccountId: f.bankId });

    const c = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-07-31');
    assert.equal(c.runs.length, 4, 'three runs and one import');
    for (const r of c.runs) assert.ok(r.ok, `${r.label}: ${JSON.stringify(r.lines.filter((l) => l.differencePaise))}`);
    for (const l of c.liabilities) assert.ok(l.ok, `${l.label}: ${JSON.stringify(l)}`);
    assert.ok(c.ok);
    const sp = c.liabilities.find((l) => l.code === CODE.SALARIES_PAYABLE)!;
    assert.equal(sp.subledgerPaise, sp.ledgerPaise, 'May and June unpaid: Salaries Payable holds exactly them');
    assert.ok(sp.ledgerPaise > 0);

    // Someone journals straight into PF Payable: the check still ties, and names the entry.
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-07-15', sourceType: 'manual_journal', memo: 'PF penalty provision',
      lines: [{ accountId: f.acc[CODE.EMPLOYER_CONTRIBUTIONS], debit: R(500) }, { accountId: f.acc[CODE.PF_PAYABLE], credit: R(500) }],
    });
    const c2 = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-07-31');
    const pf = c2.liabilities.find((l) => l.code === CODE.PF_PAYABLE)!;
    assert.equal(pf.otherPaise, R(500));
    assert.equal(pf.other[0].memo, 'PF penalty provision');
    assert.ok(pf.ok);
    // …but a pay run whose entry is changed behind its back does not tie.
    await sql`UPDATE payroll_lines SET pt = pt + 1, net_pay = net_pay - 1 WHERE run_id = ${runs[2]} LIMIT 1`.execute(f.trx);
    const c3 = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-07-31');
    const june = c3.runs.find((r) => r.month === '2026-06' && r.kind === 'run')!;
    assert.ok(!june.ok);
    assert.equal(june.lines.find((l) => l.code === CODE.PT_PAYABLE)!.differencePaise, -100);
    assert.ok(!c3.ok);

    // Reversing the import takes it out of the books and the check.
    await sql`UPDATE payroll_lines SET pt = pt - 1, net_pay = net_pay + 1 WHERE run_id = ${runs[2]} LIMIT 1`.execute(f.trx);
    await reverseImport(f.trx, f.orgId, null, Number(imp.importId), 'wrong month');
    const c4 = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-07-31');
    assert.equal(c4.runs.length, 3);
    assert.ok(c4.liabilities.every((l) => l.ok), JSON.stringify(c4.liabilities.filter((l) => !l.ok)));
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('inventory vs GL: periodic is a stated pass; perpetual ties after the true-up, and mid-month names the items', async () => {
  await withFixture(async (f) => {
    const buy = (date: string, qty: number, rate: number) => createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: `B-${date}`, date, dueDate: date, lines: [{ itemId: f.itemId, qty, ratePaise: R(rate) }],
    });
    const sell = (date: string, qty: number) => createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date, dueDate: date, status: 'approved', lines: [{ itemId: f.itemId, qty, ratePaise: R(200) }],
    });
    await buy('2026-04-10', 20, 130);
    await sell('2026-04-20', 5);
    const periodic = await inventoryVsLedger(f.trx, f.orgId, '2026-04-30');
    assert.equal(periodic.method, 'periodic');
    assert.equal(periodic.ledgerPaise, 0);
    assert.equal(periodic.status, 'pass_periodic', 'the ledger carries no stock on a periodic book; the statements value it');
    assert.equal(periodic.stockValuePaise, (await stockPosition(f.trx, f.orgId, '2026-04-30')).totalValuePaise);

    await switchToPerpetual(f.trx, f.orgId, null, '2026-05-01');
    await buy('2026-05-05', 10, 140);
    await sell('2026-05-15', 8);
    const mid = await inventoryVsLedger(f.trx, f.orgId, '2026-05-20');
    assert.equal(mid.method, 'perpetual');
    assert.equal(mid.ledgerPaise + mid.differencePaise, mid.stockValuePaise);
    if (mid.differencePaise !== 0) assert.ok(mid.items.some((i) => i.name === 'Brake pad'), 'the item that moved is named');
    assert.ok(mid.movements.length > 0, 'the bills and invoices that moved the account, for drill-down');
    await trueUpStock(f.trx, f.orgId, null, '2026-05-31');
    const after = await inventoryVsLedger(f.trx, f.orgId, '2026-05-31');
    assert.equal(after.differencePaise, 0);
    assert.equal(after.status, 'pass');
    assert.equal(after.lastTrueUp, '2026-05-31');

    const whole = await integrationCheck(f.trx, f.orgId, '2026-05-01', '2026-05-31');
    assert.equal(whole.inventory.status, 'pass');
    assert.equal(whole.external.payrollImport, null);
  });
});

test.after(async () => {
  await db.destroy();
});
