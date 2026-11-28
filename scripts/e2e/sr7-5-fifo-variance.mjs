// Status review 7, item 5: FIFO valuation variance, as the auditors test it,
// in a periodic book and then a perpetual one (each a new company):
// bill 10 @ ₹100 and 10 @ ₹120, sell 15, send 2 back to the vendor, take 1
// back from the customer, write 1 off; the valuation report, the item's FIFO
// layers, the Inventory account and COGS agree to the paisa, at any date; a
// back-dated bill is posted as a visible cost variance.
//   FRESH=1 node scripts/e2e/sr7-5-fifo-variance.mjs   (two new companies)
//   node scripts/e2e/sr7-5-fifo-variance.mjs           (the demo book)

import { addDays, api, check, contact, enter, finish, goto, shot, start, today } from './sr7-b-lib.mjs';

const t = await start('5');
const { page } = t;
const money = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const d0 = today();
const monthStart = `${d0.slice(0, 7)}-01`;
// The scenario's days, within this month (a perpetual book starts on the 1st).
const day = (n) => { const x = addDays(d0, -n); return x < monthStart ? monthStart : x; };

async function figures(itemId, asOf) {
  const rec = (await api(t, 'GET', `/api/reports/stock-reconciliation?asOf=${asOf}`)).json;
  const line = rec?.lines?.find((l) => l.itemId === String(itemId));
  const layers = (await api(t, 'GET', `/api/items/${itemId}/layers?asOf=${asOf}`)).json;
  const tb = (await api(t, 'GET', `/api/reports?report=trial-balance&to=${asOf}`)).json;
  const inv = (tb?.rows ?? []).find((r) => r.code === '1500');
  const val = (await api(t, 'GET', `/api/reports?report=inventory-valuation&to=${asOf}`)).json;
  const vrow = (val?.rows ?? []).find((r) => String(r.itemId) === String(itemId));
  return {
    method: rec?.method, variance: rec?.totals?.variancePaise, valuation: line?.valuationPaise ?? 0, ledgerItem: line?.ledgerPaise,
    ledgerTotal: rec?.totals?.ledgerPaise, layers: layers?.valuePaise, report: vrow?.valuePaise ?? 0, qty: line?.qty ?? 0,
    tbInventory: inv ? inv.debitPaise - inv.creditPaise : 0, cogs: rec?.proof?.costOfGoodsSoldPaise,
  };
}

async function scenario(perpetual) {
  const label = perpetual ? 'perpetual' : 'periodic';
  if (perpetual) {
    const sw = await api(t, 'POST', '/api/settings/stock-accounting', { action: 'switch', from: monthStart });
    check(t, `${label}: the book is put on perpetual inventory from ${monthStart} (Settings → Controls)`, sw.status === 200, JSON.stringify(sw.json).slice(0, 120));
  }
  const vendor = await contact(t, 'vendor', `FIFO Supplier ${label}`);
  const customer = await contact(t, 'customer', `FIFO Customer ${label}`);
  const it = await api(t, 'POST', '/api/items', { kind: 'goods', name: `Brake Rotor FIFO ${label}`, uqc: 'NOS', hsnSac: '8708', salePricePaise: 20_000, purchasePricePaise: 10_000, gstRatePct: 18, taxPref: 'taxable', trackInventory: true, valuationMethod: 'fifo' });
  check(t, `${label}: a FIFO item with no opening stock`, it.status === 200, JSON.stringify(it.json).slice(0, 100));
  const itemId = it.json.id;
  // 1. Two bills (setup through the app's API, as the Bills form posts them).
  const bill = (no, date, ratePaise) => api(t, 'POST', '/api/bills', { vendorId: vendor, vendorInvoiceNo: no, date, dueDate: date, lines: [{ itemId, qty: 10, ratePaise }] });
  const b1 = await bill(`${label}-A1`, day(6), 10_000);
  const b2 = await bill(`${label}-A2`, day(5), 12_000);
  check(t, `${label}: bills 10 @ ₹100 and 10 @ ₹120`, b1.status === 200 && b2.status === 200, `${b1.status}/${b2.status} ${JSON.stringify(b2.json).slice(0, 80)}`);
  // 2. The sale of 15.
  const inv = await api(t, 'POST', '/api/invoices', { customerId: customer, date: day(4), dueDate: day(4), status: 'approved', lines: [{ itemId, qty: 15, ratePaise: 20_000 }] });
  let f = await figures(itemId, day(4));
  check(t, `${label} 2: COGS ₹1,600 and closing 5 @ ₹120 = ₹600`, f.cogs === 160_000 && f.valuation === 60_000 && f.qty === 5, `COGS ${money(f.cogs)}, closing ${money(f.valuation)}`);

  // 3. Two back to the vendor, out of the second bill: through the Vendor Credits screen, goods mode.
  await goto(t, '/purchases/vendor-credits');
  await page.getByRole('button', { name: /New vendor credit/ }).click();
  const dlg = page.locator('[data-slot="vendor-credit-dialog"]');
  await dlg.locator('[data-slot="vendor-credit-date"]').fill(day(3));
  await dlg.locator('[data-slot="combobox-trigger"]').first().click();
  await page.locator('input[placeholder^="Search"]').last().fill(`FIFO Supplier ${label}`);
  await page.getByRole('option', { name: new RegExp(`FIFO Supplier ${label}`) }).first().click();
  await dlg.locator('[data-slot="vc-mode-goods"]').click();
  await dlg.locator('[data-slot="combobox-trigger"]', { hasText: 'Standalone' }).click();
  await page.getByRole('option', { name: /BILL/ }).filter({ hasText: `${label}-A2` }).first().click();
  await dlg.locator('[data-slot="vc-goods-row"]').first().waitFor();
  await dlg.locator('[data-slot="vc-goods-qty"]').first().fill('2');
  await shot(t, `${label}-vendor-credit-goods`);
  await dlg.locator('[data-slot="vendor-credit-save"]').click();
  await page.waitForTimeout(2500);
  f = await figures(itemId, day(3));
  check(t, `${label} 3: 2 sent back to the vendor: stock 3, value follows the layer (3 @ ₹120 = ₹360)`, f.qty === 3 && f.valuation === 36_000, `${f.qty} @ ${money(f.valuation)}`);

  // 4. The customer returns 1, at its cost (₹120).
  const cn = await api(t, 'POST', '/api/sales-documents', { kind: 'credit-note', customerId: customer, date: day(2), reason: 'Sales Return', againstInvoiceId: inv.json.id, lines: [{ itemId, qty: 1, ratePaise: 20_000 }] });
  check(t, `${label} 4: a credit note takes 1 back`, cn.status === 200, JSON.stringify(cn.json).slice(0, 100));
  // 5. One written off as damaged.
  const adj = await api(t, 'POST', '/api/inventory', { itemId, date: day(1), qtyDelta: -1, reason: 'damage', notes: 'Cracked in the store' });
  check(t, `${label} 5: an adjustment of −1, damaged`, adj.status === 200, `${adj.status} ${JSON.stringify(adj.json).slice(0, 100)}`);

  // 6. At any date the figures agree to the paisa.
  for (const asOf of [day(4), day(2), day(1), d0]) {
    f = await figures(itemId, asOf);
    const ledgerOk = perpetual ? f.ledgerItem === f.valuation && f.tbInventory === f.valuation : f.tbInventory === 0;
    check(t, `${label} 6 at ${asOf}: valuation report ${money(f.report)} = layers ${money(f.layers)} = reconciliation ${money(f.valuation)}${perpetual ? ` = Inventory account ${money(f.tbInventory)}` : ' (Inventory not posted on a periodic book)'}; variance ${money(f.variance ?? -1)}`,
      f.report === f.valuation && f.layers === f.valuation && ledgerOk && f.variance === 0, `COGS ${money(f.cogs)}`);
  }
  f = await figures(itemId, d0);
  check(t, `${label}: at the end 3 @ ₹120 = ₹360, COGS ₹1,600`, f.valuation === 36_000 && f.cogs === 160_000, `${money(f.valuation)}, COGS ${money(f.cogs)}`);

  // The screens: Stock Layers on the item page, Stock Valuation vs Ledger.
  await goto(t, `/sales/items/${itemId}`);
  await page.getByRole('tab', { name: 'Stock Layers' }).click();
  await page.locator('[data-slot="item-layer-row"]').first().waitFor();
  const layersValue = await page.locator('[data-slot="layers-value"]').innerText();
  check(t, `${label}: the item's Stock Layers show each receipt and ₹360.00 on hand`, /360\.00/.test(layersValue), layersValue);
  await shot(t, `${label}-stock-layers`);
  await goto(t, '/reports/stock-reconciliation');
  await page.locator('[data-slot="stock-rec-verdict"]').waitFor();
  const verdict = await page.locator('[data-slot="stock-rec-verdict"]').innerText();
  check(t, `${label}: Stock Valuation vs Ledger reads ₹0.00`, /variance ₹0\.00/.test(verdict), verdict.slice(0, 120));
  await shot(t, `${label}-valuation-vs-ledger`);

  if (perpetual) {
    // 7. A back-dated bill (5 @ ₹80, before the sale): posted as a visible cost variance naming it.
    const back = await bill(`${label}-A0`, day(7), 8_000);
    check(t, 'perpetual 7: a bill dated before the sale', back.status === 200);
    f = await figures(itemId, d0);
    check(t, 'perpetual 7: still in line after it: valuation = Inventory account, variance ₹0.00; COGS now ₹1,400', f.variance === 0 && f.ledgerItem === f.valuation && f.cogs === 140_000, `${money(f.valuation)} / ${money(f.ledgerItem)} COGS ${money(f.cogs)}`);
    const gl = (await api(t, 'GET', `/api/journal?from=${monthStart}&to=${d0}&sourceType=stock_variance`)).json;
    const text = JSON.stringify(gl ?? {});
    check(t, 'perpetual 7: the difference is a "Stock cost variance" entry naming the back-dated bill', /Stock cost variance/.test(text) && text.includes(`${label}-A0`));
    await goto(t, '/reports/general-ledger');
    await shot(t, 'perpetual-general-ledger');
  }
}

if (process.env.FRESH === '1') {
  await enter(t);
  await scenario(false);
  // A second new company, on perpetual inventory.
  await t.ctx.clearCookies();
  await enter(t);
  await scenario(true);
} else {
  await enter(t);
  await goto(t, '/reports/stock-reconciliation');
  await page.locator('[data-slot="stock-rec-verdict"]').waitFor();
  const verdict = await page.locator('[data-slot="stock-rec-verdict"]').innerText();
  const rec = (await api(t, 'GET', `/api/reports/stock-reconciliation?asOf=${d0}`)).json;
  check(t, 'the demo book (perpetual) reconciles: variance ₹0.00', rec?.method === 'perpetual' && rec?.totals?.variancePaise === 0 && /₹0\.00/.test(verdict), `${rec?.method} ${money(rec?.totals?.variancePaise ?? -1)}`);
  await shot(t, 'valuation-vs-ledger');
  const items = (await api(t, 'GET', '/api/items?search=FIFO')).json?.items ?? [];
  const fifo = items.find((i) => /Brake Disc Rotor/.test(i.name));
  check(t, 'the demo FIFO item is there', !!fifo);
  if (fifo) {
    await goto(t, `/sales/items/${fifo.id}`);
    await page.getByRole('tab', { name: 'Stock Layers' }).click();
    await page.locator('[data-slot="item-layer-row"]').first().waitFor();
    const v = await page.locator('[data-slot="layers-value"]').innerText();
    check(t, 'its Stock Layers: 3 on hand at ₹120 = ₹360.00', /360\.00/.test(v), v);
    await shot(t, 'stock-layers');
  }
}
await finish(t);
