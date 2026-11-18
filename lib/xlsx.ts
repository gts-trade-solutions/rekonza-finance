// ─────────────────────────────────────────────────────────────────────────────
// A small .xlsx writer.
//
// An .xlsx file is a zip of a handful of XML parts. Writing one needs nothing
// but a zip container and the parts themselves, so this does both — stored,
// not compressed, which every spreadsheet program reads — and works the same
// in the browser and on the server. Numbers go in as numbers, so the sheet
// can be summed; text goes in as inline strings; the first row is bold.
// ─────────────────────────────────────────────────────────────────────────────

import { allowOutput } from './output-guard';

export type Cell = string | number | null | undefined;

export interface Sheet {
  /** At most 31 characters, and none of : \ / ? * [ ]. */
  name: string;
  rows: Cell[][];
  /** Column widths in characters; left out, they follow the longest value. */
  widths?: number[];
}

const enc = new TextEncoder();

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Control characters other than tab and newlines are not allowed in XML.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A1-style column letters for a zero-based index. */
function col(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: Sheet): string {
  const widths = sheet.widths ?? (() => {
    const w: number[] = [];
    for (const r of sheet.rows) r.forEach((c, i) => { w[i] = Math.min(60, Math.max(w[i] ?? 8, String(c ?? '').length + 2)); });
    return w;
  })();
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rows = sheet.rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      if (c === null || c === undefined || c === '') return '';
      const ref = `${col(ci)}${ri + 1}`;
      const style = ri === 0 ? ' s="1"' : '';
      if (typeof c === 'number' && Number.isFinite(c)) return `<c r="${ref}"${style}><v>${c}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(String(c))}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

function safeName(name: string, used: Set<string>): string {
  let n = name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${n.slice(0, 28)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

/** The workbook's bytes. */
export function workbook(sheets: Sheet[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((s) => safeName(s.name, used));
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '</styleSheet>'],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([name, text]) => [name, enc.encode(text)]));
}

// ── A stored zip ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Zip's traditional password protection (PKWARE "ZipCrypto"): what Windows,
 * macOS and 7-Zip open by asking for the password. Not strong encryption, but
 * the protection Zoho's "File Protection Password" gives an export too.
 */
function zipCrypto(data: Uint8Array, password: string, crc: number): Uint8Array {
  let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  const step = (c: number, b: number) => (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  const update = (b: number) => {
    k0 = step(k0, b);
    k1 = (k1 + (k0 & 0xff)) >>> 0;
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
    k2 = step(k2, k1 >>> 24);
  };
  const stream = () => { const x = (k2 | 2) & 0xffff; return (Math.imul(x, x ^ 1) >>> 8) & 0xff; };
  for (const b of enc.encode(password)) update(b);
  const head = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(head.subarray(0, 11));
  else for (let i = 0; i < 11; i++) head[i] = Math.floor(Math.random() * 256);
  head[11] = (crc >>> 24) & 0xff; // the check byte unzip tests the password against
  const out = new Uint8Array(12 + data.length);
  const put = (i: number, plain: number) => { out[i] = plain ^ stream(); update(plain); };
  for (let i = 0; i < 12; i++) put(i, head[i]);
  for (let i = 0; i < data.length; i++) put(12 + i, data[i]);
  return out;
}

function zip(entries: [string, Uint8Array][], password?: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1 January 2026, 00:00 — the date inside the archive, which nothing reads.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const [name, plain] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(plain);
    // With a password the stored bytes are the encrypted ones, twelve longer; the CRC and size are the plain file's.
    const data = password ? zipCrypto(plain, password, crc) : plain;
    const flags = 0x0800 | (password ? 0x0001 : 0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true); // UTF-8 names, and encrypted when there is a password
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, plain.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, flags, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, plain.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const cdSize = central.reduce((t, p) => t + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/** Text files in one stored zip: the whole book as one CSV per part. */
export function zipText(files: [name: string, text: string][]): Uint8Array {
  return zip(files.map(([name, text]) => [name, enc.encode(text)]));
}

/** In the browser: hand a zip of text files to the user as a download. */
export function downloadZip(filename: string, files: [name: string, text: string][]) {
  if (!allowOutput('export', filename)) return;
  const blob = new Blob([zipText(files) as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** In the browser: hand a zip of files (pictures, say) to the user as a download. */
export function downloadFilesZip(filename: string, files: [name: string, bytes: Uint8Array][]) {
  if (!allowOutput('export', filename)) return;
  const blob = new Blob([zip(files) as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** In the browser: hand the workbook to the user as a download. */
export function downloadWorkbook(filename: string, sheets: Sheet[]) {
  if (!allowOutput('export', filename)) return;
  const blob = new Blob([workbook(sheets) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Zoho's export formats ───────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'xls' | 'xlsx';

/** A sheet as CSV: quoted where it must be, a byte-order mark so Excel reads the rupee sign. */
export function csvText(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/**
 * Sheets as Excel's XML Spreadsheet 2003, saved as .xls: Zoho's "XLS
 * (Microsoft Excel 1997-2004 Compatible)". Excel opens it (and may say the
 * format is not the extension's); LibreOffice and Numbers read it as is.
 */
export function xlsXml(sheets: Sheet[]): string {
  // The file's own esc: entities escaped, and the control characters XML forbids taken out.
  const cell = (v: Cell) => (typeof v === 'number' && Number.isFinite(v)
    ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
    : `<Cell><Data ss:Type="String">${esc(v === null || v === undefined ? '' : String(v))}</Data></Cell>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n`
    + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + sheets.map((s) => `<Worksheet ss:Name="${esc(s.name.slice(0, 31))}"><Table>${s.rows.map((r) => `<Row>${r.map(cell).join('')}</Row>`).join('')}</Table></Worksheet>`).join('')
    + '</Workbook>';
}

/**
 * In the browser: sheets handed over in the format chosen, as Zoho's export
 * dialog does. CSV holds one sheet, so several become one CSV each in a zip.
 * With a password, the file goes inside a password-protected zip.
 */
export function downloadExport(filename: string, sheets: Sheet[], format: ExportFormat, password?: string) {
  if (!allowOutput('export', filename)) return;
  const files: [string, Uint8Array][] = format === 'csv'
    ? sheets.map((s) => [`${sheets.length > 1 ? `${filename}-${s.name}` : filename}.csv`, enc.encode(csvText(s.rows))])
    : [[`${filename}.${format}`, format === 'xlsx' ? workbook(sheets) : enc.encode(xlsXml(sheets))]];
  const zipped = !!password || files.length > 1;
  const bytes = zipped ? zip(files, password || undefined) : files[0][1];
  const name = zipped ? `${filename}.zip` : files[0][0];
  const type = zipped ? 'application/zip' : format === 'csv' ? 'text/csv' : format === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** For tests: the zip bytes as downloadExport builds them. */
export function exportZip(files: [string, Uint8Array][], password?: string): Uint8Array {
  return zip(files, password);
}
