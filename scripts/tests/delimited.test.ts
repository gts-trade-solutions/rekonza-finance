// CSV and its cousins — tab, pipe, semicolon — read and written the same way.
//
//   npx tsx --test scripts/tests/delimited.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { delimiterName, guessDelimiter, readTextFile, toDelimited } from '../../lib/delimited';

const rows = [
  ['Name', 'GSTIN', 'Notes', 'Amount'],
  ['Sharma Traders', '33AABCS1234F1Z5', 'Pays by "NEFT", monthly', '1,180.00'],
  ['Lakshmi | Co', '', 'line one\nline two', '42'],
];

test('each separator writes a file that reads back to the same rows', () => {
  for (const d of [',', '\t', '|', ';', '~']) {
    const text = toDelimited(rows, d);
    const back = Papa.parse<string[]>(text, { delimiter: d, skipEmptyLines: 'greedy' }).data;
    assert.deepEqual(back, rows, `separator ${JSON.stringify(d)}`);
  }
});

test('a field with the separator, a quote or a line break is quoted; others are not', () => {
  const pipe = toDelimited([['a|b', 'plain', 'say "hi"']], '|');
  assert.equal(pipe, '"a|b"|plain|"say ""hi"""');
  assert.equal(toDelimited([['1,180.00', 'x']], '\t'), '1,180.00\tx', 'a comma needs no quotes in tab-separated text');
});

test('the separator is found from the file itself', () => {
  assert.equal(guessDelimiter('name,city\nA,Chennai\nB,Madurai'), ',');
  assert.equal(guessDelimiter('name\tcity\tpin\nA\tChennai\t600001\n'), '\t');
  assert.equal(guessDelimiter('name|city\nA|Chennai\nB|"Kochi, Kerala"'), '|');
  assert.equal(guessDelimiter('name;amount\nA;1,50\nB;2,75'), ';', 'semicolons, with commas as decimal points');
  assert.equal(delimiterName('\t'), 'Tab');
});

test("Excel's Unicode text (UTF-16) and a UTF-8 file with a BOM read as plain text", async () => {
  const text = 'name\tcity\nŚrī Ganesh\tChennai';
  const le = new Uint8Array(2 + text.length * 2);
  le[0] = 0xff; le[1] = 0xfe;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8; }
  assert.equal(await readTextFile(new Blob([le])), text);
  assert.equal(await readTextFile(new Blob(['﻿name,city'])), 'name,city');
});
