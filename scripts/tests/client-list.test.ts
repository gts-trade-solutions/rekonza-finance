// The client's items 7 to 24 (migrations 107 and 108): a sales order's stages,
// Ready for delivery raising the invoice and its challan, the bank statement
// as on a date, invoice payment statuses, and the company profile lists.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/client-list.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createSalesOrder } from '../../lib/server/services/sales-documents';
import { challanFromSalesOrder, invoiceFromChallan, invoiceFromSalesOrder } from '../../lib/server/services/order-flow';
import { dueDateFor } from '../../lib/options';
import { voidInvoice } from '../../lib/server/services/sales';
import { raiseProforma, setOrderStage } from '../../lib/server/services/order-stages';
import { postManualJournal } from '../../lib/server/services/journals';
import { bankStatementAsOn } from '../../lib/server/reports/bank-statement';
import { printableDocument } from '../../lib/server/services/document-print';
import { createDocumentLink, documentLinkTarget, revokeDocumentLinks } from '../../lib/server/services/sharing';
import { renderEmail } from '../../lib/server/mail/templates';
import { daysOverdue, paymentStatusOf } from '../../components/shared/invoice-status';
import { companyTypeFrom, COMPANY_TYPES, BUSINESS_NATURES, PARTY_KINDS } from '../../lib/company-profile';
import { COUNTRIES, countryCurrency, countryName } from '../../lib/countries';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Client List Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const acc = await accountIds(trx, orgId);
  const customerId = Number((await trx.insertInto('contacts').values({
    org_id: orgId, kind: 'customer', display_name: 'Order Customer', gst_treatment: 'unregistered', state_code: '33', payment_terms: 'net_15',
  } as never).executeTakeFirstOrThrow()).insertId);
  const item = (values: Record<string, unknown>) => trx.insertInto('items').values({
    org_id: orgId, uqc: 'NOS', purchase_price: '0.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES], ...values,
  } as never).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
  await trx.insertInto('hsn_codes').values([
    { org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 },
    { org_id: orgId, code: '998714', kind: 'sac', description: 'Maintenance and repair of vehicles', gst_rate_pct: 18, is_active: 1 },
    { org_id: orgId, code: '998719', kind: 'sac', description: 'Maintenance and repair services', gst_rate_pct: 18, is_active: 1 },
    { org_id: orgId, code: '7318', kind: 'hsn', description: 'Screws, bolts and nuts', gst_rate_pct: 18, is_active: 1 },
  ]).execute();
  const goods = await item({ kind: 'goods', name: 'Brake pad set', hsn_sac: '8708', sale_price: '1000.0000' });
  const service = await item({ kind: 'service', name: 'Fitting labour', hsn_sac: '998714', sale_price: '500.0000', uqc: 'OTH' });
  return { orgId, branchId, acc, customerId, goods, service };
}

test('an order goes proforma → work in process → ready, and ready raises the invoice with a challan for the goods', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [
        { itemId: b.goods, qty: 4, ratePaise: 1000_00, gstRatePct: 18, discountPct: 10 },
        { itemId: b.service, qty: 2, ratePaise: 500_00, gstRatePct: 18 },
      ],
    });

    const pi = await raiseProforma(trx, b.orgId, so.id, '2026-06-02');
    assert.match(pi.number, /^PI/);
    assert.equal(pi.stage, 'proforma');
    assert.equal((await raiseProforma(trx, b.orgId, so.id, '2026-06-05')).number, pi.number, 'raised again, the same proforma');
    const printed = await printableDocument(trx, b.orgId, 'sales-order', so.id, { proforma: true });
    assert.equal(printed.title, 'Proforma Invoice');
    assert.equal(printed.number, pi.number);
    assert.ok(printed.facts.some((f) => f.label === 'Against order' && f.value === so.number));

    // Sent as itself: its link opens the proforma, its email says proforma, and withdrawing the order's links stops it too.
    await createDocumentLink(trx, b.orgId, null, { kind: 'sales-order', id: so.id, proforma: true });
    const stored = await trx.selectFrom('share_links').select('doc_kind').where('org_id', '=', b.orgId).where('doc_id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual(documentLinkTarget(stored.doc_kind), { kind: 'sales-order', proforma: true });
    assert.deepEqual(documentLinkTarget('sales-order'), { kind: 'sales-order', proforma: false });
    const mail = await renderEmail(trx, b.orgId, 'proforma', { party: 'Order Customer', document: 'proforma invoice', number: pi.number, date: '02/06/2026', total: '₹4,720.00', detail_line: '', link: 'https://x/s/1', business: 'Client List Co' });
    assert.equal(mail.subject, `Proforma invoice ${pi.number} from Client List Co`);
    assert.match(mail.text, new RegExp(`proforma invoice ${pi.number} dated 02/06/2026`));
    assert.equal(await revokeDocumentLinks(trx, b.orgId, 'sales-order', so.id), 1);

    assert.equal((await setOrderStage(trx, b.orgId, null, so.id, 'in_process', '2026-06-03')).stage, 'in_process');

    const ready = await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-10');
    assert.equal(ready.stage, 'ready');
    const inv = ready.ready!.invoice!;
    assert.ok(inv, 'an invoice was raised');
    const invRow = await trx.selectFrom('invoices').select(['status', 'due_date', 'source_doc_type', 'source_doc_id', 'subtotal'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(invRow.source_doc_type, 'sales_order');
    assert.equal(Number(invRow.source_doc_id), so.id);
    assert.equal(String(invRow.due_date).slice(0, 10), '2026-06-25', 'net 15 from the customer');
    const invLines = await trx.selectFrom('invoice_lines').select(['item_id', 'qty', 'discount_pct']).where('invoice_id', '=', inv.id).orderBy('line_no').execute();
    assert.deepEqual(invLines.map((l) => [l.item_id, Number(l.qty), Number(l.discount_pct)]), [[b.goods, 4, 10], [b.service, 2, 0]], 'every line, the discount kept');
    assert.equal(Number(invRow.subtotal), 4 * 1000 * 0.9 + 2 * 500);

    // The challan carries the goods only, names the invoice, and is invoiced already.
    const dc = ready.ready!.challan!;
    const dcRow = await trx.selectFrom('delivery_challans').select(['status', 'invoice_id', 'source_so_id']).where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.deepEqual([dcRow.status, Number(dcRow.invoice_id), Number(dcRow.source_so_id)], ['invoiced', inv.id, so.id]);
    const dcLines = await trx.selectFrom('challan_lines').select(['item_id', 'qty', 'qty_invoiced']).where('challan_id', '=', dc.id).execute();
    assert.deepEqual(dcLines.map((l) => [l.item_id, Number(l.qty), Number(l.qty_invoiced)]), [[b.goods, 4, 4]]);
    await assert.rejects(invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-11', dueDate: '2026-06-26' }), /invoiced|Nothing is left/);
    const dcPrint = await printableDocument(trx, b.orgId, 'challan', dc.id);
    assert.ok(dcPrint.facts.some((f) => f.label === 'Invoice no.' && f.value === inv.number), 'the challan prints its invoice');
    assert.ok(dcPrint.facts.some((f) => f.label === 'Sales order' && f.value === so.number));

    const after = await trx.selectFrom('sales_orders').select(['status', 'stage']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([after.status, after.stage], ['invoiced', 'ready']);
    await assert.rejects(setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-12'), /already ready/);
    await assert.rejects(setOrderStage(trx, b.orgId, null, so.id, 'in_process', '2026-06-12'), /cannot go back/);
    await assert.rejects(raiseProforma(trx, b.orgId, (await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 1, ratePaise: 1000_00, gstRatePct: 18 }],
    })).id, '2026-06-02').then(() => raiseProforma(trx, b.orgId, so.id, '2026-06-13')), /already invoiced/);
  });
});

test('a voided Ready invoice gives everything back: the challan reopens, the order goes back a stage, Ready invoices it again', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [{ itemId: b.goods, qty: 4, ratePaise: 1000_00, gstRatePct: 18 }, { itemId: b.service, qty: 2, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const first = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-10')).ready!;
    await voidInvoice(trx, b.orgId, null, first.invoice!.id, 'Wrong price');

    const order = await trx.selectFrom('sales_orders').select(['status', 'stage', 'invoiced_amount']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([order.status, order.stage, Number(order.invoiced_amount)], ['open', 'in_process', 0]);
    const soLines = await trx.selectFrom('sales_order_lines').select(['qty_invoiced', 'qty_delivered']).where('sales_order_id', '=', so.id).orderBy('line_no').execute();
    assert.deepEqual(soLines.map((l) => [Number(l.qty_invoiced), Number(l.qty_delivered)]), [[0, 4], [0, 0]], 'nothing invoiced; the goods are still delivered');
    const dc = await trx.selectFrom('delivery_challans').select(['status', 'invoice_id']).where('id', '=', first.challan!.id).executeTakeFirstOrThrow();
    assert.deepEqual([dc.status, dc.invoice_id], ['open', null]);

    // Ready again: one invoice for all of it, closing the challan already sent, and no second challan.
    const again = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-11')).ready!;
    assert.equal(again.challan, null, 'the goods went out already');
    assert.deepEqual(again.closedChallans.map((c) => c.id), [first.challan!.id]);
    const lines = await trx.selectFrom('invoice_lines').select(['item_id', 'qty']).where('invoice_id', '=', again.invoice!.id).orderBy('line_no').execute();
    assert.deepEqual(lines.map((l) => [l.item_id, Number(l.qty)]), [[b.goods, 4], [b.service, 2]]);
    const closed = await trx.selectFrom('delivery_challans').select(['status', 'invoice_id']).where('id', '=', first.challan!.id).executeTakeFirstOrThrow();
    assert.deepEqual([closed.status, Number(closed.invoice_id)], ['invoiced', again.invoice!.id]);
    const after = await trx.selectFrom('sales_orders').select(['status', 'stage']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([after.status, after.stage], ['invoiced', 'ready']);
    await assert.rejects(invoiceFromChallan(trx, b.orgId, null, first.challan!.id, { date: '2026-06-12', dueDate: '2026-06-27' }), /invoiced|Nothing is left/);
  });
});

test('ready for delivery after part was sent: one invoice for all of it, the sent challan closed against it', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 4, ratePaise: 1000_00, gstRatePct: 18 }],
    });
    const soLine = await trx.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', so.id).executeTakeFirstOrThrow();
    const part = await challanFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-03', lines: [{ lineId: soLine.id, qty: 1 }] });
    const ready = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-10')).ready!;
    const invQty = await trx.selectFrom('invoice_lines').select('qty').where('invoice_id', '=', ready.invoice!.id).execute();
    assert.deepEqual(invQty.map((l) => Number(l.qty)), [4], 'the one sent and the three not sent');
    assert.deepEqual(ready.closedChallans.map((c) => c.id), [part.id]);
    const fresh = await trx.selectFrom('challan_lines').select('qty').where('challan_id', '=', ready.challan!.id).execute();
    assert.deepEqual(fresh.map((l) => Number(l.qty)), [3], 'a new challan for the three not sent yet');
    assert.equal(ready.openChallans, 0);
    await assert.rejects(invoiceFromChallan(trx, b.orgId, null, part.id, { date: '2026-06-12', dueDate: '2026-06-27' }), /invoiced|Nothing is left/);
  });
});

test('voiding an invoice raised from a challan gives the quantities back to the challan and its order', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 2, ratePaise: 1000_00, gstRatePct: 18 }],
    });
    const dc = await challanFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-02' });
    const inv = await invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-03', dueDate: '2026-06-18' });
    assert.equal((await trx.selectFrom('sales_orders').select('status').where('id', '=', so.id).executeTakeFirstOrThrow()).status, 'invoiced');
    await voidInvoice(trx, b.orgId, null, inv.id, 'Raised twice');
    const dcRow = await trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow();
    const dcLine = await trx.selectFrom('challan_lines').select('qty_invoiced').where('challan_id', '=', dc.id).executeTakeFirstOrThrow();
    const soRow = await trx.selectFrom('sales_orders').select(['status', 'invoiced_amount']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([dcRow.status, Number(dcLine.qty_invoiced), soRow.status, Number(soRow.invoiced_amount)], ['open', 0, 'open', 0]);
    const again = await invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-04', dueDate: '2026-06-19' });
    assert.ok(again.id, 'invoiced again from the challan');
  });
});

test('goods invoiced from the order before they are sent: their challan is invoiced already, and a void of Ready leaves it so', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [{ itemId: b.goods, qty: 10, ratePaise: 1000_00, gstRatePct: 18 }, { itemId: b.service, qty: 5, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const [goodsLine, serviceLine] = await trx.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', so.id).orderBy('line_no').execute();
    // "Invoice part": the goods, before they go out. Then "Deliver part": the same goods.
    await invoiceFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-02', dueDate: '2026-06-17', lines: [{ lineId: goodsLine.id, qty: 10 }] });
    const dc = await challanFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-03', lines: [{ lineId: goodsLine.id, qty: 10 }] });
    const dcRow = await trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.equal(dcRow.status, 'invoiced', 'sent against the invoice already raised');
    await assert.rejects(invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-04', dueDate: '2026-06-19' }), /Nothing is left/);

    // Ready invoices the service only; voiding that leaves the goods' challan invoiced.
    const ready = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-05')).ready!;
    const readyLines = await trx.selectFrom('invoice_lines').select(['source_line_id', 'qty']).where('invoice_id', '=', ready.invoice!.id).execute();
    assert.deepEqual(readyLines.map((l) => [Number(l.source_line_id), Number(l.qty)]), [[serviceLine.id, 5]]);
    await voidInvoice(trx, b.orgId, null, ready.invoice!.id, 'Service price wrong');
    const after = await trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'invoiced');
    const soLines = await trx.selectFrom('sales_order_lines').select('qty_invoiced').where('sales_order_id', '=', so.id).orderBy('line_no').execute();
    assert.deepEqual(soLines.map((l) => Number(l.qty_invoiced)), [10, 0], 'the goods stay invoiced once; the service is open again');
  });
});

test('a challan delivered before Ready, already part invoiced from the order: a void of Ready gives back only its own share', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 10, ratePaise: 1000_00, gstRatePct: 18 }],
    });
    const [line] = await trx.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', so.id).execute();
    await invoiceFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-02', dueDate: '2026-06-17', lines: [{ lineId: line.id, qty: 6 }] });
    const dc = await challanFromSalesOrder(trx, b.orgId, null, so.id, { date: '2026-06-03', lines: [{ lineId: line.id, qty: 10 }] });
    assert.equal((await trx.selectFrom('delivery_challans').select('status').where('id', '=', dc.id).executeTakeFirstOrThrow()).status, 'partially_invoiced', '6 of the 10 invoiced already');
    const ready = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-05')).ready!;
    assert.equal(Number((await trx.selectFrom('invoice_lines').select('qty').where('invoice_id', '=', ready.invoice!.id).executeTakeFirstOrThrow()).qty), 4);
    assert.equal(ready.challan, null);
    await voidInvoice(trx, b.orgId, null, ready.invoice!.id, 'Raised early');
    const dcLine = await trx.selectFrom('challan_lines').select('qty_invoiced').where('challan_id', '=', dc.id).executeTakeFirstOrThrow();
    assert.equal(Number(dcLine.qty_invoiced), 6, 'the 4 Ready invoiced are open again, the 6 before stay');
    const again = await invoiceFromChallan(trx, b.orgId, null, dc.id, { date: '2026-06-06', dueDate: '2026-06-21' });
    assert.equal(Number((await trx.selectFrom('invoice_lines').select('qty').where('invoice_id', '=', again.id).executeTakeFirstOrThrow()).qty), 4);
    assert.equal(Number((await trx.selectFrom('sales_order_lines').select('qty_invoiced').where('id', '=', line.id).executeTakeFirstOrThrow()).qty_invoiced), 10, 'never more than the order');
  });
});

test('due dates by the customer’s terms, end of the month included, on Ready and on the form', async () => {
  assert.equal(dueDateFor('due_end_of_month', '2026-11-05'), '2026-11-30');
  assert.equal(dueDateFor('due_end_of_next_month', '2026-11-05'), '2026-12-31');
  assert.equal(dueDateFor('due_end_of_month', '2027-02-10'), '2027-02-28');
  assert.equal(dueDateFor('net_15', '2026-11-25'), '2026-12-10');
  assert.equal(dueDateFor('due_on_receipt', '2026-11-05'), '2026-11-05');
  await rolledBack(async (trx) => {
    const b = await book(trx);
    await trx.updateTable('contacts').set({ payment_terms: 'due_end_of_month' }).where('id', '=', b.customerId).execute();
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-11-01', lines: [{ itemId: b.service, qty: 1, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const ready = (await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-11-05')).ready!;
    const inv = await trx.selectFrom('invoices').select('due_date').where('id', '=', ready.invoice!.id).executeTakeFirstOrThrow();
    assert.equal(String(inv.due_date).slice(0, 10), '2026-11-30');
  });
});

test('a business not registered for GST prices its quotes and orders with no GST, as its invoices', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    await trx.updateTable('organizations').set({ gst_registration_type: 'unregistered' }).where('id', '=', b.orgId).execute();
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01', lines: [{ itemId: b.goods, qty: 1, ratePaise: 1000_00, gstRatePct: 18 }],
    });
    const row = await trx.selectFrom('sales_orders').select(['total', 'supply_type']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.deepEqual([Number(row.total), row.supply_type], [1000, 'nil_or_exempt']);
    // Moved back to Order received and raised again: the same PI, at Proforma sent.
    const pi = await raiseProforma(trx, b.orgId, so.id, '2026-06-02');
    await setOrderStage(trx, b.orgId, null, so.id, 'order', '2026-06-03');
    const again = await raiseProforma(trx, b.orgId, so.id, '2026-06-04');
    assert.deepEqual([again.number, again.stage], [pi.number, 'proforma']);
  });
});

test('ready for delivery: a typed line with a SAC code is a service, not on the challan', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [
        { itemId: b.goods, qty: 1, ratePaise: 1000_00, gstRatePct: 18 },
        { description: 'Installation charges', hsnSac: '998719', qty: 1, uqc: 'OTH', ratePaise: 750_00, gstRatePct: 18 },
        { description: 'Spare bolts', hsnSac: '7318', qty: 10, uqc: 'NOS', ratePaise: 5_00, gstRatePct: 18 },
      ],
    });
    const ready = await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-04');
    const invLines = await trx.selectFrom('invoice_lines').select('description').where('invoice_id', '=', ready.ready!.invoice!.id).execute();
    assert.equal(invLines.length, 3, 'all three are invoiced');
    const dcLines = await trx.selectFrom('challan_lines').select(['item_id', 'description']).where('challan_id', '=', ready.ready!.challan!.id).orderBy('line_no').execute();
    assert.deepEqual(dcLines.map((l) => l.item_id ?? l.description), [b.goods, 'Spare bolts'], 'the goods travel; the installation does not');
  });
});

test('a services-only order made ready is invoiced without a challan', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const so = await createSalesOrder(trx, b.orgId, null, {
      branchId: b.branchId, customerId: b.customerId, date: '2026-06-01',
      lines: [{ itemId: b.service, qty: 3, ratePaise: 500_00, gstRatePct: 18 }],
    });
    const ready = await setOrderStage(trx, b.orgId, null, so.id, 'ready', '2026-06-04');
    assert.ok(ready.ready!.invoice);
    assert.equal(ready.ready!.challan, null);
  });
});

test('the bank statement as on a date works the books through to the bank', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const bankId = Number((await trx.insertInto('bank_accounts').values({
      org_id: b.orgId, kind: 'bank', name: 'Current Account', ledger_account_id: b.acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
    }).executeTakeFirstOrThrow()).insertId);
    const bank = b.acc[CODE.BANK_DEFAULT];
    const post = (date: string, memo: string, dr: number, cr: number) => postManualJournal(trx, b.orgId, null, {
      branchId: b.branchId, date, memo, approved: true,
      lines: dr ? [{ accountId: bank, debitPaise: dr }, { accountId: b.acc[CODE.SALES], creditPaise: dr }]
        : [{ accountId: b.acc[CODE.RENT], debitPaise: cr }, { accountId: bank, creditPaise: cr }],
    });
    const deposit = await post('2026-07-01', 'Cash sale banked', 50_000_00, 0);
    const lateDeposit = await post('2026-07-30', 'Cheque deposited', 8_000_00, 0);
    const cleared = await post('2026-07-05', 'Rent by cheque 101', 0, 20_000_00);
    await post('2026-07-28', 'Cheque 102 to landlord', 0, 5_000_00);

    let n = 0;
    const line = (date: string, narration: string, deposit: number, withdrawal: number, balance: number, matched?: number) =>
      trx.insertInto('bank_transactions').values({
        org_id: b.orgId, bank_account_id: bankId, txn_date: date, narration, dedupe_hash: `h${++n}`,
        deposit: (deposit / 100).toFixed(4), withdrawal: (withdrawal / 100).toFixed(4), running_balance: (balance / 100).toFixed(4),
        status: matched ? 'matched' : 'unmatched', matched_type: matched ? 'journal_entry' : null, matched_id: matched ?? null,
      }).execute();
    await line('2026-07-01', 'BY CASH', 50_000_00, 0, 50_000_00, Number(deposit.id));
    await line('2026-07-06', 'CHQ 101', 0, 20_000_00, 30_000_00, Number(cleared.id));
    await line('2026-07-29', 'SMS CHARGES', 0, 59_00, 29_941_00);
    await line('2026-07-31', 'INTEREST', 120_00, 0, 30_061_00);

    const s = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-31');
    assert.equal(s.bookPaise, 50_000_00 + 8_000_00 - 20_000_00 - 5_000_00);
    assert.deepEqual(s.notPresented.map((i) => i.amountPaise), [5_000_00], 'cheque 102 not presented');
    assert.deepEqual(s.notCredited.map((i) => i.amountPaise), [8_000_00], 'the cheque deposited not credited');
    assert.equal(s.notCredited[0].entryId, String(lateDeposit.id));
    assert.deepEqual(s.bankDebits.map((i) => i.amountPaise), [59_00]);
    assert.deepEqual(s.bankCredits.map((i) => i.amountPaise), [120_00]);
    assert.equal(s.computedPaise, 30_061_00);
    assert.equal(s.statementPaise, 30_061_00);
    assert.equal(s.differencePaise, 0, 'agrees to the paisa');

    // As on an earlier day: only what had happened by then.
    const early = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-05');
    assert.equal(early.bookPaise, 30_000_00);
    assert.deepEqual(early.notPresented.map((i) => i.amountPaise), [20_000_00], 'cheque 101 cleared on the 6th, not by the 5th');
    assert.equal(early.statementPaise, 50_000_00);
    assert.equal(early.differencePaise, 0);
  });
});

test('the bank statement: a cheque issued before the first statement line, and a receipt booked after the bank had it', async () => {
  await rolledBack(async (trx) => {
    const b = await book(trx);
    const bankId = Number((await trx.insertInto('bank_accounts').values({
      org_id: b.orgId, kind: 'bank', name: 'Current Account', ledger_account_id: b.acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
    }).executeTakeFirstOrThrow()).insertId);
    const bank = b.acc[CODE.BANK_DEFAULT];
    const post = (date: string, memo: string, dr: number, cr: number) => postManualJournal(trx, b.orgId, null, {
      branchId: b.branchId, date, memo, approved: true,
      lines: dr ? [{ accountId: bank, debitPaise: dr }, { accountId: b.acc[CODE.SALES], creditPaise: dr }]
        : [{ accountId: b.acc[CODE.RENT], debitPaise: cr }, { accountId: bank, creditPaise: cr }],
    });
    await post('2026-06-20', 'Capital banked', 100_000_00, 0); // before the statement: in its opening balance
    const cheque = await post('2026-06-28', 'Cheque 100 to landlord', 0, 10_000_00);
    const receipt = await post('2026-08-02', 'Receipt from Acme', 3_000_00, 0);

    let n = 0;
    const line = (date: string, narration: string, deposit: number, withdrawal: number, balance: number, matched?: number) =>
      trx.insertInto('bank_transactions').values({
        org_id: b.orgId, bank_account_id: bankId, txn_date: date, narration, dedupe_hash: `p${++n}`,
        deposit: (deposit / 100).toFixed(4), withdrawal: (withdrawal / 100).toFixed(4), running_balance: (balance / 100).toFixed(4),
        status: matched ? 'matched' : 'unmatched', matched_type: matched ? 'journal_entry' : null, matched_id: matched ?? null,
      }).execute();
    await line('2026-07-01', 'INTEREST', 50_00, 0, 100_050_00);
    await line('2026-07-05', 'CHQ 100', 0, 10_000_00, 90_050_00, Number(cheque.id));
    await line('2026-07-31', 'NEFT ACME', 3_000_00, 0, 93_050_00, Number(receipt.id));

    const before = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-03');
    assert.equal(before.bookPaise, 90_000_00);
    assert.deepEqual(before.notPresented.map((i) => i.amountPaise), [10_000_00], 'issued before the first line, presented after the date');
    assert.equal(before.differencePaise, 0);

    const monthEnd = await bankStatementAsOn(trx, b.orgId, bankId, '2026-07-31');
    assert.equal(monthEnd.bookPaise, 90_000_00);
    assert.deepEqual(monthEnd.notPresented, [], 'the cheque was presented on the 5th');
    assert.deepEqual(monthEnd.bankCredits.map((i) => i.amountPaise), [50_00, 3_000_00], 'the NEFT is in the bank, not yet in the books');
    assert.match(monthEnd.bankCredits[1].particulars, /in the books on 2026-08-02/);
    assert.equal(monthEnd.differencePaise, 0);

    const after = await bankStatementAsOn(trx, b.orgId, bankId, '2026-08-05');
    assert.deepEqual(after.bankCredits.map((i) => i.amountPaise), [50_00]);
    assert.equal(after.differencePaise, 0);
  });
});

test('invoices are paid, partially paid or unpaid; overdue is days past the due date', () => {
  assert.deepEqual(['paid', 'partially_paid', 'sent', 'approved', 'overdue', 'draft', 'void'].map(paymentStatusOf),
    ['paid', 'partially_paid', 'unpaid', 'unpaid', 'unpaid', 'draft', 'cancelled']);
  const t = new Date(2026, 10, 3);
  assert.equal(daysOverdue('2026-10-24', 500_00, t), 10);
  assert.equal(daysOverdue('2026-11-10', 500_00, t), 0, 'not yet due');
  assert.equal(daysOverdue('2026-10-24', 0, t), 0, 'nothing owed');
});

test('the company profile lists, and the country list', () => {
  assert.equal(COMPANY_TYPES.length, 8);
  assert.equal(BUSINESS_NATURES.length, 8);
  assert.equal(companyTypeFrom('Private Limited Company'), 'Private limited company');
  assert.equal(companyTypeFrom('Partnership firm or LLP'), 'Partnership firm', 'the PAN cannot tell a firm from an LLP; a firm is the commoner');
  assert.equal(companyTypeFrom('Limited Liability Partnership'), 'Limited liability partnership (LLP)');
  assert.equal(companyTypeFrom('Society/ Club/ Trust/ AOP'), 'Trust, society or AOP');
  assert.equal(companyTypeFrom('Government Department'), 'Government or local authority');
  assert.equal(companyTypeFrom('Company'), 'Private limited company');
  assert.equal(PARTY_KINDS.length, 9);
  assert.equal(companyTypeFrom('Proprietorship'), 'Sole proprietorship');
  assert.equal(companyTypeFrom('One person company'), 'One person company (OPC)');
  assert.equal(companyTypeFrom(''), null);
  assert.equal(countryName('AE'), 'United Arab Emirates');
  assert.equal(countryCurrency('AE'), 'AED');
  assert.equal(countryCurrency('DE'), 'EUR');
  assert.ok(!COUNTRIES.some((c) => c.code === 'IN'), 'India is not an international country');
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length, 'no country twice');
});

test.after(() => db.destroy());
