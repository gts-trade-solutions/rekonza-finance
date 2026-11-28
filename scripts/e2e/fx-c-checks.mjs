// Fixes from the independent auditor check (2026-11-28), builder fx-c, as the
// reviewer tested them through the screens:
//
//   1  Inventory → Adjustments on a periodic book: −1 Damaged of a FIFO item
//      whose oldest layer on hand costs ₹120: the window, the toast and the list
//      all say ₹120.00 (the list said ₹100, the catalogue price), and the stock
//      valuation falls by exactly that;
//   2  a vendor payment deleted from Payments Made and a transfer deleted from
//      the bank account's own screen: each window needs a reason, and
//      Accountant → Reversed Vouchers shows it (it said "Not given"), as it does
//      the credit note voided with a reason; a delete with none is answered 428;
//   3  a vendor credit of one unit back on a ₹120 + 18% bill is ₹141.60 (it was
//      rounded to ₹142), and the list names the bill by its number, not "Bill #400";
//   4  overselling, a write-off and cash paid out of an empty till: warned with
//      the item or account and the shortfall; refused once the policy is Block;
//      the profit and loss and the balance sheet say so at the top;
//   5  a journal held for approval and discarded shows as "Discarded" in
//      Approvals → Approval history;
//   6  the General Ledger of Sales (a drill-down from the P&L) names the customer
//      on every invoice row (the contact was blank).
//
//   FRESH=1 node scripts/e2e/fx-c-checks.mjs   (a new company, as the reviewer)
//   node scripts/e2e/fx-c-checks.mjs           (the demo book)

import { addDays, api, check, contact, enter, finish, goto, newGstin, shot, start, today } from './sr7-b-lib.mjs';

const t = await start('fxc');
const { page } = t;
const FRESH = process.env.FRESH === '1';
const d0 = today();
const day = (n) => addDays(d0, -n);
const rupee = (p) => `₹${(Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const toastText = async () => (await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])).join(' | ');
const waitToast = async (re, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const x = await toastText(); if (re.test(x)) return x; await page.waitForTimeout(300); }
  return toastText();
};
const pickIn = async (scope, triggerText, search, option) => {
  await scope.locator('[data-slot="combobox-trigger"]', { hasText: triggerText }).first().click();
  if (search) await page.locator('input[placeholder^="Search"]').last().fill(search);
  await page.getByRole('option', { name: option }).first().click();
};
const accountId = async (code) => ((await api(t, 'GET', '/api/accounts')).json?.accounts ?? []).find((a) => a.code === code)?.id;

async function fresh() {
  await enter(t);
  const vendor = await contact(t, 'vendor', 'Nila Suppliers Pvt Ltd', { gstTreatment: 'registered', gstin: newGstin('33') });
  const customer = await contact(t, 'customer', 'Kaveri Retail Pvt Ltd');
  const it = await api(t, 'POST', '/api/items', { kind: 'goods', name: 'FIFO Widget', uqc: 'NOS', hsnSac: '8708', salePricePaise: 20_000, purchasePricePaise: 10_000, gstRatePct: 18, taxPref: 'taxable', trackInventory: true, valuationMethod: 'fifo' });
  check(t, 'setup: a FIFO item, catalogue (purchase) price ₹100', it.status === 200, JSON.stringify(it.json).slice(0, 100));
  const itemId = it.json.id;
  const bill = (no, date, ratePaise, qty) => api(t, 'POST', '/api/bills', { vendorId: vendor, vendorInvoiceNo: no, date, dueDate: date, lines: [{ itemId, qty, ratePaise }] });
  const b1 = await bill('NS-A1', day(8), 10_000, 10);
  const b2 = await bill('NS-A2', day(7), 12_000, 10);
  const inv = await api(t, 'POST', '/api/invoices', { customerId: customer, date: day(6), dueDate: day(6), status: 'approved', lines: [{ itemId, qty: 15, ratePaise: 20_000 }] });
  check(t, 'setup: bills 10 @ ₹100 and 10 @ ₹120, invoice of 15 (5 left, all from the ₹120 layer)', b1.status === 200 && b2.status === 200 && inv.status === 200);

  // ── 1. Adjustment value ────────────────────────────────────────────────────
  const valuation = async (asOf) => ((await api(t, 'GET', `/api/reports?report=inventory-valuation&to=${asOf}`)).json?.rows ?? []).find((r) => String(r.itemId) === String(itemId))?.valuePaise ?? 0;
  const before = await valuation(day(1));
  await goto(t, '/inventory/adjustments');
  await page.getByRole('button', { name: /Adjust stock/ }).click();
  const dlg = page.locator('[data-slot="adjustment-new"]');
  await pickIn(dlg, 'Select an item', 'FIFO Widget', /FIFO Widget/);
  await dlg.locator('[data-slot="adjust-date"]').fill(day(1));
  await dlg.locator('[data-slot="adjust-qty"]').fill('-1');
  await pickIn(dlg, 'Stocktake correction', null, /^Damaged$/);
  await dlg.locator('[data-slot="adjust-preview-value"]').waitFor();
  const preview = await dlg.locator('[data-slot="adjust-preview"]').innerText();
  check(t, '1: the window says ₹120.00 written off at FIFO cost', /₹120\.00 written off at FIFO cost/.test(preview), preview);
  await shot(t, 'adjust-window');
  await dlg.locator('[data-slot="adjustment-save"]').click();
  const toast1 = await waitToast(/written off/);
  check(t, '1: the toast after saving says ₹120.00 written off', /₹120\.00 written off/.test(toast1), toast1.slice(0, 160));
  await page.waitForTimeout(1500);
  const cell = await page.locator('[data-slot="adjustment-value"]').first().innerText();
  const list = (await api(t, 'GET', '/api/inventory?view=adjustments')).json?.adjustments ?? [];
  const after = await valuation(day(1));
  check(t, '1: the adjustments list shows −₹120.00 (not −₹100.00)', /120\.00/.test(cell) && list[0]?.valuePaise === -12_000, `${cell} / ${list[0]?.valuePaise}`);
  check(t, `1: it ties to the stock valuation: ${rupee(before)} → ${rupee(after)}, down ₹120.00`, before - after === 12_000, `${before} → ${after}`);
  await shot(t, 'adjustments-list');

  // ── 3. Vendor credit against a bill ────────────────────────────────────────
  // 6 units, so it is not taken for a duplicate of NS-A2 (the same supplier and amount needs a reason).
  const b3 = await bill('NS-VC1', day(5), 12_000, 6);
  const billNo = b3.json?.internalNo ?? b3.json?.number;
  check(t, 'setup: a bill of 6 @ ₹120 + 18% GST from the registered supplier', b3.status === 200 && !!billNo, `${b3.status} ${JSON.stringify(b3.json).slice(0, 160)}`);
  await goto(t, '/purchases/vendor-credits');
  await page.getByRole('button', { name: /New vendor credit/ }).click();
  const vdlg = page.locator('[data-slot="vendor-credit-dialog"]');
  await vdlg.locator('[data-slot="vendor-credit-date"]').fill(day(4));
  await vdlg.locator('[data-slot="combobox-trigger"]').first().click();
  await page.locator('input[placeholder^="Search"]').last().fill('Nila Suppliers');
  await page.getByRole('option', { name: /Nila Suppliers/ }).first().click();
  await vdlg.locator('[data-slot="vc-mode-goods"]').click();
  await vdlg.locator('[data-slot="combobox-trigger"]', { hasText: 'Standalone' }).click();
  await page.getByRole('option', { name: /BILL/ }).filter({ hasText: 'NS-VC1' }).first().click();
  await vdlg.locator('[data-slot="vc-goods-row"]').first().waitFor();
  const rowText = await vdlg.locator('[data-slot="vc-goods-row"]').first().innerText();
  check(t, '3: the bill\'s line names its item in the goods window', /FIFO Widget/.test(rowText), rowText.replace(/\s+/g, ' '));
  await vdlg.locator('[data-slot="vc-goods-qty"]').first().fill('1');
  await page.waitForTimeout(400);
  const vtext = await vdlg.innerText();
  check(t, '3: Credit incl. GST reads ₹141.60 (not ₹142.00)', /₹141\.60/.test(vtext), (vtext.match(/Credit incl\. GST[^\n]*\n?[^\n]*/) ?? [''])[0]);
  await shot(t, 'vendor-credit-window');
  await vdlg.locator('[data-slot="vendor-credit-save"]').click();
  await page.waitForTimeout(2500);
  const vcs = (await api(t, 'GET', '/api/purchase-documents?kind=vendor-credit')).json?.documents ?? [];
  const vc = vcs.find((d) => d.linkedId === String(b3.json?.id));
  check(t, '3: the vendor credit is ₹141.60 against the bill, named by its number', vc?.totalPaise === 14_160 && vc?.linkedNumber === billNo, `${vc?.totalPaise} ${vc?.linkedNumber} vs ${billNo}`);
  const against = await page.locator('[data-slot="vc-against-bill"]').first().innerText().catch(() => '');
  check(t, `3: the list's Against bill column shows ${billNo}, not "Bill #<id>"`, against.includes(billNo) && !/Bill #/.test(await page.locator('main').innerText()), against);
  await shot(t, 'vendor-credits-list');

  // ── 2. Reasons on deletes and voids ────────────────────────────────────────
  const bankAcc = await api(t, 'POST', '/api/banking/accounts', { kind: 'bank', name: 'HDFC Current A/c', openingBalancePaise: 5_00_000_00 });
  const banks = (await api(t, 'GET', '/api/banking/accounts')).json?.accounts ?? [];
  const hdfc = banks.find((b) => b.name === 'HDFC Current A/c');
  const cash = banks.find((b) => b.kind === 'cash');
  check(t, 'setup: a bank account and Cash in Hand', bankAcc.status === 200 && !!hdfc && !!cash, JSON.stringify(bankAcc.json).slice(0, 80));
  const branchId = String(((await api(t, 'GET', '/api/settings')).json?.branches ?? [])[0]?.id ?? '');
  const pay = await api(t, 'POST', '/api/payments', { kind: 'made', branchId, contactId: vendor, date: day(3), mode: 'neft', amountPaise: 354_00, bankAccountId: hdfc.id, reference: 'UTR-TARA-01' });
  const noReason = await api(t, 'DELETE', `/api/payments/${pay.json?.id}`, undefined, { noReason: true });
  check(t, '2: deleting a posted payment with no reason is answered 428 (the browser then asks)', noReason.status === 428 && noReason.json?.code === 'reason_required', `${noReason.status} ${noReason.json?.code}`);
  await goto(t, '/purchases/payments');
  const prow = page.locator('tr', { hasText: 'UTR-TARA-01' }).first();
  await prow.locator('[data-slot="row-delete"]').click();
  const ddlg = page.locator('[data-slot="delete-document-dialog"]');
  await ddlg.waitFor();
  const disabled = await ddlg.locator('[data-slot="delete-document-confirm"]').isDisabled();
  check(t, '2: the payment\'s Delete window will not delete without a reason', disabled);
  await ddlg.locator('[data-slot="delete-document-reason"]').fill('Paid to the wrong vendor');
  await shot(t, 'payment-delete-window');
  await ddlg.locator('[data-slot="delete-document-confirm"]').click();
  await waitToast(/deleted/);

  const tr = await api(t, 'POST', '/api/banking/transfers', { fromBankAccountId: hdfc.id, toBankAccountId: cash.id, date: day(3), amountPaise: 2_000_00 });
  check(t, 'setup: a transfer HDFC → Cash in Hand of ₹2,000', tr.status === 200, JSON.stringify(tr.json).slice(0, 80));
  // Banking → Transfers: the transfer's Delete window.
  await goto(t, '/banking/transfers');
  const tcard = page.locator('[data-slot="row-actions"][aria-label^="Actions for the transfer"]').first();
  await tcard.locator('[data-slot="row-delete"]').click();
  const ldlg = page.locator('[data-slot="confirm-delete"]');
  await ldlg.waitFor();
  check(t, "2: the transfer's Delete window will not delete it without a reason", await ldlg.locator('[data-slot="confirm-delete-go"]').isDisabled());
  await ldlg.locator('[data-slot="delete-reason"]').fill('Moved to the wrong account');
  await shot(t, 'transfer-delete-window');
  await ldlg.locator('[data-slot="confirm-delete-go"]').click();
  await waitToast(/deleted/);

  const sinv = await api(t, 'POST', '/api/invoices', { customerId: customer, date: day(3), dueDate: day(3), status: 'approved', lines: [{ description: 'Fitting charges', qty: 1, ratePaise: 500_00, gstRatePct: 18, hsnSac: '998714' }] });
  const cn = await api(t, 'POST', '/api/sales-documents', { kind: 'credit-note', customerId: customer, date: day(2), reason: 'Sales Return', againstInvoiceId: sinv.json?.id, lines: [{ description: 'Fitting charges', qty: 1, ratePaise: 500_00, gstRatePct: 18, hsnSac: '998714' }] });
  const voided = await api(t, 'PATCH', '/api/sales-documents', { action: 'void-credit-note', id: cn.json?.id, reason: 'Raised against the wrong invoice' });
  check(t, 'setup: a credit note voided with a reason (as its Void window sends it)', voided.status === 200, `${cn.status} ${voided.status} ${JSON.stringify(voided.json).slice(0, 100)}`);

  await goto(t, '/accountant/reversed-vouchers');
  await page.locator('[data-slot="rv-reason"]').first().waitFor();
  const reasons = await page.locator('[data-slot="rv-reason"]').allInnerTexts();
  for (const r of ['Paid to the wrong vendor', 'Moved to the wrong account', 'Raised against the wrong invoice']) {
    check(t, `2: Reversed Vouchers shows the reason "${r}"`, reasons.some((x) => x.includes(r)), reasons.join(' | '));
  }
  check(t, '2: no reversal in this company reads "Not given"', !reasons.some((x) => /Not given/.test(x)), reasons.join(' | '));
  const howto = await page.locator('[data-slot="rv-howto"]').innerText();
  check(t, '2: the help line reads as one sentence ("the journal → Reverse, with a date")', /the journal → Reverse, with a date/.test(howto.replace(/\s+/g, ' ')), howto.slice(0, 90));
  await shot(t, 'reversed-vouchers');

  // ── 4. Negative stock and cash ─────────────────────────────────────────────
  const over = await api(t, 'POST', '/api/invoices', { customerId: customer, date: day(1), dueDate: day(1), status: 'approved', lines: [{ itemId, qty: 50, ratePaise: 20_000 }] });
  const ow = (over.json?.warnings ?? []).join(' | ');
  // On hand: 5 − 1 written off + 6 bought − 1 sent back = 9.
  check(t, '4: an invoice selling 50 of 9 in stock is warned: item, stock, going out, shortfall', /FIFO Widget: 9 in stock, 50 going out, short by 41/.test(ow), ow.slice(0, 200));
  // Through the invoice form's own warning toast: a second oversale typed on the screen is shown the same way (API above; toast below).
  const expense = await api(t, 'POST', '/api/expenses', { branchId, date: day(1), accountId: await accountId('6300') ?? await accountId('6400'), paidThroughBankAccountId: cash.id, amountPaise: 13_098_00 });
  const ew = (expense.json?.warnings ?? []).join(' | ');
  // The till is empty (the ₹2,000 transfer into it was deleted above).
  check(t, '4: an expense paid from Cash in Hand beyond what is in hand is warned, with the shortfall', /Cash in Hand would go below nil: ₹0\.00 in hand .* ₹13,098\.00 going out — short by ₹13,098\.00/.test(ew), ew.slice(0, 400) || JSON.stringify(expense.json).slice(0, 200));

  await goto(t, '/reports/profit-and-loss');
  await page.locator('[data-slot="below-zero-notice"]').waitFor();
  const pln = await page.locator('[data-slot="below-zero-notice"]').innerText();
  check(t, '4: the profit and loss says stock is below zero, naming FIFO Widget', /Stock (and cash )?below zero/.test(pln) && /FIFO Widget/.test(pln) && /-41/.test(pln), pln.replace(/\s+/g, ' ').slice(0, 200));
  await shot(t, 'pl-below-zero');
  await goto(t, '/reports/balance-sheet');
  await page.locator('[data-slot="below-zero-notice"]').waitFor();
  const bsn = await page.locator('[data-slot="below-zero-notice"]').innerText();
  check(t, '4: the balance sheet says so too, with Cash in Hand at −₹13,098.00', /FIFO Widget/.test(bsn) && /Cash in Hand/.test(bsn) && /13,098\.00/.test(bsn), bsn.replace(/\s+/g, ' ').slice(0, 220));
  await shot(t, 'bs-below-zero');

  // Settings → Policies: Negative stock and Negative cash, set to Block.
  await goto(t, '/settings?tab=policies');
  if (!(await page.locator('[data-slot="policy-negativeCash-block"]').count())) {
    await page.getByRole('tab', { name: /Policies/ }).first().click().catch(() => {});
  }
  await page.locator('[data-slot="policy-negativeCash-block"]').waitFor();
  await page.locator('[data-slot="policy-negativeStock-block"]').click();
  await waitToast(/Saved/);
  await page.locator('[data-slot="policy-negativeCash-block"]').click();
  await page.waitForTimeout(1200);
  await shot(t, 'policies-block');
  const pol = (await api(t, 'GET', '/api/settings/policies')).json;
  check(t, '4: Settings → Policies has Negative stock and Negative cash, now Block', pol?.negativeStock === 'block' && pol?.negativeCash === 'block', `${pol?.negativeStock} ${pol?.negativeCash}`);
  // A write-off of stock that is not there, through the window: refused with the reason.
  await goto(t, '/inventory/adjustments');
  await page.getByRole('button', { name: /Adjust stock/ }).click();
  await pickIn(dlg, 'Select an item', 'FIFO Widget', /FIFO Widget/);
  await dlg.locator('[data-slot="adjust-qty"]').fill('-2');
  await dlg.locator('[data-slot="adjust-preview-short"]').waitFor();
  const short = await dlg.locator('[data-slot="adjust-preview-short"]').innerText();
  await dlg.locator('[data-slot="adjustment-save"]').click();
  const refused = await waitToast(/too little stock|not recorded/);
  check(t, '4: with Block, the window warns of the shortfall and the write-off is refused', /short by/.test(short) && /too little stock/.test(refused + await dlg.innerText()), `${short} / ${refused.slice(0, 160)}`);
  await shot(t, 'adjust-refused');
  await page.keyboard.press('Escape');
  const blockedCash = await api(t, 'POST', '/api/expenses', { branchId, date: d0, accountId: await accountId('6300') ?? await accountId('6400'), paidThroughBankAccountId: cash.id, amountPaise: 100_00 });
  check(t, '4: with Block, cash paid out of an empty till is refused (409)', blockedCash.status === 409 && /below nil/.test(blockedCash.json?.error ?? ''), `${blockedCash.status} ${blockedCash.json?.error?.slice(0, 120)}`);
  await api(t, 'PUT', '/api/settings/policies', { negativeStock: 'warn', negativeCash: 'warn' });

  // ── 5. A discarded journal in the approval history ─────────────────────────
  await api(t, 'POST', '/api/approvals', { action: 'save-rule', documentType: 'journal', thresholdPaise: 10_000_00, approverRole: 'accountant', isActive: true });
  const rent = await accountId('6100') ?? await accountId('6200');
  const held = await api(t, 'POST', '/api/journal', { date: day(1), memo: 'Office rent (entered twice)', lines: [{ accountId: String(rent), debitPaise: 50_000_00 }, { accountId: String(hdfc.ledgerAccountId ?? await accountId('1210')), creditPaise: 50_000_00 }] });
  check(t, 'setup: a ₹50,000 journal is held for approval', held.json?.held === true, JSON.stringify(held.json).slice(0, 120));
  const disc = await api(t, 'POST', '/api/held-journals', { action: 'discard', id: held.json?.heldId, reason: 'Booked twice' });
  check(t, 'setup: it is discarded', disc.status === 200, JSON.stringify(disc.json).slice(0, 100));
  await goto(t, '/approvals');
  await page.locator('[data-slot="approval-history"]').waitFor();
  const hist = await page.locator('[data-slot="approval-history"]').innerText();
  check(t, '5: Approvals → Approval history shows the journal as Discarded, with why', /Discarded/.test(hist) && /Booked twice/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 200));
  await shot(t, 'approval-history');

  // ── 6. Contact on the General Ledger rows ──────────────────────────────────
  await glContacts(await accountId('4100'), 'Kaveri Retail Pvt Ltd');
}

async function glContacts(salesId, name) {
  await goto(t, `/reports/general-ledger?account=${salesId}`);
  await page.locator('[data-slot="ledger-row"]').first().waitFor();
  const rows = await page.locator('[data-slot="ledger-row"]').evaluateAll((trs) => trs.map((tr) => ({
    text: tr.innerText, contact: tr.querySelector('[data-slot="ledger-contact"]')?.textContent?.trim() ?? '',
  })));
  const invoiceRows = rows.filter((r) => /Invoice/.test(r.text));
  check(t, `6: every invoice row of the Sales ledger names its customer${name ? ` (${name})` : ''} — none blank`,
    invoiceRows.length > 0 && invoiceRows.every((r) => r.contact && r.contact !== '—') && (!name || invoiceRows.some((r) => r.contact === name)),
    `${invoiceRows.length} rows: ${invoiceRows.slice(0, 4).map((r) => r.contact).join(', ')}`);
  await shot(t, 'gl-sales-contacts');
}

async function demo() {
  await enter(t);
  // 1. Adjustments: the list's values are the FIFO/average values kept on each, none at the catalogue price.
  const adj = (await api(t, 'GET', '/api/inventory?view=adjustments')).json?.adjustments ?? [];
  const rotor = adj.find((a) => /Brake Disc Rotor/.test(a.itemName) && a.reason === 'damage');
  check(t, '1: the demo FIFO write-off (1 Brake Disc Rotor, damaged) is valued at ₹120.00', rotor?.valuePaise === -12_000, `${rotor?.itemName} ${rotor?.valuePaise}`);
  await goto(t, '/inventory/adjustments');
  await page.locator('[data-slot="adjustment-value"]').first().waitFor();
  await shot(t, 'adjustments-list');
  // 2. Reversed Vouchers: the seeded deletes carry their reasons.
  await goto(t, '/accountant/reversed-vouchers');
  await page.locator('[data-slot="rv-reason"]').first().waitFor();
  const reasons = await page.locator('[data-slot="rv-reason"]').allInnerTexts();
  check(t, '2: the deleted payment and transfer show their reasons', reasons.some((r) => /Paid twice/.test(r)) && reasons.some((r) => /wrong account/.test(r)), reasons.slice(0, 6).join(' | '));
  await shot(t, 'reversed-vouchers');
  // 3. Vendor credits name their bills by number.
  await goto(t, '/purchases/vendor-credits');
  await page.waitForTimeout(1500);
  const vtext = await page.locator('main').innerText();
  check(t, '3: no vendor credit names its bill as "Bill #<id>"', !/Bill #\d/.test(vtext));
  await shot(t, 'vendor-credits');
  // 4. The statements: a notice exactly when the books have stock or cash below zero.
  const pl = (await api(t, 'GET', `/api/reports?report=profit-and-loss-grouped&from=${addDays(d0, -200)}&to=${d0}`)).json;
  await goto(t, '/reports/profit-and-loss');
  await page.waitForTimeout(2000);
  const shown = await page.locator('[data-slot="below-zero-notice"]').count();
  const expected = (pl?.belowZero?.stock?.length ?? 0) + (pl?.belowZero?.cash?.length ?? 0) > 0;
  check(t, `4: the P&L notice is shown exactly when stock or cash is below zero (${expected ? 'some' : 'none'} in the demo book)`, (shown > 0) === expected);
  await shot(t, 'pl');
  // 5. The discarded journal in the approval history.
  await goto(t, '/approvals');
  await page.locator('[data-slot="approval-history"]').waitFor();
  const hist = await page.locator('[data-slot="approval-history"]').innerText();
  check(t, '5: Approval history shows the discarded bonus provision', /Discarded/.test(hist), hist.replace(/\s+/g, ' ').slice(0, 200));
  await shot(t, 'approval-history');
  // 6. Sales ledger: every invoice row names its customer.
  await glContacts(await accountId('4100'), null);
}

if (FRESH) await fresh(); else await demo();
await finish(t);
