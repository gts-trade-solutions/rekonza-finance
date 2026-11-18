// One item's page, as Zoho opens it beside the item list: the item read the
// same way the list reads it, the documents it is on (the Transactions tab),
// and what still refers to it, which decides whether it may be deleted
// (lib/server/services/item-read.ts, item-activity.ts, item-input.ts); Zoho's
// item fields; and sales posted to the item's own account, as Zoho posts them
// (item-accounts.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/item-page.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { runImport } from '../../lib/server/imports/run';
import { createBill } from '../../lib/server/services/purchases';
import { selectItems, shapeItems } from '../../lib/server/services/item-read';
import { hsnHistory, itemTransactions, itemUses } from '../../lib/server/services/item-activity';
import { ItemInput, UpdateInput } from '../../lib/server/services/item-input';
import { canSeeCosts } from '../../lib/rbac';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Item Page Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Shop', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 28, is_active: 1 }).execute();
  const item = async (name: string, sku: string) => Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name, sku, hsn_sac: '8708', uqc: 'NOS', sale_price: '1450.0000', purchase_price: '980.0000',
    gst_rate_pct: 28, track_inventory: 1, description: 'Front disc brake pads',
  }).executeTakeFirstOrThrow()).insertId);
  const used = await item('Brake Pad Set', 'BP-1');
  const unused = await item('Brake Shoe', 'BS-1');
  const contact = async (kind: string, display_name: string) => Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind, display_name, state_code: '33', gst_treatment: 'unregistered',
  } as never).executeTakeFirstOrThrow()).insertId);
  return { orgId, branchId, used, unused, customer: await contact('customer', 'Speedwell Garages'), vendor: await contact('vendor', 'Brake Works') };
}

test('the item reads the same on its own page as in the list, sales counted from issued invoices only', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, used, customer } = await book(trx);
    const line = { itemId: used, hsnSac: '8708', qty: 4, ratePaise: 1450_00, gstRatePct: 28 };
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved', lines: [line] });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-06-02', dueDate: '2026-07-02', status: 'draft', lines: [{ ...line, qty: 9 }] });

    const row = await selectItems(orgId, trx).where('id', '=', used).executeTakeFirstOrThrow();
    const [one] = await shapeItems(orgId, [row], trx);
    const listed = await shapeItems(orgId, await selectItems(orgId, trx).orderBy('name').execute(), trx);
    assert.deepEqual(one, listed.find((i) => i.id === String(used)), 'the page and the list agree');
    assert.equal(one.name, 'Brake Pad Set');
    assert.equal(one.salePricePaise, 1450_00);
    assert.equal(one.description, 'Front disc brake pads');
    assert.equal(one.qtySold, 4, 'a draft has not sold anything');
    assert.equal(one.soldValuePaise, 5800_00);
    assert.ok(one.createdAt, 'when it was made, for the page');
  });
});

test('the Transactions tab: every kind of document at once, purchases only for those who may see them', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, used, unused, customer, vendor } = await book(trx);
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
      lines: [{ itemId: used, hsnSac: '8708', qty: 4, ratePaise: 1450_00, gstRatePct: 28 }],
    });
    await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'BW-77', date: '2026-05-20', dueDate: '2026-06-20', status: 'open',
      lines: [{ itemId: used, qty: 10, ratePaise: 980_00, gstRatePct: 28 }],
    });
    // A recurring invoice keeps its lines on the profile, as JSON.
    await trx.insertInto('recurring_invoices').values({
      org_id: orgId, branch_id: branchId, customer_id: customer, profile_name: 'Monthly pads', start_date: '2026-06-01', next_run: '2026-07-01',
      template: JSON.stringify([{ itemId: used, description: null, qty: 2, ratePaise: 1400_00, gstRatePct: 28, hsnSac: '8708' }]),
    } as never).execute();

    const all = await itemTransactions(trx, orgId, used, { sales: true, purchases: true });
    const invoice = all.find((r) => r.kind === 'invoice');
    assert.ok(invoice, 'the invoice is listed');
    assert.equal(invoice.id, String(inv.id));
    assert.equal(invoice.party, 'Speedwell Garages');
    assert.equal(invoice.qty, 4);
    assert.equal(invoice.ratePaise, 1450_00);
    assert.equal(invoice.amountPaise, 5800_00, 'the line before GST, as Zoho’s item total is');
    assert.equal(invoice.date, '2026-06-01');
    const bill = all.find((r) => r.kind === 'bill');
    assert.equal(bill?.number, 'BW-77', 'a bill is known by the vendor’s number');
    assert.equal(bill?.party, 'Brake Works');
    const recurring = all.find((r) => r.kind === 'recurring_invoice');
    assert.equal(recurring?.number, 'Monthly pads');
    assert.equal(recurring?.amountPaise, 2800_00);
    assert.equal(recurring?.status, 'active');

    const salesOnly = await itemTransactions(trx, orgId, used, { sales: true, purchases: false });
    assert.ok(!salesOnly.some((r) => r.kind === 'bill' || r.kind === 'purchase_order'), 'no purchases for a sales role');
    assert.equal((await itemTransactions(trx, orgId, unused, { sales: true, purchases: true })).length, 0, 'an unused item is on nothing');
  });
});

test('deleting: an item on any document or recurring profile is kept, an unused one may go', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, used, unused, customer } = await book(trx);
    assert.deepEqual(await itemUses(trx, orgId, used), [], 'nothing refers to it yet');
    await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
      lines: [{ itemId: used, hsnSac: '8708', qty: 1, ratePaise: 1450_00, gstRatePct: 28 }],
    });
    await trx.insertInto('recurring_invoices').values({
      org_id: orgId, branch_id: branchId, customer_id: customer, profile_name: 'Shoes', start_date: '2026-06-01', next_run: '2026-07-01',
      template: JSON.stringify([{ itemId: unused, description: null, qty: 1, ratePaise: 100_00, gstRatePct: 28, hsnSac: '8708' }]),
    } as never).execute();
    assert.deepEqual(await itemUses(trx, orgId, used), ['1 invoices']);
    assert.deepEqual(await itemUses(trx, orgId, unused), ['1 recurring invoices'], 'a profile’s JSON lines count too');
  });
});

test('an edit changes only what it names: marking an item inactive keeps its unit, cost and tax preference', () => {
  const archive = UpdateInput.parse({ id: '7', isArchived: true });
  assert.deepEqual(Object.keys(archive).sort(), ['id', 'isArchived'], 'no defaults filled into an edit');
  assert.equal(archive.uqc, undefined);
  assert.equal(archive.purchasePricePaise, undefined);
  assert.equal(archive.taxPref, undefined);
  // A sales user's edit sends no cost: none is written.
  assert.equal(UpdateInput.parse({ id: '7', salePricePaise: 130000 }).purchasePricePaise, undefined);
  // A new item still takes the usual values.
  const created = ItemInput.parse({ kind: 'goods', name: 'Disc', salePricePaise: 1, gstRatePct: 18 });
  assert.equal(created.uqc, 'NOS');
  assert.equal(created.purchasePricePaise, 0);
  assert.equal(created.taxPref, 'taxable');
});

test('a sale credits the item\'s own sales account, as Zoho posts it, and a credit note debits it back', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, used, customer } = await book(trx);
    const acc = await accountIds(trx, orgId);
    await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998729', kind: 'sac', description: 'Repairs', gst_rate_pct: 18, is_active: 1 }).execute();
    // A service on Service Income; the goods item kept on Sales.
    const fitting = Number((await trx.insertInto('items').values({
      org_id: orgId, kind: 'service', name: 'Fitting', hsn_sac: '998729', uqc: 'OTH', sale_price: '500.0000', gst_rate_pct: 18,
      sale_account_id: acc[CODE.SERVICE_INCOME],
    }).executeTakeFirstOrThrow()).insertId);
    await trx.updateTable('items').set({ sale_account_id: acc[CODE.SALES] }).where('id', '=', used).execute();

    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
      lines: [
        { itemId: used, hsnSac: '8708', qty: 2, ratePaise: 1450_00, gstRatePct: 28 },
        { itemId: fitting, hsnSac: '998729', qty: 1, ratePaise: 500_00, gstRatePct: 18 },
      ],
    });
    const lines = await trx.selectFrom('invoice_lines').select(['item_id', 'account_id']).where('invoice_id', '=', inv.id).orderBy('line_no').execute();
    assert.equal(lines[0].account_id, null, 'an item kept on Sales needs no account of its own');
    assert.equal(lines[1].account_id, acc[CODE.SERVICE_INCOME], 'the service line names Service Income');
    const posted = async (entryId: number) => {
      const rows = await trx.selectFrom('journal_lines').select(['account_id', 'debit', 'credit']).where('entry_id', '=', entryId).execute();
      const net = new Map<number, number>();
      for (const r of rows) net.set(r.account_id, (net.get(r.account_id) ?? 0) + Math.round(Number(r.credit) * 100) - Math.round(Number(r.debit) * 100));
      return net;
    };
    const sale = await posted(inv.journalEntryId!);
    assert.equal(sale.get(acc[CODE.SALES]), 2900_00, 'the goods to Sales');
    assert.equal(sale.get(acc[CODE.SERVICE_INCOME]), 500_00, 'the service to Service Income');

    const cn = await createCreditNote(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-05', reason: 'Fitting refunded', againstInvoiceId: inv.id,
      lines: [{ itemId: fitting, description: 'Fitting', hsnSac: '998729', qty: 1, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const cnLine = await trx.selectFrom('credit_note_lines').select('account_id').where('credit_note_id', '=', cn.id).executeTakeFirstOrThrow();
    assert.equal(cnLine.account_id, acc[CODE.SERVICE_INCOME], 'the credit note line names the same head');
    const back = await posted(cn.journalEntryId!);
    assert.equal(back.get(acc[CODE.SERVICE_INCOME]), -500_00, 'Service Income debited back');
    assert.equal(back.get(acc[CODE.SALES]) ?? 0, 0, 'Sales untouched by the service refund');
  });
});

test("Zoho's item fields: saved, read back, and an edit that leaves them out keeps them", async () => {
  await rolledBack(async (trx) => {
    const { orgId, used, vendor } = await book(trx);
    await trx.updateTable('items').set({
      item_type: 'purchases', upc: '012345678905', ean: '8901234567890', isbn: null, mpn: 'BP-OEM',
      purchase_description: 'Brake pads, OEM pack', preferred_vendor_id: vendor, is_digital_service: 0,
    }).where('id', '=', used).execute();
    const [it] = await shapeItems(orgId, [await selectItems(orgId, trx).where('id', '=', used).executeTakeFirstOrThrow()], trx);
    assert.equal(it.itemType, 'purchases');
    assert.equal(it.upc, '012345678905');
    assert.equal(it.mpn, 'BP-OEM');
    assert.equal(it.purchaseDescription, 'Brake pads, OEM pack');
    assert.equal(it.preferredVendorId, String(vendor));
    assert.equal(it.createdSource, 'user', 'typed in by hand');
    const edit = UpdateInput.parse({ id: String(used), name: 'Brake Pad Set (front)' });
    for (const k of ['itemType', 'upc', 'purchaseDescription', 'preferredVendorId', 'saleAccountId', 'purchaseAccountId', 'isDigitalService'] as const) {
      assert.equal(edit[k], undefined, `${k} is not reset by an edit that leaves it out`);
    }
    const made = ItemInput.parse({ kind: 'service', name: 'Fitting', salePricePaise: 1, gstRatePct: 18 });
    assert.equal(made.itemType, 'sales_and_purchases', 'a new item is sold and bought unless ticked otherwise');
    assert.equal(made.isDigitalService, false);
  });
});

test('an imported item is marked imported, with its accounts and Zoho\'s columns', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId } = await book(trx);
    const out = await runImport(trx, { orgId, userId: null, branchId, onDuplicate: 'error' }, 'items', [
      { name: 'Clutch Plate', kind: 'goods', sku: 'CP-9', hsn_sac: '8708', unit: 'NOS', sale_price: '3200', purchase_price: '2250', gst_rate: '28',
        description: 'Clutch disc for i20', purchase_description: 'Clutch disc, OEM', preferred_vendor: 'Brake Works', upc: '036000291452', mpn: 'cp-oem-9' },
      { name: 'Wheel Alignment', kind: 'service', hsn_sac: '998729', unit: 'OTH', sale_price: '600', gst_rate: '18' },
    ]);
    assert.equal(out.errors.length, 0, JSON.stringify(out.errors));
    const acc = await accountIds(trx, orgId);
    const rows = await trx.selectFrom('items').selectAll().where('org_id', '=', orgId).where('name', 'in', ['Clutch Plate', 'Wheel Alignment']).orderBy('name').execute();
    const [clutch, alignment] = rows;
    assert.equal(clutch.created_source, 'import');
    assert.equal(clutch.purchase_description, 'Clutch disc, OEM');
    assert.equal(clutch.description, 'Clutch disc for i20');
    assert.equal(clutch.upc, '036000291452');
    assert.equal(clutch.mpn, 'CP-OEM-9', 'product codes are kept in capitals');
    assert.ok(clutch.preferred_vendor_id, 'the vendor found by name');
    assert.equal(clutch.sale_account_id, acc[CODE.SALES]);
    assert.equal(clutch.purchase_account_id, acc[CODE.PURCHASES]);
    assert.equal(alignment.sale_account_id, acc[CODE.SERVICE_INCOME], 'a service imported onto Service Income, as one typed in is');
  });
});

test("HSN/SAC Update History: each change of an item's code, from its edit log, and nothing else", async () => {
  await rolledBack(async (trx) => {
    const { orgId, used } = await book(trx);
    const log = (payload: unknown, at: string) => trx.insertInto('audit_log').values({
      org_id: orgId, actor_name: 'Arun', action: 'update', target_type: 'item', target_id: String(used),
      target_label: 'Brake Pad Set', payload: JSON.stringify(payload), created_at: new Date(at),
    } as never).execute();
    await log({ changes: { hsn_sac: { from: '8708', to: '870830' } } }, '2026-06-01T10:00:00Z');
    await log({ changes: { sale_price: { from: '1450.0000', to: '1500.00' } } }, '2026-06-02T10:00:00Z');
    await log({ changes: { hsn_sac: { from: null, to: '8708' }, sku: { from: 'BP-1', to: 'BP-2' } } }, '2026-05-01T10:00:00Z');
    const h = await hsnHistory(trx, orgId);
    assert.equal(h.length, 2, 'a price change is not a code change');
    assert.deepEqual([h[0].from, h[0].to], ['8708', '870830'], 'newest first');
    assert.deepEqual([h[1].from, h[1].to], [null, '8708'], 'a code given for the first time');
    assert.equal(h[0].item, 'Brake Pad Set');
    assert.equal(h[0].itemId, String(used));
  });
});

test('who sees what goods cost', () => {
  assert.equal(canSeeCosts('admin'), true);
  assert.equal(canSeeCosts('accountant'), true);
  assert.equal(canSeeCosts('viewer'), true);
  assert.equal(canSeeCosts('sales'), false);
  assert.equal(canSeeCosts(undefined), false);
});

test.after(() => db.destroy());
