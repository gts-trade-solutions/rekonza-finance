// The rest of the Zoho Books catch-up: reporting tags, kits, item groups, the
// customer and vendor portal, and invoice templates.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/zoho-rest.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote, createEstimate } from '../../lib/server/services/sales-documents';
import { profitByTag, saveTag, setTags, tagsFor } from '../../lib/server/services/reporting-tags';
import { explodeKits, saveKit } from '../../lib/server/services/kits';
import { combinations, createItemGroup } from '../../lib/server/services/item-groups';
import { answerQuote, createPortalLink, openPortal, ownsInvoice, portalOverview, revokePortalLinks } from '../../lib/server/services/portal';
import { checkStock } from '../../lib/server/services/guards';
import { stockPosition } from '../../lib/server/reports/stock';
import { stockLedger } from '../../lib/server/reports/stock-movement';
import { readTemplate } from '../../lib/print-template';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; bankId: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Rest Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = (kind: string, name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered', email: `${name.toLowerCase().replace(/\W/g, '')}@x.test` } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer: await mk('customer', 'Kumar Stores'), vendor: await mk('vendor', 'Steel Co'), bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const goods = (trx: Trx, orgId: number, name: string, extra: Record<string, unknown> = {}) =>
  trx.insertInto('items').values({ org_id: orgId, name, kind: 'goods', track_inventory: 1, uqc: 'NOS', sale_price: '100.0000', purchase_price: '60.0000', ...extra } as never)
    .executeTakeFirstOrThrow().then((r) => Number(r.insertId));

test('reporting tags: one value of each tag on a document; the P&L cut by tag adds up, with Untagged', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, bankId }) => {
    const acc = await accountIds(trx, orgId);
    const region = await saveTag(trx, orgId, { name: 'Region', values: ['North', 'South'] });
    await assert.rejects(saveTag(trx, orgId, { name: 'Region', values: ['East'] }), /already a tag called Region/);
    const opts = await trx.selectFrom('reporting_tag_options').select(['id', 'value']).where('tag_id', '=', region).execute();
    const north = String(opts.find((o) => o.value === 'North')!.id);
    const south = String(opts.find((o) => o.value === 'South')!.id);
    const sell = (rupees: number) => createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-10', dueDate: '2026-09-10', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }] });
    const a = await sell(1_000);
    const b = await sell(500);
    await sell(200);
    await setTags(trx, orgId, 'invoice', a.id, { [String(region)]: north });
    await setTags(trx, orgId, 'invoice', b.id, { [String(region)]: south });
    await assert.rejects(setTags(trx, orgId, 'invoice', b.id, { [String(region)]: '999999' }), /not one of the tag/);
    assert.deepEqual(await tagsFor(trx, orgId, 'invoice', a.id), { [String(region)]: north });
    const e = await createExpense(trx, orgId, null, { branchId, date: '2026-09-11', accountId: acc[CODE.RENT], paidThroughBankAccountId: bankId, amountPaise: 300_00, gstRatePct: 0 });
    await setTags(trx, orgId, 'expense', e.id, { [String(region)]: north });

    const r = await profitByTag(trx, orgId, region, '2026-09-01', '2026-09-30');
    assert.deepEqual(r.rows.map((x) => [x.option, x.incomePaise, x.expensePaise, x.profitPaise]), [
      ['North', 1_000_00, 300_00, 700_00], ['South', 500_00, 0, 500_00], ['Untagged', 200_00, 0, 200_00],
    ]);
    await saveTag(trx, orgId, { id: region, name: 'Region', values: ['North'] });
    await assert.rejects(setTags(trx, orgId, 'invoice', b.id, { [String(region)]: south }), /switched off/);
  });
});

test('kits: a sale takes the components out of stock, a return puts them back, the stock check counts them', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor }) => {
    const acc = await accountIds(trx, orgId);
    const pad = await goods(trx, orgId, 'Brake pad');
    const fluid = await goods(trx, orgId, 'Brake fluid');
    const kit = await goods(trx, orgId, 'Service kit', { sale_price: '500.0000' });
    await saveKit(trx, orgId, kit, [{ itemId: pad, qty: 4 }, { itemId: fluid, qty: 1 }]);
    await assert.rejects(saveKit(trx, orgId, pad, [{ itemId: kit, qty: 1 }]), /is a kit itself/);
    await assert.rejects(saveKit(trx, orgId, kit, [{ itemId: kit, qty: 1 }]), /cannot contain itself/);
    const k = await trx.selectFrom('items').select(['is_kit', 'track_inventory']).where('id', '=', kit).executeTakeFirstOrThrow();
    assert.deepEqual([k.is_kit, k.track_inventory], [1, 0], 'a kit holds no stock of its own');
    assert.deepEqual(await explodeKits(trx, orgId, [{ itemId: kit, qty: 2 }, { itemId: pad, qty: 1 }]), [{ itemId: pad, qty: 8 }, { itemId: fluid, qty: 2 }, { itemId: pad, qty: 1 }]);

    await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'S-1', date: '2026-09-01', dueDate: '2026-09-30', lines: [
      { itemId: pad, qty: 10, ratePaise: 60_00, gstRatePct: 0, accountId: acc[CODE.PURCHASES] },
      { itemId: fluid, qty: 3, ratePaise: 40_00, gstRatePct: 0, accountId: acc[CODE.PURCHASES] },
    ] });
    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-05', dueDate: '2026-09-05', status: 'approved', lines: [{ itemId: kit, qty: 2, ratePaise: 500_00, gstRatePct: 0 }] });
    const qty = async (date: string) => {
      const pos = await stockPosition(trx, orgId, date);
      return [pos.lines.find((l) => l.itemId === String(pad))?.qty, pos.lines.find((l) => l.itemId === String(fluid))?.qty];
    };
    assert.deepEqual(await qty('2026-09-06'), [2, 1], '10 − 8 pads, 3 − 2 bottles');
    const ledger = await stockLedger(trx, orgId, pad, '2026-09-01', '2026-09-30');
    assert.ok(ledger?.lines.some((l) => l.kind === 'Sale (in a kit)' && l.qtyOut === 8));

    const warnings: string[] = [];
    await checkStock(trx, orgId, branchId, '2026-09-07', [{ itemId: kit, qty: 1 }], warnings);
    assert.ok(warnings.some((w) => /Brake pad: 2 in stock, 4 going out/.test(w)), 'one more kit needs 4 pads; 2 are left');

    await createCreditNote(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-08', reason: 'Returned', againstInvoiceId: inv.id, lines: [{ itemId: kit, qty: 1, ratePaise: 500_00, gstRatePct: 0 }] });
    assert.deepEqual(await qty('2026-09-09'), [6, 2], 'one kit back: 4 pads and a bottle');
  });
});

test('item groups: every combination becomes an item with its own SKU; more than a hundred is refused', async () => {
  await withBook(async ({ trx, orgId }) => {
    assert.equal(combinations([{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red', 'Black', 'Blue'] }]).length, 6);
    const g = await createItemGroup(trx, orgId, { name: 'Riding jacket', attributes: [{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Colour', values: ['Red', 'Black'] }], salePricePaise: 2_500_00, hsnSac: '6201' });
    assert.equal(g.itemIds.length, 6);
    const items = await trx.selectFrom('items').select(['name', 'sku', 'variant', 'sale_price', 'item_group_id']).where('item_group_id', '=', g.groupId).orderBy('id').execute();
    assert.equal(items[0].name, 'Riding jacket — S / Red');
    assert.equal(items[0].sku, 'RIDINGJA-S-RED');
    assert.deepEqual(typeof items[0].variant === 'string' ? JSON.parse(items[0].variant) : items[0].variant, { Size: 'S', Colour: 'Red' });
    assert.equal(Number(items[5].sale_price), 2_500);
    await assert.rejects(createItemGroup(trx, orgId, { name: 'Riding jacket', attributes: [{ name: 'Size', values: ['XL'] }] }), /already an item group/);
    await assert.rejects(createItemGroup(trx, orgId, { name: 'Too many', attributes: [{ name: 'A', values: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { name: 'B', values: Array.from({ length: 10 }, (_, i) => `b${i}`) }] }), /at most 100/);
  });
});

test('portal: a link opens one contact only, lapses when withdrawn; a customer answers a sent quote once', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor }) => {
    await assert.rejects(createPortalLink(trx, orgId, null, { contactId: vendor, side: 'customer' }), /is a vendor/);
    const link = await createPortalLink(trx, orgId, null, { contactId: customer, side: 'customer' });
    const token = link.path.replace('/portal/', '');
    assert.deepEqual(await openPortal(trx, token), { orgId, contactId: customer, side: 'customer' });
    assert.equal(await openPortal(trx, 'x'.repeat(32)), null);

    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }] });
    const otherCustomer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Other', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const theirs = await createInvoice(trx, orgId, null, { branchId, customerId: otherCustomer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 50_00, gstRatePct: 0 }] });
    assert.equal(await ownsInvoice(trx, orgId, customer, inv.id), true);
    assert.equal(await ownsInvoice(trx, orgId, customer, theirs.id), false, 'another customer’s invoice is not reachable');

    const view = await portalOverview(trx, orgId, customer, 'customer');
    assert.equal(view.side, 'customer');
    if (view.side !== 'customer') return;
    assert.deepEqual(view.invoices.map((i) => i.number), [(await trx.selectFrom('invoices').select('number').where('id', '=', inv.id).executeTakeFirstOrThrow()).number]);
    assert.equal(view.statement.closingPaise, 1_000_00);

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const q = await createEstimate(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', expiryDate: future, status: 'sent', lines: [{ description: 'Quote', qty: 1, ratePaise: 300_00, gstRatePct: 0 }] });
    await answerQuote(trx, orgId, customer, q.id, 'accepted');
    await assert.rejects(answerQuote(trx, orgId, customer, q.id, 'declined'), /already accepted/);
    await assert.rejects(answerQuote(trx, orgId, otherCustomer, q.id, 'accepted'), /not yours/);

    assert.equal(await revokePortalLinks(trx, orgId, customer), 1);
    assert.equal(await openPortal(trx, token), null, 'withdrawn');
  });
});

test('invoice template: a stored template is read safely; anything missing or wrong falls back', () => {
  assert.deepEqual(readTemplate(null), { layout: 'classic', accent: '#0f172a', showLogo: true, showSignature: true, footer: null });
  assert.deepEqual(readTemplate(JSON.stringify({ layout: 'modern', accent: '#1d4ed8', showLogo: false, footer: ' CIN U12345TN2020PTC000001 ' })),
    { layout: 'modern', accent: '#1d4ed8', showLogo: false, showSignature: true, footer: 'CIN U12345TN2020PTC000001' });
  assert.equal(readTemplate({ layout: 'fancy', accent: 'red' }).layout, 'classic');
  assert.equal(readTemplate({ accent: 'red' }).accent, '#0f172a');
});

test.after(() => db.destroy());
