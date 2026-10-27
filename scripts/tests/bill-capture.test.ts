// Reading a bill: the model's answer tidied, the supplier matched, the sums checked, credits charged.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bill-capture.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { isValidGstin } from '../../lib/tax/gst';
import { captureBill, reviewNotes, toCaptured } from '../../lib/server/ai/bill-capture';

const GOOD = '27AAPFU0939F1ZV';

const answer = (over: Record<string, unknown> = {}) => ({
  vendor_name: 'Sundaram Fasteners Agency', vendor_gstin: '27 aapfu0939f1zv', invoice_number: ' SF/2026/412 ', invoice_date: '2026-10-20', due_date: null,
  lines: [
    { description: 'Hex bolts M8', hsn_sac: '7318', quantity: 200, unit_rate: 12.5, gst_rate_pct: 18 },
    { description: 'Freight', hsn_sac: 'n/a', quantity: 0, unit_rate: 500, gst_rate_pct: 17 },
  ],
  taxable_total: 3000, tax_total: 540, grand_total: 3540, ...over,
});

test('the answer is tidied: GSTIN cleaned, bad HSN and rates refused, quantities kept sane; the sums are checked', () => {
  assert.ok(isValidGstin(GOOD));
  const bill = toCaptured(answer());
  assert.equal(bill.vendorGstin, GOOD);
  assert.equal(bill.invoiceNumber, 'SF/2026/412');
  assert.deepEqual(bill.lines.map((l) => [l.hsnSac, l.qty, l.ratePaise, l.gstRatePct]), [['7318', 200, 1250, 18], [null, 1, 50000, 18]]);
  assert.equal(bill.totalPaise, 354000);
  assert.deepEqual(reviewNotes(bill), [], 'lines, tax and total agree');

  const off = toCaptured(answer({ vendor_gstin: '27AAPFU0939F1ZX', grand_total: 3999, invoice_date: '20/10/2026' }));
  const notes = reviewNotes(off);
  assert.ok(notes.some((n) => /check digit/.test(n)));
  assert.ok(notes.some((n) => /No bill date/.test(n)));
  assert.ok(notes.some((n) => /bill's total is ₹3999.00/.test(n)));
});

test('a capture matches the supplier by GSTIN and charges credits; with the assistant off nothing is sent', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Capture Co', is_demo: 1 } as never).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Clerk', email: `c-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
      const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Sundaram', gstin: GOOD, state_code: '27', gst_treatment: 'registered' } as never).executeTakeFirstOrThrow()).insertId);
      const file = { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf', filename: 'bill.pdf' };
      let calls = 0;
      const reader = async () => { calls++; return { raw: answer(), inputTokens: 3000, outputTokens: 400, model: 'gpt-5-mini' }; };
      const deps = { ex: trx, inTrx: <T,>(fn: (t: typeof trx) => Promise<T>) => fn(trx), reader };

      const r = await captureBill(orgId, userId, file, deps);
      assert.deepEqual(r.vendor, { id: String(vendor), name: 'Sundaram', by: 'gstin' });
      assert.ok(r.chargedMc >= 500, 'at least the minimum');
      const usage = await trx.selectFrom('ai_usage').select(['charged_mc', 'provider'] as never).where('org_id', '=', orgId).execute() as unknown as { provider: string }[];
      assert.equal(usage[0].provider, 'bill-capture');

      await assert.rejects(captureBill(orgId, userId, { ...file, contentType: 'text/plain' }, deps), /PDF or a photo/);
      await trx.updateTable('organizations').set({ is_demo: 0 } as never).where('id', '=', orgId).execute();
      await assert.rejects(captureBill(orgId, userId, file, deps), /Turn on the AI assistant/);
      assert.equal(calls, 1, 'refused before the model is asked');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
