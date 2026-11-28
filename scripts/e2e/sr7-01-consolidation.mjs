// Status review 7, item 1 — Company management: multi-company consolidation.
//
// The auditor's test: make a second company from the company menu; company A
// invoices company B for stock, B enters the bill, B pays part of it and still
// holds some of the stock at the period end; B's share capital and A's
// investment in it; then Reports → Consolidated statements with both
// companies: each company's column, an Eliminations column and the group; the
// P&L and a balancing balance sheet; inter-company balances and trade
// eliminated; unrealised profit in stock eliminated; goodwill and the
// non-controlling interest; mismatches explained; the consolidated trial
// balance and the consolidation check; drill-down to a company's ledger;
// Excel and PDF exports showing the companies and the eliminations.
//
//   FRESH=1 node scripts/e2e/sr7-01-consolidation.mjs   (two new companies)
//   node scripts/e2e/sr7-01-consolidation.mjs           (the demo group)
//
// In a fresh run the documents are made through the app's own API from the
// signed-in page; the company, the group set-up and every report step are
// done on the screens.

import { readFileSync } from 'node:fs';
import { start, FRESH, rupees, today, fyStart } from './_sr7-common.mjs';

const t = await start('01');
const { page, check, shot, idle, go, api, finish } = t;
const tag = String(Date.now()).slice(-6);
const firstLine = (s) => s.split(String.fromCharCode(10))[0];

async function switchTo(name) {
  await page.click('[data-slot="org-switcher"]');
  await page.getByRole('menuitem', { name: new RegExp(name) }).click();
  await page.waitForURL('**/dashboard', { timeout: 180000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await idle(1200);
}

try {
  const A = `Group Parent ${tag}`, B = `Group Sub ${tag}`;
  if (FRESH) {
    await t.signUp(A);
    // ── 0. One company only: the screen says how to add the second.
    await go('/reports/consolidated');
    await page.waitForSelector('[data-slot="consolidated-one-company"]', { timeout: 60000 });
    check('one company: the steps to add a second are shown', /Add a company/.test(await page.locator('[data-slot="consolidated-one-company"]').innerText()));
    await shot('one-company');

    // ── 1. The second company, from the company menu.
    await page.click('[data-slot="org-switcher"]');
    await page.getByRole('menuitem', { name: /Add a company/ }).click();
    await page.getByPlaceholder('Race Auto Exports Pvt Ltd').fill(B);
    await shot('add-company');
    await page.getByRole('button', { name: /Create and move there/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 180000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await idle(1500);
    check('the second company is made and opened', (await page.locator('[data-slot="org-switcher"]').innerText()).includes(B));

    // ── 2. B: its share capital, the stock item, the vendor A and an outside customer.
    const mb = (await api('GET', '/api/masters')).body;
    const bAcc = (code) => String(mb.accounts.find((a) => a.code === code).id);
    const bBranch = mb.branches[0].id;
    await api('POST', '/api/journal', { date: fyStart(), memo: 'Share capital subscribed', lines: [{ accountId: bAcc('1210'), debitPaise: 10000000 }, { accountId: bAcc('3100'), creditPaise: 10000000 }] });
    const bItem = (await api('POST', '/api/items', { kind: 'goods', name: `Brake kit ${tag}`, sku: `BK-${tag}`, salePricePaise: 150000, purchasePricePaise: 100000, gstRatePct: 0, trackInventory: true })).body;
    const vendorA = (await api('POST', '/api/contacts', { kind: 'vendor', displayName: A, gstTreatment: 'unregistered', stateCode: '33' })).body;
    const walkIn = (await api('POST', '/api/contacts', { kind: 'customer', displayName: `Walk-in ${tag}`, gstTreatment: 'unregistered', stateCode: '33' })).body;

    // ── 3. A: the same item with stock at ₹600, B as a customer, the investment; A invoices B.
    await switchTo(A);
    const ma = (await api('GET', '/api/masters')).body;
    const aAcc = (code) => String(ma.accounts.find((a) => a.code === code).id);
    const aBranch = ma.branches[0].id;
    const aItem = (await api('POST', '/api/items', { kind: 'goods', name: `Brake kit ${tag}`, sku: `BK-${tag}`, salePricePaise: 100000, purchasePricePaise: 60000, gstRatePct: 0, trackInventory: true, openingStockQty: 20, openingStockRatePaise: 60000 })).body;
    const custB = (await api('POST', '/api/contacts', { kind: 'customer', displayName: B, gstTreatment: 'unregistered', stateCode: '33' })).body;
    await api('POST', '/api/journal', { date: fyStart(), memo: 'Investment in the subsidiary: 80% of its shares', lines: [{ accountId: aAcc('1700'), debitPaise: 8500000 }, { accountId: aAcc('3100'), creditPaise: 8500000 }] });
    const sale = (await api('POST', '/api/invoices', { branchId: aBranch, customerId: String(custB.id), date: today(), dueDate: today(), status: 'approved', lines: [{ itemId: String(aItem.id), description: 'Brake kit', qty: 10, ratePaise: 100000, gstRatePct: 0 }] })).body;
    const recd = (await api('POST', '/api/payments', { kind: 'received', branchId: aBranch, contactId: String(custB.id), date: today(), mode: 'neft', amountPaise: 400000, bankAccountId: String(ma.bankAccounts[0].id) })).body;
    check('A: stock, B as a customer, the investment, an invoice to B and B\'s part payment', !!aItem.id && !!sale.id && !!recd.id, `${sale.number ?? sale.error}`);

    // ── 4. B: the bill from A, a sale of 4 to an outsider, the part payment.
    await switchTo(B);
    const bill = (await api('POST', '/api/bills', { branchId: bBranch, vendorId: String(vendorA.id), vendorInvoiceNo: sale.number, date: today(), dueDate: today(), status: 'open', lines: [{ itemId: String(bItem.id), description: 'Brake kit', qty: 10, ratePaise: 100000, gstRatePct: 0 }] })).body;
    const out = (await api('POST', '/api/invoices', { branchId: bBranch, customerId: String(walkIn.id), date: today(), dueDate: today(), status: 'approved', lines: [{ itemId: String(bItem.id), description: 'Brake kit', qty: 4, ratePaise: 150000, gstRatePct: 0 }] })).body;
    const paid = (await api('POST', '/api/payments', { kind: 'made', branchId: bBranch, contactId: String(vendorA.id), date: today(), mode: 'neft', amountPaise: 400000, bankAccountId: String(mb.bankAccounts[0].id) })).body;
    check('B: the bill from A, a sale of 4 kits, ₹4,000 paid to A', !!bill.id && !!out.id && !!paid.id, `${bill.internalNo ?? bill.error ?? ''}`);

    // ── 5. Consolidated statements: both companies; Group set-up.
    await go('/reports/consolidated');
    await page.waitForSelector('[data-slot="consolidated-companies"]', { timeout: 60000 });
    check('both companies are offered', (await page.locator('[data-slot="consolidated-companies"]').innerText()).includes(A));
    await page.click('[data-slot="consolidated-setup"]');
    await page.waitForSelector('[data-slot="setup-parent"]', { timeout: 60000 });
    await page.selectOption('[data-slot="setup-parent"]', { label: A });
    await page.fill('[data-slot="setup-name"]', `Group ${tag}`);
    await page.locator('[data-slot="setup-member"]', { hasText: B }).locator('[data-slot="setup-pct"]').fill('80');
    await page.locator('[data-slot="setup-member"]', { hasText: B }).locator('[data-slot="setup-acquired"]').fill(fyStart());
    await page.locator('[data-slot="setup-member"]', { hasText: B }).locator('[data-slot="setup-investment"]').selectOption({ label: '1700 Investments' }).catch(async () => {
      const opts = await page.locator('[data-slot="setup-member"] [data-slot="setup-investment"] option').allInnerTexts();
      await page.locator('[data-slot="setup-member"]', { hasText: B }).locator('[data-slot="setup-investment"]').selectOption({ label: opts.find((o) => o.startsWith('1700')) });
    });
    // Neither company has a PAN: link the customer and the vendor by hand.
    await page.locator('[data-slot="setup-links"]', { hasText: `In ${A}` }).locator(`select[aria-label="${B} is"]`).selectOption({ label: `is ${B}` });
    await page.locator('[data-slot="setup-links"]', { hasText: `In ${B}` }).locator(`select[aria-label="${A} is"]`).selectOption({ label: `is ${A}` });
    await shot('group-setup');
    await page.click('[data-slot="setup-save"]');
    await page.waitForSelector('text=Group set up', { timeout: 60000 });
    await idle(2000);
  } else {
    await t.loginDemo();
    await go('/reports/consolidated');
    await page.waitForSelector('[data-slot="consolidated-companies"]', { timeout: 60000 });
    await page.click('[data-slot="consolidated-setup"]');
    await page.waitForSelector('[data-slot="setup-parent"]', { timeout: 60000 });
    check('the demo group: the parent and a 75% subsidiary', (await page.locator('[data-slot="setup-pct"]').first().inputValue()) === '75');
    await shot('group-setup');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  }

  // ── 6. The statements: companies, eliminations, group.
  await page.waitForSelector('[data-slot="consolidated-table"]', { timeout: 60000 });
  const head = await page.locator('[data-slot="consolidated-table"] thead').innerText();
  check('a column per company, Eliminations and Group', /Eliminations/i.test(head) && /Group/i.test(head) && (FRESH ? head.includes(A.toUpperCase()) || head.includes(A) : /RACE AUTO EXPORTS|Race Auto Exports/i.test(head)), firstLine(head));
  const rowText = async (re) => (await page.locator('[data-slot="consolidated-table"] tr').filter({ hasText: re }).first().allInnerTexts()).join(' ');
  const totalIncome = await rowText(/^Total income/);
  const salesRow = page.locator('[data-slot="consolidated-table"] tr', { hasText: '4100' }).first();
  const elimSales = rupees(firstLine(await salesRow.locator('[data-slot="consolidated-elim"]').innerText()));
  if (FRESH) {
    check('A\'s ₹10,000 sale to B is eliminated from sales', elimSales === -10000 || elimSales === 10000, String(elimSales));
    const groupIncome = rupees(firstLine(await page.locator('[data-slot="consolidated-table"] tr', { hasText: /Total income/ }).first().locator('[data-slot="consolidated-group"]').innerText()));
    check('group income is the ₹6,000 sold outside the group', groupIncome === 6000, totalIncome);
  } else {
    check('the demo book\'s ₹58,000 sale to its subsidiary is eliminated', Math.abs(elimSales) === 58000, String(elimSales));
  }
  check('the group balance sheet balances', /balances/.test(await page.locator('[data-slot="consolidated-balanced"]').innerText()));
  check('profit attributable to owners and to the non-controlling interest', (await page.locator('[data-slot="consolidated-owners-profit"]').count()) === 1 && (await page.locator('[data-slot="consolidated-nci-profit"]').count()) === 1);
  const ar = page.locator('[data-slot="consolidated-table"] tr', { hasText: '1100' }).first();
  check('inter-company receivable eliminated', rupees(firstLine(await ar.locator('[data-slot="consolidated-elim"]').innerText())) !== 0);
  const up = await page.locator('[data-slot="consolidated-table"] tr', { hasText: 'Less: unrealised profit' }).count();
  check('unrealised profit in group stock taken out of assets', up === 1);
  check('goodwill on consolidation shown', (await page.locator('[data-slot="consolidated-table"] tr', { hasText: 'Goodwill on consolidation' }).count()) === 1);
  await shot('statements');

  // ── 7. Drill-down to a company's ledger.
  await ar.locator('[data-slot="consolidated-drill"]').first().click();
  await page.waitForSelector('[data-slot="consolidated-ledger"]', { timeout: 60000 });
  await page.waitForSelector('[data-slot="consolidated-ledger-line"]', { timeout: 60000 }).catch(() => {});
  await idle(1000);
  check('a company figure opens that company\'s ledger', (await page.locator('[data-slot="consolidated-ledger-line"]').count()) > 0);
  await shot('drill-ledger');
  await page.keyboard.press('Escape');

  // ── 8. Trial balance, check, eliminations.
  await page.click('[data-slot="consolidated-tab-trial-balance"]');
  await page.waitForSelector('[data-slot="consolidated-tb-total"]', { timeout: 60000 });
  const tb = await page.locator('[data-slot="consolidated-tb-total"] td').allInnerTexts();
  check('the consolidated trial balance: group debits equal credits', rupees(tb[tb.length - 2]) === rupees(tb[tb.length - 1]) && rupees(tb[tb.length - 1]) > 0, tb.slice(-2).join(' = '));
  await shot('trial-balance');
  await page.click('[data-slot="consolidated-tab-check"]');
  await page.waitForSelector('[data-slot="check-group"]');
  check('the consolidation check: each company and the group balance', /Yes/.test(await page.locator('[data-slot="check-group"]').innerText()) && (await page.locator('[data-slot="check-company"]', { hasText: 'No' }).count()) === 0);
  await shot('consolidation-check');
  await page.click('[data-slot="consolidated-tab-eliminations"]');
  await page.waitForSelector('[data-slot="consolidated-unrealised"]');
  const ic = await page.locator('[data-slot="intercompany-row"]').first().innerText();
  const urow = await page.locator('[data-slot="unrealised-row"]').first().innerText();
  const inv = await page.locator('[data-slot="investment-row"]').first().innerText();
  if (FRESH) {
    check('inter-company: ₹6,000 owed both sides, ₹10,000 traded both sides', (ic.match(/6,000\.00/g) ?? []).length >= 2 && (ic.match(/10,000\.00/g) ?? []).length >= 2, ic.replace(/\s+/g, ' '));
    check('unrealised profit: 6 kits held, bought at ₹1,000, cost ₹600: ₹2,400', /\b6\b/.test(urow) && /2,400\.00/.test(urow), urow.replace(/\s+/g, ' '));
    check('goodwill ₹5,000; NCI 20% of profit and net assets', /80%/.test(inv) && /5,000\.00/.test(inv), inv.replace(/\s+/g, ' '));
  } else {
    check('demo: unrealised profit ₹11,750 on 25 sets held', /11,750\.00/.test(urow) && /\b25\b/.test(urow), urow.replace(/\s+/g, ' '));
    check('demo: goodwill ₹50,000 at 75%', /75%/.test(inv) && /50,000\.00/.test(inv), inv.replace(/\s+/g, ' '));
  }
  check('mismatches are explained', /agree|difference is shown/.test(await page.locator('[data-slot="intercompany-agree"]').innerText()));
  await shot('eliminations');

  // ── 9. Exports: Excel and PDF with the companies and the eliminations.
  const exportAs = async (label) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), (async () => { await page.click('[data-slot="consolidated-export"]'); await page.getByRole('menuitem', { name: label, exact: true }).click(); })()]);
    return { name: dl.suggestedFilename(), text: readFileSync(await dl.path()).toString('latin1') };
  };
  const x = await exportAs('Excel (.xlsx)');
  check('Excel: statements, trial balance and eliminations sheets', x.text.startsWith('PK') && x.text.includes('Eliminations') && x.text.includes('Trial balance'), x.name);
  const p = await exportAs('PDF');
  check('PDF: the companies, Eliminations, Group and the check', p.text.startsWith('%PDF') && p.text.includes('Eliminations') && p.text.includes('CONSOLIDATION CHECK'), p.name);
} catch (e) {
  check('the script ran to the end', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
  await shot('failure').catch(() => {});
}
await finish();
