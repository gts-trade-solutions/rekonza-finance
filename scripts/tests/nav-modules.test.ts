// The menu, laid out as Zoho's (components/layout/nav-config.ts), still tells
// the print guard which part of the books every screen belongs to. A screen it
// cannot place could be printed by any role, so the single-link groups
// (Banking, Reports, Documents) must be found as well as the screens in groups.
//
//   npx tsx --test scripts/tests/nav-modules.test.ts
//
// Run without --conditions=react-server (package.json runs it as its own step):
// the menu carries lucide icons, which need React's client build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_NAV_ITEMS, NAV_GROUPS, TOP_LEVEL, menuModuleForPath } from '../../components/layout/nav-config';

test('every screen is placed in its part of the books', () => {
  assert.equal(menuModuleForPath('/reports/profit-and-loss'), 'reports');
  assert.equal(menuModuleForPath('/reports'), 'reports');
  assert.equal(menuModuleForPath('/documents'), 'accountant');
  assert.equal(menuModuleForPath('/banking/reconcile'), 'banking');
  assert.equal(menuModuleForPath('/sales/invoices/12'), 'sales');
  assert.equal(menuModuleForPath('/purchases/bills/7'), 'purchases');
  assert.equal(menuModuleForPath('/gst/eway-bills'), 'gst', 'e-way bills sit under Sales in the menu but are GST work');
  assert.equal(menuModuleForPath('/purchases/recurring'), 'purchases', 'an entry with a query still places its path');
  assert.equal(menuModuleForPath('/settings'), 'settings');
  assert.equal(menuModuleForPath('/dashboard'), 'sales');
});

test("Zoho's menu comes first, in Zoho's order, and Rekonza's own after it", () => {
  assert.equal(TOP_LEVEL[0].label, 'Home');
  const zoho = NAV_GROUPS.filter((g) => !g.extra).map((g) => g.label);
  assert.deepEqual(zoho, ['Items', 'Sales', 'Purchases', 'Time Tracking', 'Banking', 'Accountant', 'Reports', 'Documents']);
  const sales = NAV_GROUPS.find((g) => g.label === 'Sales')!.items.map((i) => i.label);
  assert.deepEqual(sales.slice(0, 10), ['Customers', 'Quotes', 'Service Invoices', 'Sales Orders', 'Invoices', 'Recurring Invoices', 'Delivery Challans', 'Payments Received', 'Credit Notes', 'e-Way Bills']);
  // Every extra group follows every Zoho group.
  const firstExtra = NAV_GROUPS.findIndex((g) => g.extra);
  assert.ok(NAV_GROUPS.slice(firstExtra).every((g) => g.extra));
});

test('no screen is listed twice under one group, and every link is an app address', () => {
  for (const g of NAV_GROUPS) {
    const hrefs = g.items.map((i) => i.href);
    assert.equal(new Set(hrefs).size, hrefs.length, `${g.label} lists a screen twice`);
  }
  for (const i of ALL_NAV_ITEMS) assert.match(i.href, /^\//, i.label);
});

test('entering a transaction folds the sidebar; a master’s form and the lists do not', async () => {
  const { isEntryPage } = await import('../../components/layout/nav-state');
  for (const p of [
    '/sales/invoices/new', '/sales/invoices/42/edit', '/sales/debit-notes/new', '/sales/sales-receipts/new',
    '/sales/payments/new', '/purchases/bills/new', '/purchases/payments/new', '/purchases/expenses/new',
    '/accountant/journals/new', '/sales/estimates/7/edit',
  ]) assert.equal(isEntryPage(p), true, p);
  for (const p of [
    '/sales/invoices', '/sales/invoices/42', '/sales/customers/new', '/sales/customers/3/edit', '/sales/items/new',
    '/purchases/vendors/new', '/purchases/vendors/9/edit', '/analytics/new', '/dashboard', '/sales/invoices/new-ish', null, '',
  ]) assert.equal(isEntryPage(p), false, String(p));
});
