// Cancelling an e-invoice, against real MySQL, inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/einvoice-cancel.test.ts
//
// What matters is the order of things. Every check that can refuse runs before
// the portal is asked, because a cancellation the portal has accepted cannot be
// taken back; and the invoice is voided in the same transaction, because the
// portal will never accept its number again.
//
// The portal call is passed in: the real one writes its log through a separate
// connection, which would wait on this test's uncommitted organisation row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { ApiError } from '../../lib/server/http';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { cancelEinvoice, type PortalCaller } from '../../lib/server/integrations/gst/einvoice-service';
import { PortalRejection } from '../../lib/server/integrations/gst/provider';
import { irnCancelDeadline, irnCancelOpenUntil, irnCancellable, timeLeft } from '../../lib/tax/einvoice';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-12T10:00:00+05:30');

interface Fixture {
  trx: Trx;
  orgId: number;
  invoiceId: number;
  entryId: number | null;
}

/** An issued invoice whose IRN the stand-in registered `issuedHoursAgo` before NOW. */
async function withRegisteredInvoice(fn: (f: Fixture) => Promise<void>, issuedHoursAgo = 1) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'E-invoice Cancel Test Co', aato_above_5cr: 1 })
        .executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({
          org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1,
          gstin: '33AABCU9603R1ZU', address: '14 Anna Salai', city: 'Chennai', pincode: '600002',
        })
        .executeTakeFirstOrThrow();

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const customer = await trx.insertInto('contacts')
        .values({
          org_id: orgId, kind: 'customer', display_name: 'Ridge Office', gst_treatment: 'registered',
          state_code: '33', gstin: '33AAACR5055K1ZE', billing_address: '9 Mount Road',
          billing_city: 'Chennai', billing_pincode: '600006',
        })
        .executeTakeFirstOrThrow();

      const item = await trx.insertInto('items')
        .values({
          org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708',
          uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
          gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
        })
        .executeTakeFirstOrThrow();

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      const inv = await createInvoice(trx, orgId, null, {
        branchId: Number(branch.insertId), customerId: Number(customer.insertId),
        date: '2026-09-12', dueDate: '2026-10-12',
        status: 'approved', lines: [{ itemId: Number(item.insertId), qty: 2 }],
      });

      await trx.updateTable('einvoices')
        .set({
          status: 'submitted', provider: 'fake', irn: `DEMO${'a'.repeat(60)}`, ack_no: '112233445566',
          ack_date: new Date(NOW.getTime() - issuedHoursAgo * HOUR),
        })
        .where('invoice_id', '=', inv.id)
        .execute();

      const row = await trx.selectFrom('invoices').select('journal_entry_id')
        .where('id', '=', inv.id).executeTakeFirstOrThrow();

      await fn({ trx, orgId, invoiceId: inv.id, entryId: row.journal_entry_id });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** Stands in for the logged portal call: runs it, or a scripted outcome, and counts the asks. */
function portal(outcome?: () => Promise<{ cancelledAt: string }>) {
  const asked: string[] = [];
  const call = (async (record: { operation: string }, payload: unknown, fn: () => Promise<unknown>) => {
    void payload;
    asked.push(record.operation);
    return outcome ? outcome() : fn();
  }) as unknown as PortalCaller;
  return { asked, call };
}

const refusedWith = (code: string) => (err: unknown) => err instanceof ApiError && err.code === code;

const reasonOf = { reason: '2' as const, remark: 'Wrong rate' };

async function state(trx: Trx, invoiceId: number) {
  const e = await trx.selectFrom('einvoices').select(['status', 'cancel_reason', 'cancelled_at'])
    .where('invoice_id', '=', invoiceId).executeTakeFirstOrThrow();
  const i = await trx.selectFrom('invoices').select('status')
    .where('id', '=', invoiceId).executeTakeFirstOrThrow();
  return { einvoice: e.status, invoice: i.status, reason: e.cancel_reason, cancelledAt: e.cancelled_at };
}

// ── The time rules ───────────────────────────────────────────────────────────

test('an IRN can be cancelled for 24 hours after it is issued, and not after', () => {
  const issued = new Date('2026-09-12T10:00:00+05:30');
  assert.equal(irnCancelDeadline(issued)?.toISOString(), new Date('2026-09-13T10:00:00+05:30').toISOString());
  assert.equal(irnCancellable(issued, new Date(issued.getTime() + 23 * HOUR)), true);
  assert.equal(irnCancellable(issued, new Date(issued.getTime() + 24 * HOUR + 1)), false);
  assert.equal(irnCancelOpenUntil(issued, new Date(issued.getTime() + 25 * HOUR)), null);
  assert.equal(irnCancelDeadline(null), null, 'no issue time, no window');
  assert.equal(timeLeft(new Date(issued.getTime() + 5.5 * HOUR), issued), '5 hours');
  assert.equal(timeLeft(new Date(issued.getTime() + 40 * 60_000), issued), '40 minutes');
  assert.equal(timeLeft(issued, issued), 'no time');
});

// ── Cancelling ───────────────────────────────────────────────────────────────

test('an IRN cancelled within 24 hours voids the invoice with it', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId, entryId }) => {
    const p = portal();
    const out = await cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call });

    assert.deepEqual(p.asked, ['cancel_irn']);
    assert.equal(out.provider, 'fake');
    assert.equal(out.live, false);
    assert.equal(out.recovered, false);

    const s = await state(trx, invoiceId);
    assert.equal(s.einvoice, 'cancelled');
    assert.equal(s.invoice, 'void');
    assert.equal(s.reason, 'Data entry mistake: Wrong rate');
    assert.ok(s.cancelledAt);

    // The sale leaves the ledger by a reversing entry, not by deletion.
    assert.ok(entryId, 'the invoice was posted');
    const reversal = await trx.selectFrom('journal_entries').select('id')
      .where('reversal_of_entry_id', '=', entryId!).executeTakeFirst();
    assert.ok(reversal, 'a reversing entry was posted');
  });
});

test('the portal is not asked once 24 hours have passed', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    const p = portal();
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      refusedWith('cancel_window_passed'),
    );
    assert.deepEqual(p.asked, []);
    assert.deepEqual(
      { einvoice: (await state(trx, invoiceId)).einvoice, invoice: (await state(trx, invoiceId)).invoice },
      { einvoice: 'submitted', invoice: 'approved' },
    );
  }, 25);
});

test('payments against the invoice stop a cancellation before the portal is asked', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    await trx.updateTable('invoices').set({ amount_paid: '100.0000' }).where('id', '=', invoiceId).execute();
    const p = portal();
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      refusedWith('has_payments'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('an e-way bill still standing has to be cancelled first', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    await trx.insertInto('eway_bills')
      .values({ org_id: orgId, invoice_id: invoiceId, status: 'generated', eway_bill_no: '181000000001' })
      .execute();
    const p = portal();
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      refusedWith('ewb_active'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('an IRN from a provider the branch no longer uses is not sent anywhere else', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    await trx.updateTable('einvoices').set({ provider: 'nic_einvoice' }).where('invoice_id', '=', invoiceId).execute();
    const p = portal();
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      refusedWith('provider_changed'),
    );
    assert.deepEqual(p.asked, []);
  });
});

test('a portal that already cancelled it is recorded as cancelled', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    const p = portal(async () => {
      throw new PortalRejection('9999', 'The IRN is already cancelled.');
    });
    const out = await cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call });
    assert.equal(out.recovered, true);
    const s = await state(trx, invoiceId);
    assert.equal(s.einvoice, 'cancelled');
    assert.equal(s.invoice, 'void');
  });
});

test('any other refusal leaves the IRN and the invoice as they were', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    const p = portal(async () => {
      throw new PortalRejection('2270', 'The allowed cancellation time limit is crossed.');
    });
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      refusedWith('portal_rejected'),
    );
    const s = await state(trx, invoiceId);
    assert.equal(s.einvoice, 'submitted');
    assert.equal(s.invoice, 'approved');
  });
});

test('a cancelled IRN cannot be cancelled twice', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    const p = portal();
    await cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call });
    await assert.rejects(
      cancelEinvoice(trx, orgId, null, invoiceId, reasonOf, { now: NOW, call: p.call }),
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );
    assert.deepEqual(p.asked, ['cancel_irn']);
  });
});

// ── Voiding around the portal ────────────────────────────────────────────────

test('an invoice with a live IRN cannot be voided in the books alone', async () => {
  await withRegisteredInvoice(async ({ trx, orgId, invoiceId }) => {
    await assert.rejects(voidInvoice(trx, orgId, null, invoiceId, 'Mistake'), refusedWith('irn_active'));
    assert.equal((await state(trx, invoiceId)).invoice, 'approved');
  });
});

test.after(async () => {
  await db.destroy();
});
