/* eslint-disable @typescript-eslint/no-explicit-any -- responses are read as raw JSON and checked field by field */
// The HTTP surface, against a running dev server.
//   npm run dev            (in one terminal)
//   npm run test:api
//
// These are the checks that cannot be made in-process: authentication,
// permissions, and the shape of what actually crosses the wire. A permission
// enforced only in a React component is not enforced at all, so most of what
// follows is deliberately hostile.

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE || 'http://localhost:5000';

interface Res<T = any> {
  status: number;
  body: T;
  cookie?: string;
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body,
    cookie: setCookie?.split(';')[0],
  };
}

async function signIn(email: string, password = 'Rekonza@2026'): Promise<string> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign-in failed for ${email}: ${JSON.stringify(res.body)}`);
  assert.ok(res.cookie, 'no session cookie returned');
  return res.cookie!;
}

let admin = '';
let viewer = '';
let sales = '';

// ─────────────────────────────────────────────────────────────────────────────
// The ids these tests act on, discovered rather than assumed.
//
// They used to be written in as '1', '2', '16'. That held only while the demo
// was the first thing in the database and the seeder reset every AUTO_INCREMENT
// to one. It no longer is: real organisations share these tables, so --fresh
// deletes the demo's rows by org_id and the next seed starts from wherever the
// counters happen to be. Ids are therefore looked up by the property each test
// actually depends on — a Tamil Nadu branch, a Karnataka customer, a 28% item —
// which is what the test meant all along.
// ─────────────────────────────────────────────────────────────────────────────
const ids = {
  branch: '',        // Chennai — Tamil Nadu, state 33
  branchKa: '',      // Bengaluru — Karnataka, state 29; the sales user's only branch
  customerIntra: '', // registered, also in Tamil Nadu
  customerInter: '', // registered, in Karnataka
  item28: '',        // a 28% item, so the arithmetic below stays fixed
  vendor: '',        // registered, for bills
  bankAccount: '',   // a real bank, not cash or a card
  expenseAccount: '',// an ordinary expense head, not a control account
};

test('the API is up and the database is reachable', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.database.ok, true);
});

test('signs in and issues an httpOnly session cookie', async () => {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'arun@raceautospares.in', password: 'Rekonza@2026' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  admin = res.cookie!;
  viewer = await signIn('deepa@raceautospares.in');
  sales = await signIn('vikram@raceautospares.in');
});

test('resolves the ids the rest of the suite acts on', async () => {
  const m = await call('/api/masters', { cookie: admin });
  assert.equal(m.status, 200, JSON.stringify(m.body));

  const branch = m.body.branches.find((b: any) => b.stateCode === '33');
  assert.ok(branch, 'the demo book has a Tamil Nadu registration');
  ids.branch = branch.id;
  ids.branchKa = m.body.branches.find((b: any) => b.stateCode === '29')?.id;
  assert.ok(ids.branchKa, 'and a Karnataka one');

  const customers = m.body.contacts.filter(
    (c: any) => (c.kind === 'customer' || c.kind === 'both') && c.gstTreatment === 'registered',
  );
  // Same state as the branch, so the supply is intra-state and splits.
  ids.customerIntra = customers.find((c: any) => c.stateCode === '33')?.id;
  // A different state, so the same goods attract IGST instead.
  ids.customerInter = customers.find((c: any) => c.stateCode === '29')?.id;
  assert.ok(ids.customerIntra && ids.customerInter, 'customers on both sides of a border');

  // The tax figures asserted below are worked from a 28% rate.
  ids.item28 = m.body.items.find((i: any) => i.gstRatePct === 28)?.id;
  assert.ok(ids.item28, 'a 28% item');

  ids.vendor = m.body.contacts.find(
    (c: any) => (c.kind === 'vendor' || c.kind === 'both') && c.gstTreatment === 'registered',
  )?.id;
  assert.ok(ids.vendor, 'a registered vendor');

  ids.bankAccount = m.body.bankAccounts.find((b: any) => b.kind === 'bank')?.id;
  assert.ok(ids.bankAccount, 'a bank account');

  // An ordinary overhead. Posting a test expense to Cost of Goods Sold would
  // work but would be a lie about what the expense was.
  ids.expenseAccount = m.body.accounts.find(
    (a: any) => a.type === 'expense' && !a.isSystem && a.code >= '6000',
  )?.id;
  assert.ok(ids.expenseAccount, 'an expense account');
});

test('a wrong password and an unknown email are indistinguishable', async () => {
  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'arun@raceautospares.in', password: 'not-it' }),
  });
  const unknown = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@example.com', password: 'not-it' }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  // Identical text and code, or the login form becomes a customer list.
  assert.equal(wrong.body.error, unknown.body.error);
  assert.equal(wrong.body.code, unknown.body.code);
});

test('rejects an unauthenticated request', async () => {
  const res = await call('/api/invoices');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'unauthorized');
});

test('rejects a forged session cookie', async () => {
  const res = await call('/api/auth/me', { cookie: 'rekonza_session=made-up-token-value' });
  assert.equal(res.status, 401);
});

test('a viewer may read but not create — enforced on the server', async () => {
  const read = await call('/api/invoices', { cookie: viewer });
  assert.equal(read.status, 200, 'a viewer can read');

  const write = await call('/api/invoices', {
    cookie: viewer,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId: ids.item28, qty: 1, ratePaise: 100 }],
    }),
  });
  assert.equal(write.status, 403, 'a viewer cannot create');
  assert.match(write.body.error, /cannot create in sales/);
});

test('a sales user may create an invoice but not touch the accountant module', async () => {
  const res = await call('/api/invoices', {
    cookie: sales,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branchKa, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'draft',
      lines: [{ itemId: ids.item28, qty: 1, ratePaise: 145000 }],
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.number.startsWith('INV/'));
  // A draft posts nothing — it is not a sale yet.
  assert.equal(res.body.journalEntryId, null);
});

test('a user limited to one branch cannot raise documents under another GSTIN', async () => {
  // Vikram sells from Bengaluru only. Naming Chennai in the body used to work,
  // because the restriction lived only in the branch picker.
  const res = await call('/api/invoices', {
    cookie: sales,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'draft',
      lines: [{ itemId: ids.item28, qty: 1, ratePaise: 145000 }],
    }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /access to that branch/);

  const me = await call('/api/auth/me', { cookie: sales });
  assert.deepEqual(me.body.branches.map((b: any) => b.id), [ids.branchKa]);
});

test('validates the request body and names the offending field', async () => {
  const res = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: 'not-a-date', dueDate: '2026-09-06',
      lines: [{ itemId: ids.item28, qty: 1, ratePaise: 100 }],
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'validation');
  assert.match(res.body.details.date, /yyyy-mm-dd/);
});

test('refuses an invoice with no lines', async () => {
  const res = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06', lines: [],
    }),
  });
  assert.equal(res.status, 400);
});

test('refuses an HSN code that is not on the approved list', async () => {
  const res = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ description: 'Something', hsnSac: '1234', qty: 1, ratePaise: 10000, gstRatePct: 18 }],
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not on the approved list/);
});

test('resolves GST from the two states and posts a balanced entry', async () => {
  // Chennai branch (33) to a Tamil Nadu customer (33): the tax splits.
  const intra = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId: ids.item28, qty: 10, ratePaise: 145000 }],
    }),
  });
  assert.equal(intra.status, 200, JSON.stringify(intra.body));

  const detail = await call(`/api/invoices/${intra.body.id}`, { cookie: admin });
  assert.equal(detail.body.supplyType, 'intra');
  assert.equal(detail.body.subtotalPaise, 1_450_000);
  assert.equal(detail.body.tax.cgstPaise, 203_000);
  assert.equal(detail.body.tax.sgstPaise, 203_000);
  assert.equal(detail.body.tax.igstPaise, 0);
  assert.equal(detail.body.totalPaise, 1_856_000);

  const dr = detail.body.journalLines.reduce((t: number, l: any) => t + l.debitPaise, 0);
  const cr = detail.body.journalLines.reduce((t: number, l: any) => t + l.creditPaise, 0);
  assert.equal(dr, cr, 'the entry balances');
  assert.equal(dr, 1_856_000);

  // Tax is credited to a liability, never to income.
  const taxLines = detail.body.journalLines.filter((l: any) => l.accountCode.startsWith('22'));
  assert.equal(taxLines.length, 2, 'CGST and SGST posted separately');

  // Chennai branch (33) to a Karnataka customer (29): one integrated tax.
  const inter = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerInter, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId: ids.item28, qty: 10, ratePaise: 145000 }],
    }),
  });
  const interDetail = await call(`/api/invoices/${inter.body.id}`, { cookie: admin });
  assert.equal(interDetail.body.supplyType, 'inter');
  assert.equal(interDetail.body.tax.igstPaise, 406_000);
  assert.equal(interDetail.body.tax.cgstPaise, 0);
  // Same money either way — only the split differs.
  assert.equal(interDetail.body.totalPaise, detail.body.totalPaise);
});

test('invoice numbers are unique and sequential within a branch', async () => {
  const numbers: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await call('/api/invoices', {
      cookie: admin,
      method: 'POST',
      body: JSON.stringify({
        branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
        status: 'draft', lines: [{ itemId: ids.item28, qty: 1, ratePaise: 145000 }],
      }),
    });
    numbers.push(res.body.number);
  }
  assert.equal(new Set(numbers).size, 3, 'no duplicates');
  const seq = numbers.map((n) => Number(n.split('/').pop()));
  assert.deepEqual(seq, [seq[0], seq[0] + 1, seq[0] + 2], 'consecutive');
});

test('concurrent creates never collide on a number', async () => {
  // The failure this guards against only appears under contention: two people
  // saving at the same moment being handed the same invoice number, which is a
  // GSTR-1 rejection rather than a cosmetic clash.
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      call('/api/invoices', {
        cookie: admin,
        method: 'POST',
        body: JSON.stringify({
          branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
          status: 'draft', lines: [{ itemId: ids.item28, qty: 1, ratePaise: 100000 }],
        }),
      }),
    ),
  );
  const ok = results.filter((r) => r.status === 200);
  const numbers = ok.map((r) => r.body.number);
  assert.equal(ok.length, 8, `all 8 succeeded: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(new Set(numbers).size, 8, `all 8 numbers distinct: ${numbers.join(', ')}`);
});

test('voiding reverses the entry and leaves the original in place', async () => {
  const created = await call('/api/invoices', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, customerId: ids.customerIntra, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId: ids.item28, qty: 2, ratePaise: 145000 }],
    }),
  });
  const id = created.body.id;

  const voided = await call(`/api/invoices/${id}`, {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ action: 'void', reason: 'Raised in error' }),
  });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.status, 'void');

  const after = await call(`/api/invoices/${id}`, { cookie: admin });
  assert.equal(after.body.status, 'void');
  // The document and its original entry are still there — a void is a
  // correction posted alongside, not an erasure.
  assert.ok(after.body.journalEntryId, 'the original entry is still linked');
  assert.equal(after.body.lines.length, 1);

  const again = await call(`/api/invoices/${id}`, {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ action: 'void' }),
  });
  assert.equal(again.status, 409, 'voiding twice is refused');
});

test('list filters by date and status in SQL', async () => {
  const all = await call('/api/invoices?limit=500', { cookie: admin });
  assert.equal(all.status, 200);
  assert.ok(all.body.invoices.length > 0);
  assert.ok(all.body.summary.count > 0);

  const narrow = await call('/api/invoices?from=2020-01-01&to=2020-12-31', { cookie: admin });
  assert.equal(narrow.body.invoices.length, 0, 'a period with no invoices returns none');

  const drafts = await call('/api/invoices?status=draft', { cookie: admin });
  assert.ok(drafts.body.invoices.every((i: any) => i.status === 'draft'));
});

test('signing out invalidates the session immediately', async () => {
  const cookie = await signIn('priya@raceautospares.in');
  assert.equal((await call('/api/auth/me', { cookie })).status, 200);

  const out = await call('/api/auth/logout', { cookie, method: 'POST' });
  assert.equal(out.status, 200);

  // The same cookie value must now be worthless, not merely cleared in the
  // browser — which is the thing a stateless JWT cannot promise.
  assert.equal((await call('/api/auth/me', { cookie })).status, 401);
});

test('records a bill and a payment against it through the API', async () => {
  const bill = await call('/api/bills', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, vendorId: ids.vendor, vendorInvoiceNo: `API-${Date.now()}`,
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ description: 'Parts', qty: 10, ratePaise: 60000, gstRatePct: 18 }],
    }),
  });
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  assert.ok(bill.body.internalNo.startsWith('BILL/'));
  assert.ok(bill.body.journalEntryId, 'the bill posted an entry');

  const pay = await call('/api/payments', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      kind: 'made', branchId: ids.branch, contactId: ids.vendor, date: '2026-08-10',
      mode: 'neft', amountPaise: bill.body.totalPaise, bankAccountId: ids.bankAccount,
      allocations: [{ targetType: 'bill', targetId: bill.body.id, amountPaise: bill.body.totalPaise }],
    }),
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.unappliedPaise, 0);

  const bills = await call(`/api/bills?search=${encodeURIComponent(bill.body.internalNo)}`, { cookie: admin });
  const found = bills.body.bills.find((b: any) => b.id === bill.body.id);
  assert.equal(found.status, 'paid', 'the bill is settled');
  assert.equal(found.balancePaise, 0);
});

test('a receipt cannot be allocated against a bill', async () => {
  // Crossing the two would credit a customer for paying a supplier.
  const res = await call('/api/payments', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      kind: 'received', branchId: ids.branch, contactId: ids.customerIntra, date: '2026-08-10',
      mode: 'neft', amountPaise: 1000, bankAccountId: ids.bankAccount,
      allocations: [{ targetType: 'bill', targetId: '1', amountPaise: 1000 }],
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /receipt cannot be allocated against a bill/);
});

test('records an expense and posts it', async () => {
  const res = await call('/api/expenses', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, date: '2026-08-07', accountId: ids.expenseAccount,
      paidThroughBankAccountId: ids.bankAccount, amountPaise: 118000, gstRatePct: 18,
      notes: 'API test expense',
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.totalPaise, 118000);
  assert.ok(res.body.journalEntryId);

  const list = await call('/api/expenses?limit=5', { cookie: admin });
  assert.equal(list.status, 200);
  assert.ok(list.body.expenses.length > 0);
});

test('a sales user cannot record a purchase', async () => {
  const res = await call('/api/bills', {
    cookie: sales,
    method: 'POST',
    body: JSON.stringify({
      branchId: ids.branch, vendorId: ids.vendor, vendorInvoiceNo: 'NOPE-1',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ description: 'x', qty: 1, ratePaise: 1000 }],
    }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /cannot create in purchases/);
});

test('the same vendor invoice number cannot be entered twice', async () => {
  // The check that stops a duplicate payment going out.
  const dup = `DUP-${Date.now()}`;
  const payload = {
    branchId: ids.branch, vendorId: ids.vendor, vendorInvoiceNo: dup,
    date: '2026-08-07', dueDate: '2026-09-06',
    lines: [{ description: 'Parts', qty: 1, ratePaise: 50000, gstRatePct: 18 }],
  };
  const first = await call('/api/bills', { cookie: admin, method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 200);
  const second = await call('/api/bills', { cookie: admin, method: 'POST', body: JSON.stringify(payload) });
  assert.equal(second.status, 409, JSON.stringify(second.body));
});

test('imports a bank statement and skips a re-import', async () => {
  const stamp = Date.now();
  const rows = [
    { date: '2026-08-01', narration: `API IMPORT ${stamp} A`, depositPaise: 25000 },
    { date: '2026-08-02', narration: `API IMPORT ${stamp} B`, withdrawalPaise: 7500 },
  ];

  const first = await call('/api/banking/import', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ bankAccountId: ids.bankAccount, filename: 'api.csv', rows }),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.imported, 2);
  assert.equal(first.body.duplicates, 0);

  // The same file again: nothing new, nothing doubled.
  const second = await call('/api/banking/import', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ bankAccountId: ids.bankAccount, filename: 'api.csv', rows }),
  });
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.duplicates, 2);
});

test('categorising a bank line through the API posts an entry', async () => {
  const stamp = Date.now();
  await call('/api/banking/import', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({
      bankAccountId: ids.bankAccount,
      filename: 'cat.csv',
      rows: [{ date: '2026-08-04', narration: `CATEGORISE ME ${stamp}`, withdrawalPaise: 4500 }],
    }),
  });

  const list = await call('/api/banking/transactions?status=unmatched&limit=500', { cookie: admin });
  const line = list.body.transactions.find((t: any) => t.narration.includes(`CATEGORISE ME ${stamp}`));
  assert.ok(line, 'the imported line is listed');

  // Account 39 is an expense account in the seeded chart.
  const res = await call('/api/banking/transactions', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ action: 'categorise', transactionId: line.id, accountId: ids.expenseAccount }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.journalEntryId);

  const after = await call('/api/banking/transactions?status=matched&limit=500', { cookie: admin });
  assert.ok(after.body.transactions.some((t: any) => t.id === line.id), 'now matched');
});

test('bank accounts report a balance and an unmatched count', async () => {
  const res = await call('/api/banking/accounts', { cookie: admin });
  assert.equal(res.status, 200);
  assert.ok(res.body.accounts.length > 0);
  const main = res.body.accounts[0];
  assert.equal(typeof main.balancePaise, 'number');
  assert.equal(typeof main.unmatchedCount, 'number');
  // Automatic feeds need a licensed aggregator, so this must stay off.
  assert.equal(main.feedConnected, false);
});

test('the statements agree with each other over the API', async () => {
  const tb = await call('/api/reports?report=trial-balance&to=2027-03-31', { cookie: admin });
  assert.equal(tb.status, 200, JSON.stringify(tb.body));
  assert.equal(tb.body.balanced, true, `off by ${tb.body.totalDebit - tb.body.totalCredit}`);
  assert.equal(tb.body.totalDebit, tb.body.totalCredit);

  const bs = await call('/api/reports?report=balance-sheet&to=2027-03-31', { cookie: admin });
  assert.equal(bs.body.balanced, true);
  assert.equal(bs.body.totalAssets, bs.body.totalLiabilities + bs.body.totalEquity);

  const pl = await call('/api/reports?report=profit-and-loss&from=2026-04-01&to=2027-03-31', { cookie: admin });
  assert.equal(pl.status, 200);
  // Two reports over one journal must reach the same profit.
  assert.equal(pl.body.netProfit, bs.body.currentPeriodEarnings);
});

test('a profit and loss without a start date is refused', async () => {
  const res = await call('/api/reports?report=profit-and-loss&to=2027-03-31', { cookie: admin });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs a start date/);
});

test('ageing agrees with the control account', async () => {
  const ar = await call('/api/reports?report=ar-ageing&to=2027-03-31', { cookie: admin });
  assert.equal(ar.status, 200);
  const tb = await call('/api/reports?report=trial-balance&to=2027-03-31', { cookie: admin });
  const control = tb.body.rows.find((r: any) => r.code === '1100');
  assert.equal(ar.body.grandTotalPaise, control?.balancePaise ?? 0);
});

test('a sales user cannot see the banking module', async () => {
  const res = await call('/api/banking/accounts', { cookie: sales });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /cannot view in banking/);
});
