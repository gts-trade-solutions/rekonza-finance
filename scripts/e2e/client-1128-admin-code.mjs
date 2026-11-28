// The client's three asks of 2026-11-28, through the screens, in a company
// signed up for the run (FRESH=1) or the demo book:
//
//   1. the sidebar is open when the app first opens, and folds once a page is
//      chosen from it;
//   2. someone who is not an admin reverses a journal only with the one-time
//      code the admin was sent (the admin reads it in their notifications);
//      a wrong code is refused; deleting and changing an invoice ask too, and
//      an admin is never asked;
//   3. an entry undone on its own date leaves the General Ledger, and comes
//      back with "Show reversed entries".
//
//   BASE=http://localhost:5022 FRESH=1 node scripts/e2e/client-1128-admin-code.mjs

import { start, signInOn, BASE, FRESH, today } from './_sr7-common.mjs';

const t = await start('c1128');
const { page, check, shot, go, api, idle } = t;
const tag = String(Date.now()).slice(-6);
const width = async () => Math.round((await page.locator('aside').first().boundingBox())?.width ?? 0);

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
  cpage.setDefaultTimeout(60000);
  await signInOn(cpage, clerkEmail, clerkPassword);
  check('the accountant signs in', /\/dashboard/.test(cpage.url()), cpage.url());
  const capi = (method, p, body, code) => cpage.evaluate(async ([m, u, b, c]) => {
    const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Change-Reason': encodeURIComponent('End-to-end test'), ...(c ? { 'X-Admin-Code': c } : {}) }, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  }, [method, p, body, code]);
  /** The newest code, as the admin reads it under the bell. */
  const adminCode = async (words) => {
    const n = (await api('GET', '/api/notifications')).body;
    const hit = (n.items ?? []).find((x) => x.kind === 'admin_code' && (!words || words.test(x.title)));
    return hit ? { code: /Code (\d{6})/.exec(hit.title)?.[1], title: hit.title } : null;
  };

  // Changing and deleting the invoice: both stopped, both told to the admin.
  const put = await capi('PUT', `/api/invoices/${inv.body.id}`, { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 2, ratePaise: 100_000, gstRatePct: 0 }] });
  check('the accountant changing a saved invoice is stopped for an admin code', put.status === 428 && put.body?.code === 'admin_code_required', `${put.status} ${put.body?.code}`);
  const forEdit = await adminCode(/change invoice/);
  check('the admin is told who wants to change which invoice, with the code', !!forEdit?.code && forEdit.title.includes(inv.body.number), forEdit?.title);
  const putOk = await capi('PUT', `/api/invoices/${inv.body.id}`, { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 2, ratePaise: 100_000, gstRatePct: 0 }] }, forEdit?.code);
  check('with the code, the invoice is changed (₹2,000 now)', putOk.status === 200, `${putOk.status} ${JSON.stringify(putOk.body).slice(0, 120)}`);
  const del = await capi('DELETE', `/api/invoices/${inv.body.id}?reason=test`);
  check('deleting it is stopped too', del.status === 428 && del.body?.code === 'admin_code_required', `${del.status} ${del.body?.code}`);
  const create = await capi('POST', '/api/invoices', { branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'New work', qty: 1, ratePaise: 50_000, gstRatePct: 0 }] });
  check('the accountant creates an invoice without any code', create.status === 200, `${create.status}`);

  // Reversing a journal through the screen: the dialog asks for the code.
  await cpage.goto(`${BASE}/accountant/journals`, { waitUntil: 'domcontentloaded' });
  const row = cpage.locator('tr', { hasText: `Stationery ${tag}` }).first();
  await row.waitFor({ timeout: 60000 });
  await row.locator('[data-slot="reverse-journal"]').click();
  await cpage.fill('[data-slot="reverse-date"]', today());
  await cpage.fill('[data-slot="reverse-reason"]', 'Posted to the wrong account');
  await cpage.click('[data-slot="confirm-reverse"]');
  const dlg = cpage.locator('[data-slot="admin-code-dialog"]');
  await dlg.waitFor({ timeout: 30000 });
  check('reversing a journal opens "An admin has to agree"', /An admin has to agree/.test(await dlg.innerText()));
  await cpage.screenshot({ path: `${process.env.SHOTS ?? '.'}/c1128-admin-code-asked${FRESH ? '-fresh' : '-demo'}.png` });
  const forRev = await adminCode(/reverse journal entry/);
  check('the admin has the code in their notifications', !!forRev?.code, forRev?.title);
  await go('/dashboard');
  await page.locator('button[aria-label*="otification"]').first().click().catch(() => {});
  await idle(600);
  await shot('admin-sees-the-code');
  await page.keyboard.press('Escape');

  // A wrong code first, then the right one.
  await dlg.locator('[data-slot="admin-code-input"]').fill(forRev?.code === '000000' ? '000001' : '000000');
  await dlg.locator('[data-slot="admin-code-go"]').click();
  await cpage.locator('[data-slot="admin-code-wrong"]').waitFor({ timeout: 30000 });
  check('a wrong code is refused, and says so', /not right/.test(await cpage.locator('[data-slot="admin-code-wrong"]').innerText()));
  await cpage.locator('[data-slot="admin-code-input"]').fill(forRev.code);
  await cpage.locator('[data-slot="admin-code-go"]').click();
  await dlg.waitFor({ state: 'hidden', timeout: 30000 });
  await cpage.waitForTimeout(1500);
  const list = (await api('GET', '/api/journal?sourceType=manual&limit=300&hideReversed=0')).body;
  const orig = (list.entries ?? []).find((e) => e.memo === `Stationery ${tag}`);
  check('with the right code the journal is reversed', !!orig?.reversedBy, JSON.stringify(orig?.reversedBy ?? null));
  const trail = (await api('GET', '/api/audit?targetType=admin_code&limit=50')).body;
  const details = (trail.events ?? []).map((e) => e.detail ?? '');
  check('the audit trail says who asked and that an admin agreed', details.some((d) => /asked to reverse journal entry/.test(d)) && details.some((d) => /admin code was given/.test(d)), details.slice(0, 3).join(' | '));
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
  const sw = await page.locator('[data-slot="control-admin-code-undo"], [data-slot="control-admin-code-invoice"]').count();
  check('Settings → Controls has both admin-code switches', sw === 2, String(sw));
  await shot('controls-switches');
} catch (e) {
  check('the script ran to the end', false, String(e?.message ?? e).slice(0, 300));
  await shot('failure').catch(() => {});
}
await t.finish();
