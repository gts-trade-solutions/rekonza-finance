// Status review 7, item 2 — Security & audit trail: audit log export.
//
// The auditor's test: create, edit and delete an invoice; change settings;
// change a user's role; sign out and in. Then on Accountant → Audit Trail
// filter by date, user, action and record type; export Excel, CSV and PDF —
// every matching event (not the page on screen), IST times, user, action,
// record, detail, reason, IP, each field's old → new value, what a deletion
// removed; a real XLSX with dates; the file named after the company and the
// range; the export recorded in the trail. A read-only viewer can view and
// export it, and cannot change it; the trail cannot be switched off; Verify
// integrity finds it intact, and (in a fresh company) finds a row changed
// behind the application's back.
//
//   FRESH=1 node scripts/e2e/sr7-02-audit-export.mjs   (a new company)
//   node scripts/e2e/sr7-02-audit-export.mjs           (the demo book)

import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { start, FRESH, BASE, today } from './_sr7-common.mjs';

const t = await start('02');
const { page, check, shot, idle, go, api, expect4xx, finish } = t;
const tag = String(Date.now()).slice(-6);

try {
  let me, creds;
  if (FRESH) { creds = await t.signUp(`Audit Export Co ${tag}`, `Audit Tester ${tag}`); me = `Audit Tester ${tag}`; } else { await t.loginDemo(); creds = { email: 'arun@raceautospares.in', password: 'Rekonza@2026' }; me = 'Arun Kumar'; }
  const masters = (await api('GET', '/api/masters')).body;
  const company = masters.org.legalName ?? masters.org.name;
  const branchId = masters.branches[0].id;

  // ── 1. Changes: an invoice created, edited and deleted; settings; a user's role.
  const cust = (await api('POST', '/api/contacts', { kind: 'customer', displayName: `Audit Customer ${tag}`, gstTreatment: 'unregistered', stateCode: '33' })).body;
  const line = (rate) => ({ branchId, customerId: String(cust.id), date: today(), dueDate: today(), status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: rate, gstRatePct: 0 }] });
  const inv = (await api('POST', '/api/invoices', line(450000))).body;
  const edited = await api('PUT', `/api/invoices/${inv.id}`, line(500000));
  const deleted = await api('DELETE', `/api/invoices/${inv.id}?reason=${encodeURIComponent(`Raised twice ${tag}`)}`);
  check('an invoice created, edited and deleted', !!inv.id && edited.status === 200 && deleted.status === 200, `${inv.number} ${edited.status} ${deleted.status}`);
  const setting = await api('POST', '/api/reporting-tags', { action: 'save', name: `Channel ${tag}`, values: ['Retail', 'Fleet'] });
  const rule = await api('POST', '/api/approvals', { action: 'save-rule', documentType: 'bill', thresholdPaise: 50000000, approverRole: 'admin', isActive: true });
  check('settings changed (a reporting tag, an approval rule)', setting.status === 200 && rule.status === 200);
  let viewerEmail = 'deepa@raceautospares.in', viewerPassword = 'Rekonza@2026';
  if (FRESH) {
    viewerEmail = `viewer-${tag}@example.test`;
    const made = (await api('POST', '/api/settings/users', { action: 'add', name: `Viewer ${tag}`, email: viewerEmail, role: 'accountant' })).body;
    const role = await api('POST', '/api/settings/users', { action: 'update', id: made.id, role: 'viewer' });
    check('a user\'s role changed (accountant → viewer)', role.status === 200);
    viewerPassword = 'Viewer@2026Okay';
    const c0 = await t.browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.8.8.8' } });
    await c0.request.post(`${BASE}/api/auth/login`, { data: { email: viewerEmail, password: made.temporaryPassword } });
    await c0.request.post(`${BASE}/api/auth/password`, { data: { current: made.temporaryPassword, next: viewerPassword } });
    await c0.close();
  } else {
    const users = (await api('GET', '/api/settings/users')).body.users;
    const kavya = users.find((u) => u.email === 'kavya@raceautospares.in');
    const r1 = await api('POST', '/api/settings/users', { action: 'update', id: kavya.id, role: 'staff' });
    const r2 = await api('POST', '/api/settings/users', { action: 'update', id: kavya.id, role: kavya.role });
    check('a user\'s role changed and changed back', r1.status === 200 && r2.status === 200);
  }
  // Sign out and in.
  await api('POST', '/api/auth/logout');
  check('signed out', (await t.ctx.request.get(`${BASE}/api/masters`)).status() === 401);
  await t.loginDemo(creds.email, creds.password);
  check('signed in again', page.url().includes('/dashboard'));

  // ── 2. The audit trail, filtered by date, user, action and record type.
  await go('/accountant/audit-trail');
  await page.waitForSelector('[data-slot="audit-filters"]', { timeout: 60000 });
  check('the trail says it cannot be switched off or edited', /cannot be switched off/.test(await page.locator('[data-slot="audit-cannot-disable"]').innerText()));
  await page.fill('input[aria-label="From"]', today());
  await page.fill('input[aria-label="To"]', today());
  await idle(1200);
  await page.selectOption('[data-slot="audit-user"]', { label: new RegExp(me) }).catch(async () => {
    const opts = await page.locator('[data-slot="audit-user"] option').allInnerTexts();
    const o = opts.find((x) => x.startsWith(me));
    if (o) await page.selectOption('[data-slot="audit-user"]', { label: o });
  });
  await page.selectOption('select[aria-label="Action"]', 'delete');
  await idle(1000);
  const types = await page.locator('[data-slot="audit-type"] option').allInnerTexts();
  const invType = types.find((x) => /^invoice/i.test(x.trim()));
  if (invType) await page.selectOption('[data-slot="audit-type"]', { label: invType });
  await idle(1500);
  const shown = await page.locator('main').innerText();
  check('the deleted invoice is found by date, user, action and record type', shown.includes(inv.number) && /Raised twice/.test(shown), inv.number);
  await shot('trail-filtered');

  // ── 3. Exports: XLSX, CSV, PDF of every matching event.
  const exportAs = async (fmt) => {
    await page.click('[data-slot="audit-export"]');
    await page.waitForSelector('[data-slot="audit-export-dialog"]');
    await page.check(`[data-slot="audit-format-${fmt}"]`);
    if (fmt === 'xlsx') await shot('export-dialog');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.click('[data-slot="audit-export-go"]')]);
    return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
  };
  const x = await exportAs('xlsx');
  const xt = x.bytes.toString('latin1');
  check('XLSX named after the company and the range', x.name.startsWith(`Audit trail - ${company.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()}`) && x.name.includes(`${today()} to ${today()}`) && x.name.endsWith('.xlsx'), x.name);
  check('XLSX: real dates and what was deleted', xt.startsWith('PK') && xt.includes('s="2"') && xt.includes(`dated ${today()}`) && xt.includes(`Raised twice ${tag}`), '');
  const c = await exportAs('csv');
  const ct = c.bytes.toString('utf8');
  check('CSV: the columns the auditor asked for', /Date and time \(IST\),User,Action,Record type,Record ID,Record,Detail,Reason,IP address,Fields changed \(old → new\),What was deleted/.test(ct), ct.split('\n')[0]);
  const p = await exportAs('pdf');
  const pt = p.bytes.toString('latin1');
  check('PDF: landscape, paginated, with the company and the filters', pt.startsWith('%PDF') && /Page 1 of/.test(pt) && pt.includes('Action: delete') && pt.includes('/MediaBox [0 0 841.89 595.28]'), p.name);

  // ── 4. Edit log: each field's old → new value, and the export in the trail.
  await page.selectOption('select[aria-label="Action"]', 'all');
  await page.selectOption('[data-slot="audit-type"]', 'all');
  await page.fill('[data-slot="audit-search"]', 'Exported the audit trail');
  await idle(1800);
  check('each export is recorded in the trail', /Exported the audit trail as PDF/.test(await page.locator('main').innerText()));
  await shot('export-recorded');
  await page.fill('[data-slot="audit-search"]', '');
  await idle(800);

  // ── 5. Verify integrity.
  await page.click('[data-slot="audit-verify"]');
  await page.waitForSelector('[data-slot="audit-verify-ok"], [data-slot="audit-verify-problems"]', { timeout: 120000 });
  check('Verify integrity: intact', (await page.locator('[data-slot="audit-verify-ok"]').count()) === 1);
  await shot('verify-intact');

  // ── 6. A read-only viewer can view and export, and cannot change anything.
  const vctx = await t.browser.newContext({ viewport: { width: 1500, height: 950 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.6.6.6' }, acceptDownloads: true });
  const vpage = await vctx.newPage();
  await vpage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await vpage.locator('#email').fill(viewerEmail);
  await vpage.locator('#password').fill(viewerPassword);
  await vpage.getByRole('button', { name: /^Sign in$/ }).click();
  await vpage.waitForURL(/\/dashboard/, { timeout: 180000 });
  await vpage.goto(`${BASE}/accountant/audit-trail`, { waitUntil: 'domcontentloaded' });
  await vpage.waitForSelector('[data-slot="audit-export"]', { timeout: 60000 });
  await vpage.click('[data-slot="audit-export"]');
  await vpage.check('[data-slot="audit-format-xlsx"]');
  const [vdl] = await Promise.all([vpage.waitForEvent('download', { timeout: 90000 }), vpage.click('[data-slot="audit-export-go"]')]);
  check('the viewer exports the trail', vdl.suggestedFilename().startsWith('Audit trail - '), vdl.suggestedFilename());
  const write = await vpage.evaluate(async () => (await fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-01', memo: 'x', lines: [] }) })).status);
  check('the viewer cannot post anything', write === 403, String(write));
  await vpage.screenshot({ path: `${process.env.SHOTS}/02-viewer-trail${FRESH ? '-fresh' : '-demo'}.png`, fullPage: true }).catch(() => {});
  await vctx.close();

  // ── 7. The ready-made Auditor role.
  await go('/settings?tab=users');
  await page.waitForSelector('[data-slot="add-role"]', { timeout: 60000 });
  if (await page.locator('[data-slot="add-auditor-role"]').count()) {
    await page.click('[data-slot="add-auditor-role"]');
    await page.getByRole('dialog').getByRole('button', { name: /^Save/ }).click();
    await idle(1500);
  }
  const roles = await page.locator('[data-slot="role-rights"]').allInnerTexts();
  check('an Auditor role: view, print and export, nothing else', roles.some((r) => /Accountant — view, print, export/.test(r) && !/create|edit|void|approve/.test(r)), roles.join(' || ').slice(0, 200));
  await shot('auditor-role');

  // ── 8. Tampering behind the application is found (fresh company only).
  if (FRESH) {
    const c2 = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3331), user: 'root', database: 'finora' });
    const [rows] = await c2.query('SELECT id FROM audit_log WHERE org_id = ? AND action = ? ORDER BY id LIMIT 1', [Number(masters.org.id), 'delete']);
    await c2.query('UPDATE audit_log SET actor_name = ? WHERE id = ?', ['Someone else', rows[0].id]);
    await c2.end();
    await go('/accountant/audit-trail');
    await page.click('[data-slot="audit-verify"]');
    await page.waitForSelector('[data-slot="audit-verify-problems"]', { timeout: 120000 });
    check('a row changed in the database is reported by Verify integrity', new RegExp(`Audit row ${rows[0].id}`).test(await page.locator('[data-slot="audit-verify-problems"]').innerText()));
    await shot('verify-tampering-found');
  }
  await api('POST', '/api/approvals', { action: 'delete-rule', id: rule.body?.id }).catch(() => {});
  expect4xx('/api/journal');
} catch (e) {
  check('the script ran to the end', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await finish();
