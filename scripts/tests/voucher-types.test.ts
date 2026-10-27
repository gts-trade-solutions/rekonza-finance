// Voucher types: their own number series beside the ordinary one.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/voucher-types.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { saveVoucherType } from '../../lib/server/services/voucher-types';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { createPurchaseOrder } from '../../lib/server/services/purchase-documents';

test('an export series runs beside the ordinary one; prefixes stay apart; a retired type issues nothing', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Series Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998714', kind: 'sac', description: 'Repairs', gst_rate_pct: 18, is_active: 1 }).execute();
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'consumer' } as never).executeTakeFirstOrThrow()).insertId);
      const exp = await saveVoucherType(trx, orgId, { docType: 'INV', code: 'exp', name: 'Export invoice', prefix: 'exp' });
      await assert.rejects(saveVoucherType(trx, orgId, { docType: 'INV', code: 'EX2', name: 'Another', prefix: 'EXP' }), /already uses/);
      await assert.rejects(saveVoucherType(trx, orgId, { docType: 'INV', code: 'SVC', name: 'Service', prefix: 'SERVICE' }), /one to five/);

      const sell = (voucherTypeId?: number) => createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-01', status: 'approved', voucherTypeId,
        lines: [{ description: 'Repair', hsnSac: '998714', qty: 1, ratePaise: 100_00, gstRatePct: 18 }],
      });
      assert.equal((await sell(exp)).number, 'EXP/26-27/0001');
      assert.equal((await sell()).number, 'INV/26-27/0001', 'the ordinary series is untouched');
      assert.equal((await sell(exp)).number, 'EXP/26-27/0002');

      await saveVoucherType(trx, orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP', isActive: false }, exp);
      await assert.rejects(sell(exp), /no longer in use/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test('credit notes and purchase orders have series of their own too', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Series Two Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const party = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'both', display_name: 'Party', state_code: '33', gst_treatment: 'consumer' } as never).executeTakeFirstOrThrow()).insertId);
      const scn = await saveVoucherType(trx, orgId, { docType: 'CN', code: 'SVC', name: 'Service credit note', prefix: 'SCN' });
      const ipo = await saveVoucherType(trx, orgId, { docType: 'PO', code: 'IMP', name: 'Import order', prefix: 'IPO' });
      const line = [{ description: 'Service', qty: 1, ratePaise: 100_00, gstRatePct: 0 }];
      const cn = (voucherTypeId?: number) => createCreditNote(trx, orgId, null, { branchId, customerId: party, date: '2026-06-01', reason: 'Deficiency in service', lines: line, voucherTypeId });
      assert.equal((await cn(scn)).number, 'SCN/26-27/0001');
      assert.equal((await cn()).number, 'CN/26-27/0001');
      const po = (voucherTypeId?: number) => createPurchaseOrder(trx, orgId, null, { branchId, vendorId: party, date: '2026-06-01', lines: line, voucherTypeId });
      assert.equal((await po(ipo)).number, 'IPO/26-27/0001');
      assert.equal((await po()).number, 'PO/26-27/0001');
      await assert.rejects(po(scn), /does not exist for this kind of document/, 'a credit note type cannot number an order');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
