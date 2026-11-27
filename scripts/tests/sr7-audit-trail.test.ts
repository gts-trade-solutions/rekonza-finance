// The audit trail for the auditor (status review 7, item 2): the hash chain
// that shows a row was changed or removed behind the application's back, the
// export of every row the filters find — 50,000 and more — with what each
// deletion removed, the user filter, and Indian days at the date edges.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sr7-audit-trail.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { sealAuditChain, verifyAuditChain } from '../../lib/server/audit-chain';
import { auditExportHeader, auditExportRows } from '../../lib/server/audit-export';
import { hasPermission } from '../../lib/rbac';
import { workbook, istWallClock } from '../../lib/xlsx';
import { pdfTable } from '../../lib/pdf';

async function withOrg(fn: (trx: Trx, orgId: number, users: { arun: number; priya: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Audit Co' }).executeTakeFirstOrThrow()).insertId);
      const user = async (name: string) => Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);
      await fn(trx, orgId, { arun: await user('arun'), priya: await user('priya') });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const row = (orgId: number, actor: number, name: string, action: string, at: string, extra: Record<string, unknown> = {}) => ({
  org_id: orgId, actor_user_id: actor, actor_name: name, action, target_type: 'invoice', target_id: '1', target_label: 'INV-1',
  detail: `${action} INV-1`, created_at: new Date(at), ...extra,
});

test('every row is sealed into the chain, and verify finds nothing wrong', async () => {
  await withOrg(async (trx, orgId, u) => {
    await trx.insertInto('audit_log').values([
      row(orgId, u.arun, 'Arun', 'create', '2026-11-01T05:00:00Z'),
      row(orgId, u.arun, 'Arun', 'update', '2026-11-01T06:00:00Z', { payload: JSON.stringify({ changes: { rate: { from: 450, to: 500 } } }) }),
      row(orgId, u.priya, 'Priya', 'delete', '2026-11-02T06:00:00Z', { reason: 'Raised twice' }),
    ] as never).execute();
    assert.equal(await sealAuditChain(orgId, { trx }), 3);
    assert.equal(await sealAuditChain(orgId, { trx }), 0, 'sealing again seals nothing new');
    const ok = await verifyAuditChain(orgId, { trx });
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    assert.equal(ok.checked, 3);
    assert.equal(ok.unsealed, 0);
    assert.match(ok.headHash, /^[0-9a-f]{64}$/);
    // A later row joins the chain on the next seal and the chain stays whole.
    await trx.insertInto('audit_log').values(row(orgId, u.arun, 'Arun', 'export', '2026-11-03T06:00:00Z') as never).execute();
    const again = await verifyAuditChain(orgId, { trx });
    assert.equal(again.ok, true);
    assert.equal(again.checked, 4);
    assert.notEqual(again.headHash, ok.headHash, 'the head moves with each sealed row');
  });
});

test('a row changed or deleted behind the application is reported, by row', async () => {
  await withOrg(async (trx, orgId, u) => {
    await trx.insertInto('audit_log').values([
      row(orgId, u.arun, 'Arun', 'create', '2026-11-01T05:00:00Z'),
      row(orgId, u.arun, 'Arun', 'update', '2026-11-01T06:00:00Z'),
      row(orgId, u.priya, 'Priya', 'void', '2026-11-02T06:00:00Z'),
    ] as never).execute();
    await sealAuditChain(orgId, { trx });
    const ids = (await trx.selectFrom('audit_log').select('id').where('org_id', '=', orgId).orderBy('id').execute()).map((r) => Number(r.id));
    // Someone with database access rewrites who did it, and deletes another row.
    await sql`UPDATE audit_log SET actor_name = 'Someone else' WHERE id = ${ids[1]}`.execute(trx);
    await sql`DELETE FROM audit_log WHERE id = ${ids[2]}`.execute(trx);
    const r = await verifyAuditChain(orgId, { trx });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.kind === 'changed' && p.auditId === ids[1]), 'the edited row is named');
    assert.ok(r.problems.some((p) => p.kind === 'missing' && p.auditId === ids[2]), 'the deleted row is named');
    assert.ok(!r.problems.some((p) => p.auditId === ids[0]), 'an untouched row is not blamed');
    // A changed timestamp is a change too.
    await sql`UPDATE audit_log SET actor_name = 'Arun', created_at = '2026-10-01 00:00:00' WHERE id = ${ids[1]}`.execute(trx);
    const t = await verifyAuditChain(orgId, { trx });
    assert.ok(t.problems.some((p) => p.kind === 'changed' && p.auditId === ids[1]));
  });
});

test('a removed seal breaks the chain where it was removed', async () => {
  await withOrg(async (trx, orgId, u) => {
    await trx.insertInto('audit_log').values([1, 2, 3, 4].map((i) => row(orgId, u.arun, 'Arun', 'update', `2026-11-0${i}T06:00:00Z`)) as never).execute();
    await sealAuditChain(orgId, { trx });
    const links = await trx.selectFrom('audit_chain').select(['audit_id', 'seq']).where('org_id', '=', orgId).orderBy('seq').execute();
    await sql`DELETE FROM audit_log WHERE id = ${links[1].audit_id}`.execute(trx);
    await sql`DELETE FROM audit_chain WHERE audit_id = ${links[1].audit_id}`.execute(trx);
    const r = await verifyAuditChain(orgId, { trx });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.kind === 'broken'), JSON.stringify(r.problems));
  });
});

test('the export holds every row the filters find: 52,000 events, newest first, user and day filters in Indian time', async () => {
  await withOrg(async (trx, orgId, u) => {
    // 52,000 events across two users, from 31 Oct 18:30 UTC (1 Nov 00:00 IST) onward, one a minute.
    const start = Date.parse('2026-10-31T18:30:00Z');
    const total = 52_000;
    for (let i = 0; i < total; i += 4000) {
      const chunk = Array.from({ length: Math.min(4000, total - i) }, (_, k) => {
        const n = i + k;
        return row(orgId, n % 2 ? u.priya : u.arun, n % 2 ? 'Priya' : 'Arun', 'update', new Date(start + n * 60_000).toISOString(), { target_id: String(n), ip: '10.0.0.1' });
      });
      await trx.insertInto('audit_log').values(chunk as never).execute();
    }
    const t0 = Date.now();
    const all = await auditExportRows(trx, orgId, {}, true);
    assert.equal(all.rows.length, total, 'not capped at a page or at 25,000');
    assert.equal(all.truncated, false);
    assert.ok(Date.now() - t0 < 60_000, `read in ${Date.now() - t0}ms`);
    assert.equal(all.rows[0][4], String(total - 1), 'newest first');
    assert.equal(all.instants.length, total);
    assert.equal(auditExportHeader(true).length, all.rows[0].length);
    assert.equal(auditExportHeader(true)[8], 'IP address');
    assert.equal(all.rows[0][8], '10.0.0.1');
    // The user filter: Priya's half exactly.
    const priya = await auditExportRows(trx, orgId, { actorUserId: String(u.priya) }, false);
    assert.equal(priya.rows.length, total / 2);
    assert.ok(priya.rows.every((r) => r[1] === 'Priya'));
    assert.equal(priya.rows[0].length, auditExportHeader(false).length, 'no IP column when left out');
    // 1 November in India is 1,440 minutes: the first event is at 00:00 IST, so the day holds 1,440 events.
    const day = await auditExportRows(trx, orgId, { from: '2026-11-01', to: '2026-11-01' }, false);
    assert.equal(day.rows.length, 1440);
    assert.match(day.rows[day.rows.length - 1][0], /^01 Nov 2026, 00:00:00$/, 'IST stamp at the start edge');
    assert.match(day.rows[0][0], /^01 Nov 2026, 23:59:00$/, 'IST stamp at the end edge');
  });
});

test('a deletion in the export says what was deleted; the file formats open', async () => {
  await withOrg(async (trx, orgId, u) => {
    const contact = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Sharma Traders', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    await trx.insertInto('deleted_documents').values({
      org_id: orgId, doc_type: 'invoice', doc_id: 77, number: 'INV/26-27/0077', doc_date: '2026-11-20', total: '1180.00', contact_id: contact,
      reason: 'Raised twice', snapshot: JSON.stringify({}), deleted_by_user_id: u.arun,
    } as never).execute();
    await trx.insertInto('audit_log').values(row(orgId, u.arun, 'Arun', 'delete', '2026-11-20T06:00:00Z', { target_id: '77', target_label: 'INV/26-27/0077', detail: 'Deleted INV/26-27/0077' }) as never).execute();
    const r = await auditExportRows(trx, orgId, { action: 'delete' }, false);
    assert.equal(r.rows.length, 1);
    const what = r.rows[0][r.rows[0].length - 1];
    assert.match(what, /INV\/26-27\/0077/);
    assert.match(what, /dated 2026-11-20/);
    assert.match(what, /Sharma Traders/);
    assert.match(what, /₹1,180\.00/);
    assert.match(what, /Raised twice/);
    // XLSX with the first column a real Excel date (IST wall clock), and a PDF that opens.
    const book = workbook([{ name: 'Audit trail', rows: [auditExportHeader(false), [istWallClock(new Date(r.instants[0])), ...r.rows[0].slice(1)]] }]);
    const text = new TextDecoder().decode(book);
    assert.match(text, /numFmtId="164" formatCode="dd-mmm-yyyy hh:mm:ss"/);
    // 20 Nov 2026 06:00 UTC is 11:30 IST: serial 46346.479166...
    assert.match(text, /<c r="A2" s="2"><v>46346\.479166/);
    const pdf = pdfTable({ title: 'Audit trail', org: 'Audit Co', columns: auditExportHeader(false).map((h) => ({ header: h })), rows: r.rows });
    assert.equal(new TextDecoder().decode(pdf.slice(0, 8)), '%PDF-1.4');
    assert.match(new TextDecoder('latin1').decode(pdf), /Page 1 of 1/);
  });
});

test('a viewer, and a ready-made Auditor role, may view and export the trail but not change anything', async () => {
  assert.equal(hasPermission('viewer', 'accountant', 'view', null), true);
  assert.equal(hasPermission('viewer', 'accountant', 'export', null), true);
  assert.equal(hasPermission('viewer', 'accountant', 'edit', null), false);
  assert.equal(hasPermission('viewer', 'accountant', 'void', null), false);
  // The Auditor role the settings screen offers: view, print and export everywhere.
  const auditor = { accountant: ['view', 'print', 'export'], 'reports.financial': ['view', 'print', 'export'], output: [] } as never;
  assert.equal(hasPermission('viewer', 'accountant', 'export', auditor), true);
  assert.equal(hasPermission('viewer', 'accountant', 'create', auditor), false);
  assert.equal(hasPermission('viewer', 'accountant', 'void', auditor), false);
});

test.after(() => db.destroy());
