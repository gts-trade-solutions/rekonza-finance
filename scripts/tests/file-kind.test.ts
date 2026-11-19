// Any file, on any import screen: where it goes, and which import its headings fit.
//
//   npx tsx --test scripts/tests/file-kind.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileHome, guessImportKind, guessJsonKind } from '../../lib/imports/file-kind';
import { IMPORT_KINDS, TEMPLATES } from '../../lib/imports/templates';
import { templateJson } from '../../lib/imports/json';

test('a file goes to the screen that reads it, by its name', () => {
  assert.equal(fileHome('1-masters.xml'), 'tally');
  assert.equal(fileHome('DayBook.txt', '<?xml version="1.0"?><ENVELOPE>'), 'tally');
  assert.equal(fileHome('DayBook.txt', '\uFEFF<ENVELOPE>'), 'tally');
  assert.equal(fileHome('parties.txt', 'Type\tName\tGSTIN'), 'sheet');
  assert.equal(fileHome('Company.900'), 'tally-data');
  assert.equal(fileHome('C:\\Tally\\data\\100000\\TSTATE.TSF'), 'tally-data');
  assert.equal(fileHome('tally-export.zip'), 'zip');
  for (const f of ['1-customers-and-vendors.xlsx', '4-sales-invoices.csv', 'rates.tsv', 'x.dsv', 'x.psv', 'sales-invoices.json']) {
    assert.equal(fileHome(f), 'sheet', f);
  }
  for (const f of ['4-our-invoice-Kaveri-RAS-26-27-0211.pdf', 'bill-photo.JPG', 'scan.png', 'scan.webp']) {
    assert.equal(fileHome(f), 'pdf', f);
  }
  assert.equal(fileHome('company.iif'), 'quickbooks');
  // Excel 97–2003 is read too (lib/imports/xls).
  assert.equal(fileHome('old-ledger.xls'), 'sheet');
  // Tally's JSON export, and its HTML and SDF reports, belong to the Tally screen.
  assert.equal(fileHome('Master.json', '{\n "tallymessage": [ {'), 'tally');
  assert.equal(fileHome('TrialBal.html'), 'tally');
  assert.equal(fileHome('StkSum.sdf'), 'tally');
  assert.equal(fileHome('notes.docx'), 'unreadable');
});

test('every import knows its own template, from its headings alone', () => {
  for (const kind of IMPORT_KINDS) {
    const labels = TEMPLATES[kind].columns.map((c) => c.label);
    assert.equal(guessImportKind(labels), kind, `${kind} by its labels`);
    const keys = TEMPLATES[kind].columns.map((c) => c.key);
    assert.equal(guessImportKind(keys), kind, `${kind} by its keys`);
    // Only the required columns: a word in the file's name settles imports alike.
    const required = TEMPLATES[kind].columns.filter((c) => c.required).map((c) => c.label);
    assert.ok(guessImportKind(required, `my-${TEMPLATES[kind].title}.csv`), `${kind} with only its required columns`);
  }
});

test("the dummy files' headings each find their import", () => {
  // The headings of the files in Downloads\rekonza-sample-files, as they are.
  const contacts = ['Type', 'Name', 'Legal name', 'GSTIN', 'PAN', 'State', 'Email', 'Phone', 'Address', 'City', 'PIN code', 'Credit days', 'Udyam number'];
  const items = ['Name', 'Kind', 'SKU', 'HSN/SAC', 'Unit', 'Sale price', 'Purchase price', 'GST rate', 'Track stock', 'Opening quantity', 'Opening rate'];
  assert.equal(guessImportKind(contacts, '1-customers-and-vendors.xlsx'), 'contacts');
  assert.equal(guessImportKind(items, '2-items.xlsx'), 'items');
  assert.equal(guessImportKind(['Type', 'Party', 'Bill number', 'Bill date', 'Due date', 'Amount unpaid'], '3-opening-unpaid-bills.csv'), 'opening-bills');
  assert.equal(guessImportKind(['Invoice number', 'Date', 'Due date', 'Customer', 'Item', 'Description', 'HSN/SAC', 'Quantity', 'Rate', 'Discount %', 'GST rate'], '4-sales-invoices.csv'), 'invoices');
  assert.equal(guessImportKind(["Supplier's bill number", 'Date', 'Due date', 'Vendor', 'Item', 'Description', 'HSN/SAC', 'Quantity', 'Rate', 'GST rate'], '5-purchase-bills.csv'), 'bills');
  // The same headings under any file name: the headings decide, not the name.
  assert.equal(guessImportKind(items, 'customers.xlsx'), 'items');
  assert.equal(guessImportKind(contacts, 'export (3).xlsx'), 'contacts');
});

test('headings no import can take give no guess', () => {
  assert.equal(guessImportKind(['Particulars', 'Debit', 'Credit']), null);
  assert.equal(guessImportKind([]), null);
  // A customer list without its Type column is a customer list to finish, not an item list for its Name.
  assert.equal(guessImportKind(['Name', 'GSTIN', 'Email', 'Phone']), null);
  // Sales invoices without their Invoice number: not taken for quotes or orders.
  assert.equal(guessImportKind(['Date', 'Customer', 'Item', 'Quantity', 'Rate', 'GST rate'], 'sales-invoices.csv'), null);
});

test('a JSON file finds its import, however its rows are laid out', () => {
  const dummy = JSON.stringify({ invoices: [{ invoice_no: 'SI/26-27/0305', date: '2026-11-09', customer: 'Sakthi Motors', lines: [{ item: 'Shock absorber (rear)', qty: 4, rate: 1750, gst_rate: 18 }] }] });
  assert.equal(guessJsonKind(dummy, 'sales-invoices.json'), 'invoices');
  for (const kind of IMPORT_KINDS) {
    assert.equal(guessJsonKind(JSON.stringify(templateJson(kind))), kind, `${kind}'s own JSON template`);
  }
  assert.equal(guessJsonKind(JSON.stringify({ format: 'rekonza-export', module: 'items', rows: templateJson('items') })), 'items');
  assert.equal(guessJsonKind('{ not json'), null);
  assert.equal(guessJsonKind(JSON.stringify({ hello: 'world' })), null);
});
