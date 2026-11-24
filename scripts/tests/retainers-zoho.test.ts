// Zoho's retainer invoice form and its Edit and Delete (services/retainers.ts,
// migration 122). Against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/retainers-zoho.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createRetainerZoho, deleteRetainer, retainerDetail, updateRetainer, type RetainerFormInput } from '../../lib/server/services/retainers';
import { receivePayment } from '../../lib/server/services/payments';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customerId: number; bankId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Retainer Zoho Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, acc, customerId, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}
test.after(() => db.destroy());

const form = (f: Fixture, lines: { description: string; amountPaise: number }[], extra: Partial<RetainerFormInput> = {}): RetainerFormInput => ({
  branchId: f.branchId, customerId: f.customerId, date: '2026-11-10', lines, reference: 'PO-77', notes: 'Thanks', terms: '50% upfront', ...extra,
});

test('a retainer of several lines: their sum is posted to unearned revenue, and every field reads back', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const r = await createRetainerZoho(trx, orgId, null, form(f, [{ description: 'Design phase', amountPaise: 300_000 }, { description: 'Build phase', amountPaise: 200_000 }]));
    assert.equal(r.totalPaise, 500_000);
    assert.equal(await balance(trx, orgId, acc[CODE.UNEARNED]), -500_000);
    const d = await retainerDetail(trx, orgId, r.id);
    assert.deepEqual(d.lines, [{ description: 'Design phase', amountPaise: 300_000 }, { description: 'Build phase', amountPaise: 200_000 }]);
    assert.equal(d.reference, 'PO-77');
    assert.equal(d.notes, 'Thanks');
    assert.equal(d.terms, '50% upfront');
    assert.equal(d.changeable, true);
  });
});

test("Zoho's empty-description message, and a line without an amount, are refused", async () => {
  await withFixture(async (f) => {
    await assert.rejects(createRetainerZoho(f.trx, f.orgId, null, form(f, [{ description: '', amountPaise: 10_000 }])), /The Description field cannot be empty\./);
    await assert.rejects(createRetainerZoho(f.trx, f.orgId, null, form(f, [{ description: '  ', amountPaise: 0 }])), /The Description field cannot be empty\./);
    await assert.rejects(createRetainerZoho(f.trx, f.orgId, null, form(f, [{ description: 'Work', amountPaise: 0 }])), /amount above zero/);
  });
});

test('Edit rewrites it in place with the same number, and the ledger is as if it were right first time', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const r = await createRetainerZoho(trx, orgId, null, form(f, [{ description: 'Design phase', amountPaise: 300_000 }]));
    const e = await updateRetainer(trx, orgId, null, r.id, form(f, [{ description: 'Design phase', amountPaise: 350_000 }, { description: 'Travel', amountPaise: 50_000 }], { reference: 'PO-78' }));
    assert.equal(e.number, r.number);
    assert.equal(e.totalPaise, 400_000);
    assert.equal(await balance(trx, orgId, acc[CODE.UNEARNED]), -400_000);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 400_000);
    const d = await retainerDetail(trx, orgId, r.id);
    assert.equal(d.reference, 'PO-78');
    assert.equal(d.lines.length, 2);
    await verifyLedgerBalances(trx, orgId);
  });
});

test('once paid, Edit and Delete are refused; before that, Delete reverses it and keeps the number as deleted', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const paid = await createRetainerZoho(trx, orgId, null, form(f, [{ description: 'Advance', amountPaise: 100_000 }]));
    await receivePayment(trx, orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-11-11', mode: 'neft', amountPaise: 100_000, bankAccountId: f.bankId,
      allocations: [{ targetType: 'retainer', targetId: paid.id, amountPaise: 100_000 }],
    });
    assert.equal((await retainerDetail(trx, orgId, paid.id)).changeable, false);
    await assert.rejects(updateRetainer(trx, orgId, null, paid.id, form(f, [{ description: 'Advance', amountPaise: 90_000 }])), /has been paid/);
    await assert.rejects(deleteRetainer(trx, orgId, null, paid.id), /has been paid/);

    const spare = await createRetainerZoho(trx, orgId, null, form(f, [{ description: 'Spare', amountPaise: 70_000 }]));
    const before = await balance(trx, orgId, acc[CODE.UNEARNED]);
    await deleteRetainer(trx, orgId, null, spare.id, 'raised in error');
    assert.equal(await balance(trx, orgId, acc[CODE.UNEARNED]), before + 70_000, 'its entry is reversed');
    const kept = await trx.selectFrom('deleted_documents').select(['number', 'doc_type', 'reason']).where('org_id', '=', orgId).where('doc_id', '=', spare.id).executeTakeFirstOrThrow();
    assert.deepEqual([kept.number, kept.doc_type, kept.reason], [spare.number, 'retainer', 'raised in error']);
    await assert.rejects(retainerDetail(trx, orgId, spare.id), /does not exist/);
    await verifyLedgerBalances(trx, orgId);
  });
});
