// The client's three asks of 2026-11-28, through the screens, in a company
// signed up for the run (FRESH=1) or the demo book:
//
//   1. the sidebar is open when the app first opens, and folds once a page is
//      chosen from it;
//   2. when someone who is not an admin reverses a journal, deletes or
//      changes an invoice, it goes to the admin with Approve and Reject (in
//      the bell and on Approvals); Approve carries it out, Reject leaves it;
//      the person is told; an admin is never asked;
//   3. an entry undone on its own date leaves the General Ledger, and comes
//      back with "Show reversed entries".
//
//   BASE=http://localhost:5022 FRESH=1 node scripts/e2e/client-1128-admin-code.mjs

import { start, signInOn, BASE, FRESH, today } from './_sr7-common.mjs';

const t = await start('c1128');
const { page, check, shot, go, api, idle } = t;
const tag = String(Date.now()).slice(-6);
const width = async () => Math.round((await page.locator('aside').first().boundingBox())?.width ?? 0);

let clerkPage = null;
try {
  if (FRESH) await t.signUp(`Admin Code Co ${tag}`); else await t.loginDemo();

  // ── 1. The sidebar ────────────────────────────────────────────────────────
  check('the app opens with the sidebar showing (220px)', (await width()) === 220, `${await width()}px`);
  await shot('sidebar-open-at-first');
  await page.locator('[data-slot=sidebar] button', { hasText: /^Sales$/ }).first().click();
  await page.locator('[data-slot=sidebar] a[href="/sales/invoices"]').first().click();
  await page.waitForURL('**/sales/invoices');
  await idle(600);
  check('choosing a page from it folds it to the rail (72px)', (await width()) === 72, `${await width()}px`);
  await shot('sidebar-folded-after-click');
  await page.locator('[data-slot=topbar-nav-fold]').click();
  await idle(400);
  check('the ☰ in the top bar opens it again', (await width()) === 220, `${await width()}px`);

  // ── Set-up: an accountant, an invoice and two journals ───────────────────
  const masters = (await api('GET', '/api/masters')).body;
  const acc = (code) => String(masters.accounts.find((a) => a.code === code).id);
  const branchId = String(((await api('GET', '/api/settings')).body?.branches ?? [])[0]?.id ?? '');
  const clerkEmail = `clerk-${tag}@example.test`;
  const clerkPassword = 'Clerk@2026Okay';
  const made = (await api('POST', '/api/settings/users', { action: 'add', name: `Kumar Clerk ${tag}`, email: clerkEmail, role: 'accountant', homeBranchId: branchId })).body;
  const c0 = await t.browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.8.8.8' } });
  await c0.request.post(`${BASE}/api/auth/login`, { data: { email: clerkEmail, password: made.temporaryPassword } });
  const changed = await c0.request.post(`${BASE}/api/auth/password`, { data: { current: made.temporaryPassword, next: clerkPassword } });
  check('set-up: an accountant (not an admin) is added', changed.status() === 200, String(changed.status()));
  await c0.close();

  const cust = (await api('POST', '/api/contacts', { kind: 'customer', displayName: `Code Test Buyer ${tag}`, gstTreatment: 'unregistered', stateCode: '33' })).body;
  const inv = (await api('POST', '/api/invoices', { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: 100_000, gstRatePct: 0 }] }));
  check('set-up: an invoice to change and delete', inv.status === 200, JSON.stringify(inv.body).slice(0, 120));
  const jv = (await api('POST', '/api/journal', { date: today(), memo: `Stationery ${tag}`, lines: [{ accountId: acc('6400'), debitPaise: 50_000 }, { accountId: acc('1210'), creditPaise: 50_000 }] }));
  check('set-up: a journal to reverse', jv.status === 200, JSON.stringify(jv.body).slice(0, 120));
  // No journal approval rule here: the reversal posts as soon as the code is given.

  // An admin is never asked: deleting a journal of their own goes straight through.
  const own = (await api('POST', '/api/journal', { date: today(), memo: `Admin's own ${tag}`, lines: [{ accountId: acc('6400'), debitPaise: 10_000 }, { accountId: acc('1210'), creditPaise: 10_000 }] })).body;
  const adminRev = await api('PATCH', '/api/journal', { entryId: own.id, date: today(), reason: 'Entered twice' });
  check('an admin reverses without a code', adminRev.status === 200, `${adminRev.status} ${JSON.stringify(adminRev.body).slice(0, 100)}`);

  // ── 2. The accountant, on their own page ─────────────────────────────────
  const cctx = await t.browser.newContext({ viewport: { width: 1500, height: 950 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.6.6.6' } });
  const cpage = await cctx.newPage();
  clerkPage = cpage;
  cpage.setDefaultTimeout(60000);
  await signInOn(cpage, clerkEmail, clerkPassword);
  check('the accountant signs in', /\/dashboard/.test(cpage.url()), cpage.url());
  const capi = (method, p, body) => cpage.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Change-Reason': encodeURIComponent('End-to-end test') }, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  }, [method, p, body]);
  const noticesOf = async (get) => ((await get('GET', '/api/notifications')).body?.items ?? []);
  const changedLines = [{ description: 'Service', qty: 2, ratePaise: 100_000, gstRatePct: 0 }];
  // A request the app refuses on purpose (409, sent for approval) is logged by the browser; it is expected here.
  t.expect4xx('/api/invoices');

  // Changing the saved invoice: kept for an admin, nothing changes yet.
  const put = await capi('PUT', `/api/invoices/${inv.body.id}`, { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: changedLines });
  check('the accountant changing a saved invoice is sent to the admin for approval', put.status === 409 && put.body?.code === 'sent_for_approval', `${put.status} ${put.body?.code}`);
  const still = (await api('GET', `/api/invoices/${inv.body.id}`)).body;
  check('…and the invoice is unchanged while it waits (₹1,000)', still?.totalPaise === 100_000, String(still?.totalPaise));

  // The admin rejects it from the bell.
  await go('/dashboard');
  await page.locator('button[aria-label^="Notifications"]').first().click();
  await page.locator('[data-slot="bell-admin-request"]').first().waitFor({ timeout: 30000 });
  check('the bell shows the request with Approve and Reject', (await page.locator('[data-slot="admin-request-approve"]').count()) > 0 && (await page.locator('[data-slot="admin-request-reject"]').count()) > 0);
  await shot('admin-bell-approve-reject');
  const changeRow = page.locator('[role="menuitem"]', { hasText: 'asks to change invoice' }).first();
  await changeRow.locator('[data-slot="admin-request-reject"]').click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  const after = (await api('GET', `/api/invoices/${inv.body.id}`)).body;
  check('Reject: the invoice stays as it was', after?.totalPaise === 100_000, String(after?.totalPaise));
  const toldReject = (await noticesOf(capi)).find((n) => /^Rejected: change invoice/.test(n.title));
  check('…and the accountant is told it was rejected', !!toldReject, toldReject?.title);

  // Reversing a journal through the screen: told it went for approval.
  await cpage.goto(`${BASE}/accountant/journals`, { waitUntil: 'domcontentloaded' });
  const row = cpage.locator('tr', { hasText: `Stationery ${tag}` }).first();
  await row.waitFor({ timeout: 60000 });
  await row.locator('[data-slot="reverse-journal"]').click();
  await cpage.fill('[data-slot="reverse-date"]', today());
  await cpage.fill('[data-slot="reverse-reason"]', 'Posted to the wrong account');
  await cpage.click('[data-slot="confirm-reverse"]');
  const sentDlg = cpage.locator('[data-slot="approval-sent"]');
  await sentDlg.waitFor({ timeout: 30000 });
  check('reversing a journal says "Sent to the admin for approval"', /Sent to the admin for approval/.test(await sentDlg.innerText()) && /reverse journal entry/.test(await sentDlg.innerText()));
  await cpage.screenshot({ path: `${process.env.SHOTS ?? '.'}/c1128-sent-for-approval${FRESH ? '-fresh' : '-demo'}.png` });
  await cpage.locator('[data-slot="approval-sent-ok"]').click();
  let list = (await api('GET', '/api/journal?sourceType=manual&limit=300&hideReversed=0')).body;
  check('…and nothing is reversed yet', !(list.entries ?? []).find((e) => e.memo === `Stationery ${tag}`)?.reversedBy);

  // The admin approves it on Approvals.
  await go('/approvals');
  const reqRow = page.locator('[data-slot="admin-request-row"]', { hasText: 'reverse journal entry' }).first();
  await reqRow.waitFor({ timeout: 30000 });
  check('Approvals lists the request with who asked and the reason', /Kumar Clerk/.test(await reqRow.innerText()), (await reqRow.innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await shot('approvals-requests');
  await reqRow.locator('[data-slot="admin-request-approve"]').click();
  await page.locator('[data-slot="admin-request-row"][data-status="done"]', { hasText: 'reverse journal entry' }).first().waitFor({ timeout: 60000 });
  list = (await api('GET', '/api/journal?sourceType=manual&limit=300&hideReversed=0')).body;
  const orig = (list.entries ?? []).find((e) => e.memo === `Stationery ${tag}`);
  check('Approve: the journal is reversed at once', !!orig?.reversedBy, JSON.stringify(orig?.reversedBy ?? null));
  await shot('approvals-done');
  const toldDone = (await noticesOf(capi)).find((n) => /^Approved and done: reverse journal entry/.test(n.title));
  check('…and the accountant is told it was approved and done', !!toldDone, toldDone?.title);

  // Deleting the invoice, approved from the bell: the invoice goes.
  const del = await capi('DELETE', `/api/invoices/${inv.body.id}?reason=${encodeURIComponent('Raised by mistake')}`);
  check('deleting an invoice is sent for approval too', del.status === 409 && del.body?.code === 'sent_for_approval', `${del.status} ${del.body?.code}`);
  await go('/dashboard');
  await page.locator('button[aria-label^="Notifications"]').first().click();
  const delRow = page.locator('[role="menuitem"]', { hasText: 'asks to delete invoice' }).first();
  await delRow.locator('[data-slot="admin-request-approve"]').waitFor({ timeout: 30000 });
  await delRow.locator('[data-slot="admin-request-approve"]').click();
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  const gone = await api('GET', `/api/invoices/${inv.body.id}`);
  check('Approve from the bell: the invoice is deleted', gone.status === 404 || gone.body?.status === 'void' || gone.body?.deleted === true, `${gone.status} ${gone.body?.status ?? ''}`);
  const create = await capi('POST', '/api/invoices', { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'New work', qty: 1, ratePaise: 50_000, gstRatePct: 0 }] });
  check('the accountant creates an invoice without asking anyone', create.status === 200, `${create.status}`);
  const trail = (await api('GET', '/api/audit?targetType=admin_request&limit=50')).body;
  const details = (trail.events ?? []).map((e) => e.detail ?? '');
  check('the audit trail keeps who asked, who approved or rejected, and what happened', details.some((d) => /asked to reverse journal entry/.test(d)) && details.some((d) => /approved .* it was carried out/.test(d)) && details.some((d) => /rejected/.test(d)), details.slice(0, 3).join(' | '));
  await cctx.close();

  // ── 3. The ledger: the entry undone today and its reversal are left out ──
  await go(`/reports/general-ledger?account=${acc('6400')}`);
  await page.locator('[data-slot="ledger-show-reversed"]').waitFor({ timeout: 60000 });
  const rowsOf = async () => (await page.locator('tbody tr').allInnerTexts()).join('\n');
  check('the General Ledger leaves out the reversed journal and its reversal', !(await rowsOf()).includes(`Stationery ${tag}`));
  await shot('ledger-reversed-hidden');
  await page.locator('[data-slot="ledger-show-reversed"] input').check();
  await idle(1200);
  check('"Show reversed entries" brings both back', (await rowsOf()).includes(`Stationery ${tag}`));
  await shot('ledger-reversed-shown');

  // Settings → Controls has the two switches.
  await go('/settings?tab=controls');
  const sw = await page.locator('[data-slot="control-admin-approval-undo"], [data-slot="control-admin-approval-invoice"]').count();
  check('Settings → Controls has both admin-approval switches', sw === 2, String(sw));
  await shot('controls-switches');
} catch (e) {
  if (clerkPage) await clerkPage.screenshot({ path: `${process.env.SHOTS ?? '.'}/c1128-failure-accountant${FRESH ? '-fresh' : '-demo'}.png` }).catch(() => {});
  check('the script ran to the end', false, String(e?.message ?? e).slice(0, 300));
  await shot('failure').catch(() => {});
}
await t.finish();
