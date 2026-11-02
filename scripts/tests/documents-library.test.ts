// The Documents workspace (lib/server/files/library.ts): the inbox, moving a
// file to its transaction, folders, the bank statements a role may see, and
// finding the record to attach to.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/documents-library.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, type Trx } from '../../lib/server/db';
import { DiskStore, setFileStore } from '../../lib/server/files/store';
import { attachFile, moveAttachment, readAttachment, sniff } from '../../lib/server/files/attachments';
import { findTargets, listLibrary } from '../../lib/server/files/library';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

let dir = '';
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rekonza-docs-'));
  setFileStore(new DiskStore(dir));
});
test.after(async () => {
  await rm(dir, { recursive: true, force: true });
  await db.destroy();
});

async function withOrg(fn: (trx: Trx, orgId: number, branchId: number, otherOrg: number) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Documents Co' }).executeTakeFirstOrThrow()).insertId);
      const otherOrg = Number((await trx.insertInto('organizations').values({ name: 'Another Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCV8080H1Z8' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await fn(trx, orgId, branchId, otherOrg);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a file waits in the inbox, then moves to the bill it turned out to be', async () => {
  await withOrg(async (trx, orgId, branchId) => {
    const scan = await attachFile(trx, orgId, null, { type: 'inbox', targetId: orgId, filename: 'lakshmi-bill.pdf', bytes: PDF });
    await attachFile(trx, orgId, null, { type: 'inbox', targetId: orgId, filename: 'lease.pdf', bytes: PDF, folder: 'Contracts' });

    let lib = await listLibrary(trx, orgId, 'admin', { view: 'inbox' });
    assert.deepEqual(lib.files.map((f) => f.filename).sort(), ['lakshmi-bill.pdf', 'lease.pdf']);
    assert.equal(lib.counts.inbox, 2);
    assert.deepEqual(lib.folders, [{ name: 'Contracts', count: 1 }]);
    assert.equal(lib.files.every((f) => f.attachedTo === null), true);

    const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Lakshmi Auto Components', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'LAC/118', date: '2026-10-05', dueDate: '2026-11-04',
      lines: [{ description: 'Brake pads', qty: 10, ratePaise: 600_00, gstRatePct: 18 }],
    });
    await moveAttachment(trx, orgId, Number(scan.id), { type: 'bill', targetId: Number(bill.id) });

    lib = await listLibrary(trx, orgId, 'admin', { view: 'all' });
    const moved = lib.files.find((f) => f.id === scan.id)!;
    assert.equal(moved.attachedTo?.type, 'bill');
    assert.equal(moved.attachedTo?.label, 'LAC/118');
    assert.equal(moved.attachedTo?.href, `/purchases/bills/${bill.id}`);
    assert.equal((await listLibrary(trx, orgId, 'admin', { view: 'inbox' })).counts.inbox, 1);
    assert.ok((await readAttachment(trx, orgId, Number(scan.id))).bytes.equals(PDF), 'the bytes move with it');

    const folder = await listLibrary(trx, orgId, 'admin', { view: 'folder', folder: 'Contracts' });
    assert.deepEqual(folder.files.map((f) => f.filename), ['lease.pdf']);
    const search = await listLibrary(trx, orgId, 'admin', { view: 'all', q: 'lakshmi' });
    assert.deepEqual(search.files.map((f) => f.filename), ['lakshmi-bill.pdf']);

    const targets = await findTargets(trx, orgId, 'bill', 'Lakshmi');
    assert.equal(targets[0]?.id, String(bill.id));
  });
});

test('a file cannot be moved into another company, and a role sees only what it may', async () => {
  await withOrg(async (trx, orgId, _branchId, otherOrg) => {
    const scan = await attachFile(trx, orgId, null, { type: 'inbox', targetId: orgId, filename: 'x.pdf', bytes: PDF });
    await assert.rejects(moveAttachment(trx, orgId, Number(scan.id), { type: 'inbox', targetId: otherOrg }), /not found/i);
    await assert.rejects(attachFile(trx, orgId, null, { type: 'inbox', targetId: otherOrg, filename: 'y.pdf', bytes: PDF }), /not found/i);

    const imp = Number((await trx.insertInto('bank_statement_imports').values({
      org_id: orgId, bank_account_id: Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC', ledger_account_id: (await trx.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('code', '=', '1210').executeTakeFirstOrThrow()).id, opening_balance: '0' }).executeTakeFirstOrThrow()).insertId),
      filename: 'oct.ofx', rows_total: 1, rows_imported: 1, rows_duplicate: 0,
    } as never).executeTakeFirstOrThrow()).insertId);
    await attachFile(trx, orgId, null, { type: 'bank_import', targetId: imp, filename: 'oct.ofx', bytes: Buffer.from('OFXHEADER:100\n<OFX></OFX>') });

    const admin = await listLibrary(trx, orgId, 'admin', { view: 'statements' });
    assert.deepEqual(admin.files.map((f) => f.filename), ['oct.ofx']);
    assert.equal(admin.files[0].attachedTo?.href, '/banking/imports');
    const sales = await listLibrary(trx, orgId, 'sales', { view: 'all' });
    assert.equal(sales.files.some((f) => f.filename === 'oct.ofx'), false, 'a sales user does not see bank statements');
  });
});

test('statement files are accepted as text, never as markup', () => {
  assert.equal(sniff(Buffer.from('OFXHEADER:100'), 'oct.ofx')?.contentType, 'text/plain');
  assert.equal(sniff(Buffer.from('[{"date":"2026-10-01"}]'), 'lines.json')?.contentType, 'application/json');
  assert.equal(sniff(Buffer.from(':20:X\n:61:'), 'acct.sta')?.contentType, 'text/plain');
  assert.equal(sniff(Buffer.from('<html></html>'), 'page.html'), null);
  assert.equal(sniff(Buffer.from([0, 1, 2]), 'bad.ofx'), null);
});
