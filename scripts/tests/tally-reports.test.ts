// Tally's files beyond its masters XML: its JSON export, and its reports —
// the Trial Balance, the Stock Summary and the bills outstanding — in Excel,
// XML, HTML, ASCII and SDF. The fixtures are real files exported by TallyPrime
// (scripts/tests/fixtures/tally), from one company: 17 ledgers in Tally's
// groups and two of its own, three stock items, a sale and a purchase.
//
//   npx tsx --test scripts/tests/tally-reports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isTallyJson, tallyJsonToXml } from '../../lib/tally/json';
import { readStyledXlsx, unitOfFormat } from '../../lib/tally/xlsx';
import {
  buildTree, combineTallyReports, figure, readTallyReportGrid, readTallyReportJson, readTallyReportText, tallyDay, tallyMastersXml, tallyReportPicture,
  type ReportLine, type TallyReport,
} from '../../lib/tally/reports';
import { parseTallyFiles, summariseTallyFile } from '../../lib/tally/xml';

const dir = path.join(__dirname, 'fixtures', 'tally');
const bytes = (f: string) => fs.readFileSync(path.join(dir, f));
/** As the browser reads it: UTF-16 when Tally wrote UTF-16, else UTF-8. */
const text = (f: string) => {
  const b = bytes(f);
  return (b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')).replace(/^﻿/, '');
};
const read = (f: string) => {
  const r = readTallyReportText(text(f), f);
  assert.ok(r, `${f} is read as a Tally report`);
  return r;
};
const balances = (r: TallyReport | { masters: TallyReport['masters'] }) =>
  Object.fromEntries(r.masters.ledgers.map((l) => [l.name, l.balancePaise]));

// What the company's books hold, debit positive in paise: the Trial Balance with every level shown.
const LEDGERS: Record<string, number> = {
  'Capital - Partners': -50000000, 'Input CGST': 144000, 'Input SGST': 144000, 'Output CGST': -85500, 'Output SGST': -85500,
  'Salary Payable': -12600000, Furniture: 18200000, 'Sales A/c (Tally)': -1670000, 'Petty Cash': 3243000, 'HDFC Bank Current': 15112000,
  'Sales - Spares': -950000, 'Purchase - Spares': 1600000, Electricity: 728000, Rent: 5000000, 'Office Supplies': 420000,
  'Rounding Off': 1250000, Salaries: 8400000,
};
const PARENTS: Record<string, string> = {
  'Input CGST': 'Duties & Taxes', 'Petty Cash': 'Cash-in-Hand', 'HDFC Bank Current': 'Bank Accounts', Electricity: 'Office Expenses',
  Rent: 'Office Expenses', Salaries: 'Indirect Expenses', 'Salary Payable': 'Current Liabilities',
};

test('the Trial Balance with every level shown reads the same from ASCII, XML, SDF and HTML', () => {
  for (const f of ['tb-all.csv', 'tb-all.xml', 'tb-all.txt', 'tb-all.html']) {
    const r = read(f);
    assert.equal(r.kind, 'trial-balance', f);
    assert.equal(r.problem, null, `${f}: ${r.problem}`);
    assert.deepEqual(balances(r), LEDGERS, f);
    const parent = Object.fromEntries(r.masters.ledgers.map((l) => [l.name, l.parent]));
    for (const [l, p] of Object.entries(PARENTS)) assert.equal(parent[l], p, `${f}: ${l} under ${p}`);
    // Groups of the company's own come with their place: Office Expenses under Indirect Expenses.
    assert.equal(r.masters.groups.get('Office Expenses'), 'Indirect Expenses', f);
    assert.equal(r.masters.groups.get('Duties & Taxes'), 'Current Liabilities', f);
    // Opening stock is the year's start: kept apart, for closing the year.
    assert.equal(r.openingStockPaise, 7445000, f);
  }
  assert.equal(read('tb-all.html').asAt, '2027-03-31');
});

test('reports saved as JSON: the Trial Balance nested by group, the Stock Summary, the Balance Sheet named', () => {
  // The Trial Balance as Tally wrote it: Sundry Debtors shows a total with no ledger under it (a ledger Tally
  // would not list in this test company), so it cannot come in as it is.
  const raw = text('tb-all.json');
  const asIs = readTallyReportJson(raw);
  assert.ok(asIs);
  assert.equal(asIs.kind, 'trial-balance');
  assert.equal(asIs.format, 'JSON');
  assert.match(asIs.problem ?? '', /only the total of Sundry Debtors/);

  // Without that line (and its ₹59,000 out of Current Assets), every ledger comes in under its group.
  const doc = JSON.parse(raw);
  const assets = doc.dspaccbody.dspaccline.find((l: { dspaccname: { dspdispname: string } }) => l.dspaccname.dspdispname === 'Current Assets');
  assets.grpexplosion.dspaccline = assets.grpexplosion.dspaccline.filter((l: { dspaccname: { dspdispname: string } }) => l.dspaccname.dspdispname !== 'Sundry Debtors');
  assets.dspaccinfo[0].dspcldramt.dspcldramta = -258000;
  const r = readTallyReportJson(JSON.stringify(doc));
  assert.ok(r);
  assert.equal(r.problem, null, r.problem ?? '');
  assert.deepEqual(balances(r), LEDGERS);
  const parent = Object.fromEntries(r.masters.ledgers.map((l) => [l.name, l.parent]));
  for (const [l, p] of Object.entries(PARENTS)) assert.equal(parent[l], p, `${l} under ${p}`);
  assert.equal(r.masters.groups.get('Office Expenses'), 'Indirect Expenses');
  assert.equal(r.openingStockPaise, 7445000);

  // Condensed: the groups alone, nothing under them.
  for (const l of doc.dspaccbody.dspaccline) delete l.grpexplosion;
  assert.match(readTallyReportJson(JSON.stringify(doc))?.problem ?? '', /groups only/);

  const stock = readTallyReportJson(text('stock.json'));
  assert.ok(stock);
  assert.deepEqual(stock.masters.stockItems.map((s) => `${s.name}|${s.qty}|${s.unit}|${s.valuePaise}`),
    ['Brake Pad Set|35|Nos|2975000', 'Engine Oil 5W30|55|Nos|2310000', 'Wheel Bearing|50|Nos|3125000']);
  assert.equal(stock.closingStockPaise, 8410000);

  assert.equal(readTallyReportJson(text('balance-sheet.json'))?.kind, 'balance-sheet');
  // A Day Book saved as JSON is its vouchers, read as masters and vouchers are.
  assert.equal(readTallyReportJson(text('daybook.json')), null);
  assert.ok(isTallyJson(text('daybook.json')));
  assert.equal(parseTallyFiles([tallyJsonToXml(text('daybook.json'))]).vouchers.length > 0, true);
  assert.equal(readTallyReportJson('{"invoices":[]}'), null);
  assert.equal(tallyReportPicture('BSheet.pdf')?.kind, 'balance-sheet');
});

test('a Trial Balance that shows only groups, or one level of them, is refused with how to export it', () => {
  const condensed = read('tb-condensed.csv');
  assert.match(condensed.problem ?? '', /groups only/);
  assert.match(condensed.problem ?? '', /Expand all levels/);
  assert.equal(condensed.masters.ledgers.length, 0);
  const oneLevel = read('tb-one-level.csv');
  assert.match(oneLevel.problem ?? '', /only the total of Duties & Taxes, Cash-in-Hand, Bank Accounts/);
  assert.equal(oneLevel.masters.ledgers.length, 0, 'nothing comes in from it');
});

test('Tally’s Excel Trial Balance: groups bold, ledgers italic and indented', async () => {
  const grid = await readStyledXlsx(new Blob([bytes('TrialBal.xlsx')]));
  assert.equal(grid[0][0].v, 'Race Test Co');
  assert.equal(grid[7][0].bold, true, 'Fixed Assets is bold');
  assert.equal(grid[8][0].italic, true, 'its ledger is italic');
  assert.equal(grid[8][0].indent, 3);
  const r = readTallyReportGrid(grid, 'Excel');
  assert.ok(r);
  assert.equal(r.kind, 'trial-balance');
  assert.equal(r.problem, null);
  assert.equal(r.company, 'Race Test Co');
  assert.equal(r.asAt, '2026-09-01');
  assert.deepEqual(balances(r), { 'Sales A/c (Tally)': -1670000, 'Office Supplies': 420000, 'Rounding Off': 1250000 });
  assert.equal(r.masters.ledgers.find((l) => l.name === 'Office Supplies')?.parent, 'Indirect Expenses');
});

test('the Stock Summary reads from Excel (the unit in its number format), ASCII, XML, SDF and HTML', async () => {
  const items = (r: TallyReport) => r.masters.stockItems.map((s) => `${s.name}|${s.qty}|${s.unit}|${s.valuePaise}`);
  const want = ['Brake Pad Set|35|Nos|2975000', 'Engine Oil 5W30|55|Nos|2310000', 'Wheel Bearing|50|Nos|3125000'];
  for (const f of ['stock.csv', 'stock.xml', 'stock.txt', 'stock.html']) {
    const r = read(f);
    assert.equal(r.kind, 'stock-summary', f);
    assert.deepEqual(items(r), want, f);
    assert.equal(r.closingStockPaise, 8410000, f);
  }
  const x = readTallyReportGrid(await readStyledXlsx(new Blob([bytes('StkSum.xlsx')])), 'Excel');
  assert.ok(x);
  assert.deepEqual(items(x), want);
  assert.equal(x.asAt, '2026-09-02');
  assert.equal(unitOfFormat('""0" Nos"'), 'Nos');
  assert.equal(unitOfFormat('0.00'), null);
});

test('a Trial Balance with its Stock Summary gives the openings Tally’s own masters export gives', () => {
  // The masters exported from the same company with "Export closing balance as opening balance".
  const fromJson = parseTallyFiles([tallyJsonToXml(text('masters.json'))]);
  const tally = Object.fromEntries(fromJson.masters.ledgers.filter((l) => l.balancePaise).map((l) => [l.name, l.balancePaise]));
  assert.equal(tally['Profit & Loss A/c'], 15483000, 'Tally closes the year into Profit & Loss A/c: a loss');

  const combined = combineTallyReports([read('tb-all.csv'), read('stock.csv')]);
  const ours = Object.fromEntries(combined.masters.ledgers.filter((l) => l.balancePaise).map((l) => [l.name, l.balancePaise]));
  assert.deepEqual(ours, tally, 'every ledger as Tally carries it forward');
  assert.deepEqual(
    combined.masters.stockItems.map((s) => [s.name, s.qty, s.valuePaise]),
    fromJson.masters.stockItems.map((s) => [s.name, s.qty, s.valuePaise]),
  );
  assert.ok(combined.notes.some((n) => /close into Profit & Loss A\/c/.test(n) && /a loss of ₹1,54,830\.00/.test(n)), combined.notes.join(' / '));

  // Written as Tally's XML, it reads back the same.
  const back = parseTallyFiles([tallyMastersXml(combined.masters, combined.company)]);
  assert.deepEqual(Object.fromEntries(back.masters.ledgers.filter((l) => l.balancePaise).map((l) => [l.name, l.balancePaise])), tally);
  assert.equal(back.masters.groups.get('Office Expenses'), 'Indirect Expenses');
  assert.equal(back.masters.ledgers.find((l) => l.name === 'Rent')?.balancePaise, 0, 'an expense ledger comes in, closed');
  assert.deepEqual(back.masters.stockItems.map((s) => [s.name, s.qty, s.unit, s.valuePaise]), [
    ['Brake Pad Set', 35, 'Nos', 2975000], ['Engine Oil 5W30', 55, 'Nos', 2310000], ['Wheel Bearing', 50, 'Nos', 3125000],
  ]);
});

test('without a Stock Summary the closing stock is nil, and it says so', () => {
  const c = combineTallyReports([read('tb-all.csv')]);
  assert.ok(c.notes.some((n) => /No Stock Summary came with the Trial Balance/.test(n)));
  assert.equal(c.masters.ledgers.find((l) => l.name === 'Profit & Loss A/c')?.balancePaise, 15483000 + 8410000);
});

test('Tally’s JSON export, in both its styles, reads as its XML does', () => {
  for (const f of ['masters.json', 'vouchers.json', 'vouchers-plain.json']) assert.ok(isTallyJson(text(f)), f);
  assert.equal(isTallyJson('{"invoices":[{"number":"1"}]}'), false);
  assert.equal(isTallyJson('not json'), false);
  const file = parseTallyFiles(['masters.json', 'vouchers.json', 'vouchers-plain.json'].map((f) => tallyJsonToXml(text(f))));
  const s = summariseTallyFile(file);
  assert.equal(s.ledgers, 20);
  assert.equal(s.stockItems, 3);
  assert.equal(s.groups, 30);
  assert.equal(s.vouchers, 6, 'the plain export’s vouchers are the same ones, not new');
  assert.equal(s.posting, 6);
  const hdfc = file.masters.ledgers.find((l) => l.name === 'HDFC Bank Current');
  assert.equal(hdfc?.parent, 'Bank Accounts');
  assert.equal(hdfc?.balancePaise, 15112000);
  const contra = file.vouchers.find((v) => v.baseType === 'Contra');
  assert.ok(contra);
  assert.deepEqual(contra.lines, [
    { ledger: 'Petty Cash', debitPaise: 1000000, creditPaise: 0 }, { ledger: 'HDFC Bank Current', debitPaise: 0, creditPaise: 1000000 },
  ]);
  assert.throws(() => tallyJsonToXml('{"rows":[]}'), /not one Tally exported/);
});

test('reports that cannot be posted from are named, with what to export instead', () => {
  const day = read('daybook.csv');
  assert.equal(day.kind, 'day-book');
  assert.match(day.problem ?? '', /one line for each voucher/);
  assert.match(day.problem ?? '', /Alt\+E → Transactions/);
  assert.equal(read('balance-sheet.csv').kind, 'balance-sheet');
  assert.match(read('balance-sheet.csv').problem ?? '', /Trial Balance instead/);
  assert.equal(read('list-of-accounts.csv').kind, 'list-of-accounts');
  const pdf = tallyReportPicture('TrialBal.pdf');
  assert.equal(pdf?.kind, 'trial-balance');
  assert.match(pdf?.problem ?? '', /PDF of Tally's Trial Balance/);
  assert.equal(tallyReportPicture('invoice-0042.pdf'), null, 'an invoice PDF is not taken for a Tally report');
  assert.equal(readTallyReportText('Name,Email\nA,a@x.com\n', 'customers.csv'), null, 'a customer list is not Tally’s');
});

test('bills outstanding: Tally’s headings over two lines, each party’s bills under Sundry Debtors', () => {
  // The headings as Tally writes them (from its HTML export of Bills Receivable), with two bills of one party and one of another.
  const g = (rows: (string | number | null)[][]) => rows.map((r) => r.map((v) => ({ v })));
  const grid = g([
    ['Race Test Co'], ['Bills Receivable'], ['1-Apr-26 to 31-Mar-27'],
    ['Date', 'Ref. No.', "Party's Name", 'Pending', 'Due on', 'Overdue'],
    [null, null, null, 'Amount', null, 'by days'],
    ['15-Feb-26', 'INV/25-26/0141', 'Kaveri Motors', '35,400.00 Dr', '17-Mar-26', 199],
    ['10-Mar-26', 'INV/25-26/0158', 'Kaveri Motors', '23,600.00 Dr', '9-Apr-26', 176],
    ['25-Mar-26', 'INV/25-26/0162', 'Sri Murugan Traders', 11800, '9-Apr-26', 176],
    ['Grand Total', null, null, '70,800.00 Dr', null, null],
  ]);
  const r = readTallyReportGrid(grid, 'Excel');
  assert.ok(r);
  assert.equal(r.kind, 'bills-receivable');
  assert.equal(r.problem, null);
  assert.equal(r.bills, 3);
  const kaveri = r.masters.ledgers.find((l) => l.name === 'Kaveri Motors');
  assert.equal(kaveri?.parent, 'Sundry Debtors');
  assert.equal(kaveri?.balancePaise, 5900000);
  assert.deepEqual(kaveri?.bills, [
    { ref: 'INV/25-26/0141', date: '2026-02-15', amountPaise: 3540000, creditDays: 30 },
    { ref: 'INV/25-26/0158', date: '2026-03-10', amountPaise: 2360000, creditDays: 30 },
  ]);
  // Together with a Trial Balance that has the party: its bills are attached to it.
  const tb = readTallyReportGrid(g([
    ['Trial Balance'], ['Particulars', null, null], [null, 'Debit', 'Credit'],
    ['Current Assets', 59000, null], ['Sundry Debtors', 59000, null], ['Kaveri Motors', 59000, null],
    ['Capital Account', null, 59000], ['Capital', null, 59000],
  ]), 'Excel');
  assert.ok(tb && !tb.problem, tb?.problem ?? '');
  const both = combineTallyReports([tb, r]);
  assert.equal(both.masters.ledgers.find((l) => l.name === 'Kaveri Motors')?.bills.length, 2);
  assert.equal(both.masters.ledgers.find((l) => l.name === 'Sri Murugan Traders')?.parent, 'Sundry Debtors');
  // The empty report Tally exports when nothing is owed says so.
  assert.match(read('bills-receivable-empty.html').problem ?? '', /No unpaid bills|headings|columns/);
});

test('groups told from ledgers by their totals, even when a ledger equals the sum of those after it', () => {
  const L = (name: string, dr: number, cr = 0): ReportLine => ({ name, dr, cr });
  // Indirect Expenses 200: Office Expenses (group, 100: Rent 60, Power 40), then Salaries 100 — equal to the group.
  const tree = buildTree([
    L('Indirect Expenses', 200), L('Office Expenses', 100), L('Rent', 60), L('Power', 40), L('Salaries', 100),
    L('Capital Account', 0, 200), L('Capital', 0, 200),
  ]);
  assert.ok(tree);
  const shape = (nodes: NonNullable<typeof tree>): unknown => nodes.map((n) => (n.children.length ? { [n.line.name]: shape(n.children) } : n.line.name));
  assert.deepEqual(shape(tree), [
    { 'Indirect Expenses': [{ 'Office Expenses': ['Rent', 'Power'] }, 'Salaries'] },
    { 'Capital Account': ['Capital'] },
  ]);
});

test('figures and days as Tally writes them', () => {
  assert.equal(figure('5,00,000.00'), 500000);
  assert.equal(figure('1,180.00 Dr'), -1180);
  assert.equal(figure('1,180.00 Cr'), 1180);
  assert.equal(figure('(1,200.00)'), -1200);
  assert.equal(figure('Nos'), null);
  assert.equal(tallyDay('1-Apr-26'), '2026-04-01');
  assert.equal(tallyDay('1-Sep-2026'), '2026-09-01');
  assert.equal(tallyDay('20260331'), '2026-03-31');
  assert.equal(tallyDay('31-03-2026'), '2026-03-31');
});
