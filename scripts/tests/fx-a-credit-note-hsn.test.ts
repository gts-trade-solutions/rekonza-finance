// A credit note line without an HSN or SAC is caught when the note is made
// (auditor check, 2026-11-28), not only under GSTR-1's "Before you file".
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-a-credit-note-hsn.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { setPolicies } from '../../lib/server/services/org-settings';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx, registration: 'regular' | 'unregistered' = 'regular') {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'CN HSN Co', gst_registration_type: registration } as never).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: registration === 'regular' ? '33AABCC1234C1Z5' : null }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const customerId = Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind: 'customer', display_name: 'Kaveri Retail', state_code: '33', gst_treatment: 'registered', gstin: '33AAACK3333K1Z5',
  } as never).executeTakeFirstOrThrow()).insertId);
  const note = (hsnSac: string | undefined, status: 'open' | 'draft' = 'open') => createCreditNote(trx, orgId, null, {
    branchId, customerId, date: '2026-11-20', reason: 'Rate reduction', status,
    lines: [{ description: 'Rate difference', hsnSac, qty: 1, ratePaise: 400_00, gstRatePct: 18 }],
  });
  return { orgId, note };
}

test('a GST-registered book is warned when a credit note line has no HSN or SAC', async () => {
  await rolledBack(async (trx) => {
    const { note } = await book(trx);
    const r = await note(undefined);
    assert.ok(r.warnings?.some((w) => /Line 1 \(Rate difference\) has no HSN or SAC code.*Before you file/.test(w)), JSON.stringify(r.warnings));
    const ok = await note('8708');
    assert.ok(!ok.warnings?.some((w) => /HSN/.test(w)), 'a line with its code is not warned');
  });
});

test('where Settings → Items asks for six digits, an open credit note needs the code; a draft is only warned', async () => {
  await rolledBack(async (trx) => {
    const { orgId, note } = await book(trx);
    await setPolicies(trx, orgId, null, { hsn: { digits: 6 } });
    await assert.rejects(note(undefined), /no HSN or SAC code.*at least 6 digits/);
    const draft = await note(undefined, 'draft');
    assert.ok(draft.warnings?.some((w) => /no HSN or SAC/.test(w)));
    await note('870830');
  });
});

test('above ₹5 crore turnover the code is required on an open credit note', async () => {
  await rolledBack(async (trx) => {
    const { orgId, note } = await book(trx);
    await trx.updateTable('organizations').set({ aato_above_5cr: 1 }).where('id', '=', orgId).execute();
    await assert.rejects(note(undefined), /no HSN or SAC code/);
  });
});

test('a book not registered for GST files no GSTR-1 and is not asked', async () => {
  await rolledBack(async (trx) => {
    const { note } = await book(trx, 'unregistered');
    const r = await note(undefined);
    assert.ok(!r.warnings?.some((w) => /HSN/.test(w)));
  });
});

test.after(() => db.destroy());
