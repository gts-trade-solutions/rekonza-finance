// Every document prints, goes by email, opens from a link and from the portal,
// as in Zoho Books (lib/print-doc.ts, migration 100): quotes, sales orders,
// delivery challans, credit notes, retainers, receipts, purchase orders,
// vendor credits, payment advices and bills; quotes, orders and POs clone.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/document-print.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createChallan, createCreditNote, createEstimate, createRetainer, createSalesOrder } from '../../lib/server/services/sales-documents';
import { createPurchaseOrder, createVendorCredit } from '../../lib/server/services/purchase-documents';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment, receivePayment } from '../../lib/server/services/payments';
import { documentParty, printableDocument } from '../../lib/server/services/document-print';
import { cloneDocument } from '../../lib/server/services/clone-document';
import { openShareLink } from '../../lib/server/services/sharing';
import { createPortalLink } from '../../lib/server/services/portal';
import { emailDocument } from '../../lib/server/mail/documents';
import { setMailTransport, type OutgoingMail } from '../../lib/server/mail/mailer';
import { EMAIL_KINDS, listTemplates, renderEmail, saveTemplate } from '../../lib/server/mail/templates';
import { wipeOrganizations } from '../../lib/server/seed/wipe';
import { GET as shareGet } from '../../app/api/share/[token]/route';
import { GET as portalDocGet } from '../../app/api/portal/[token]/document/[kind]/[id]/route';

const gstinFor = (orgId: number) => `33AABCP${String(orgId % 10_000).padStart(4, '0')}P1Z4`;

interface Book { orgId: number; branchId: number; customer: number; vendor: number; bankId: number; acc: Record<string, number> }

async function makeBook(trx: Trx, name: string): Promise<Book> {
  const orgId = Number((await trx.insertInto('organizations').values({ name }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({
    // Unique to this book: another test file running alongside may hold a branch with any fixed GSTIN.
    org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: gstinFor(orgId), address: '1 Mount Road', city: 'Chennai', pincode: '600002',
  }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const acc = await accountIds(trx, orgId) as Record<string, number>;
  const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', bank_name: 'HDFC', account_number: '50100012345678', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
  const mk = (kind: string, display: string, extra: Record<string, unknown>) =>
    trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: display, state_code: '33', gst_treatment: 'unregistered', ...extra } as never)
      .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
  return {
    orgId, branchId, bankId, acc,
    customer: await mk('customer', 'Kumar Stores', { email: `kumar-${orgId}@x.test`, billing_address: '9 Anna Salai', phone: '9876543210' }),
    vendor: await mk('vendor', 'Steel Co', { email: `steel-${orgId}@x.test` }),
  };
}

async function withBook(fn: (trx: Trx, b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx, await makeBook(trx, 'Print Co')); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (rupees: number, gst = 18) => [{ description: 'Steel rods', qty: 2, ratePaise: rupees * 100, gstRatePct: gst }];
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> });

test('each of the ten documents prints from what is stored: title, number, party, lines, tax and totals', async () => {
  await withBook(async (trx, b) => {
    const { orgId, branchId, customer, vendor, bankId } = b;
    const est = await createEstimate(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', expiryDate: '2026-10-16', lines: line(500), notes: 'Delivery in a week' });
    const q = await printableDocument(trx, orgId, 'estimate', est.id);
    assert.equal(q.title, 'Quotation');
    assert.equal(q.number, est.number);
    assert.equal(q.tag, 'Draft');
    assert.equal(q.taxColumns, 'split', 'Tamil Nadu to Tamil Nadu: CGST and SGST');
    assert.deepEqual(q.facts.map((f) => f.label), ['Quote no.', 'Quote date', 'Valid until']);
    assert.equal(q.facts[2].value, '16 Oct 2026');
    assert.equal(q.party.name, 'Kumar Stores');
    assert.equal(q.seller.gstin, gstinFor(orgId));
    assert.equal(q.lines[0].qty, 2);
    assert.equal(q.lines[0].taxablePaise, 1000_00);
    assert.equal(q.lines[0].cgstPaise, 90_00);
    assert.equal(q.totalPaise, est.totalPaise);
    assert.equal(q.totals.reduce((s, t) => s + t.paise, 0), q.totalPaise, 'the rows add up to the total');
    assert.equal(q.notes, 'Delivery in a week');

    const so = await createSalesOrder(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-02', expectedShipDate: '2026-10-09', lines: line(500) });
    const o = await printableDocument(trx, orgId, 'sales-order', so.id);
    assert.equal(o.title, 'Sales Order');
    assert.ok(o.facts.some((f) => f.label === 'Expected shipment' && f.value === '09 Oct 2026'));

    const dc = await createChallan(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-03', challanType: 'job_work', lines: [{ description: 'Dies', qty: 3, ratePaise: 200_00 }] });
    const c = await printableDocument(trx, orgId, 'challan', dc.id);
    assert.equal(c.title, 'Delivery Challan');
    assert.deepEqual(c.copies, ['Original for consignee', 'Duplicate for transporter', 'Triplicate for consigner'], 'Rule 55: triplicate');
    assert.equal(c.endorsement, 'Purpose: Sent for job work');
    assert.equal(c.seller.label, 'Consigner');
    assert.equal(c.party.label, 'Consignee');
    assert.equal(c.totalPaise, 600_00);

    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-04', dueDate: '2026-10-20', status: 'approved', lines: line(500) });
    const cnId = (await createCreditNote(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-05', reason: 'Damaged in transit', againstInvoiceId: inv.id, lines: line(100) })).id;
    const cn = await printableDocument(trx, orgId, 'credit-note', cnId);
    assert.equal(cn.title, 'Credit Note');
    assert.match(cn.endorsement ?? '', new RegExp(`Against invoice ${inv.number} dated 04 Oct 2026`), 'Rule 53(1A): names the invoice');
    assert.match(cn.endorsement ?? '', /Damaged in transit/);

    const ret = await createRetainer(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-06', description: 'Advance for the dies', amountPaise: 5_000_00, status: 'draft' });
    const r = await printableDocument(trx, orgId, 'retainer', ret.id);
    assert.equal(r.title, 'Service Invoice');
    assert.deepEqual(r.after.map((a) => [a.label, a.paise]), [['Paid', 0], ['Balance due', 5_000_00]]);

    const rec = await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-10-10', mode: 'neft', reference: 'UTR123', amountPaise: 800_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 500_00 }],
    });
    const pr = await printableDocument(trx, orgId, 'payment-received', rec.id);
    assert.equal(pr.title, 'Payment Receipt');
    assert.equal(pr.totalPaise, 800_00);
    assert.deepEqual(pr.allocations?.rows.map((x) => [x.number, x.paise]), [[inv.number, 500_00]]);
    assert.deepEqual(pr.after, [{ label: 'In excess, held as an advance', paise: 300_00 }]);
    assert.ok(pr.facts.some((f) => f.label === 'Mode' && f.value === 'NEFT'));
    assert.ok(pr.facts.some((f) => f.label === 'Deposited to' && f.value.endsWith('5678')), 'only the last four digits of the account');
    await assert.rejects(printableDocument(trx, orgId, 'payment-made', rec.id), /does not exist/, 'a receipt is not a payment made');

    const po = await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-10-07', expectedDate: '2026-10-14', lines: line(300), status: 'draft' });
    const p = await printableDocument(trx, orgId, 'purchase-order', po.id);
    assert.equal(p.title, 'Purchase Order');
    assert.equal(p.seller.label, 'Buyer');
    assert.equal(p.party.name, 'Steel Co');
    assert.equal(p.shipTo?.label, 'Deliver to');
    assert.equal(p.shipTo?.address, '1 Mount Road', 'goods come to the branch');

    const bill = await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'SC-77', date: '2026-10-08', dueDate: '2026-10-28', status: 'open', lines: line(300) } as never);
    const bl = await printableDocument(trx, orgId, 'bill', bill.id);
    assert.equal(bl.number, 'SC-77');
    assert.ok(bl.after.some((a) => a.label === 'Balance due' && a.paise === bl.totalPaise));

    const vc = await createVendorCredit(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-10-09', reason: 'Short supply', againstBillId: bill.id, amountPaise: 100_00, gstRatePct: 0 });
    const v = await printableDocument(trx, orgId, 'vendor-credit', vc.id);
    assert.equal(v.title, 'Vendor Credit');
    assert.match(v.endorsement ?? '', /Against your bill SC-77/);

    const pay = await makePayment(trx, orgId, null, {
      branchId, contactId: vendor, date: '2026-10-12', mode: 'rtgs', amountPaise: 200_00, bankAccountId: bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 200_00 }],
    });
    const pm = await printableDocument(trx, orgId, 'payment-made', pay.id);
    assert.equal(pm.title, 'Payment Advice');
    assert.equal(pm.party.label, 'Paid to');
    assert.deepEqual(pm.allocations?.rows.map((x) => x.number), ['SC-77'], 'the vendor’s own bill number');

    // Whose each one is, for the portal's check.
    assert.deepEqual(await documentParty(trx, orgId, 'estimate', est.id), { contactId: customer, status: 'draft' });
    assert.deepEqual(await documentParty(trx, orgId, 'payment-made', pay.id), { contactId: vendor, status: 'cleared' });
    assert.equal(await documentParty(trx, orgId, 'payment-received', pay.id), null);
    await assert.rejects(printableDocument(trx, orgId + 1, 'estimate', est.id), /does not exist/, 'another book cannot read it');
  });
});

test('clone: a quote, an order and a PO come back dated today with the same lines; nothing that posts is cloned', async () => {
  await withBook(async (trx, { orgId, branchId, customer, vendor }) => {
    const est = await createEstimate(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-01', expiryDate: '2026-09-11', lines: line(250), status: 'sent' });
    const copy = await cloneDocument(trx, orgId, null, 'estimate', est.id, '2026-10-20');
    assert.notEqual(copy.number, est.number);
    const row = await trx.selectFrom('estimates').selectAll().where('id', '=', copy.id).executeTakeFirstOrThrow();
    assert.equal(String(row.estimate_date).slice(0, 10), '2026-10-20');
    assert.equal(String(row.expiry_date).slice(0, 10), '2026-10-30', 'as long to accept as the original gave');
    assert.equal(row.status, 'draft');
    assert.equal(copy.totalPaise, est.totalPaise);

    const so = await createSalesOrder(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-02', lines: line(250) });
    const soCopy = await cloneDocument(trx, orgId, null, 'sales-order', so.id, '2026-10-20');
    assert.equal(soCopy.totalPaise, so.totalPaise);
    const po = await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-09-03', lines: line(120) });
    const poCopy = await cloneDocument(trx, orgId, null, 'purchase-order', po.id, '2026-10-20');
    const poRow = await trx.selectFrom('purchase_orders').select(['status', 'total']).where('id', '=', poCopy.id).executeTakeFirstOrThrow();
    assert.equal(poRow.status, 'draft', 'a cloned PO waits to be issued');
    assert.equal((await trx.selectFrom('purchase_order_lines').select('id').where('purchase_order_id', '=', poCopy.id).execute()).length, 1);

    await assert.rejects(cloneDocument(trx, orgId, null, 'challan', 1), /Only quotes, sales orders and purchase orders/);
    await assert.rejects(cloneDocument(trx, orgId, null, 'credit-note', 1), /Only quotes/);
    await assert.rejects(cloneDocument(trx, orgId + 1, null, 'estimate', est.id), /does not exist/);
  });
});

test('email templates: one for each document, worded like Zoho, editable, and the link cannot be left out', async () => {
  await withBook(async (trx, { orgId }) => {
    for (const k of ['quote', 'sales_order', 'challan', 'credit_note', 'retainer', 'payment_receipt', 'purchase_order', 'vendor_credit', 'payment_advice']) {
      assert.ok((EMAIL_KINDS as string[]).includes(k), `${k} has a template`);
    }
    const list = await listTemplates(trx, orgId);
    assert.equal(list.length, EMAIL_KINDS.length);
    const quote = list.find((t) => t.kind === 'quote')!;
    assert.match(quote.body, /\{link\}/);
    await assert.rejects(saveTemplate(trx, orgId, null, 'quote', { subject: 'Our quote', body: 'Here it is.' }), /Keep \{link\}.*recipient cannot open the document/);
    await assert.rejects(saveTemplate(trx, orgId, null, 'quote', { subject: 'Quote', body: '{link} {due_date}' }), /\{due_date\} is not a placeholder/);
    await saveTemplate(trx, orgId, null, 'quote', { subject: 'Quote {number} for {party}', body: 'Namaste {party}, {document} {number}: {link}' });
    const m = await renderEmail(trx, orgId, 'quote', { party: 'Kumar Stores', document: 'quote', number: 'QT-1', link: 'https://x/s/1' });
    assert.equal(m.subject, 'Quote QT-1 for Kumar Stores');
    assert.equal(m.text, 'Namaste Kumar Stores, quote QT-1: https://x/s/1');
  });
});

test('emailed, a document opens from its link and from the portal; a draft quote becomes sent and a draft PO is issued', async () => {
  const sent: OutgoingMail[] = [];
  setMailTransport(async (m) => { sent.push(m); return { messageId: `t${sent.length}` }; });
  let orgId = 0;
  try {
    const setup = await transaction(async (trx) => {
      const b = await makeBook(trx, 'Print Mail Co (temporary)');
      const est = await createEstimate(trx, b.orgId, null, { branchId: b.branchId, customerId: b.customer, date: '2026-10-01', expiryDate: '2026-10-16', lines: line(500), status: 'draft' });
      const draftEst = await createEstimate(trx, b.orgId, null, { branchId: b.branchId, customerId: b.customer, date: '2026-10-01', expiryDate: '2026-10-16', lines: line(50), status: 'draft' });
      const po = await createPurchaseOrder(trx, b.orgId, null, { branchId: b.branchId, vendorId: b.vendor, date: '2026-10-07', lines: line(300), status: 'draft' });
      const other = Number((await trx.insertInto('contacts').values({ org_id: b.orgId, kind: 'customer', display_name: 'No Mail Ltd', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const silent = await createEstimate(trx, b.orgId, null, { branchId: b.branchId, customerId: other, date: '2026-10-01', expiryDate: '2026-10-16', lines: line(10), status: 'sent' });
      const portal = await createPortalLink(trx, b.orgId, null, { contactId: b.customer, side: 'customer' });
      const vendorPortal = await createPortalLink(trx, b.orgId, null, { contactId: b.vendor, side: 'vendor' });
      return { ...b, est: est.id, estNo: est.number, draftEst: draftEst.id, po: po.id, silent: silent.id, portal: portal.path.split('/').pop()!, vendorPortal: vendorPortal.path.split('/').pop()! };
    });
    orgId = setup.orgId;

    const r = await emailDocument(orgId, null, 'estimate', setup.est, { baseUrl: 'https://books.test' });
    assert.deepEqual(r.to, [`kumar-${orgId}@x.test`], 'to the customer’s address');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, `Quote ${setup.estNo} from Print Mail Co (temporary)`);
    assert.match(sent[0].text, /Thank you for your enquiry/);
    assert.match(sent[0].text, /It is valid until 16 Oct 2026\./);
    const url = /https:\/\/books\.test(\/share\/[A-Za-z0-9_-]+)/.exec(sent[0].text)?.[1];
    assert.ok(url, 'the email carries the link');
    assert.equal((await db.selectFrom('estimates').select('status').where('id', '=', setup.est).executeTakeFirstOrThrow()).status, 'sent');
    const log = await db.selectFrom('email_log').select(['doc_type', 'doc_id']).where('org_id', '=', orgId).execute();
    assert.deepEqual(log.map((l) => [l.doc_type, Number(l.doc_id)]), [['estimate', setup.est]]);

    // The link: the printed quote, without signing in.
    const token = url!.split('/').pop()!;
    const opened = await openShareLink(db, token);
    assert.equal(opened?.docType, 'document');
    assert.equal(opened?.docKind, 'estimate');
    const shared = await json(await shareGet(new Request(`https://books.test/api/share/${token}`), { params: Promise.resolve({ token }) }));
    assert.equal(shared.status, 200);
    assert.equal(shared.body.kind, 'document');
    assert.equal((shared.body.doc as { number: string }).number, setup.estNo);

    // A PO goes to the vendor and is issued by being sent.
    await emailDocument(orgId, null, 'purchase-order', setup.po, { baseUrl: 'https://books.test', message: 'Please confirm by Friday.' });
    assert.deepEqual(sent[1].to, [`steel-${orgId}@x.test`]);
    assert.match(sent[1].text, /^Please confirm by Friday\.\n\nView or download it here: https:\/\/books\.test\/share\//, 'a typed message keeps the link');
    assert.equal((await db.selectFrom('purchase_orders').select('status').where('id', '=', setup.po).executeTakeFirstOrThrow()).status, 'open');

    await assert.rejects(emailDocument(orgId, null, 'estimate', setup.silent), /No Mail Ltd has no email address/);
    await assert.rejects(emailDocument(orgId, null, 'bill', 1), /vendor’s own document/);
    assert.equal(sent.length, 2, 'nothing sent for the refusals');

    // The portal: the customer's own sent quote opens; a draft, another kind's side or another contact's does not.
    const get = (tok: string, kind: string, id: number) => portalDocGet(new Request(`https://books.test/api/portal/${tok}/document/${kind}/${id}`), { params: Promise.resolve({ token: tok, kind, id: String(id) }) }).then(json);
    const mine = await get(setup.portal, 'estimate', setup.est);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.title, 'Quotation');
    assert.equal((await get(setup.portal, 'estimate', setup.draftEst)).status, 404, 'a draft is not on the portal');
    assert.equal((await get(setup.portal, 'estimate', setup.silent)).status, 404, 'another customer’s quote');
    assert.equal((await get(setup.portal, 'purchase-order', setup.po)).status, 404, 'a customer has no purchase orders');
    assert.equal((await get(setup.vendorPortal, 'purchase-order', setup.po)).status, 200, 'the vendor sees their issued PO');
    assert.equal((await get('not-a-real-token-but-long-enough', 'estimate', setup.est)).status, 404);
  } finally {
    setMailTransport(null);
    if (orgId) await wipeOrganizations(db, [orgId]);
  }
});

test.after(async () => {
  await db.destroy();
});
