// Sales receipts and debit notes, both kept as invoices.
//
// A sales receipt is an invoice and its receipt recorded together, born
// settled. A debit note posts as an invoice does but is numbered in its own
// series and reported in GSTR-1 with the notes, as type D; GSTR-9 shows it in
// 4J rather than among the year's B2B supplies.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/receipts-debit-notes.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createSalesReceipt } from '../../lib/server/services/sales-receipts';
import { gstr1 } from '../../lib/server/gst/returns';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { gstr9 } from '../../lib/server/gst/gstr9';
import { partyStatement } from '../../lib/server/reports/party-statement';

interface Book { trx: Trx; orgId: number; branchId: number; buyer: number; other: number; walkIn: number; bankId: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Counter Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCR3333R1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts of motor vehicles', gst_rate_pct: 18, is_active: 1 }).execute();
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', state_code: '33', ...values } as never).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'cash', name: 'Cash in hand', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId,
        buyer: await mk({ display_name: 'Local Co', gst_treatment: 'registered', gstin: '33AAACL1111L1Z1' }),
        other: await mk({ display_name: 'Other Co', gst_treatment: 'registered', gstin: '33AAACO2222O1Z2' }),
        walkIn: await mk({ display_name: 'Walk-in', gst_treatment: 'unregistered' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (rupees: number) => ({ description: 'Brake pad', hsnSac: '8708', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 });

test('a sales receipt: the invoice and its receipt in one go, born settled', async () => {
  await withBook(async ({ trx, orgId, branchId, walkIn, bankId }) => {
    const r = await createSalesReceipt(trx, orgId, null,
      { branchId, customerId: walkIn, date: '2026-07-04', dueDate: '2026-07-04', lines: [line(1_000)] },
      { mode: 'upi', bankAccountId: bankId, reference: 'UPI 4411' });
    const inv = await trx.selectFrom('invoices').select(['status', 'total', 'amount_paid', 'paid_at_sale', 'doc_kind']).where('id', '=', r.id).executeTakeFirstOrThrow();
    assert.equal(Number(inv.total), 1_180, '₹1,000 and 18% GST');
    assert.equal(Number(inv.amount_paid), 1_180, 'settled in full');
    assert.equal(inv.status, 'paid');
    assert.equal(inv.paid_at_sale, 1);
    assert.equal(inv.doc_kind, 'invoice', 'still a tax invoice');
    const pay = await trx.selectFrom('payments').select(['amount', 'mode', 'reference', 'unapplied_amount']).where('id', '=', r.payment.id).executeTakeFirstOrThrow();
    assert.deepEqual([Number(pay.amount), pay.mode, pay.reference, Number(pay.unapplied_amount)], [1_180, 'upi', 'UPI 4411', 0]);
    // Nothing is owed: the statement shows the sale and the money, and a nil balance.
    const s = await partyStatement(trx, orgId, walkIn, 'customer', '2026-07-01', '2026-07-31');
    assert.deepEqual(s.lines.map((l) => l.kind), ['Invoice', 'Payment received']);
    assert.equal(s.closingPaise, 0);

    await assert.rejects(
      createSalesReceipt(trx, orgId, null, { branchId, customerId: walkIn, date: '2026-07-04', dueDate: '2026-07-04', lines: [line(10)], currency: 'USD', exchangeRate: 83 },
        { mode: 'cash', bankAccountId: bankId }),
      /another currency/,
    );
  });
});

test('a debit note: its own series, a reason, the right customer; reported as a note in GSTR-1 and in 4J of GSTR-9', async () => {
  await withBook(async ({ trx, orgId, branchId, buyer, other }) => {
    const inv = await createInvoice(trx, orgId, null, { branchId, customerId: buyer, date: '2026-07-02', dueDate: '2026-07-02', status: 'approved', lines: [line(10_000)] });
    const note = (extra: Record<string, unknown>) => createInvoice(trx, orgId, null, {
      branchId, customerId: buyer, date: '2026-07-20', dueDate: '2026-08-19', status: 'approved', lines: [line(500)],
      docKind: 'debit_note', againstInvoiceId: inv.id, noteReason: 'Price revised from 1 July', ...extra,
    });
    await assert.rejects(note({ noteReason: ' ' }), /Say why the debit note is raised/);
    await assert.rejects(note({ customerId: other }), /customer of the invoice it corrects/);
    const dn = await note({});
    assert.match(dn.number, /^DN/, 'numbered in the debit note series');
    const invNo = (await trx.selectFrom('invoices').select('number').where('id', '=', inv.id).executeTakeFirstOrThrow()).number;
    assert.doesNotMatch(invNo, /^DN/);
    const unnamed = await note({ againstInvoiceId: null });
    assert.ok((unnamed.warnings ?? []).some((w) => /Rule 53\(1A\)/.test(w)), 'a note that names no invoice is flagged');

    // Posted as an invoice is: the customer owes the extra.
    const s = await partyStatement(trx, orgId, buyer, 'customer', '2026-07-01', '2026-07-31');
    assert.deepEqual(s.lines.map((l) => l.kind), ['Invoice', 'Debit note', 'Debit note']);
    assert.equal(s.closingPaise, (11_800 + 590 + 590) * 100);

    // GSTR-1: out of B2B, into the notes as type D.
    const g = await gstr1(trx, orgId, '2026-07');
    assert.deepEqual(g.b2b.map((r) => r.number), [invNo], 'only the invoice is a B2B supply');
    const d = g.creditNotes.filter((n) => n.noteType === 'D');
    assert.equal(d.length, 2);
    assert.equal(d.find((n) => n.number === dn.number)?.againstNumber, invNo);
    assert.equal(g.documentSummary.from, invNo, 'the invoice series, without the debit notes');

    // The portal file: cdnr with ntty D, and the debit notes counted as document type 4.
    const file = await gstr1PortalFile(trx, orgId, '2026-07') as unknown as {
      b2b?: { inv: { inum: string }[] }[]; cdnr?: { ctin: string; nt: { ntty: string; nt_num: string }[] }[];
      doc_issue?: { doc_det: { doc_num: number; docs: { totnum: number }[] }[] };
    };
    assert.deepEqual(file.b2b?.flatMap((b) => b.inv.map((i) => i.inum)), [invNo]);
    assert.deepEqual(file.cdnr?.flatMap((c) => c.nt.map((n) => n.ntty)), ['D', 'D']);
    assert.equal(file.doc_issue?.doc_det.find((x) => x.doc_num === 4)?.docs.reduce((t, x) => t + x.totnum, 0), 2);

    // GSTR-9: 4J, not 4B.
    const y = await gstr9(trx, orgId, 2026);
    assert.equal(y.table4.b2b.taxablePaise, 10_000_00);
    assert.equal(y.table4.debitNotes.taxablePaise, 1_000_00);
    assert.equal(y.table4.total.taxablePaise, 11_000_00, 'they still count in the year\'s total');
  });
});

test.after(() => db.destroy());
