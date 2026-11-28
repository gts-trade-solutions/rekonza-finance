// The audit trail's edit log, IP addresses and exports, as the independent
// reviewer tested them (fixes after status review 7, item 2):
//
//   * an invoice edit (rate 500 → 550) records "line 1 · rate: 500 → 550", on
//     screen and in every export; a settings change records each setting,
//     before → after; credit notes, journals, bills and contacts the same;
//   * the IP address is recorded for every row a request writes, behind a
//     proxy and without one;
//   * an export is one line in the trail, not two;
//   * a record type written two ways is one entry in the filter.
//
// Companies (Accounts) Rules, 2014, rule 3(1): the edit log must show what was changed.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-b-audit-edit-log.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, updateInvoice, type CreateInvoiceInput } from '../../lib/server/services/sales';
import { createCreditNote, updateSalesDocument } from '../../lib/server/services/sales-documents';
import { editJournal, postManualJournal } from '../../lib/server/services/journals';
import { createBill } from '../../lib/server/services/purchases';
import { updateBill } from '../../lib/server/services/purchase-changes';
import { getPolicies, setPolicies } from '../../lib/server/services/org-settings';
import { logAudit } from '../../lib/server/audit';
import { auditRows, changeText, changesIn, typeKey } from '../../lib/server/audit-query';
import { auditExportRows, auditExportHeader } from '../../lib/server/audit-export';
import { withRequestOrigin } from '../../lib/server/request-context';
import { auditIp, clientIp } from '../../lib/server/client-ip';
import { changesOf, diffSnapshots, normalizeAuditPayload } from '../../lib/audit-changes';
import { allowOutput, outputRecorded, setOutputGuard } from '../../lib/output-guard';

interface Fixture { trx: Trx; orgId: number; userId: number; branchId: number; acc: Record<string, number>; customerId: number; vendorId: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Audit Edit Log Co' }).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Meena Auditor', email: `meena-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Velan Motors Pvt Ltd', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Tara Components', gst_treatment: 'registered', state_code: '33', pan: 'BBBBB2222B', gstin: '33BBBBB2222B1Z1',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'CN Gadget', sku: 'G-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '500.0000', purchase_price: '300.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 }).execute();
      await fn({ trx, orgId, userId, branchId, acc, customerId, vendorId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const sale = (f: Fixture, ratePaise: number): CreateInvoiceInput => ({
  branchId: f.branchId, customerId: f.customerId, date: '2026-11-26', dueDate: '2026-12-26',
  status: 'approved', lines: [{ itemId: f.itemId, qty: 1, ratePaise, gstRatePct: 18 }],
});

/** The last audit row the fixture wrote, as the screen and the export read it. */
async function lastRow(f: Fixture) {
  const r = await f.trx.selectFrom('audit_log').selectAll().where('org_id', '=', f.orgId).orderBy('id', 'desc').executeTakeFirstOrThrow();
  return { row: r, changes: changesIn(r.payload) };
}

// ── The diff itself ─────────────────────────────────────────────────────────

test('two document snapshots give header fields and line fields that moved, and nothing the save itself moves', () => {
  const before = {
    invoice: { id: 7, number: 'INV/26-27/0007', total: '590.0000', journal_entry_id: 11, updated_at: '2026-11-28T08:00:00.000Z', invoice_date: '2026-11-26T00:00:00.000Z' },
    lines: [{ id: 1, invoice_id: 7, line_no: 1, description: 'CN Gadget', qty: '1.000000', rate: '500.0000', gst_rate_pct: '18.00', created_at: '2026-11-28T08:00:00.000Z' }],
  };
  const after = {
    invoice: { id: 7, number: 'INV/26-27/0007', total: '649.0000', journal_entry_id: 12, updated_at: '2026-11-28T08:05:00.000Z', invoice_date: '2026-11-26' },
    lines: [
      { id: 9, invoice_id: 7, line_no: 1, description: 'CN Gadget', qty: '1', rate: '550.0000', gst_rate_pct: '18', created_at: '2026-11-28T08:05:00.000Z' },
      { id: 10, invoice_id: 7, line_no: 2, description: 'Fitting', qty: '2', rate: '100.0000', gst_rate_pct: '18', created_at: '2026-11-28T08:05:00.000Z' },
    ],
  };
  const d = diffSnapshots(before, after);
  assert.deepEqual(d['line 1 · rate'], { from: '500', to: '550' });
  assert.deepEqual(d.total, { from: '590', to: '649' });
  assert.deepEqual(d['line 2 (added)'], { from: null, to: 'Fitting, qty 2, rate 100' });
  for (const k of Object.keys(d)) assert.doesNotMatch(k, /(^|· )(id|journal entry id|journal_entry_id|updated_at|created_at|invoice_date)$/, `${k} is not a change anyone made`);
  assert.equal(d['line 1 · qty'], undefined, '1.000000 and 1 are the same quantity');
});

test('a settings change stored as { changes: { before, after } } reads as each setting, before → after (and old rows read so too)', () => {
  const payload = { changes: { before: { cashLimits: 'warn', controls: { changeReasons: false } }, after: { cashLimits: 'block', controls: { changeReasons: false } } } };
  // An old row, written before this fix, reads correctly.
  assert.deepEqual(changesOf(JSON.stringify(payload)), { 'cash limits': { from: 'warn', to: 'block' } });
  // A new row stores the flat map, with the snapshots kept beside it.
  const stored = normalizeAuditPayload(payload) as { changes: Record<string, unknown>; before: unknown; after: unknown };
  assert.deepEqual(stored.changes, { 'cash limits': { from: 'warn', to: 'block' } });
  assert.ok(stored.before && stored.after);
  assert.equal(changeText(changesOf(stored)), 'cash limits: warn → block');
  // The flat map callers already wrote is left alone.
  assert.deepEqual(changesOf({ changes: { rate: { from: 450, to: 500 } } }), { rate: { from: 450, to: 500 } });
});

// ── The edit paths ──────────────────────────────────────────────────────────

test('an invoice edit, rate 500 → 550: the trail and the export show line 1 · rate 500 → 550', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, f.userId, sale(f, 50_000));
    const made = await updateInvoice(f.trx, f.orgId, f.userId, inv.id, sale(f, 55_000));
    // As PUT /api/invoices/[id] records it.
    await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: f.userId, actorName: 'Meena Auditor', action: 'update', targetType: 'invoice', targetId: inv.id,
      targetLabel: made.number, detail: `Edited ${made.number}`, payload: { before: made.before, after: made.after } });
    const { changes } = await lastRow(f);
    assert.ok(changes, 'the edit carries its changes');
    assert.deepEqual(changes!['line 1 · rate'], { from: '500', to: '550' });
    assert.deepEqual(changes!.total, { from: '590', to: '649' });
    assert.equal(changes!['line 1 · qty'], undefined);
    const { rows } = await auditExportRows(f.trx, f.orgId, { action: 'update' }, true);
    const cell = rows[0][auditExportHeader(true).indexOf('Fields changed (old → new)')];
    assert.match(cell, /line 1 · rate: 500 → 550/);
    assert.match(cell, /total: 590 → 649/);
  });
});

test('a credit note, a manual journal and a bill edited: each records what moved', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, f.userId, sale(f, 100_000));
    const cnInput = { branchId: f.branchId, customerId: f.customerId, date: '2026-11-27', reason: 'Damaged', againstInvoiceId: inv.id, lines: [{ itemId: f.itemId, qty: 1, ratePaise: 100_000, gstRatePct: 18 }] };
    const cn = await createCreditNote(f.trx, f.orgId, f.userId, cnInput);
    const cnEdit = await updateSalesDocument(f.trx, f.orgId, f.userId, cn.id, { kind: 'credit-note', input: { ...cnInput, lines: [{ ...cnInput.lines[0], ratePaise: 50_000 }] } });
    assert.deepEqual(changesOf({ before: cnEdit.before, after: cnEdit.after })!['line 1 · rate'], { from: '1000', to: '500' });

    const j = await postManualJournal(f.trx, f.orgId, f.userId, { branchId: f.branchId, date: '2026-11-20', memo: 'Owner brought cash', lines: [
      { accountId: f.acc[CODE.BANK_DEFAULT], debitPaise: 500_000 }, { accountId: f.acc[CODE.CAPITAL], creditPaise: 500_000 },
    ] });
    const jEdit = await editJournal(f.trx, f.orgId, f.userId, j.id, { branchId: f.branchId, date: '2026-11-20', memo: 'Owner brought cash', lines: [
      { accountId: f.acc[CODE.BANK_DEFAULT], debitPaise: 700_000 }, { accountId: f.acc[CODE.CAPITAL], creditPaise: 700_000 },
    ] });
    const jc = changesOf({ before: jEdit.before, after: jEdit.after })!;
    assert.deepEqual(jc['line 1 · debit'], { from: '5000', to: '7000' });
    assert.deepEqual(jc['line 2 · credit'], { from: '5000', to: '7000' });

    const bill = await createBill(f.trx, f.orgId, f.userId, { branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'T-101', date: '2026-11-10', dueDate: '2026-11-10', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 30_000 }] });
    const bEdit = await updateBill(f.trx, f.orgId, f.userId, bill.id, { branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'T-101', date: '2026-11-10', dueDate: '2026-11-10', lines: [{ itemId: f.itemId, qty: 12, ratePaise: 30_000 }] });
    assert.deepEqual(changesOf({ before: bEdit.before, after: bEdit.after })!['line 1 · qty'], { from: '10', to: '12' });
  });
});

test('Settings → Policies, cash limits Warn → Block: the setting, before → after', async () => {
  await withFixture(async (f) => {
    const before = await getPolicies(f.trx, f.orgId);
    const after = await setPolicies(f.trx, f.orgId, f.userId, { cashLimits: 'block' });
    // As PUT /api/settings/policies records it.
    await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: f.userId, actorName: 'Meena Auditor', action: 'update', targetType: 'organization', targetId: f.orgId,
      targetLabel: 'Policies', detail: 'Policies changed: cashLimits', payload: { changes: { before, after } } });
    const { changes } = await lastRow(f);
    assert.deepEqual(changes, { 'cash limits': { from: 'warn', to: 'block' } });
  });
});

// ── IP addresses ────────────────────────────────────────────────────────────

test('the IP address: recorded for every row a request writes, behind nginx and without a proxy', async () => {
  const req = (h: Record<string, string>) => new Request('http://x/api', { headers: h });
  const hops = process.env.TRUSTED_PROXY_HOPS;
  try {
    // The live server: one nginx hop, which appends the client's address.
    process.env.TRUSTED_PROXY_HOPS = '1';
    assert.equal(auditIp(req({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
    assert.equal(auditIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })), '203.0.113.9', 'a forged first entry is not believed');
    // No proxy (TRUSTED_PROXY_HOPS=0): nothing for the sign-in allowlist, but the trail still has the connection's address.
    process.env.TRUSTED_PROXY_HOPS = '0';
    assert.equal(clientIp(req({ 'x-forwarded-for': '::ffff:127.0.0.1' })), null);
    assert.equal(auditIp(req({ 'x-forwarded-for': '::ffff:127.0.0.1' })), '127.0.0.1');
  } finally {
    if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = hops;
  }

  await withFixture(async (f) => {
    // A route that never passed auditMeta(req): the request's origin is still recorded.
    await withRequestOrigin({ ip: '203.0.113.9', userAgent: 'Mozilla/5.0 test' }, () => logAudit({
      trx: f.trx, orgId: f.orgId, actorUserId: f.userId, actorName: 'Meena Auditor', action: 'update', targetType: 'invoice', targetId: 1, detail: 'Edited',
    }));
    const { row } = await lastRow(f);
    assert.equal(row.ip, '203.0.113.9');
    assert.equal(row.user_agent, 'Mozilla/5.0 test');
    const withIp = await auditExportRows(f.trx, f.orgId, {}, true);
    assert.equal(withIp.rows[0][auditExportHeader(true).indexOf('IP address')], '203.0.113.9');
    const without = await auditExportRows(f.trx, f.orgId, {}, false);
    assert.ok(!auditExportHeader(false).includes('IP address'));
    assert.ok(!without.rows[0].includes('203.0.113.9'));
  });
});

// ── Exports and the record-type filter ──────────────────────────────────────

test('an audit-trail export is recorded once: the server records it, the download gate does not again', () => {
  const posted: boolean[] = [];
  setOutputGuard((_action, _what, recorded) => { posted.push(!recorded); return true; });
  try {
    // The audit trail's own export: GET /api/audit/export has written its line.
    assert.equal(outputRecorded(() => allowOutput('export', 'Audit trail - Co - start to 2026-11-28')), true);
    // Any other download: the gate writes the line.
    assert.equal(allowOutput('export', 'Invoices'), true);
    assert.deepEqual(posted, [false, true]);
  } finally {
    setOutputGuard(() => true);
  }
});

test('"credit-note" and "credit_note" are one record type: listed once, filtered together', async () => {
  assert.equal(typeKey('credit-note'), typeKey('credit_note'));
  await withFixture(async (f) => {
    for (const t of ['credit-note', 'credit_note', 'invoice']) {
      await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: f.userId, actorName: 'Meena Auditor', action: 'update', targetType: t, targetId: 1, detail: t });
    }
    const found = await auditRows(f.orgId, { targetType: 'credit_note' }, f.trx).select('target_type').execute();
    assert.deepEqual(found.map((r) => r.target_type).sort(), ['credit-note', 'credit_note']);
  });
});
