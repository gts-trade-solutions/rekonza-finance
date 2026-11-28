// One item, one HSN code, everywhere (auditor check, 2026-11-28).
//
// An item saved with HSN 8708 showed 870899 on a bill line and in GSTR-1's B2B
// HSN table (and its JSON), and 8708 in the B2C table. The 870899 came from the
// demo seed: its pass that gives the demo book's free-text lines six-digit
// codes ran its UPDATE over every company in the database, so wherever the demo
// was seeded beside a real company, that company's older lines were rewritten.
// Newer lines (the B2C ones, made after the seed ran) kept the item's code.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-a-hsn-consistency.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { gstr1Report } from '../../lib/server/gst/gstr1-report';
import { sixDigitHsnCodes } from '../../lib/server/seed/demo-sr7-d';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** A real company: an item on HSN 8708 bought on a bill and sold B2B and B2C. */
async function realCompany(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Alpha Traders' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCA1111A1Z5' }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const itemId = Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name: 'CN Gadget', hsn_sac: '8708', uqc: 'NOS', gst_rate_pct: '18', sale_price: '500', purchase_price: '300', track_inventory: 0,
  } as never).executeTakeFirstOrThrow()).insertId);
  const contact = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({ org_id: orgId, ...v } as never).executeTakeFirstOrThrow()).insertId);
  const vendor = await contact({ kind: 'vendor', display_name: 'Nila Suppliers', gst_treatment: 'registered', state_code: '33', gstin: '33AAACN2222N1Z5' });
  const buyer = await contact({ kind: 'customer', display_name: 'Kaveri Retail', gst_treatment: 'registered', state_code: '33', gstin: '33AAACK3333K1Z5' });
  const consumer = await contact({ kind: 'customer', display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33' });

  const bill = await createBill(trx, orgId, null, {
    branchId, vendorId: vendor, vendorInvoiceNo: 'NS-B-201', date: '2026-11-03', dueDate: '2026-12-03',
    lines: [{ itemId, qty: 20, ratePaise: 300_00 }],
  });
  const b2b = await createInvoice(trx, orgId, null, { branchId, customerId: buyer, date: '2026-11-11', dueDate: '2026-12-11', status: 'approved', lines: [{ itemId, qty: 10, ratePaise: 500_00 }] });
  const b2c = await createInvoice(trx, orgId, null, { branchId, customerId: consumer, date: '2026-11-12', dueDate: '2026-12-12', status: 'approved', lines: [{ itemId, qty: 4, ratePaise: 500_00 }] });
  return { orgId, itemId, billId: Number(bill.id), b2bId: Number(b2b.id), b2cId: Number(b2c.id) };
}

/** The demo book beside it, with a named item and a free-text line on four-digit codes. */
async function demoBook(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Demo', is_demo: 1 } as never).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const itemId = Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name: 'Brake Pad Set – Swift/Baleno', hsn_sac: '8708', uqc: 'NOS', gst_rate_pct: '28', sale_price: '1000', track_inventory: 0,
  } as never).executeTakeFirstOrThrow()).insertId);
  const otherItem = Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name: 'Some other part', hsn_sac: '8708', uqc: 'NOS', gst_rate_pct: '28', sale_price: '100', track_inventory: 0,
  } as never).executeTakeFirstOrThrow()).insertId);
  const consumer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33' } as never).executeTakeFirstOrThrow()).insertId);
  const inv = await createInvoice(trx, orgId, null, {
    branchId, customerId: consumer, date: '2026-11-05', dueDate: '2026-12-05',
    lines: [
      { itemId, qty: 1, ratePaise: 1000_00 },
      { itemId: otherItem, qty: 1, ratePaise: 100_00 },
      { description: 'Price difference on brake pads', hsnSac: '8708', qty: 1, ratePaise: 50_00, gstRatePct: 28 },
    ],
  });
  return { orgId, itemId, otherItem, invoiceId: Number(inv.id) };
}

const codesOn = async (trx: Trx, table: 'invoice_lines' | 'bill_lines', key: 'invoice_id' | 'bill_id', id: number) =>
  (await trx.selectFrom(table).select(['hsn_sac']).where(key, '=', id).execute()).map((l) => l.hsn_sac);

test('seeding the demo book leaves every other company\'s HSN codes alone', async () => {
  await rolledBack(async (trx) => {
    const real = await realCompany(trx);
    const demo = await demoBook(trx);

    await sixDigitHsnCodes(trx, demo.orgId);

    // The real company: the item's own code on the bill and both invoices.
    assert.deepEqual(await codesOn(trx, 'bill_lines', 'bill_id', real.billId), ['8708'], 'the bill line keeps the item\'s code');
    assert.deepEqual(await codesOn(trx, 'invoice_lines', 'invoice_id', real.b2bId), ['8708']);
    assert.deepEqual(await codesOn(trx, 'invoice_lines', 'invoice_id', real.b2cId), ['8708']);

    // The demo book: every item and its lines agree; the free-text line gets six digits.
    const items = await trx.selectFrom('items').select(['id', 'hsn_sac']).where('org_id', '=', demo.orgId).execute();
    const code = (id: number) => items.find((i) => i.id === id)!.hsn_sac;
    assert.equal(code(demo.itemId), '870830');
    assert.equal(code(demo.otherItem), '870899', 'an item on a four-digit code goes to six with its lines');
    const lines = await trx.selectFrom('invoice_lines').select(['item_id', 'hsn_sac']).where('invoice_id', '=', demo.invoiceId).orderBy('id').execute();
    assert.deepEqual(lines.map((l) => l.hsn_sac), ['870830', '870899', '870899']);
    for (const l of lines.filter((x) => x.item_id)) assert.equal(l.hsn_sac, code(Number(l.item_id)), 'a line never differs from its item');
  });
});

test('GSTR-1 (screen and JSON) shows the item\'s own code in both the B2B and the B2C HSN tables', async () => {
  await rolledBack(async (trx) => {
    const real = await realCompany(trx);
    await sixDigitHsnCodes(trx, (await demoBook(trx)).orgId);

    const file = await gstr1PortalFile(trx, real.orgId, '2026-11');
    const hsn = file.hsn as { hsn_b2b: { hsn_sc: string; qty: number }[]; hsn_b2c: { hsn_sc: string; qty: number }[] };
    assert.deepEqual(hsn.hsn_b2b.map((r) => [r.hsn_sc, r.qty]), [['8708', 10]]);
    assert.deepEqual(hsn.hsn_b2c.map((r) => [r.hsn_sc, r.qty]), [['8708', 4]]);

    const report = await gstr1Report(trx, real.orgId, '2026-11');
    assert.deepEqual(report.tables.hsnB2b.rows.map((r) => r.code), ['8708']);
    assert.deepEqual(report.tables.hsnB2c.rows.map((r) => r.code), ['8708']);
  });
});

test('migration 135 gives back the item\'s code on lines the old seed rewrote, in real companies only', async () => {
  await rolledBack(async (trx) => {
    const real = await realCompany(trx);
    const demo = await demoBook(trx);
    // What the old seed did: every 8708 line in the database became 870899.
    for (const t of ['invoice_lines', 'bill_lines'] as const) {
      await sql`UPDATE ${sql.table(t)} SET hsn_sac = '870899' WHERE org_id IN (${real.orgId}, ${demo.orgId}) AND hsn_sac = '8708'`.execute(trx);
    }
    // A line where someone typed 870899 on purpose for an item on another code is not touched.
    await sql`UPDATE items SET hsn_sac = '8714' WHERE id = ${real.itemId}`.execute(trx);
    await sql`UPDATE invoice_lines SET hsn_sac = '870899' WHERE invoice_id = ${real.b2cId}`.execute(trx);

    // The migration's UPDATE statements (its ALTER would end the test's transaction).
    const file = readFileSync('db/migrations/135_gstr2b_sections_hsn_repair.sql', 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    // Put the item back on 8708 for the B2B and bill lines, keep the B2C one as the typed case.
    await sql`UPDATE items SET hsn_sac = '8708' WHERE id = ${real.itemId}`.execute(trx);
    const typedItem = Number((await trx.insertInto('items').values({ org_id: real.orgId, kind: 'goods', name: 'Typed', hsn_sac: '8714', uqc: 'NOS', gst_rate_pct: '18', track_inventory: 0 } as never).executeTakeFirstOrThrow()).insertId);
    await sql`UPDATE invoice_lines SET item_id = ${typedItem} WHERE invoice_id = ${real.b2cId}`.execute(trx);
    for (const stmt of file.split(';').map((x) => x.trim()).filter((x) => /^UPDATE/i.test(x))) await sql.raw(stmt).execute(trx);

    assert.deepEqual(await codesOn(trx, 'bill_lines', 'bill_id', real.billId), ['8708'], 'the bill line has its item\'s code back');
    assert.deepEqual(await codesOn(trx, 'invoice_lines', 'invoice_id', real.b2bId), ['8708']);
    assert.deepEqual(await codesOn(trx, 'invoice_lines', 'invoice_id', real.b2cId), ['870899'], 'a code that is not the seed\'s pair for the item stays');
    const demoLines = await trx.selectFrom('invoice_lines').select('hsn_sac').where('invoice_id', '=', demo.invoiceId).execute();
    assert.ok(demoLines.every((l) => l.hsn_sac === '870899'), 'the demo book is not touched');
  });
});

test.after(() => db.destroy());
