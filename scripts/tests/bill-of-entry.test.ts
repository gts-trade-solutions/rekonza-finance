// Bills of entry: customs duty to cost, import IGST to credit, counted in
// GSTR-3B 4(A)(1) and GSTR-9 6E, blocked credit kept in cost, and a void
// reversing it all.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bill-of-entry.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { recordBillOfEntry, voidBillOfEntry } from '../../lib/server/services/bill-of-entry';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr9 } from '../../lib/server/gst/gstr9';

test('a bill of entry: duty to cost, IGST to credit in 4(A)(1); blocked credit stays in cost; a void reverses it', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Import Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCB5555B1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const base = { branchId, boeDate: '2026-09-12', portCode: 'inmaa1', assessablePaise: 10_00_000_00, dutyAccountId: acc[CODE.PURCHASES], paidThroughBankAccountId: bankId };

      const a = await recordBillOfEntry(trx, orgId, null, { ...base, boeNo: '4455667', customsDutyPaise: 1_10_000_00, igstPaise: 1_99_800_00 });
      assert.equal(a.totalPaise, 3_09_800_00);
      const lines = await trx.selectFrom('journal_lines as l').innerJoin('accounts as x', 'x.id', 'l.account_id')
        .select(['x.code', 'l.debit', 'l.credit']).where('l.entry_id', '=', a.journalEntryId).orderBy('x.code').execute();
      assert.deepEqual(lines.map((l) => [l.code, Number(l.debit), Number(l.credit)]),
        [[CODE.BANK_DEFAULT, 0, 309_800], [CODE.ITC_IGST, 199_800, 0], [CODE.PURCHASES, 110_000, 0]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
      await assert.rejects(recordBillOfEntry(trx, orgId, null, { ...base, boeNo: '4455667', customsDutyPaise: 1, igstPaise: 1 }), /already recorded/);
      await assert.rejects(recordBillOfEntry(trx, orgId, null, { ...base, boeNo: '12', customsDutyPaise: 1, igstPaise: 1 }), /6 to 8 digits/);

      // Blocked credit: the IGST is a cost too.
      await recordBillOfEntry(trx, orgId, null, { ...base, boeNo: '4455668', customsDutyPaise: 0, igstPaise: 18_000_00, itcEligibility: 'ineligible' });

      const r = await gstr3b(trx, orgId, '2026-09');
      assert.equal(r.itc.importsPaise, 1_99_800_00, '4(A)(1): only the claimable one');
      assert.equal(r.itc.igstPaise, 1_99_800_00);
      assert.equal(r.itc.blockedPaise, 18_000_00);
      assert.equal((await gstr9(trx, orgId, 2026)).table6.imports.igstPaise, 1_99_800_00, 'GSTR-9 6E');

      await voidBillOfEntry(trx, orgId, null, a.id, 'Entered twice');
      assert.equal((await gstr3b(trx, orgId, '2026-09')).itc.importsPaise, 0, 'a void takes the credit back out');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
