// Status review 7, item 7: the credit note workflow, as the auditors test it.
//   FRESH=1 node scripts/e2e/sr7-7-credit-notes.mjs   (a new company)
//   node scripts/e2e/sr7-7-credit-notes.mjs           (the demo book)

import { addDays, api, check, contact, enter, finish, goto, shot, start, stamp, today, BASE } from './sr7-b-lib.mjs';

const t = await start('7');
const { page } = t;

/** A GSTIN with its check digit (the GSTN's mod-36 checksum). */
function gstin(first14) {
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = cs.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return first14 + cs[(36 - (sum % 36)) % 36];
}
const money = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const invoiceOwes = async (id) => (await api(t, 'GET', `/api/invoices/${id}`)).json?.balancePaise;

await enter(t);

if (process.env.FRESH === '1') {
  const d = today();
  // The company's GSTIN, so its invoices charge GST (setup: Settings → Organisation as a person would type it).
  const settings = (await api(t, 'GET', '/api/settings')).json;
  const br = (settings?.branches ?? [])[0];
  const own = gstin(`33AAACR${String(Math.floor(Math.random() * 9000) + 1000)}K1Z`);
  const setG = await api(t, 'PUT', '/api/settings', { branchId: br?.id, name: br?.name ?? 'Head office', gstin: own });
  check(t, 'the company is registered for GST (its GSTIN set)', setG.status === 200, `${setG.status} ${JSON.stringify(setG.json).slice(0, 100)}`);
  // Setup: a registered customer, an item, an accountant to approve, and the invoice to correct.
  const buyerGstin = gstin('33AABCB1234F1Z');
  const buyer = await contact(t, 'customer', 'Registered Buyer Pvt Ltd', { gstTreatment: 'registered', gstin: buyerGstin, pan: buyerGstin.slice(2, 12) });
  const other = await contact(t, 'customer', 'Walk-in Buyer');
  const item = await api(t, 'POST', '/api/items', { kind: 'goods', name: 'Clutch Plate', uqc: 'NOS', hsnSac: '8708', salePricePaise: 100_000, purchasePricePaise: 60_000, gstRatePct: 18, taxPref: 'taxable', trackInventory: true, openingStockQty: 50, openingStockRatePaise: 60_000 });
  check(t, 'an item is set up', item.status === 200, JSON.stringify(item.json).slice(0, 100));
  const inv = await api(t, 'POST', '/api/invoices', { customerId: buyer, date: d, dueDate: addDays(d, 30), status: 'approved', lines: [{ itemId: item.json.id, qty: 10, ratePaise: 100_000, gstRatePct: 18 }] });
  check(t, '1. an invoice: 10 at ₹1,000 + 18% GST = ₹11,800', inv.status === 200 && inv.json.totalPaise === 1_180_000, `${inv.status} ${inv.json?.totalPaise}`);
  const inv2 = await api(t, 'POST', '/api/invoices', { customerId: buyer, date: d, dueDate: addDays(d, 30), status: 'approved', lines: [{ description: 'Fitting labour', qty: 1, ratePaise: 200_000, gstRatePct: 18 }] });
  const approverEmail = `approver-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const acct = await api(t, 'POST', '/api/settings/users', { action: 'add', name: 'Priya Approver', email: approverEmail, role: 'accountant' });
  check(t, 'an accountant is added to approve', acct.status === 200 && !!acct.json.temporaryPassword);

  // 3. The approval rule: Settings → Approvals → credit notes of ₹1,000 and above need an accountant.
  await goto(t, '/approvals');
  const ruleRow = page.locator('div.grid', { has: page.locator('select') }).filter({ hasText: 'From amount' }).first();
  await ruleRow.locator('select').first().selectOption('credit_note');
  await ruleRow.locator('input').first().fill('1000');
  await ruleRow.locator('select').nth(1).selectOption('accountant');
  await page.getByRole('button', { name: /Add rule/ }).click();
  await page.waitForTimeout(1500);
  check(t, '3. Approvals: a rule for credit notes of ₹1,000 and above, by an accountant', /Credit notes/.test(await page.locator('body').innerText()));
  await shot(t, 'approval-rule');

  // 2. From the invoice: Create Credit Note, 3 of the 10 returned, and a price cut on the 7 kept.
  await goto(t, `/sales/invoices/${inv.json.id}`);
  await page.locator('[data-slot="invoice-more"]').click();
  await page.locator('[data-slot="create-credit-note"]').click();
  await page.waitForURL(/credit-notes\/new\?invoice=/, { timeout: 120_000 });
  await page.locator('textarea[placeholder="Add a description"]').first().waitFor();
  await page.waitForTimeout(1500);
  const firstRow = page.locator('tr', { has: page.locator('textarea[placeholder="Add a description"]') }).first();
  await firstRow.locator('input[type="number"]').first().fill('3');
  await page.getByRole('button', { name: /Add New Row/ }).click();
  const second = page.locator('tr', { has: page.locator('textarea[placeholder="Add a description"]') }).nth(1);
  await second.locator('textarea[placeholder="Add a description"]').fill('Rate reduction agreed: ₹50 on each of the 7 kept');
  await second.locator('input[type="number"]').first().fill('7');
  await second.locator('input[placeholder="0.00"]').first().fill('50');
  await page.waitForTimeout(600);
  await shot(t, 'credit-note-from-invoice');
  await page.locator('[data-slot="doc-save-open"]').last().click();
  await page.waitForURL(/credit-notes\/\d+$/, { timeout: 120_000 });
  const cnId = page.url().match(/credit-notes\/(\d+)/)[1];
  await page.locator('[data-slot="cn-awaiting-approval"]').waitFor({ timeout: 30_000 }).catch(() => {});
  check(t, '3. it waits for approval, posting nothing', await page.locator('[data-slot="cn-awaiting-approval"]').isVisible());
  check(t, 'the invoice still owes the full ₹11,800 while it waits', (await invoiceOwes(inv.json.id)) === 1_180_000);
  await shot(t, 'awaiting-approval');

  // The maker cannot approve their own: the accountant signs in and approves.
  const mine = await api(t, 'POST', '/api/approvals', { action: 'approve', doc: 'credit_note', id: cnId });
  check(t, 'the person who raised it cannot approve it', mine.status === 403 && /Someone else/.test(mine.json?.error ?? ''), mine.json?.error);
  const admin = await t.ctx.storageState();
  await t.ctx.clearCookies();
  await goto(t, '/login');
  await page.locator('#email').fill(approverEmail);
  await page.locator('#password').fill(acct.json.temporaryPassword);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForURL(/change-password|dashboard/, { timeout: 120_000 });
  // A temporary password is changed first. The app may send the person to that page only after the
  // dashboard has opened, so look again once the inbox is asked for.
  const changeIfAsked = async () => {
    await page.waitForTimeout(1500);
    if (!page.url().includes('change-password')) return false;
    await page.locator('#cp-current').fill(acct.json.temporaryPassword);
    await page.locator('#cp-next').fill('Approver@2026x');
    await page.locator('#cp-again').fill('Approver@2026x');
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/dashboard/, { timeout: 120_000 });
    return true;
  };
  await changeIfAsked();
  await goto(t, '/approvals');
  if (await changeIfAsked()) await goto(t, '/approvals');
  const pendingRow = page.locator('tr, li, div', { hasText: /CN-|CN\// }).filter({ has: page.getByRole('button', { name: /^Approve/ }) }).last();
  await shot(t, 'approvals-inbox');
  await pendingRow.getByRole('button', { name: /^Approve/ }).first().click();
  await page.waitForTimeout(2500);
  // Back as the admin.
  await t.ctx.clearCookies();
  await t.ctx.addCookies(admin.cookies);
  const cn = (await api(t, 'GET', `/api/sales-documents/credit-note/${cnId}`)).json;
  check(t, '4. approved and posted: (3,000 + 350) + 18% = ₹3,953, applied to the invoice', cn?.status === 'applied' && cn?.totalPaise === 395_300 && cn?.approvalStatus === 'approved', `${cn?.status} ${cn?.totalPaise} ${cn?.approvalStatus}`);
  check(t, '4. the invoice now owes ₹11,800 − ₹3,953 = ₹7,847', (await invoiceOwes(inv.json.id)) === 784_700, money(await invoiceOwes(inv.json.id)));
  await goto(t, `/sales/credit-notes/${cnId}`);
  await shot(t, 'credit-note-posted');

  // GST: output tax down by the note's ₹603, and GSTR-1 shows it as CDNR with the original invoice's number and date.
  const tb = (await api(t, 'GET', `/api/reports?report=trial-balance&to=${d}`)).json;
  const outTax = (tb?.rows ?? []).filter((r) => ['2210', '2220', '2230'].includes(r.code)).reduce((s, r) => s + (r.creditPaise ?? 0) - (r.debitPaise ?? 0), 0);
  check(t, 'output tax in the ledger: ₹1,800 + ₹360 − ₹603 = ₹1,557', outTax === 155_700, money(outTax));
  await goto(t, `/gst/gstr1?month=${d.slice(0, 7)}`);
  await page.waitForTimeout(2000);
  const against = await page.locator('[data-slot="gstr1-against"]').allInnerTexts().catch(() => []);
  check(t, 'GSTR-1 lists the note against the invoice, with its date', against.some((a) => a.includes(inv.json.number) && a.includes(d)), against.join(' | '));
  await shot(t, 'gstr1-cdnr');

  // A second note, not against an invoice: applied to another invoice of the customer, the rest refunded by cash.
  const cn2 = await api(t, 'POST', '/api/sales-documents', { kind: 'credit-note', customerId: buyer, date: d, reason: 'Goodwill credit', lines: [{ description: 'Goodwill credit', qty: 1, ratePaise: 50_000, gstRatePct: 0 }] });
  check(t, 'a credit note of ₹500 kept on account (below the rule)', cn2.status === 200, JSON.stringify(cn2.json).slice(0, 100));
  await goto(t, `/sales/credit-notes/${cn2.json.id}`);
  await page.getByRole('button', { name: /^Apply to Invoices$/ }).first().click();
  const dlg = page.locator('[data-slot="cn-apply-dialog"]');
  await dlg.waitFor();
  const target = dlg.locator('tr', { hasText: inv2.json.number });
  await target.locator('input').fill('300');
  await shot(t, 'apply-to-another-invoice');
  await dlg.getByRole('button', { name: /^Save$/ }).click();
  await page.waitForTimeout(1500);
  check(t, '4. applied to another invoice: it owes ₹2,360 − ₹300 = ₹2,060', (await invoiceOwes(inv2.json.id)) === 206_000, money(await invoiceOwes(inv2.json.id)));
  await page.getByRole('button', { name: /^Refund$/ }).first().click();
  const rdlg = page.locator('[data-slot="cn-refund-dialog"]');
  await rdlg.waitFor();
  await rdlg.getByRole('button', { name: /^Refund$/ }).click();
  await page.waitForTimeout(1500);
  const cn2After = (await api(t, 'GET', `/api/sales-documents/credit-note/${cn2.json.id}`)).json;
  check(t, '5. the ₹200 left is refunded', cn2After?.status === 'refunded', cn2After?.status);
  await shot(t, 'refunded');

  // 6. Void a credit note: entry reversed, applications undone, the invoice owes again.
  const cn3 = await api(t, 'POST', '/api/sales-documents', { kind: 'credit-note', customerId: buyer, date: d, reason: 'Raised in error', againstInvoiceId: inv.json.id, lines: [{ itemId: item.json.id, qty: 1, ratePaise: 100_000, gstRatePct: 18 }] });
  const before = await invoiceOwes(inv.json.id);
  await goto(t, `/sales/credit-notes/${cn3.json.id}`);
  await page.locator('[data-slot="doc-more"]').click();
  await page.locator('[data-slot="cn-void"]').click();
  const vdlg = page.locator('[data-slot="cn-void-dialog"]');
  await vdlg.locator('input').fill('Raised against the wrong invoice');
  await vdlg.getByRole('button', { name: /^Void$/ }).click();
  await page.waitForTimeout(1500);
  check(t, '6. voided: the invoice owes ₹1,180 more again', (await invoiceOwes(inv.json.id)) === before + 118_000, `${money(before)} → ${money(await invoiceOwes(inv.json.id))}`);
  await shot(t, 'voided');
  // Edit and Delete only where allowed: a refunded note cannot be voided or edited.
  const noEdit = await api(t, 'PATCH', '/api/sales-documents', { action: 'void-credit-note', id: cn2.json.id, reason: 'try' });
  check(t, 'a refunded credit note cannot be voided, with the reason', noEdit.status === 409 && /refunded/.test(noEdit.json?.error ?? ''), noEdit.json?.error);

  // The s.34 time limit: a note today against an invoice of an earlier year is warned on the form.
  const old = await api(t, 'POST', '/api/invoices', { customerId: other, date: '2024-06-10', dueDate: '2024-07-10', status: 'approved', lines: [{ description: 'Old service', qty: 1, ratePaise: 100_000, gstRatePct: 18 }] });
  await goto(t, `/sales/credit-notes/new?invoice=${old.json.id}`);
  await page.locator('[data-slot="credit-note-s34"]').waitFor({ timeout: 30_000 }).catch(() => {});
  const late = await page.locator('[data-slot="credit-note-s34"]').innerText().catch(() => '');
  check(t, 'a credit note past the s.34 time limit is warned on the form', /s\.34\(2\)/.test(late) && /2025-11-30/.test(late), late.slice(0, 140));
  await shot(t, 's34-warning');

  // Stock back, AR ageing, the customer statement, and the Zoho print.
  const st = (await api(t, 'GET', `/api/items/${item.json.id}`)).json;
  check(t, 'goods returned are back in stock: 50 − 10 + 3 = 43', st?.stock?.onHand === 43, String(st?.stock?.onHand));
  const ageing = (await api(t, 'GET', `/api/reports?report=ar-ageing&to=${d}`)).json;
  const buyerAge = JSON.stringify(ageing ?? {}).includes('Registered Buyer');
  check(t, 'AR ageing reflects the notes (the buyer\'s balance is there)', buyerAge);
  await goto(t, `/print/credit-note/${cnId}`);
  await page.waitForTimeout(2000);
  check(t, 'the credit note prints in the Zoho template', /CREDIT NOTE|Credit Note/.test(await page.locator('body').innerText()));
  await shot(t, 'print');
} else {
  // The demo book: the note waiting for approval, and the one on a paid invoice, applied and refunded.
  await goto(t, '/approvals');
  const body = await page.locator('body').innerText();
  check(t, 'the demo Approvals inbox has a credit note waiting', /CN/.test(body) && /Credit notes/i.test(body));
  await shot(t, 'approvals');
  await goto(t, '/sales/credit-notes');
  await page.waitForTimeout(1500);
  check(t, 'the demo credit notes list opens with records', (await page.locator('tbody tr').count()) > 0);
  await shot(t, 'list');
}
void today;
await finish(t);
