// Attachments: what is accepted, where it goes, and that removing one keeps it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/attachments.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, type Trx } from '../../lib/server/db';
import { DiskStore, setFileStore } from '../../lib/server/files/store';
import { attachFile, listAttachments, readAttachment, removeAttachment, sniff } from '../../lib/server/files/attachments';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let dir = '';
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rekonza-files-'));
  setFileStore(new DiskStore(dir));
});

async function withOrg(fn: (trx: Trx, orgId: number, otherOrg: number) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Files Co' }).executeTakeFirstOrThrow()).insertId);
      const otherOrg = Number((await trx.insertInto('organizations').values({ name: 'Someone Else' }).executeTakeFirstOrThrow()).insertId);
      await fn(trx, orgId, otherOrg);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a file is recognised by its bytes, not its name', () => {
  assert.equal(sniff(PDF, 'scan.jpg')?.contentType, 'application/pdf');
  assert.equal(sniff(PNG, 'logo')?.contentType, 'image/png');
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>'), 'page.html'), null);
  assert.equal(sniff(Buffer.from('<svg onload="x()"/>'), 'logo.svg'), null, 'SVG can carry script');
  assert.equal(sniff(Buffer.from('a,b\n1,2\n'), 'rates.csv')?.contentType, 'text/csv');
  assert.equal(sniff(Buffer.from([0, 1, 2, 3]), 'data.csv'), null, 'binary is not text');
});

test('attach, read back, and remove without losing the bytes', async () => {
  await withOrg(async (trx, orgId) => {
    const contact = Number((await trx.insertInto('contacts').values({
      org_id: orgId, kind: 'vendor', display_name: 'Supplier', state_code: '33',
    } as never).executeTakeFirstOrThrow()).insertId);

    const a = await attachFile(trx, orgId, null, { type: 'contact', targetId: contact, filename: 'agreement.pdf', bytes: PDF });
    assert.equal(a.contentType, 'application/pdf');
    assert.equal(a.sizeBytes, PDF.length);

    const { bytes } = await readAttachment(trx, orgId, Number(a.id));
    assert.ok(bytes.equals(PDF));

    await removeAttachment(trx, orgId, null, Number(a.id));
    assert.equal((await listAttachments(trx, orgId, 'contact', contact)).length, 0, 'gone from the record');
    await assert.rejects(readAttachment(trx, orgId, Number(a.id)), /not found/i);

    const kept = await readdir(dir, { recursive: true });
    assert.ok(kept.some((f) => String(f).endsWith('.pdf')), 'the bytes are kept');
  });
});

test('a file cannot be attached to, or read from, another company', async () => {
  await withOrg(async (trx, orgId, otherOrg) => {
    const theirs = Number((await trx.insertInto('contacts').values({
      org_id: otherOrg, kind: 'vendor', display_name: 'Not yours', state_code: '33',
    } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(
      attachFile(trx, orgId, null, { type: 'contact', targetId: theirs, filename: 'x.pdf', bytes: PDF }),
      /not found/i,
    );

    const mine = await attachFile(trx, otherOrg, null, { type: 'contact', targetId: theirs, filename: 'x.pdf', bytes: PDF });
    await assert.rejects(readAttachment(trx, orgId, Number(mine.id)), /not found/i);
  });
});

test('empty, oversized and unaccepted files are refused', async () => {
  await withOrg(async (trx, orgId) => {
    await assert.rejects(attachFile(trx, orgId, null, { type: 'organization', targetId: orgId, filename: 'a.pdf', bytes: Buffer.alloc(0) }), /empty/);
    await assert.rejects(
      attachFile(trx, orgId, null, { type: 'organization', targetId: orgId, filename: 'a.pdf', bytes: Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]) }),
      /up to 10 MB/,
    );
    await assert.rejects(
      attachFile(trx, orgId, null, { type: 'organization', targetId: orgId, filename: 'a.exe', bytes: Buffer.from('MZ\x90\x00') }),
      /not accepted/,
    );
  });
});

test.after(async () => {
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});
