// Merging two customers or two vendors, as Zoho Books does
// (services/contact-merge.ts, migration 101): everything moves to the one
// kept, the other is archived pointing at it, and GST decides what may merge.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/contact-merge.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createEstimate } from '../../lib/server/services/sales-documents';
import { receivePayment } from '../../lib/server/services/payments';
import { createPortalLink, openPortal } from '../../lib/server/services/portal';
import { mergeContacts, mergePreview } from '../../lib/server/services/contact-merge';

interface Book { trx: Trx; orgId: number; branchId: number; bankId: number; mk: (kind: string, name: string, extra?: Record<string, unknown>) => Promise<number> }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Merge Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCM9292M1Z6' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId) as Record<string, number>;
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const mk = (kind: string, name: string, extra: Record<string, unknown> = {}) =>
        trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered', ...extra } as never)
          .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      await fn({ trx, orgId, branchId, bankId, mk });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const receivable = async (trx: Trx, orgId: number, contactId: number) => {
  const { rows } = await sql<{ n: string | null }>`SELECT SUM(jl.debit - jl.credit) AS n FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.org_id = ${orgId} AND jl.contact_id = ${contactId} AND a.code = ${CODE.AR}`.execute(trx);
  return Math.round(Number(rows[0].n ?? 0) * 100);
};

test('merging moves documents, payments, ledger lines, people, addresses, fields, comments and files; the other is archived', async () => {
  await withBook(async ({ trx, orgId, branchId, bankId, mk }) => {
    const dup = await mk('customer', 'Kumar Store', { email: 'kumar@x.test', phone: '9876543210' });
    const keep = await mk('customer', 'Kumar Stores');
    for (const [who, rupees] of [[dup, 1_000], [keep, 400]] as const) {
      await createInvoice(trx, orgId, null, { branchId, customerId: who, date: '2026-10-01', dueDate: '2026-10-31', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }] });
    }
    const inv = await trx.selectFrom('invoices').select('id').where('customer_id', '=', dup).executeTakeFirstOrThrow();
    await receivePayment(trx, orgId, null, { branchId, contactId: dup, date: '2026-10-05', mode: 'upi', amountPaise: 300_00, bankAccountId: bankId, allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 300_00 }] });
    await createEstimate(trx, orgId, null, { branchId, customerId: dup, date: '2026-10-02', expiryDate: '2026-10-12', lines: [{ description: 'Goods', qty: 1, ratePaise: 50_00, gstRatePct: 0 }] });
    await trx.insertInto('contact_persons').values({ org_id: orgId, contact_id: dup, name: 'Ravi', email: 'ravi@x.test' } as never).execute();
    await trx.insertInto('contact_addresses').values({ org_id: orgId, contact_id: keep, label: 'Head office', address: '1 Road', state_code: '33', is_default: 1 } as never).execute();
    await trx.insertInto('contact_addresses').values({ org_id: orgId, contact_id: dup, label: 'Godown', address: '2 Road', state_code: '33', is_default: 1 } as never).execute();
    const field = Number((await trx.insertInto('custom_fields').values({ org_id: orgId, entity: 'contact', field_key: 'region', label: 'Region', data_type: 'text' } as never).executeTakeFirstOrThrow()).insertId);
    await trx.insertInto('custom_field_values').values({ org_id: orgId, field_id: field, entity_id: dup, value: 'South' } as never).execute();
    await trx.insertInto('comments').values({ org_id: orgId, target_type: 'contact', target_id: dup, body: 'Pays late', author_name: 'Arun' } as never).execute();
    const portal = await createPortalLink(trx, orgId, null, { contactId: dup, side: 'customer' });
    const portalToken = portal.path.split('/').pop()!;
    const dueBefore = await receivable(trx, orgId, dup) + await receivable(trx, orgId, keep);

    const preview = await mergePreview(trx, orgId, dup, keep);
    assert.equal(preview.blocked, null);
    assert.equal(preview.counts.invoices, 1);
    assert.equal(preview.counts.payments, 1);
    assert.equal(preview.counts.estimates, 1);
    assert.equal(preview.counts.journal_lines, 2, 'the invoice and the receipt reached the ledger under the contact');

    const r = await mergeContacts(trx, orgId, dup, keep);
    assert.equal(r.from, 'Kumar Store');
    assert.equal(r.into, 'Kumar Stores');

    assert.equal((await trx.selectFrom('invoices').select('id').where('customer_id', '=', keep).execute()).length, 2);
    assert.equal((await trx.selectFrom('invoices').select('id').where('customer_id', '=', dup).execute()).length, 0);
    assert.equal((await trx.selectFrom('payments').select('id').where('contact_id', '=', keep).execute()).length, 1);
    assert.equal((await trx.selectFrom('estimates').select('id').where('customer_id', '=', keep).execute()).length, 1);
    assert.equal(await receivable(trx, orgId, dup), 0, 'nothing is left owed by the one merged away');
    assert.equal(await receivable(trx, orgId, keep), dueBefore, 'the kept one owes what both did: ₹700 + ₹400');
    assert.equal(dueBefore, 1_100_00);
    assert.equal((await trx.selectFrom('contact_persons').select('name').where('contact_id', '=', keep).execute())[0]?.name, 'Ravi');
    const addresses = await trx.selectFrom('contact_addresses').select(['label', 'is_default']).where('contact_id', '=', keep).orderBy('id').execute();
    assert.deepEqual(addresses.map((a) => [a.label, a.is_default]), [['Head office', 1], ['Godown', 0]], 'the kept default stays the only default');
    assert.equal((await trx.selectFrom('custom_field_values').select('value').where('entity_id', '=', keep).where('field_id', '=', field).executeTakeFirst())?.value, 'South');
    assert.equal((await trx.selectFrom('comments').select('id').where('target_type', '=', 'contact').where('target_id', '=', keep).execute()).length, 1);
    assert.equal(await openPortal(trx, portalToken), null, 'the old portal link stops working');

    const gone = await trx.selectFrom('contacts').select(['is_archived', 'merged_into_id', 'notes']).where('id', '=', dup).executeTakeFirstOrThrow();
    assert.equal(gone.is_archived, 1);
    assert.equal(gone.merged_into_id, keep);
    assert.match(gone.notes ?? '', /Merged into Kumar Stores/);
    const kept = await trx.selectFrom('contacts').select(['email', 'phone']).where('id', '=', keep).executeTakeFirstOrThrow();
    assert.deepEqual([kept.email, kept.phone], ['kumar@x.test', '9876543210'], 'what the kept one lacked comes across');

    await assert.rejects(mergeContacts(trx, orgId, dup, keep), /already merged/);
    await assert.rejects(mergeContacts(trx, orgId, keep, keep), /different contact/);
  });
});

test('what may not merge: two GSTINs, a vendor onto a customer, one GSTIN with invoices behind it', async () => {
  await withBook(async ({ trx, orgId, branchId, mk }) => {
    const a = await mk('customer', 'A Traders', { gstin: '33AAACA1111A1Z1', gst_treatment: 'registered' });
    const b = await mk('customer', 'A Traders (Madurai)', { gstin: '33AAACA2222A1Z2', gst_treatment: 'registered' });
    assert.match((await mergePreview(trx, orgId, a, b)).blocked ?? '', /different GSTINs/);
    await assert.rejects(mergeContacts(trx, orgId, a, b), /different GSTINs/);

    const vendor = await mk('vendor', 'Steel Co');
    assert.match((await mergePreview(trx, orgId, vendor, a)).blocked ?? '', /vendor; .* is a customer only/);
    const both = await mk('both', 'Steel & Sons');
    assert.equal((await mergePreview(trx, orgId, vendor, both)).blocked, null, 'a vendor may merge into one that is both');

    // No GSTIN, with an invoice, into a registered customer: past B2C sales would turn B2B.
    const walkIn = await mk('customer', 'A Traders walk-in');
    await createInvoice(trx, orgId, null, { branchId, customerId: walkIn, date: '2026-10-01', dueDate: '2026-10-31', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }] });
    assert.match((await mergePreview(trx, orgId, walkIn, a)).blocked ?? '', /Only one of them has a GSTIN/);
    // Without invoices it may.
    const fresh = await mk('customer', 'A Traders (typo)');
    assert.equal((await mergePreview(trx, orgId, fresh, a)).blocked, null);
    await mergeContacts(trx, orgId, fresh, a);
    await assert.rejects(mergePreview(trx, orgId + 1, fresh, a), /does not exist/);
  });
});

test.after(async () => {
  await db.destroy();
});
