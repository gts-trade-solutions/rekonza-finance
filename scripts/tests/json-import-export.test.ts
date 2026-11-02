// JSON export and import (services/data-export.ts, lib/imports/json.ts), and
// the GSTR-2A JSON read by the 2B importer.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/json-import-export.test.ts
//
// The point of exporting in the import's own columns is the round trip: what
// comes out of one book goes into another unchanged. That is what is tested,
// through the same grid the Import page builds from a JSON file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { exportModule, EXPORT_MODULES } from '../../lib/server/services/data-export';
import { runImport } from '../../lib/server/imports/run';
import { jsonGrid, templateJson } from '../../lib/imports/json';
import { columnFor, IMPORT_KINDS, type ImportKind } from '../../lib/imports/templates';
import { parseGstr2b } from '../../lib/server/gst/gstr2b-import';

test.after(() => db.destroy());

async function withBooks(fn: (trx: Trx, a: { orgId: number; branchId: number }, b: { orgId: number; branchId: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const make = async (name: string, gstin: string) => {
        const orgId = Number((await trx.insertInto('organizations').values({ name }).executeTakeFirstOrThrow()).insertId);
        const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin }).executeTakeFirstOrThrow()).insertId);
        await installChartOfAccounts(trx, orgId);
        return { orgId, branchId };
      };
      await fn(trx, await make('Export Source Co', '33AABCX5050E1Z5'), await make('Import Target Co', '33AABCY6060F1Z6'));
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** What the Import page does with a JSON file: grid, then rows keyed by the template. */
function rowsFromJson(text: string, kind: ImportKind) {
  const grid = jsonGrid(text, kind);
  const map = grid[0].map((h, idx) => ({ key: columnFor(kind, h), idx }));
  return grid.slice(1).map((r) => Object.fromEntries(map.filter((m) => m.key).map((m) => [m.key!, r[m.idx]])));
}

test('customers, items and invoices exported as JSON import into another book', async () => {
  await withBooks(async (trx, a, b) => {
    const acc = await accountIds(trx, a.orgId);
    assert.ok(acc[CODE.SALES]);
    const customer = Number((await trx.insertInto('contacts').values({
      org_id: a.orgId, kind: 'customer', display_name: 'Sri Murugan Motors', gst_treatment: 'registered', state_code: '33',
      gstin: '33AAACS1234F1ZZ', email: 'accounts@murugan.example', payment_terms: 'net_30',
    } as never).executeTakeFirstOrThrow()).insertId);
    await trx.insertInto('items').values({ org_id: a.orgId, kind: 'goods', name: 'Brake pad set', sku: 'BP-101', hsn_sac: '8708', uqc: 'NOS', sale_price: '850.0000', purchase_price: '600.0000', gst_rate_pct: '18.00' } as never).execute();
    await createInvoice(trx, a.orgId, null, {
      branchId: a.branchId, customerId: customer, date: '2026-08-05', dueDate: '2026-09-04', status: 'approved',
      lines: [{ description: 'Brake pad set', qty: 4, ratePaise: 850_00, gstRatePct: 18 }],
    });

    const range = { from: '1900-01-01', to: '2999-12-31' };
    const asFile = async (key: string) => JSON.stringify({ format: 'rekonza-export', module: key, rows: await exportModule(key)!.rows(trx, a.orgId, range) });
    const ctx = { orgId: b.orgId, userId: null, branchId: b.branchId, onDuplicate: 'error' as const };

    const contacts = await runImport(trx, ctx, 'contacts', rowsFromJson(await asFile('contacts'), 'contacts'));
    assert.deepEqual(contacts.errors, []);
    assert.equal(contacts.created, 1);
    const copied = await trx.selectFrom('contacts').selectAll().where('org_id', '=', b.orgId).executeTakeFirstOrThrow();
    assert.equal(copied.gstin, '33AAACS1234F1ZZ');
    assert.equal(copied.payment_terms, 'net_30', 'credit days survive the trip');

    const items = await runImport(trx, ctx, 'items', rowsFromJson(await asFile('items'), 'items'));
    assert.deepEqual(items.errors, []);
    assert.equal(items.created, 1);

    const invoices = await runImport(trx, ctx, 'invoices', rowsFromJson(await asFile('invoices'), 'invoices'));
    assert.deepEqual(invoices.errors, []);
    assert.equal(invoices.created, 1);
    const inv = await trx.selectFrom('invoices').select(['total']).where('org_id', '=', b.orgId).executeTakeFirstOrThrow();
    assert.equal(Number(inv.total), 4012, '4 × 850 + 18% GST, the same in both books');
  });
});

test('a backup file feeds the import of each module, and nested lines become rows', () => {
  const backup = JSON.stringify({ format: 'rekonza-backup', modules: { items: [{ name: 'Clutch plate', hsn_sac: '8708', gst_rate: 18 }] } });
  assert.deepEqual(jsonGrid(backup, 'items'), [['name', 'hsn_sac', 'gst_rate'], ['Clutch plate', '8708', '18']]);
  assert.throws(() => jsonGrid(backup, 'accounts'), /no ledger accounts/i);

  const nested = JSON.stringify([{ invoice_no: 'INV-9', date: '2026-08-01', customer: 'X', lines: [{ description: 'A', qty: 1, rate: 10 }, { description: 'B', qty: 2, rate: 5 }] }]);
  const g = jsonGrid(nested, 'invoices');
  assert.deepEqual(g[0], ['invoice_no', 'date', 'customer', 'description', 'qty', 'rate']);
  assert.equal(g.length, 3, 'one row per line');
  assert.deepEqual(g[2], ['INV-9', '2026-08-01', 'X', 'B', '2', '5']);

  assert.throws(() => jsonGrid('{"module":"items","rows":[]}', 'contacts'), /export of items/);
  assert.throws(() => jsonGrid('not json', 'contacts'), /not valid JSON/);
  for (const k of IMPORT_KINDS) assert.equal(templateJson(k).length, 1);
});

test('every export module runs on an empty book', async () => {
  await withBooks(async (trx, a) => {
    for (const m of EXPORT_MODULES) {
      const rows = await m.rows(trx, a.orgId, { from: '2026-04-01', to: '2027-03-31' });
      assert.ok(Array.isArray(rows), m.key);
    }
  });
});

test('a GSTR-2A download is read into the same lines as 2B', () => {
  const p = parseGstr2b({
    gstin: '33AABCX5050E1Z5', fp: '082026',
    b2b: [{ ctin: '33AAACS3333S1Z3', cfs: 'Y', inv: [{ inum: 'S-77', idt: '05-08-2026', val: 1180, rchrg: 'N', itms: [
      { num: 1, itm_det: { rt: 18, txval: 800, camt: 72, samt: 72 } },
      { num: 2, itm_det: { rt: 18, txval: 200, camt: 18, samt: 18 } },
    ] }] }],
    cdn: [{ ctin: '33AAACS3333S1Z3', cfs: 'N', nt: [{ ntty: 'C', nt_num: 'CN-3', nt_dt: '20-08-2026', itms: [{ num: 1, itm_det: { rt: 18, txval: 100, camt: 9, samt: 9 } }] }] }],
  });
  assert.equal(p.returnPeriod, '082026');
  assert.equal(p.lines.length, 2);
  assert.deepEqual({ ...p.lines[0] }, {
    vendorGstin: '33AAACS3333S1Z3', vendorName: null, docType: 'invoice', number: 'S-77', date: '2026-08-05',
    taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, itcAvailable: true, reverseCharge: false,
  });
  assert.equal(p.lines[1].docType, 'credit_note');
  assert.equal(p.lines[1].itcAvailable, false, 'the supplier has not filed');
});
