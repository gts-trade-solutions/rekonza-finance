// The client's latest five points (2026-11-06):
//   1. roles can be added           3. the LUT as a yes or no
//   2. domestic and international   4. an export's IGST: nil under the LUT, or paid
//   5. goods and services separately
// Each test builds its own company in a transaction that is rolled back.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/trade-profile.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { convertToInvoice, createCreditNote, createEstimate, createSalesOrder, salesOrderFromEstimate } from '../../lib/server/services/sales-documents';
import { challanFromSalesOrder, invoiceFromChallan, invoiceFromSalesOrder } from '../../lib/server/services/order-flow';
import { gstr1 } from '../../lib/server/gst/returns';
import { supplyMix } from '../../lib/server/reports/supply-mix';
import { lutPatch, tradeProfile } from '../../lib/server/services/trade-profile';
import { listCustomRoles, saveCustomRole } from '../../lib/server/services/users';
import { exportPaysIgstByDefault, exportTaxFor, exportTaxOf, isExportSupply, lutGap, type ExportProfile } from '../../lib/tax/gst';

interface Fixture { trx: Trx; orgId: number; branchId: number; local: number; overseas: number; part: number; advice: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Trade Co (temporary)' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1, gstin: '33AAAAT0000A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts of motor vehicles', gst_rate_pct: '18' },
        { org_id: orgId, code: '998311', kind: 'sac', description: 'Management consulting', gst_rate_pct: '18' },
      ]).execute();
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const item = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('items').values({ org_id: orgId, gst_rate_pct: '18', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        local: await contact({ display_name: 'TN Buyer', state_code: '33', gst_treatment: 'registered', gstin: '33BBBBB0000B1Z5' }),
        overseas: await contact({ display_name: 'Dubai Buyer', state_code: '96', gst_treatment: 'overseas' }),
        part: await item({ name: 'Brake pad', kind: 'goods', hsn_sac: '8708', sale_price: '1000.00' }),
        advice: await item({ name: 'Advisory day', kind: 'service', hsn_sac: '998311', sale_price: '10000.00' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const LUT = { lut_declared: 1, lut_arn: 'AD330426012345X', lut_valid_from: '2026-04-01', lut_valid_to: '2027-03-31' };
const declare = (f: Fixture, set: Record<string, unknown>) => f.trx.updateTable('organizations').set(set).where('id', '=', f.orgId).execute();
const sell = (f: Fixture, customerId: number, itemId: number, extra: Record<string, unknown> = {}) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId, date: '2026-08-05', dueDate: '2026-09-04', status: 'approved',
  lines: [{ itemId, qty: 2 }], ...extra,
} as never);
const head = (f: Fixture, table: 'invoices' | 'estimates' | 'sales_orders' | 'credit_notes', id: number) =>
  f.trx.selectFrom(table).select(['supply_type', 'igst']).where('id', '=', id).executeTakeFirstOrThrow()
    .then((r) => ({ type: r.supply_type, igst: Number(r.igst) }));

test('the LUT rule itself: in force on the date, or the reason it is not', () => {
  const p: ExportProfile = { lutDeclared: true, lutArn: 'AD330426012345X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31', exportIgst: 'nil_lut' };
  assert.equal(lutGap(p, '2026-08-05'), null);
  assert.match(lutGap(p, '2027-04-01') ?? '', /runs from 1 Apr 2026 to 31 Mar 2027, and this export is dated 1 Apr 2027/);
  assert.match(lutGap({ ...p, lutDeclared: false }, '2026-08-05') ?? '', /No LUT is declared/);
  assert.match(lutGap({ ...p, lutArn: null }, '2026-08-05') ?? '', /no ARN/);
  assert.equal(exportPaysIgstByDefault(p, '2026-08-05'), false, 'under the LUT');
  assert.equal(exportPaysIgstByDefault({ ...p, exportIgst: 'paid' }, '2026-08-05'), true, 'the organisation pays IGST on exports');
  assert.equal(exportPaysIgstByDefault(p, '2027-05-01'), true, 'outside the LUT');
  assert.equal(exportPaysIgstByDefault(null, '2026-08-05'), true, 'no LUT at all');
  assert.equal(isExportSupply('overseas', '33'), true);
  assert.equal(isExportSupply('registered', '96'), true);
  assert.equal(isExportSupply('sez', '33'), false, 'an SEZ supply is not an export');
  assert.deepEqual([exportTaxOf('export_with_tax'), exportTaxOf('export_lut'), exportTaxOf('inter')], [true, false, undefined]);
});

test('LUT yes: an export goes with IGST nil and keeps the ARN; it can still pay IGST by choice', async () => {
  await withFixture(async (f) => {
    await declare(f, { ...LUT, trade_scope: 'both' });
    const nil = await sell(f, f.overseas, f.part);
    assert.deepEqual(await head(f, 'invoices', nil.id), { type: 'export_lut', igst: 0 });
    const arn = await f.trx.selectFrom('invoices').select('export_lut_arn').where('id', '=', nil.id).executeTakeFirstOrThrow();
    assert.equal(arn.export_lut_arn, 'AD330426012345X');

    const paid = await sell(f, f.overseas, f.part, { exportWithTax: true });
    assert.deepEqual(await head(f, 'invoices', paid.id), { type: 'export_with_tax', igst: 360 }, '18% on ₹2,000');

    // The organisation can make IGST paid the starting point instead.
    await declare(f, { export_igst: 'paid' });
    assert.equal((await head(f, 'invoices', (await sell(f, f.overseas, f.part)).id)).type, 'export_with_tax');
    // Within India nothing changes.
    assert.equal((await head(f, 'invoices', (await sell(f, f.local, f.part)).id)).type, 'intra');
  });
});

test('LUT no: an export pays IGST, and IGST nil is refused with the reason', async () => {
  await withFixture(async (f) => {
    const paid = await sell(f, f.overseas, f.advice);
    assert.deepEqual(await head(f, 'invoices', paid.id), { type: 'export_with_tax', igst: 3600 });
    await assert.rejects(sell(f, f.overseas, f.advice, { exportWithTax: false }), /No LUT is declared for the organisation, so this export cannot go with IGST nil/);
    // A LUT on file but answered No is still a No.
    await declare(f, { ...LUT, lut_declared: 0 });
    await assert.rejects(sell(f, f.overseas, f.advice, { exportWithTax: false }), /No LUT is declared/);
    // Declared, but the invoice falls outside it.
    await declare(f, LUT);
    await assert.rejects(sell(f, f.overseas, f.advice, { exportWithTax: false, date: '2026-03-20', dueDate: '2026-04-19' }), /runs from 1 Apr 2026/);
  });
});

test('estimates, orders and their invoices, and credit notes, take the same IGST as the export', async () => {
  await withFixture(async (f) => {
    await declare(f, LUT);
    const est = await createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-08-01', expiryDate: '2026-08-31', lines: [{ itemId: f.part, qty: 2 }],
    });
    assert.equal((await head(f, 'estimates', est.id)).type, 'export_lut');

    // An order taken while exports paid IGST is invoiced with IGST, even after the default changes.
    await declare(f, { export_igst: 'paid' });
    const so = await createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-08-02', lines: [{ itemId: f.part, qty: 2 }],
    });
    assert.equal((await head(f, 'sales_orders', so.id)).type, 'export_with_tax');
    await declare(f, { export_igst: 'nil_lut' });
    const fromOrder = await invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-06', dueDate: '2026-09-05' });
    assert.deepEqual(await head(f, 'invoices', fromOrder.id), { type: 'export_with_tax', igst: 360 });

    // A credit note against it gives back the IGST it charged.
    const cn = await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-08-10', reason: 'One pad returned',
      againstInvoiceId: fromOrder.id, lines: [{ itemId: f.part, qty: 1 }],
    });
    assert.deepEqual(await head(f, 'credit_notes', cn.id), { type: 'export_with_tax', igst: 180 });
  });
});

test('the rule for every way an invoice comes: asked, from a source, as billed, or the default', () => {
  const p: ExportProfile = { lutDeclared: true, lutArn: 'AD330426012345X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31', exportIgst: 'nil_lut' };
  assert.deepEqual(exportTaxFor(p, '2026-08-05', { asked: false }), { withTax: false, refused: null, note: null });
  assert.match(exportTaxFor(p, '2027-05-01', { asked: false }).refused ?? '', /runs from/);
  assert.equal(exportTaxFor(p, '2027-05-01', { source: false }).withTax, true, 'an order under LUT invoiced after it pays IGST');
  assert.match(exportTaxFor(p, '2027-05-01', { source: false }).note ?? '', /pays IGST although the document it comes from went under the LUT/);
  assert.equal(exportTaxFor(p, '2026-08-05', { source: false }).withTax, false);
  assert.equal(exportTaxFor(null, '2026-08-05', { history: false }).withTax, false, 'imported history stays as billed');
  assert.equal(exportTaxFor({ ...p, exportIgst: 'paid' }, '2026-08-05', {}).withTax, true);
});

test('a debit note takes the IGST of the export it corrects, whatever is asked, and its LUT', async () => {
  await withFixture(async (f) => {
    await declare(f, LUT);
    const paid = await sell(f, f.overseas, f.part, { exportWithTax: true });
    const nil = await sell(f, f.overseas, f.part);
    const note = (against: number, extra: Record<string, unknown> = {}) => sell(f, f.overseas, f.part, {
      docKind: 'debit_note', againstInvoiceId: against, noteReason: 'Price revised upward', ...extra,
    });
    assert.equal((await head(f, 'invoices', (await note(paid.id, { exportWithTax: false })).id)).type, 'export_with_tax');
    // A year on, with the next LUT on file, a debit note on the old LUT export keeps the old ARN and is not refused.
    await declare(f, { lut_arn: 'AD330427099999Z', lut_valid_from: '2027-04-01', lut_valid_to: '2028-03-31' });
    const dn = await note(nil.id, { date: '2026-08-20', dueDate: '2026-09-19' });
    const kept = await f.trx.selectFrom('invoices').select(['supply_type', 'export_lut_arn']).where('id', '=', dn.id).executeTakeFirstOrThrow();
    assert.deepEqual([kept.supply_type, kept.export_lut_arn], ['export_lut', 'AD330426012345X']);
    // And the return does not call last year's LUT exports uncovered now that this year's is on file.
    const g = await gstr1(f.trx, f.orgId, '2026-08');
    assert.ok(!g.issues.some((i) => /Undertaking|LUT/.test(i.message)), g.issues.map((i) => i.message).join(' | '));
  });
});

test('an order or estimate under LUT is still invoiced when no LUT covers the date: with IGST, and a note', async () => {
  await withFixture(async (f) => {
    await declare(f, LUT);
    const est = await createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2027-03-20', expiryDate: '2027-04-30', lines: [{ itemId: f.part, qty: 2 }],
    });
    assert.equal((await head(f, 'estimates', est.id)).type, 'export_lut');
    // The order made from it keeps it while the LUT runs.
    const so = await salesOrderFromEstimate(f.trx, f.orgId, null, est.id, { date: '2027-03-25' });
    assert.equal((await head(f, 'sales_orders', so.id)).type, 'export_lut');
    // Another, invoiced in April, past the LUT: IGST paid, not refused.
    const est2 = await createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2027-03-21', expiryDate: '2027-04-30', lines: [{ itemId: f.part, qty: 2 }],
    });
    const inv = await convertToInvoice(f.trx, f.orgId, null, { type: 'estimate', id: est2.id }, { date: '2027-04-03', dueDate: '2027-05-03' });
    assert.deepEqual(await head(f, 'invoices', inv.id), { type: 'export_with_tax', igst: 360 });
  });
});

test('goods sent on a challan against an export order are invoiced with the order’s IGST', async () => {
  await withFixture(async (f) => {
    await declare(f, { ...LUT, export_igst: 'paid' });
    const so = await createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-08-02', lines: [{ itemId: f.part, qty: 2 }],
    });
    assert.equal((await head(f, 'sales_orders', so.id)).type, 'export_with_tax');
    await declare(f, { export_igst: 'nil_lut' });
    const dc = await challanFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-03' });
    const inv = await invoiceFromChallan(f.trx, f.orgId, null, dc.id, { date: '2026-08-04', dueDate: '2026-09-03' });
    assert.equal((await head(f, 'invoices', inv.id)).type, 'export_with_tax');
  });
});

test('an imported export comes in as it was billed', async () => {
  await withFixture(async (f) => {
    // No LUT on file at all: an old export billed without IGST is kept that way (the return then asks for its LUT).
    const old = await sell(f, f.overseas, f.part, { exportAsBilled: false, date: '2025-11-05', dueDate: '2025-12-05' });
    assert.deepEqual(await head(f, 'invoices', old.id), { type: 'export_lut', igst: 0 });
    const paid = await sell(f, f.overseas, f.part, { exportAsBilled: true });
    assert.equal((await head(f, 'invoices', paid.id)).type, 'export_with_tax');
  });
});

test('sales by supply: domestic and international, goods and services, each on its own line', async () => {
  await withFixture(async (f) => {
    await declare(f, LUT);
    await sell(f, f.local, f.part);                          // domestic goods ₹2,000
    await sell(f, f.local, f.advice);                        // domestic services ₹20,000
    await sell(f, f.overseas, f.part);                       // export goods under LUT ₹2,000
    await sell(f, f.overseas, f.advice, { exportWithTax: true }); // export services, IGST paid ₹20,000 + ₹3,600
    const rows = await supplyMix(f.trx, f.orgId, { from: '2026-04-01', to: '2027-03-31' });
    const by = Object.fromEntries(rows.map((r) => [r.key, [r.invoices, r.taxablePaise / 100, r.igstPaise / 100]]));
    assert.deepEqual(by, {
      'domestic-goods': [1, 2000, 0],
      'domestic-service': [1, 20000, 0],
      'export-lut-goods': [1, 2000, 0],
      'export-lut-service': [0, 0, 0],
      'export-paid-goods': [0, 0, 0],
      'export-paid-service': [1, 20000, 3600],
    }, 'SEZ lines appear only when there are some');
    assert.equal(rows.find((r) => r.key === 'domestic-goods')!.cgstSgstPaise, 360_00);
  });
});

test('sales by supply nets credit notes off the line they belong to, and counts invoices only', async () => {
  await withFixture(async (f) => {
    const inv = await sell(f, f.local, f.part);                       // ₹2,000 of goods
    await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.local, date: '2026-08-08', reason: 'One pad returned',
      againstInvoiceId: inv.id, lines: [{ itemId: f.part, qty: 1 }],
    });
    const goods = (await supplyMix(f.trx, f.orgId, { from: '2026-04-01', to: '2027-03-31' })).find((r) => r.key === 'domestic-goods')!;
    assert.deepEqual([goods.invoices, goods.taxablePaise / 100, goods.cgstSgstPaise / 100], [1, 1000, 180]);
  });
});

test('the organisation profile: domestic until set, and what it says', async () => {
  await withFixture(async (f) => {
    const before = await tradeProfile(f.trx, f.orgId);
    assert.deepEqual([before.tradeScope, before.supplies, before.lutDeclared, before.exportIgst], ['domestic', 'both', false, 'nil_lut']);
    await declare(f, { ...LUT, trade_scope: 'both', supplies: 'goods' });
    const after = await tradeProfile(f.trx, f.orgId);
    assert.deepEqual(after, {
      tradeScope: 'both', supplies: 'goods', lutDeclared: true, lutArn: 'AD330426012345X',
      lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31', exportIgst: 'nil_lut',
    });
  });
});

test('saving the LUT: a yes needs its ARN and dates; a no makes exports pay IGST', async () => {
  await withFixture(async (f) => {
    assert.deepEqual(await lutPatch(f.trx, f.orgId, {}), {}, 'nothing about the LUT sent, nothing changes');
    await assert.rejects(lutPatch(f.trx, f.orgId, { lutDeclared: true }), /needs its ARN/);
    await assert.rejects(lutPatch(f.trx, f.orgId, { lutDeclared: true, lutArn: 'AD330426012345X' }), /needs the dates/);
    assert.deepEqual(
      await lutPatch(f.trx, f.orgId, { lutDeclared: true, lutArn: 'AD330426012345X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31', exportIgst: 'nil_lut' }),
      { lut_declared: 1, export_igst: 'nil_lut' },
    );
    // Already on file, a yes needs nothing more; a no turns exports to IGST paid.
    await declare(f, LUT);
    assert.deepEqual(await lutPatch(f.trx, f.orgId, { lutDeclared: true }), { lut_declared: 1, export_igst: 'nil_lut' });
    assert.deepEqual(await lutPatch(f.trx, f.orgId, { lutDeclared: false, exportIgst: 'nil_lut' }), { lut_declared: 0, export_igst: 'paid' });
  });
});

test('roles can be added, part by part, and listed with what they may do', async () => {
  await withFixture(async (f) => {
    const id = await saveCustomRole(f.trx, f.orgId, {
      name: 'Billing clerk', baseRole: 'sales', description: 'Invoices only',
      permissions: { sales: ['create', 'print'], 'reports.sales': ['view'] },
    });
    const [role] = await listCustomRoles(f.trx, f.orgId);
    assert.equal(role.id, String(id));
    assert.deepEqual(role.permissions.sales, ['view', 'create', 'print'], 'anything beyond viewing brings viewing');
    assert.deepEqual(role.permissions['reports.sales'], ['view']);
    await assert.rejects(saveCustomRole(f.trx, f.orgId, { name: 'Billing clerk', baseRole: 'sales', permissions: { sales: ['view'] } }), /already a role/);
    await assert.rejects(saveCustomRole(f.trx, f.orgId, { name: 'Admin', baseRole: 'sales', permissions: { sales: ['view'] } }), /standard role/);
  });
});

test.after(() => db.destroy());
