// The .xlsx writer: a workbook it writes is one a real parser reads back.
//
//   npx tsx --test scripts/tests/xlsx.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import readXlsxFile from 'read-excel-file/node';
import { workbook } from '../../lib/xlsx';
import { columnFor, IMPORT_KINDS, TEMPLATES, templateSheets } from '../../lib/imports/templates';

test('round trip through a real parser, numbers as numbers, odd names made safe', async () => {
  const bytes = workbook([
    { name: 'Trial Balance', rows: [['Code', 'Account', 'Debit', 'Credit'], ['1100', 'Accounts Receivable', 12500.5, null], ['2100', 'Payables & "dues" <x>', null, 9000]] },
    { name: 'Profit/Loss: FY 2026-27 [draft]', rows: [['Line', 'Amount'], ['Revenue', 100000], ['यूनिकोड ₹', -2.25]] },
  ]);
  const buf = Buffer.from(bytes);
  // This version of the parser hands back every sheet, named.
  const sheets = (await readXlsxFile(buf)) as unknown as { sheet: string; data: unknown[][] }[];
  assert.deepEqual(sheets.map((x) => x.sheet), ['Trial Balance', 'Profit Loss  FY 2026-27  draft']);
  const tb = sheets[0].data;
  assert.deepEqual(tb[0], ['Code', 'Account', 'Debit', 'Credit']);
  assert.equal(tb[1][2], 12500.5);
  assert.equal(tb[2][1], 'Payables & "dues" <x>');
  assert.equal(tb[2][3], 9000);
  const pl = sheets[1].data;
  assert.equal(pl[2][0], 'यूनिकोड ₹');
  assert.equal(pl[2][1], -2.25);
});

test('every import template opens, and its headings are read back as its columns', async () => {
  for (const kind of IMPORT_KINDS) {
    const sheets = (await readXlsxFile(Buffer.from(workbook(templateSheets(kind))))) as unknown as { sheet: string; data: unknown[][] }[];
    assert.equal(sheets.length, 2, kind);
    const [data, how] = sheets;
    assert.equal(data.data.length, 1, `${kind}: headings only, so the example cannot be imported by mistake`);
    assert.deepEqual(data.data[0].map((h) => columnFor(kind, String(h))), TEMPLATES[kind].columns.map((c) => c.key), kind);
    assert.equal(how.sheet, 'How to fill');
    assert.equal(how.data.length - 1 >= TEMPLATES[kind].columns.length, true, `${kind}: every column explained`);
  }
});
