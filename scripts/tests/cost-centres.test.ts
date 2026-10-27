// Cost centres: on income and expense lines only, kept through reversals, and a P&L by centre that adds up.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/cost-centres.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { postManualJournal, reverseJournal } from '../../lib/server/services/journals';
import { profitAndLoss } from '../../lib/server/reports/statements';
import { costCentrePnl, saveCostCentre } from '../../lib/server/services/cost-centres';

test('a document\'s centre falls on its income and expense; a journal line names its own; the columns make the P&L', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Centres Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const party = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'both', display_name: 'Party', state_code: '33', gst_treatment: 'registered', gstin: '33AABCP1234Q1Z5' } as never).executeTakeFirstOrThrow()).insertId);
      const north = await saveCostCentre(trx, orgId, { code: 'north', name: 'North depot', category: 'Depot' });
      const south = await saveCostCentre(trx, orgId, { code: 'SOUTH', name: 'South depot', category: 'Depot' });
      await assert.rejects(saveCostCentre(trx, orgId, { code: 'NORTH', name: 'Again' }), /already has the code/);

      const inv = await createInvoice(trx, orgId, null, {
        branchId, customerId: party, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved', costCentreId: north,
        lines: [{ description: 'Service', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
      });
      const invLines = await trx.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id').innerJoin('accounts as a', 'a.id', 'l.account_id')
        .select(['a.type', 'l.cost_centre_id']).where('e.source_type', '=', 'invoice').where('e.source_id', '=', inv.id).execute();
      assert.ok(invLines.filter((l) => l.type === 'income').every((l) => l.cost_centre_id === north), 'income carries the centre');
      assert.ok(invLines.filter((l) => l.type !== 'income' && l.type !== 'expense').every((l) => l.cost_centre_id === null), 'receivable and GST carry none');

      await createBill(trx, orgId, null, {
        branchId, vendorId: party, vendorInvoiceNo: 'P-1', date: '2026-06-02', dueDate: '2026-07-02', status: 'open', costCentreId: south,
        lines: [{ description: 'Repairs', qty: 1, ratePaise: 3_000_00, gstRatePct: 0 }],
      } as never);
      const je = await postManualJournal(trx, orgId, null, {
        branchId, date: '2026-06-03', memo: 'Rent split',
        lines: [
          { accountId: acc[CODE.RENT], debitPaise: 2_000_00, costCentreId: north },
          { accountId: acc[CODE.RENT], debitPaise: 1_000_00, costCentreId: south },
          { accountId: acc[CODE.CASH], creditPaise: 3_000_00, costCentreId: north },
        ],
      });
      const cash = await trx.selectFrom('journal_lines').select('cost_centre_id').where('entry_id', '=', je.id).where('account_id', '=', acc[CODE.CASH]).executeTakeFirstOrThrow();
      assert.equal(cash.cost_centre_id, null, 'a centre named on a balance-sheet line is dropped');

      const cols = await costCentrePnl(trx, orgId, '2026-06-01', '2026-06-30');
      const by = (code: string) => cols.find((c) => c.code === code)!;
      assert.deepEqual([by('NORTH').incomePaise, by('NORTH').expensePaise], [10_000_00, 2_000_00]);
      assert.equal(by('SOUTH').expensePaise, 4_000_00);
      const pl = await profitAndLoss(trx, orgId, '2026-06-01', '2026-06-30');
      const total = cols.reduce((t, c) => t + c.netPaise, 0);
      assert.equal(total, pl.totalIncome - pl.totalExpense, 'the centres and the unallocated make the whole P&L');

      await reverseJournal(trx, orgId, null, je.id);
      const after = await costCentrePnl(trx, orgId, '2026-06-01', '2026-06-30');
      assert.equal(after.find((c) => c.code === 'NORTH')!.expensePaise, 0, 'the reversal carries the centre back out');

      await saveCostCentre(trx, orgId, { id: south, code: 'SOUTH', name: 'South depot', isActive: false });
      await assert.rejects(postManualJournal(trx, orgId, null, {
        branchId, date: '2026-06-04', memo: 'x',
        lines: [{ accountId: acc[CODE.RENT], debitPaise: 100, costCentreId: south }, { accountId: acc[CODE.CASH], creditPaise: 100 }],
      }), /no longer in use/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
