// Zoho's export formats (lib/xlsx.ts): CSV, XLS (Excel's XML Spreadsheet) and
// a password-protected zip (ZipCrypto, what Windows and 7-Zip open by asking
// for the password); and the delimited reader the contact persons import uses
// (lib/delimited.ts).
//
//   npx tsx --test scripts/tests/export-formats.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { csvText, exportZip, xlsXml } from '../../lib/xlsx';
import { parseDelimitedText } from '../../lib/delimited';
import { passwordProblem } from '../../components/shared/export-dialog';

const enc = new TextEncoder();

/** The reader's side of ZipCrypto: decrypts a stored entry with the password, as unzip does. */
function unzipStored(zip: Uint8Array, password: string): { name: string; bytes: Uint8Array; checkOk: boolean }[] {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const out: { name: string; bytes: Uint8Array; checkOk: boolean }[] = [];
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const flags = v.getUint16(at + 6, true);
    const crc = v.getUint32(at + 14, true);
    const size = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    let bytes = data;
    let checkOk = true;
    if (flags & 1) {
      let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
      const step = (c: number, b: number) => (crcTable[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
      const update = (b: number) => { k0 = step(k0, b); k1 = (k1 + (k0 & 0xff)) >>> 0; k1 = (Math.imul(k1, 134775813) + 1) >>> 0; k2 = step(k2, k1 >>> 24); };
      for (const b of enc.encode(password)) update(b);
      const plain = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) { const x = (k2 | 2) & 0xffff; const p = data[i] ^ ((Math.imul(x, x ^ 1) >>> 8) & 0xff); plain[i] = p; update(p); }
      checkOk = plain[11] === ((crc >>> 24) & 0xff);
      bytes = plain.subarray(12);
    }
    out.push({ name, bytes, checkOk });
    at += 30 + nameLen + size;
  }
  return out;
}

test('CSV: quoted where it must be, a byte-order mark first so Excel reads ₹', () => {
  const csv = csvText([['Name', 'Note', 'Amount'], ['Apex, Motors', 'Say "hi"', 1620.48], ['Line\nbreak', null, 0]]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.slice(1), 'Name,Note,Amount\r\n"Apex, Motors","Say ""hi""",1620.48\r\n"Line\nbreak",,0');
});

test('XLS: Excel XML Spreadsheet, numbers as numbers, text escaped, control characters dropped', () => {
  const xml = xlsXml([{ name: 'Customers', rows: [['Name', 'Due'], ['A & B <Ltd>', 1500], ['bad\u0007char', null]] }]);
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.ok(xml.includes('<Worksheet ss:Name="Customers">'));
  assert.ok(xml.includes('<Data ss:Type="Number">1500</Data>'));
  assert.ok(xml.includes('A &amp; B &lt;Ltd&gt;'));
  assert.ok(xml.includes('badchar') && !xml.includes('\u0007'));
});

test('A password puts the files in a zip that opens with that password and fails its check with another', () => {
  const files: [string, Uint8Array][] = [['customers.csv', enc.encode('Name\r\nApex')], ['items.xls', enc.encode('<x/>')]];
  const plain = unzipStored(exportZip(files), '');
  assert.deepEqual(plain.map((f) => new TextDecoder().decode(f.bytes)), ['Name\r\nApex', '<x/>'], 'without a password the files are stored as they are');
  const locked = exportZip(files, 'Secret#2026ok');
  const right = unzipStored(locked, 'Secret#2026ok');
  assert.ok(right.every((f) => f.checkOk));
  assert.deepEqual(right.map((f) => new TextDecoder().decode(f.bytes)), ['Name\r\nApex', '<x/>']);
  const wrong = unzipStored(locked, 'not-it');
  assert.ok(wrong.some((f) => !f.checkOk) || wrong.some((f, i) => new TextDecoder().decode(f.bytes) !== new TextDecoder().decode(right[i].bytes)), 'another password does not give the files back');
});

test("Zoho's password rule: twelve or more, with upper, lower, a digit and a sign; none at all is fine", () => {
  assert.equal(passwordProblem(''), null);
  assert.equal(passwordProblem('Secret#2026ok'), null);
  assert.ok(passwordProblem('short#A1'));
  assert.ok(passwordProblem('alllowercase#2026'));
  assert.ok(passwordProblem('NoDigitsHere#Ok'));
  assert.ok(passwordProblem('NoSigns2026Okay'));
});

test('Delimited text: quotes, doubled quotes, line breaks inside quotes, and tabs read right', () => {
  assert.deepEqual(parseDelimitedText('Display Name,First Name\r\n"Apex, Motors",Divya\r\n"Say ""hi""","Two\nlines"\r\n\r\n'),
    [['Display Name', 'First Name'], ['Apex, Motors', 'Divya'], ['Say "hi"', 'Two\nlines']]);
  assert.deepEqual(parseDelimitedText('A\tB\n1\t2\n'), [['A', 'B'], ['1', '2']]);
});
