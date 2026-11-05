// The demo book answers the client's checklist ("3. Updated Unresolved Issues"):
// built the way `npm run db:seed` builds it, every point the client listed has
// records behind it, and the dashboard's board names each one in their words.
// Everything runs in one transaction that is rolled back.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/demo-coverage.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { bootstrap } from '../../lib/server/seed/bootstrap';
import { seedDemoBook } from '../../lib/server/seed/demo-book';
import { seedDemoDocuments } from '../../lib/server/seed/demo-documents';
import { seedDemoCoverage, seedDemoHistory } from '../../lib/server/seed/demo-coverage';
import { turnOnDemoControls } from '../../lib/server/seed/demo-controls';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { checklist } from '../../lib/server/services/checklist';

// The client's points, area by area, as the review lists them as not evidenced.
const CLIENT_POINTS: Record<string, string[]> = {
  'Company Management': ['Financial year setup', 'Statutory configuration'],
  'Security & Audit Trail': ['Role based access', 'Audit logs', 'MFA', 'Approval history'],
  'Master Data': ['Cost centres', 'Employee masters', 'Warehouse masters'],
  'Accounting Vouchers': ['Journal', 'Contra', 'Debit note', 'Credit note'],
  Inventory: ['Stock adjustment', 'Transfer', 'Valuation reports'],
  Banking: ['Bank reconciliation', 'Payment processing'],
  'Fixed Assets': ['Asset register', 'Depreciation'],
  Payroll: ['Payroll processing', 'Employee records'],
  'GST & Compliance': ['GST returns', 'TDS / TCS', 'Tax reporting'],
  'Budgeting & Costing': ['Budgets', 'Variance analysis'],
  Reporting: ['Trial balance', 'Balance sheet', 'Profit and loss', 'Cash flow and fund flow'],
  Integration: ['API', 'ERP (webhooks)', 'BI (Power BI, Excel)', 'Payroll'],
};

test('the demo book has records behind every point of the client’s checklist, and the ledger still balances', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      // A demo book already in this database holds the demo GSTINs, which are
      // unique across companies: set aside for this transaction only.
      await trx.updateTable('branches').set({ gstin: null }).where('gstin', 'in', ['33AAGCR4231F1ZR', '29AAGCR4231F1ZG']).execute();
      const ids = await bootstrap(trx, { isDemo: true });
      await seedDemoBook(trx, ids);
      await seedDemoDocuments(trx, ids);
      const made = await seedDemoCoverage(trx, ids);
      await turnOnDemoControls(trx, ids.orgId);
      const history = await seedDemoHistory(trx, ids);

      assert.equal(made.payrollMonths, 4, 'four months of payroll');
      assert.equal(made.depreciationRuns, 4, 'four months of depreciation');
      assert.ok(history.auditEntries > 50, `an audit trail (${history.auditEntries})`);
      const balances = await verifyLedgerBalances(trx, ids.orgId);
      assert.ok(balances.balanced && balances.unbalancedEntries === 0, 'the ledger balances');

      const areas = await checklist(trx, ids.orgId);
      for (const [area, points] of Object.entries(CLIENT_POINTS)) {
        const a = areas.find((x) => x.area === area);
        assert.ok(a, `${area} is on the checklist`);
        for (const label of points) {
          const point = a!.points.find((p) => p.label === label);
          assert.ok(point, `${area} names "${label}"`);
          assert.ok(point!.ok, `${area}: "${label}" has records (${point!.value})`);
          assert.match(point!.href, /^\//, `${area}: "${label}" opens a screen`);
        }
      }
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
