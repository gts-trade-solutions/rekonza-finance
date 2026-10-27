// Lower-deduction certificates, inoperative PANs, and the Form 131 / 16A tracker.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tds-certificates.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { quarterReturn } from '../../lib/server/tax/tds-returns';
import {
  addLowerCertificate, cancelLowerCertificate, certificateDueDate, certificates, recordCertificate, setPanStatus,
} from '../../lib/server/tax/tds-certificates';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; vendorId: number; customerId: number; bankId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Cert Co', tan: 'CHER12345A' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Consulting LLP', gst_treatment: 'registered',
        state_code: '33', pan: 'AAAFC1234B', tds_section: '194J',
      }).executeTakeFirstOrThrow()).insertId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Big Buyer Ltd', gst_treatment: 'registered', state_code: '33', pan: 'AAACB1234C',
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current A/c', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, vendorId, customerId, bankId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const bill = (f: Fixture, no: string, date: string, ratePaise: number) => createBill(f.trx, f.orgId, null, {
  branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: no, date, dueDate: date,
  lines: [{ description: 'Consulting', qty: 1, ratePaise, gstRatePct: 18 }],
});
const tdsOf = async (f: Fixture, id: number) => {
  const b = await f.trx.selectFrom('bills').select(['tds_amount', 'tds_rate_pct', 'tds_lower_cert_id']).where('id', '=', id).executeTakeFirstOrThrow();
  return { tds: toPaiseFromSql(b.tds_amount), rate: b.tds_rate_pct === null ? null : Number(b.tds_rate_pct), cert: b.tds_lower_cert_id };
};

test('a certificate sets the rate while its amount lasts, then the normal rate returns', async () => {
  await withFixture(async (f) => {
    const cert = await addLowerCertificate(f.trx, f.orgId, null, {
      contactId: f.vendorId, sectionCode: '194J', certificateNo: 'ab1234567890', ratePct: 2,
      validFrom: '2026-04-01', validTo: '2027-03-31', limitPaise: 1_50_000_00,
    });
    assert.equal(cert.certificateNo, 'AB1234567890');

    const a = await bill(f, 'C-1', '2026-07-05', 1_00_000_00);
    assert.deepEqual(await tdsOf(f, a.id), { tds: 2_000_00, rate: 2, cert: cert.id });

    // Another 1,00,000 would take the certificate to 2,00,000 against a 1,50,000 limit.
    const b = await bill(f, 'C-2', '2026-07-20', 1_00_000_00);
    assert.deepEqual(await tdsOf(f, b.id), { tds: 10_000_00, rate: 10, cert: null });

    const r = await quarterReturn(f.trx, f.orgId, 2026, 2);
    const rows = r.forms[0].rows;
    assert.equal(rows.find((x) => x.docNumber.includes('C-1'))!.remark, 'A');
    assert.equal(rows.find((x) => x.docNumber.includes('C-1'))!.lowerCertificateNo, 'AB1234567890');
    assert.equal(rows.find((x) => x.docNumber.includes('C-2'))!.remark, null);

    await assert.rejects(
      addLowerCertificate(f.trx, f.orgId, null, {
        contactId: f.vendorId, sectionCode: '194J', certificateNo: 'XY9999999999', ratePct: 1,
        validFrom: '2026-10-01', validTo: '2026-12-31',
      }),
      /already covers part of that period/,
    );
  });
});

test('a nil certificate still reaches the return; a withdrawn one stops applying', async () => {
  await withFixture(async (f) => {
    const cert = await addLowerCertificate(f.trx, f.orgId, null, {
      contactId: f.vendorId, sectionCode: '194J', certificateNo: 'NIL0000001', ratePct: 0,
      validFrom: '2026-04-01', validTo: '2026-09-30',
    });
    const a = await bill(f, 'N-1', '2026-05-10', 80_000_00);
    assert.deepEqual(await tdsOf(f, a.id), { tds: 0, rate: 0, cert: cert.id });
    const r = await quarterReturn(f.trx, f.orgId, 2026, 1);
    assert.equal(r.forms[0].rows.length, 1, 'reported, with nothing deducted');
    assert.equal(r.forms[0].rows[0].remark, 'A');

    await cancelLowerCertificate(f.trx, f.orgId, cert.id);
    const b = await bill(f, 'N-2', '2026-05-20', 80_000_00);
    assert.equal((await tdsOf(f, b.id)).rate, 10);
  });
});

test('an inoperative PAN is deducted at the no-PAN rate and flagged C', async () => {
  await withFixture(async (f) => {
    await setPanStatus(f.trx, f.orgId, f.vendorId, 'inoperative', '2026-06-30');
    const a = await bill(f, 'P-1', '2026-07-05', 1_00_000_00);
    assert.equal((await tdsOf(f, a.id)).rate, 20);
    const r = await quarterReturn(f.trx, f.orgId, 2026, 2);
    assert.equal(r.forms[0].rows[0].remark, 'C');
    assert.ok(r.issues.some((i) => /inoperative/.test(i.message)));
  });
});

test('certificates due, sent, and received from customers', async () => {
  await withFixture(async (f) => {
    await bill(f, 'Q-1', '2026-07-05', 1_00_000_00);
    // A customer pays 99,000 and withholds 1,000 of TDS.
    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-08-01', mode: 'neft',
      amountPaise: 99_000_00, tdsPaise: 1_000_00, bankAccountId: f.bankId,
    });

    assert.equal(certificateDueDate(2026, 2), '2026-11-15', '15 days after the 31 October return');
    let v = await certificates(f.trx, f.orgId, 2026, 2, '2026-11-20');
    assert.equal(v.form, 'Form 131');
    assert.equal(v.issued[0].taxPaise, 10_000_00);
    assert.equal(v.issued[0].status, 'overdue');
    assert.equal(v.received[0].taxPaise, 1_000_00);
    assert.equal(v.received[0].status, 'due');

    await recordCertificate(f.trx, f.orgId, null, {
      direction: 'issued', contactId: f.vendorId, fy: 2026, quarter: 2, certificateNo: 'ABCDE12', issuedOn: '2026-11-21', taxPaise: 10_000_00,
    });
    await recordCertificate(f.trx, f.orgId, null, {
      direction: 'received', contactId: f.customerId, fy: 2026, quarter: 2, certificateNo: 'XYZW99', issuedOn: '2026-11-10', taxPaise: 400_00,
    });
    v = await certificates(f.trx, f.orgId, 2026, 2, '2026-11-25');
    assert.equal(v.issued[0].status, 'done');
    assert.equal(v.received[0].status, 'partial', '400 of the 1,000 withheld is covered');
  });
});

test.after(async () => {
  await db.destroy();
});
