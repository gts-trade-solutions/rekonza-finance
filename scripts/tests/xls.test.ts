// The .xls reader (lib/imports/xls.ts): a real Excel 97–2003 file saved by
// Excel itself, and the "xls" files banks send that are really HTML or text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readXls } from '../../lib/imports/xls';
import { columnFor } from '../../lib/imports/templates';

const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'zoho-customers.xls')));

test('an .xls saved by Excel reads as its grid: text, numbers, dates, booleans, formulas, Unicode', () => {
  const r = readXls(fixture);
  assert.ok('grid' in r);
  const g = r.grid;
  assert.equal(g.length, 150, 'every row, the shared strings running on into CONTINUE records');
  assert.deepEqual(g[0], ['Display Name', 'Company Name', 'GST Treatment', 'Place of Contact', 'EmailID', 'Opening Balance', 'Created On', 'Active', 'Notes']);
  assert.equal(g[1][0], 'Acme Traders');
  assert.equal(g[1][5], 1250.5);
  assert.ok(g[1][6] instanceof Date && (g[1][6] as Date).toISOString().startsWith('2026-11-15'), 'a date-formatted formula is a date');
  assert.equal(g[1][7], true);
  assert.equal(g[1][8], '₹ தமிழ advance');
  assert.equal(g[2][5], 2501, 'a formula keeps its result');
  assert.ok((g[2][6] as Date).toISOString().startsWith('2026-11-15'), 'a number formatted as a date is a date');
  assert.equal(g[2][8], 'Ref-Blue Star Retail', 'a formula returning text');
  assert.equal(g[149][0], 'Customer number 150 with a fairly long display name to fill the shared string table');
  assert.equal(g[149][5], 450);
});

test('Zoho’s export headings find their columns', () => {
  const r = readXls(fixture);
  assert.ok('grid' in r);
  const keys = r.grid[0].map((h) => columnFor('contacts', String(h)));
  assert.deepEqual(keys.slice(0, 5), ['name', 'legal_name', null, 'state', 'email']);
  assert.equal(columnFor('invoices', 'Customer Name'), 'customer');
  assert.equal(columnFor('invoices', 'Item Price'), 'rate');
  assert.equal(columnFor('invoices', 'Item Tax %'), 'gst_rate');
  assert.equal(columnFor('bills', 'Bill Number'), 'bill_no');
  assert.equal(columnFor('items', 'Item Name'), 'name');
  assert.equal(columnFor('items', 'Item Type'), null, 'Zoho’s Item Type is sales or purchases, not goods or service');
});

test('a bank’s ".xls" that is an HTML table, or tab-separated text, reads as what it is', () => {
  const html = new TextEncoder().encode('<html><body><table><tr><th>Date</th><th>Narration</th><th>Amount</th></tr><tr><td>01/11/2026</td><td>NEFT&nbsp;ACME</td><td>1,200.00</td></tr></table></body></html>');
  const h = readXls(html);
  assert.ok('grid' in h);
  assert.deepEqual(h.grid, [['Date', 'Narration', 'Amount'], ['01/11/2026', 'NEFT ACME', '1,200.00']]);
  const tsv = new TextEncoder().encode('Date\tNarration\tAmount\n01/11/2026\tUPI\t500\n');
  const t = readXls(tsv);
  assert.ok('text' in t && t.text.startsWith('Date\tNarration'));
});

test('a bank statement saved as .xls, with a title and blank rows above the headings, finds its columns', async () => {
  const { guessMapping, readWithMapping } = await import('../../lib/bank-statement');
  const r = readXls(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'bank-statement.xls'))));
  assert.ok('grid' in r);
  assert.equal(r.grid[0][0], 'HDFC BANK Ltd.');
  assert.deepEqual(r.grid[1].filter((c) => c !== null), [], 'a blank row is a row of blanks, not a hole');
  const m = guessMapping(r.grid);
  assert.ok(m, 'the heading row is found under the title');
  assert.equal(m.headerAt, 5);
  const { rows, problem } = readWithMapping(r.grid, m);
  assert.equal(problem, null);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].narration, 'NEFT CR-APEX MOTORS PVT LTD-INV 39');
});
