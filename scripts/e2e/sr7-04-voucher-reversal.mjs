// Status review 7, item 4 — Accounting vouchers: voucher reversal.
//
// The auditor's test: a JV goes for approval, a second person approves it and
// it posts; it is reversed on a chosen date with a reason, again through the
// approval rule (the maker cannot approve their own); the reversal is linked
// both ways, cannot be repeated, is refused in a locked period with the first
// open date offered, shows in the journal report and the Reversed Vouchers
// register with its reason, and the pair nets to nil. An auto-reversing
// journal waits for its date; document vouchers are voided into a reversing
// entry.
//
//   FRESH=1 node scripts/e2e/sr7-04-voucher-reversal.mjs   (a new company)
//   node scripts/e2e/sr7-04-voucher-reversal.mjs           (the demo book)

import { start, FRESH, BASE, rupees, today, signInOn } from './_sr7-common.mjs';

const t = await start('04');
const { page, check, shot, idle, go, api, expect4xx, finish } = t;
const tag = String(Date.now()).slice(-6);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

try {
  if (FRESH) await t.signUp(`Reversal Audit Co ${tag}`); else await t.loginDemo();
  const masters = (await api('GET', '/api/masters')).body;
  const acc = (code) => masters.accounts.find((a) => a.code === code);

  // ── The checker: a second person with the accountant role.
  let checkerEmail = 'priya@raceautospares.in', checkerPassword = 'Rekonza@2026';
  if (FRESH) {
    checkerEmail = `checker-${tag}@example.test`;
    const made = (await api('POST', '/api/settings/users', { action: 'add', name: `Checker ${tag}`, email: checkerEmail, role: 'accountant' })).body;
    checkerPassword = 'Checker@2026Ok';
    const c0 = await t.browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.9.9.9' } });
    await c0.request.post(`${BASE}/api/auth/login`, { data: { email: checkerEmail, password: made.temporaryPassword } });
    const changed = await c0.request.post(`${BASE}/api/auth/password`, { data: { current: made.temporaryPassword, next: checkerPassword } });
    check('set-up: a checker with the accountant role', changed.status() === 200, String(changed.status()));
    await c0.close();
  }
  const cctx = await t.browser.newContext({ viewport: { width: 1500, height: 950 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.7.7.7' } });
  const cpage = await cctx.newPage();
  cpage.setDefaultTimeout(60000);
  await signInOn(cpage, checkerEmail, checkerPassword);
  check('the checker signs in', /\/dashboard/.test(cpage.url()), cpage.url());

  // ── A journal approval rule: journals of ₹1,000 and more need an accountant.
  const rule = await api('POST', '/api/approvals', { action: 'save-rule', documentType: 'journal', thresholdPaise: 100000, approverRole: 'accountant', isActive: true });
  check('set-up: journal approval rule (₹1,000 and above, accountant)', rule.status === 200);

  // ── 1. The maker enters a JV on the screen; it goes for approval.
  await go('/accountant/journals');
  await page.getByRole('button', { name: /New journal/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByPlaceholder('What this entry records').fill(`Office rent ${tag}`);
  const pick = async (row, search, name) => {
    await dlg.locator('tbody tr').nth(row).locator('[data-slot="combobox-trigger"]').click();
    await page.getByPlaceholder('Search accounts by name or code').fill(search);
    await page.getByRole('option', { name }).first().click();
  };
  await pick(0, '6100', /Rent/);
  await pick(1, '1210', /Bank/);
  await dlg.locator('tbody tr').nth(0).getByPlaceholder('0.00').first().fill('50000');
  await dlg.locator('tbody tr').nth(1).getByPlaceholder('0.00').nth(1).fill('50000');
  await page.keyboard.press('Tab');
  await shot('jv-form');
  await dlg.getByRole('button', { name: /Post journal/ }).click();
  await page.waitForSelector('text=Held for accountant approval', { timeout: 60000 });
  check('the JV is held for approval, not posted', true);
  await idle(800);
  await shot('jv-held');

  // ── 2. The checker approves it on the Approvals screen.
  await cpage.goto(`${BASE}/approvals`, { waitUntil: 'domcontentloaded' });
  await cpage.waitForSelector(`text=Office rent ${tag}`, { timeout: 60000 });
  await cpage.locator('tr', { hasText: `Office rent ${tag}` }).getByRole('button', { name: /Approve/ }).click();
  await cpage.waitForSelector('text=approved and posted', { timeout: 60000 });
  check('the checker approves; it posts', true);
  const listJ = (await page.evaluate(async (m) => (await (await fetch(`/api/journal?search=${encodeURIComponent(m)}&limit=5`)).json()), `Office rent ${tag}`));
  const posted = listJ.entries.find((e) => !e.reversalOf);
  check('the posted JV is in the ledger', !!posted, posted ? `#${posted.entryNo}` : '');

  // ── 3. The maker reverses it on a date, with a reason: held again for the checker.
  await go('/accountant/journals');
  const row = page.locator('tr', { hasText: `Office rent ${tag}` }).first();
  await row.locator('[data-slot="reverse-journal"]').click();
  await page.fill('[data-slot="reverse-date"]', today());
  await page.fill('[data-slot="reverse-reason"]', `Rent ${tag} was paid from the landlord's deposit`);
  await shot('reverse-dialog');
  await page.click('[data-slot="confirm-reverse"]');
  await page.waitForSelector('text=sent for accountant approval', { timeout: 60000 });
  check('the reversal follows the approval rule', true);
  // The maker cannot approve their own reversal.
  await go('/approvals');
  const mine = page.locator('tr', { hasText: `Reversal of #${posted.entryNo}` });
  check('the maker sees "Not yours to approve"', /Not yours to approve/.test(await mine.innerText()));
  await shot('maker-cannot-approve');
  const held = (await api('GET', '/api/held-journals')).body.held.find((h) => h.reversesEntryNo === posted.entryNo);
  expect4xx('/api/approvals');
  const self = await api('POST', '/api/approvals', { action: 'approve', doc: 'journal', id: held.id });
  check('approving one\'s own reversal is refused', self.status === 403 && /You asked for this reversal/.test(self.body?.error ?? ''), self.body?.error);
  await cpage.goto(`${BASE}/approvals`, { waitUntil: 'domcontentloaded' });
  await cpage.waitForSelector(`text=Reversal of #${posted.entryNo}`, { timeout: 60000 });
  await cpage.locator('tr', { hasText: `Reversal of #${posted.entryNo}` }).getByRole('button', { name: /Approve/ }).click();
  await cpage.waitForSelector('text=approved and posted', { timeout: 60000 });
  check('the checker approves the reversal', true);

  // ── 4. Linked both ways, once only, nil across the pair.
  await go('/accountant/journals');
  await page.click('[data-slot="show-reversed"] input');
  await idle(1000);
  const orig = page.locator('tr', { hasText: `Office rent ${tag}` }).first();
  check('the original says "Reversed by #…"', (await page.locator('[data-slot="reversed-by"]').filter({ hasText: '#' }).count()) > 0);
  check('the reversal says "Reversal of #…"', (await page.locator('[data-slot="reversal-of"]', { hasText: `Reversal of #${posted.entryNo}` }).count()) === 1);
  check('no second Reverse button on a reversed entry', (await orig.locator('[data-slot="reverse-journal"]').count()) === 0);
  await shot('linked-both-ways');
  expect4xx('/api/journal');
  const again = await api('PATCH', '/api/journal', { entryId: posted.id, date: today(), reason: 'again' });
  check('reversing twice is refused', again.status === 409 && /already been reversed/.test(again.body?.error ?? ''), again.body?.error);
  const rent = acc('6100');
  const pl = (await api('GET', `/api/reports?report=general-ledger&accountId=${rent.id}&from=${today()}&to=${today()}`)).body;
  const pair = pl.lines.filter((l) => (l.memo ?? '').includes(`Office rent ${tag}`) || (l.memo ?? '').startsWith(`Reversal of #${posted.entryNo}:`));
  const netRent = pair.reduce((s, l) => s + l.debitPaise - l.creditPaise, 0);
  check('the GL shows both halves of the pair', pair.length === 2, String(pair.length));
  check('rent nets to nil across the pair (GL)', netRent === 0, String(netRent));
  const tb = (await api('GET', `/api/reports?report=trial-balance&to=${today()}`)).body;
  check('the trial balance balances', tb.balanced === true);

  // ── 5. A locked period refuses the date and offers the first open one.
  const small = (await api('POST', '/api/journal', { date: today(), memo: `Stationery ${tag}`, lines: [{ accountId: String(acc('6400').id), debitPaise: 50000 }, { accountId: String(acc('1210').id), creditPaise: 50000 }] })).body;
  const locks = (await api('GET', '/api/transaction-locks')).body;
  const before = (locks.locks ?? locks.rows ?? []).find?.((l) => l.module === 'accountant')?.lockedUpto ?? null;
  await api('PUT', '/api/transaction-locks', { module: 'accountant', lockedUpto: today(), reason: `Month closed (${tag})` });
  await go('/accountant/journals');
  await page.locator('tr', { hasText: `Stationery ${tag}` }).first().locator('[data-slot="reverse-journal"]').click();
  await page.fill('[data-slot="reverse-date"]', today());
  await page.fill('[data-slot="reverse-reason"]', 'Entered in the wrong month');
  expect4xx('/api/journal');
  await page.click('[data-slot="confirm-reverse"]');
  await page.waitForSelector('[data-slot="reverse-error"]', { timeout: 60000 });
  const lockMsg = await page.locator('[data-slot="reverse-error"]').innerText();
  check('a locked period is refused with the first open date', /locked up to/.test(lockMsg) && /first open date is/.test(lockMsg), lockMsg.split('\n')[0]);
  await shot('locked-period-refused');
  await page.click('[data-slot="use-first-open-date"]');
  check('the first open date is put in', (await page.inputValue('[data-slot="reverse-date"]')) === addDays(today(), 1));
  await page.click('[data-slot="confirm-reverse"]');
  await page.waitForSelector('text=Reversal posted as', { timeout: 60000 });
  check('reversed on the first open date', true);
  await api('PUT', '/api/transaction-locks', { module: 'accountant', lockedUpto: before, reason: before ? 'Restored after the test' : null });
  void small;

  // ── 6. An auto-reversing journal waits for its date.
  const auto = (await api('POST', '/api/journal', { date: today(), memo: `Accrued audit fee ${tag}`, reverseOn: addDays(today(), 5), lines: [{ accountId: String(acc('6300').id), debitPaise: 80000 }, { accountId: String(acc('2700').id), creditPaise: 80000 }] })).body;
  void auto;
  // The approval rule holds it (₹800 is under ₹1,000, so it posts).
  await go('/accountant/journals');
  check('the auto-reversal is held for its date, "Reverses #…"', (await page.locator('[data-slot="held-reverses"]').count()) >= 1);
  await shot('auto-reversal-held');

  // ── 7. A document voucher: an invoice voided posts a reversing entry.
  const cust = (await api('POST', '/api/contacts', { kind: 'customer', displayName: `Void Test ${tag}`, gstTreatment: 'unregistered', stateCode: '33' })).body;
  const inv = (await api('POST', '/api/invoices', { branchId: masters.branches[0].id, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: 300000, gstRatePct: 0 }] })).body;
  const voided = await api('POST', `/api/invoices/${inv.id}`, { action: 'void', reason: `Raised to the wrong customer ${tag}` });
  check('an invoice is voided', voided.status === 200, JSON.stringify(voided.body).slice(0, 80));

  // ── 8. The register and the journal report.
  await go('/accountant/reversed-vouchers');
  await page.waitForSelector('[data-slot="rv-reason"]', { timeout: 60000 });
  const reg = await page.locator('table').innerText();
  check('the register lists the JV pair with its reason', reg.includes(`Rent ${tag} was paid from the landlord's deposit`));
  check('the register names the checker who approved it', /approved by/.test(reg));
  check('the register lists the voided invoice', reg.includes(`Raised to the wrong customer ${tag}`));
  check('the register lists the auto-reversal still to come', /Due on/.test(reg));
  await shot('reversed-vouchers-register');
  await go(`/reports/journal-report?source=reversals&from=${today()}&to=${addDays(today(), 1)}`);
  await page.waitForSelector('[data-slot="jr-reversal-of"]', { timeout: 60000 });
  check('the journal report shows "Reversal of #…" and "Reversed by #…"', (await page.locator('[data-slot="jr-reversal-of"]').count()) > 0 && (await page.locator('[data-slot="jr-reversed-by"]').count()) > 0);
  await shot('journal-report-pairs');

  // ── 9. The reason is in the audit trail.
  await go('/accountant/audit-trail');
  await page.fill('[data-slot="audit-search"]', `landlord's deposit`);
  await idle(1500);
  check('the reversal and its reason are in the audit trail', (await page.locator('main').innerText()).includes(`Rent ${tag} was paid from the landlord's deposit`));
  await shot('audit-trail-reason');

  // Clean up the rule so the book is as it was.
  const rules = (await api('GET', '/api/approvals')).body.rules ?? [];
  for (const r of rules.filter((x) => x.documentType === 'journal')) await api('POST', '/api/approvals', { action: 'delete-rule', id: r.id });
  await cctx.close();
} catch (e) {
  check('the script ran to the end', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await finish();
void rupees;
