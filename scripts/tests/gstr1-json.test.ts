// The GSTR-1 file the portal takes, built from invoice lines.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr1-json.test.ts
//
// What the portal rejects, or quietly misreads, if it is wrong: dates must be
// day-first, a buyer appears once with all their invoices under them, every
// invoice is split by tax rate, consumer sales are one row per state and rate,
// and the HSN table is in two parts from May 2025.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { b2clThreshold } from '../../lib/server/gst/returns';

interface Fixture {
  trx: Trx; orgId: number; branchId: number;
  buyer: number; consumer: number; farConsumer: number; overseas: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'GSTR-1 File Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCG1111G1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts and accessories of motor vehicles', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '4011', kind: 'hsn', description: 'Tyres', gst_rate_pct: 5, is_active: 1 },
      ]).execute();
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId,
        buyer: await mk({ display_name: 'Local Co', gst_treatment: 'registered', state_code: '33', gstin: '33AAACL1111L1Z1' }),
        consumer: await mk({ display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33' }),
        farConsumer: await mk({ display_name: 'Bengaluru buyer', gst_treatment: 'unregistered', state_code: '29' }),
        overseas: await mk({ display_name: 'Dubai Motors', gst_treatment: 'overseas', state_code: '96' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const parts = (rupees: number) => ({ description: 'Brake pad', hsnSac: '8708', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 });
const tyres = (rupees: number) => ({ description: 'Tyre', hsnSac: '4011', qty: 2, ratePaise: (rupees / 2) * 100, gstRatePct: 5 });

const sell = (f: Fixture, customerId: number, date: string, lines: ReturnType<typeof parts>[]) =>
  createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId, date, dueDate: date, status: 'approved', lines });

type Inv = { inum: string; idt: string; val: number; inv_typ?: string; itms: { num: number; itm_det: Record<string, number> }[] };

test('a buyer appears once, each invoice split by rate, dates day-first', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2026-08-05', [parts(10_000), tyres(4_000)]);
    await sell(f, f.buyer, '2026-08-20', [parts(1_000)]);

    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    assert.equal(file.gstin, '33AABCG1111G1Z5');
    assert.equal(file.fp, '082026');

    const b2b = file.b2b as { ctin: string; inv: Inv[] }[];
    assert.equal(b2b.length, 1, 'one entry for the buyer');
    assert.equal(b2b[0].ctin, '33AAACL1111L1Z1');
    assert.equal(b2b[0].inv.length, 2, 'both invoices under it');

    const first = b2b[0].inv[0];
    assert.equal(first.idt, '05-08-2026');
    assert.equal(first.inv_typ, 'R');
    assert.deepEqual(first.itms.map((i) => i.itm_det.rt).sort((a, b) => a - b), [5, 18]);
    const at18 = first.itms.find((i) => i.itm_det.rt === 18)!.itm_det;
    assert.equal(at18.txval, 10_000);
    assert.equal(at18.camt, 900);
    assert.equal(at18.samt, 900);
    assert.equal(first.val, 10_000 + 1_800 + 4_000 + 200);
  });
});

test('consumer sales roll up by state and rate, net of credit notes', async () => {
  await withFixture(async (f) => {
    await sell(f, f.consumer, '2026-08-02', [parts(1_000)]);
    await sell(f, f.consumer, '2026-08-03', [parts(2_000)]);
    await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.consumer, date: '2026-08-10', reason: 'Returned',
      lines: [{ ...parts(500) }],
    });

    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    const b2cs = file.b2cs as Record<string, unknown>[];
    assert.equal(b2cs.length, 1);
    assert.deepEqual(b2cs[0], {
      sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 18,
      txval: 2_500, iamt: 0, camt: 225, samt: 225, csamt: 0,
    });
    assert.equal(file.cdnur, undefined, 'a note against a B2CS sale is not listed on its own');
  });
});

test('an inter-state consumer sale over ₹1 lakh is listed invoice by invoice', async () => {
  assert.equal(b2clThreshold('2024-07-31'), 2_50_000_00);
  assert.equal(b2clThreshold('2024-08-01'), 1_00_000_00);
  await withFixture(async (f) => {
    await sell(f, f.farConsumer, '2026-08-04', [parts(90_000)]);   // 1,06,200 with IGST
    await sell(f, f.farConsumer, '2026-08-05', [parts(50_000)]);   // 59,000

    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    const b2cl = file.b2cl as { pos: string; inv: Inv[] }[];
    assert.equal(b2cl.length, 1);
    assert.equal(b2cl[0].pos, '29');
    assert.equal(b2cl[0].inv.length, 1);
    assert.deepEqual(b2cl[0].inv[0].itms[0].itm_det, { rt: 18, txval: 90_000, iamt: 16_200, csamt: 0 });

    const b2cs = file.b2cs as Record<string, unknown>[];
    assert.equal(b2cs.length, 1);
    assert.equal(b2cs[0].sply_ty, 'INTER');
    assert.equal(b2cs[0].txval, 50_000);
  });
});

test('exports, the HSN table in two parts, and the document summary', async () => {
  await withFixture(async (f) => {
    await sell(f, f.overseas, '2026-08-06', [parts(20_000)]);
    await sell(f, f.buyer, '2026-08-07', [parts(1_000)]);
    await sell(f, f.consumer, '2026-08-08', [parts(3_000)]);

    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-08');
    const exp = file.exp as { exp_typ: string; inv: { itms: Record<string, number>[] }[] }[];
    assert.equal(exp.length, 1);
    assert.equal(exp[0].exp_typ, 'WOPAY', 'under LUT, without tax');
    assert.deepEqual(exp[0].inv[0].itms[0], { txval: 20_000, rt: 18, iamt: 0, csamt: 0 });

    const hsn = file.hsn as { hsn_b2b: Record<string, unknown>[]; hsn_b2c: Record<string, unknown>[] };
    assert.equal(hsn.hsn_b2b.length, 1);
    assert.equal(hsn.hsn_b2b[0].txval, 1_000);
    assert.equal(hsn.hsn_b2b[0].rt, 18);
    assert.equal(hsn.hsn_b2b[0].desc, 'Parts and accessories of motor', 'cut to 30 characters');
    assert.equal(hsn.hsn_b2c.length, 1, 'export and consumer sale under one code and rate');
    assert.equal(hsn.hsn_b2c[0].txval, 23_000);
    assert.equal(hsn.hsn_b2c[0].qty, 2);

    const doc = file.doc_issue as { doc_det: { doc_num: number; docs: Record<string, unknown>[] }[] };
    assert.equal(doc.doc_det[0].doc_num, 1);
    assert.equal(doc.doc_det[0].docs[0].totnum, 3);
    assert.equal(doc.doc_det[0].docs[0].net_issue, 3);
  });
});

test('before May 2025 the HSN table is one list; IFF takes the B2B part only', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2025-04-10', [parts(1_000)]);
    await sell(f, f.consumer, '2025-04-11', [parts(1_000)]);

    const april = await gstr1PortalFile(f.trx, f.orgId, '2025-04');
    assert.ok(Array.isArray((april.hsn as { data: unknown[] }).data));

    const iffFile = await gstr1PortalFile(f.trx, f.orgId, '2025-04', { scope: 'iff' });
    assert.deepEqual(Object.keys(iffFile).sort(), ['b2b', 'fp', 'gstin']);
  });
});

test.after(async () => {
  await db.destroy();
});
