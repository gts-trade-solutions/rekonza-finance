// The customer and vendor portal, made to work as Zoho Books' does (migration
// 094): signing in by an emailed code, comments on documents and the
// business's replies, a contact keeping their own details, a vendor's new bank
// account held for approval, purchase orders accepted or declined, the Portal
// activities report, and which files a portal may open.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/portal-zoho.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createPurchaseOrder } from '../../lib/server/services/purchase-documents';
import {
  contactPortalComments, createPortalLink, decidePortalRequest, listPortalRequests, logPortalActivity, openPortal, portalActivityReport,
  portalComment, portalFile, portalOverview, PORTAL_SHARED_FOLDER, PORTAL_UPLOAD_FOLDER, replyOnPortal, requestBankChange, respondToOrder,
  revokePortalLinks, updatePortalProfile,
} from '../../lib/server/services/portal';
import { portalsFor, requestPortalCode, verifyPortalCode } from '../../lib/server/services/portal-login';
import { setMailTransport, type OutgoingMail } from '../../lib/server/mail/mailer';
import { isSealed, unseal } from '../../lib/server/crypto/fields';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; other: number; vendor: number; email: string }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  const email = `portal-${randomBytes(4).toString('hex')}@x.test`;
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Portal Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCP9494P1Z4' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const mk = (kind: string, name: string, extra: Record<string, unknown> = {}) =>
        trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered', ...extra } as never)
          .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      await fn({
        trx, orgId, branchId, email,
        customer: await mk('customer', 'Kumar Stores', { email }),
        other: await mk('customer', 'Other Stores', { email: `other-${email}` }),
        vendor: await mk('vendor', 'Steel Co', { email: `vendor-${email}`, bank_name: 'Old Bank', bank_account_name: 'Steel Co', bank_account_no: '111122223333', bank_ifsc: 'HDFC0000001' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const goods = (rupees: number) => [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }];

test('sign-in by email: only an address with a live portal gets a code; the code is single-use, five tries, and opens each of its portals', async () => {
  const sent: OutgoingMail[] = [];
  setMailTransport(async (m) => { sent.push(m); return { messageId: `t${sent.length}` }; });
  try {
    await withBook(async ({ trx, orgId, customer, email }) => {
      // No portal yet: the same answer, and nothing sent.
      const generic = await requestPortalCode(trx, email);
      assert.match(generic.message, /If that address has a portal/);
      assert.equal(sent.length, 0, 'no portal, no email');
      await assert.rejects(requestPortalCode(trx, 'not-an-email'), /email address/);

      await createPortalLink(trx, orgId, null, { contactId: customer, side: 'customer' });
      assert.deepEqual((await portalsFor(trx, email.toUpperCase())).map((m) => m.contactId), [customer], 'case does not matter');
      assert.deepEqual(await requestPortalCode(trx, email), generic, 'the reply does not say whether the address is known');
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].to, [email]);
      const code = /(\d{6})/.exec(sent[0].subject)?.[1] ?? '';
      assert.equal(code.length, 6);
      const row = await trx.selectFrom('portal_login_codes').select(['code_hash']).where('email', '=', email).executeTakeFirstOrThrow();
      assert.ok(!row.code_hash.includes(code) && row.code_hash.length === 64, 'only a hash of the code is kept');

      const wrong = code === '000000' ? '111111' : '000000';
      await assert.rejects(verifyPortalCode(trx, email, wrong), /not right/);
      await assert.rejects(verifyPortalCode(trx, email, '12ab56'), /six digits/);
      const ok = await verifyPortalCode(trx, email, code);
      assert.equal(ok.portals.length, 1);
      assert.equal(ok.portals[0].side, 'customer');
      assert.equal(ok.portals[0].contactName, 'Kumar Stores');
      assert.deepEqual(await openPortal(trx, ok.portals[0].path.replace('/portal/', '')), { orgId, contactId: customer, side: 'customer' }, 'the link it gives opens that customer');
      await assert.rejects(verifyPortalCode(trx, email, code), /not right/, 'a code works once');
      const signedIn = await trx.selectFrom('portal_activity').select('action').where('org_id', '=', orgId).where('contact_id', '=', customer).execute();
      assert.deepEqual(signedIn.map((a) => a.action), ['signed_in']);

      // Five wrong tries and the code is spent, right or not.
      await requestPortalCode(trx, email);
      const code2 = /(\d{6})/.exec(sent[1].subject)?.[1] ?? '';
      const bad = code2 === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await assert.rejects(verifyPortalCode(trx, email, bad), /not right/);
      await assert.rejects(verifyPortalCode(trx, email, code2), /not right/, 'locked after five wrong tries');

      // A contact person's address opens the same portal; a withdrawn portal opens nothing.
      const person = `person-${email}`;
      await trx.insertInto('contact_persons').values({ org_id: orgId, contact_id: customer, name: 'Ravi', email: person } as never).execute();
      assert.deepEqual((await portalsFor(trx, person)).map((m) => m.contactId), [customer]);
      await revokePortalLinks(trx, orgId, customer);
      assert.deepEqual(await portalsFor(trx, email), []);
    });
  } finally {
    setMailTransport(null);
  }
});

test('comments: a contact comments on their own documents only; the business replies and both sides see the thread', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, other, vendor }) => {
    const mine = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved', lines: goods(1_000) });
    const theirs = await createInvoice(trx, orgId, null, { branchId, customerId: other, date: '2026-09-01', dueDate: '2026-09-15', status: 'approved', lines: goods(500) });
    const r = await portalComment(trx, orgId, customer, 'customer', 'Kumar Stores', { targetType: 'invoice', targetId: mine.id, body: '  Please send the delivery challan too.  ' });
    assert.equal(r.label, 'invoice');
    await assert.rejects(portalComment(trx, orgId, customer, 'customer', 'Kumar Stores', { targetType: 'invoice', targetId: theirs.id, body: 'Hi' }), /not yours/);
    await assert.rejects(portalComment(trx, orgId, vendor, 'vendor', 'Steel Co', { targetType: 'invoice', targetId: mine.id, body: 'Hi' }), /cannot be commented/);
    await assert.rejects(portalComment(trx, orgId, customer, 'customer', 'Kumar Stores', { targetType: 'invoice', targetId: mine.id, body: '   ' }), /Write the comment/);

    const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Anita', email: `staff-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
    await replyOnPortal(trx, orgId, customer, 'customer', { userId, name: 'Anita' }, { targetType: 'invoice', targetId: mine.id, body: 'Attached on the portal now.' });
    await assert.rejects(replyOnPortal(trx, orgId, customer, 'customer', { userId, name: 'Anita' }, { targetType: 'invoice', targetId: theirs.id, body: 'x' }), /not this contact/);

    const view = await portalOverview(trx, orgId, customer, 'customer');
    const thread = view.comments[`invoice:${mine.id}`];
    assert.deepEqual(thread.map((c) => [c.fromPortal, c.body]), [[true, 'Please send the delivery challan too.'], [false, 'Attached on the portal now.']]);
    assert.equal(thread[0].author, 'Kumar Stores (portal)');
    assert.equal(view.comments[`invoice:${theirs.id}`], undefined);
    const staff = await contactPortalComments(trx, orgId, customer, 'customer');
    assert.equal(staff.length, 2);
    assert.ok(staff.every((c) => c.targetType === 'invoice' && c.targetId === String(mine.id)));
    assert.deepEqual(await contactPortalComments(trx, orgId, other, 'customer'), []);
  });
});

test('profile: a contact keeps their own email, phone and addresses; bad values are refused', async () => {
  await withBook(async ({ trx, orgId, customer, email }) => {
    const r = await updatePortalProfile(trx, orgId, customer, { email, phone: ' 98400 12345 ', billingAddress: '12 Anna Salai', billingCity: 'Chennai', billingPincode: '600002', shippingAddress: '' });
    assert.deepEqual(r.changed.sort(), ['billing address', 'billing city', 'billing pincode', 'phone'], 'only what changed; an empty field that was empty is not a change');
    const c = await trx.selectFrom('contacts').select(['phone', 'billing_city', 'billing_pincode', 'shipping_address']).where('id', '=', customer).executeTakeFirstOrThrow();
    assert.deepEqual([c.phone, c.billing_city, c.billing_pincode, c.shipping_address], ['98400 12345', 'Chennai', '600002', null]);
    await assert.rejects(updatePortalProfile(trx, orgId, customer, { billingPincode: '60002' }), /six digits/);
    await assert.rejects(updatePortalProfile(trx, orgId, customer, { email: 'nope' }), /does not look right/);
    await assert.rejects(updatePortalProfile(trx, orgId, customer, {}), /Nothing to change/);
    const view = await portalOverview(trx, orgId, customer, 'customer');
    assert.equal(view.profile.billingCity, 'Chennai');
  });
});

test('bank details: a vendor’s new account waits, sealed, for the business to approve; approving writes it, turning down leaves the old one', async () => {
  const before = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    await withBook(async ({ trx, orgId, vendor }) => {
      await assert.rejects(requestBankChange(trx, orgId, vendor, { bankName: 'New', accountName: 'Steel Co', accountNo: '12', ifsc: 'ICIC0001234' }), /6 to 20 digits/);
      await assert.rejects(requestBankChange(trx, orgId, vendor, { bankName: 'New', accountName: 'Steel Co', accountNo: '999988887777', ifsc: 'ICIC1001234' }), /IFSC/);
      await assert.rejects(requestBankChange(trx, orgId, vendor, { bankName: 'New', accountName: ' ', accountNo: '999988887777', ifsc: 'ICIC0001234' }), /name the account/);

      const first = await requestBankChange(trx, orgId, vendor, { bankName: 'ICICI', accountName: 'Steel Co', accountNo: '5555 6666 7777', ifsc: 'icic0001234' });
      assert.equal(first.accountLast4, '7777');
      const stored = await trx.selectFrom('portal_requests').select('payload').where('id', '=', first.id).executeTakeFirstOrThrow();
      const payload = (typeof stored.payload === 'string' ? JSON.parse(stored.payload) : stored.payload) as { accountNo: string; ifsc: string };
      assert.ok(isSealed(payload.accountNo), 'the account number is sealed at rest');
      assert.equal(unseal(payload.accountNo), '555566667777');
      assert.equal(payload.ifsc, 'ICIC0001234');
      let c = await trx.selectFrom('contacts').select(['bank_account_no', 'bank_ifsc']).where('id', '=', vendor).executeTakeFirstOrThrow();
      assert.deepEqual([c.bank_account_no, c.bank_ifsc], ['111122223333', 'HDFC0000001'], 'nothing changes until someone approves');

      const view = await portalOverview(trx, orgId, vendor, 'vendor');
      if (view.side !== 'vendor') throw new Error('vendor view');
      assert.equal(view.bank?.accountLast4, '3333', 'the portal shows only the last four digits');
      assert.ok(view.bankChangePendingSince);

      // Asking again replaces the earlier request; only one is ever waiting.
      const second = await requestBankChange(trx, orgId, vendor, { bankName: 'Axis', accountName: 'Steel Co Pvt Ltd', accountNo: '123456789012', ifsc: 'UTIB0000123' });
      const list = await listPortalRequests(trx, orgId, vendor);
      assert.deepEqual(list.map((r) => [r.id, r.status]), [[String(second.id), 'pending'], [String(first.id), 'rejected']]);
      assert.equal(list[0].accountNoMasked, '••••9012');

      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'AP', email: `ap-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
      await assert.rejects(decidePortalRequest(trx, orgId, userId, first.id, 'applied'), /already rejected/);
      const done = await decidePortalRequest(trx, orgId, userId, second.id, 'applied');
      assert.deepEqual(done, { contactId: vendor, kind: 'bank_details', email: null, accountLast4: '9012' });
      c = await trx.selectFrom('contacts').select(['bank_account_no', 'bank_ifsc']).where('id', '=', vendor).executeTakeFirstOrThrow();
      assert.ok(isSealed(c.bank_account_no), 'written to the vendor sealed');
      assert.equal(unseal(c.bank_account_no), '123456789012');
      assert.equal(c.bank_ifsc, 'UTIB0000123');
      await assert.rejects(decidePortalRequest(trx, orgId, userId, second.id, 'rejected'), /already applied/);

      const third = await requestBankChange(trx, orgId, vendor, { bankName: 'Fraud', accountName: 'Someone', accountNo: '000011112222', ifsc: 'SBIN0000001' });
      await decidePortalRequest(trx, orgId, userId, third.id, 'rejected');
      assert.equal(unseal((await trx.selectFrom('contacts').select('bank_account_no').where('id', '=', vendor).executeTakeFirstOrThrow()).bank_account_no), '123456789012', 'turned down: the approved account stands');
    });
  } finally {
    if (before === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = before;
  }
});

test('purchase orders: the vendor accepts or declines an open order once, with a note; not another vendor’s, not a closed one', async () => {
  await withBook(async ({ trx, orgId, branchId, vendor }) => {
    const otherVendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Other Steel', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const po = await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-10-01', expectedDate: '2026-10-15', lines: goods(2_000) });
    const draft = await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-10-02', lines: goods(100), status: 'draft' });
    await assert.rejects(respondToOrder(trx, orgId, otherVendor, po.id, 'accepted'), /not yours/);
    await assert.rejects(respondToOrder(trx, orgId, vendor, draft.id, 'accepted'), /no longer be answered/);
    assert.deepEqual(await respondToOrder(trx, orgId, vendor, po.id, 'accepted', ' Delivery on the 12th. '), { number: po.number });
    await assert.rejects(respondToOrder(trx, orgId, vendor, po.id, 'declined'), /already accepted/);
    const row = await trx.selectFrom('purchase_orders').select(['vendor_response', 'vendor_response_note', 'vendor_response_at']).where('id', '=', po.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.vendor_response, row.vendor_response_note], ['accepted', 'Delivery on the 12th.']);
    assert.ok(row.vendor_response_at);
    const view = await portalOverview(trx, orgId, vendor, 'vendor');
    if (view.side !== 'vendor') throw new Error('vendor view');
    assert.deepEqual(view.orders.map((o) => [o.number, o.response]), [[po.number, 'accepted']], 'a draft is not on the portal');
  });
});

test('the Portal activities report, and which files a portal may open', async () => {
  await withBook(async ({ trx, orgId, customer, other, vendor }) => {
    await logPortalActivity(trx, { orgId, contactId: customer, side: 'customer', action: 'opened', detail: 'Opened the portal' });
    await logPortalActivity(trx, { orgId, contactId: vendor, side: 'vendor', action: 'order_accepted', targetType: 'purchase_order', targetId: 1, detail: 'PO-1', ip: '10.0.0.1' });
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const all = await portalActivityReport(trx, orgId, { from: today, to: today });
    assert.deepEqual(all.map((r) => r.action).sort(), ['opened', 'order_accepted']);
    assert.deepEqual((await portalActivityReport(trx, orgId, { from: today, to: today, contactId: vendor })).map((r) => [r.contact, r.side]), [['Steel Co', 'vendor']]);
    assert.deepEqual(await portalActivityReport(trx, orgId, { from: '2020-01-01', to: '2020-01-31' }), []);

    const file = (contactId: number, folder: string | null) => trx.insertInto('files').values({
      org_id: orgId, storage_key: `${orgId}/t/${randomBytes(4).toString('hex')}.pdf`, filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 10,
      checksum_sha256: '0'.repeat(64), attached_to_type: 'contact', attached_to_id: contactId, folder,
    } as never).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
    const shared = await file(customer, PORTAL_SHARED_FOLDER);
    const sent = await file(customer, PORTAL_UPLOAD_FOLDER);
    const internal = await file(customer, null);
    const othersShared = await file(other, PORTAL_SHARED_FOLDER);
    assert.ok(await portalFile(trx, orgId, customer, shared));
    assert.ok(await portalFile(trx, orgId, customer, sent));
    assert.equal(await portalFile(trx, orgId, customer, internal), undefined, 'a file kept on the contact but not shared stays private');
    assert.equal(await portalFile(trx, orgId, customer, othersShared), undefined, 'another contact’s file is not reachable');
    const view = await portalOverview(trx, orgId, customer, 'customer');
    assert.deepEqual(view.documents.map((d) => [d.id, d.fromYou]).sort(), [[String(shared), false], [String(sent), true]].sort());
  });
});

test.after(() => db.destroy());
