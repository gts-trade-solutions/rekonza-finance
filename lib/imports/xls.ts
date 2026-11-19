// ─────────────────────────────────────────────────────────────────────────────
// An old Excel file (.xls, Excel 97–2003) read without a library, for the
// imports: Zoho's sample files, bank statements and Tally exports still come
// as .xls. The file is a compound document holding a "Workbook" stream of BIFF8
// records; only what a grid of values needs is read — the shared strings, the
// cells (text, numbers, formulas' results, booleans) and which formats are
// dates. Many ".xls" downloads (banks especially) are really an HTML table or
// tab-separated text with the wrong name: those are read as what they are.
//
// Plain functions over bytes, no browser API except DOMParser for the HTML
// case: shared by the import screens and the tests.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

export type XlsCell = string | number | boolean | Date | null;

export const isCompoundFile = (b: Uint8Array) => SIGNATURE.every((v, i) => b[i] === v);

/** The compound document's streams, by name. */
function streams(b: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sectorSize = 1 << v.getUint16(0x1e, true);
  const miniSize = 1 << v.getUint16(0x20, true);
  const dirStart = v.getUint32(0x30, true);
  const cutoff = v.getUint32(0x38, true);
  const miniFatStart = v.getUint32(0x3c, true);
  const difatStart = v.getUint32(0x44, true);
  const sector = (i: number) => b.subarray((i + 1) * sectorSize, (i + 2) * sectorSize);

  // The FAT's own sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = v.getUint32(0x4c + i * 4, true);
    if (s !== FREE && s !== END_OF_CHAIN) fatSectors.push(s);
  }
  for (let d = difatStart, guard = 0; d !== END_OF_CHAIN && d !== FREE && guard < 10_000; guard++) {
    const sv = new DataView(b.buffer, b.byteOffset + (d + 1) * sectorSize, sectorSize);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = sv.getUint32(i * 4, true);
      if (s !== FREE && s !== END_OF_CHAIN) fatSectors.push(s);
    }
    d = sv.getUint32(sectorSize - 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const sv = new DataView(b.buffer, b.byteOffset + (s + 1) * sectorSize, sectorSize);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sv.getUint32(i * 4, true));
  }
  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start; s !== END_OF_CHAIN && s !== FREE && s < table.length && out.length <= table.length; s = table[s]) out.push(s);
    return out;
  };
  const join = (parts: Uint8Array[], size: number) => {
    const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.subarray(0, size);
  };

  const dir = join(chain(dirStart, fat).map(sector), Number.MAX_SAFE_INTEGER);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const dv = new DataView(dir.buffer, dir.byteOffset + o, 128);
    const len = dv.getUint16(0x40, true);
    let name = '';
    for (let i = 0; i < Math.max(0, len - 2); i += 2) name += String.fromCharCode(dv.getUint16(i, true));
    entries.push({ name, type: dv.getUint8(0x42), start: dv.getUint32(0x74, true), size: dv.getUint32(0x78, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? join(chain(root.start, fat).map(sector), root.size) : new Uint8Array();
  const miniFat: number[] = [];
  for (const s of chain(miniFatStart, fat)) {
    const sv = new DataView(b.buffer, b.byteOffset + (s + 1) * sectorSize, sectorSize);
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(sv.getUint32(i * 4, true));
  }
  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.type !== 2) continue;
    const data = e.size < cutoff
      ? join(chain(e.start, miniFat).map((m) => miniStream.subarray(m * miniSize, (m + 1) * miniSize)), e.size)
      : join(chain(e.start, fat).map(sector), e.size);
    out.set(e.name, data);
  }
  return out;
}

/** Excel's built-in number formats that show a date or a time. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateFormat = (code: string) => {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase();
  return /[dmy]/.test(bare) && !/^general$/.test(bare) && !/[#0]/.test(bare.replace(/[dmyhs]/g, ''));
};

/** A string record that may run on into CONTINUE records, each starting with a fresh flags byte mid-string. */
class Reader {
  seg = 0;
  at = 0;
  constructor(private readonly parts: Uint8Array[]) {}
  private ensure() { while (this.seg < this.parts.length && this.at >= this.parts[this.seg].length) { this.seg++; this.at = 0; } }
  get done() { this.ensure(); return this.seg >= this.parts.length; }
  u8() { this.ensure(); return this.parts[this.seg]?.[this.at++] ?? 0; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) { for (let i = 0; i < n; i++) this.u8(); }
  /** The characters of a string; across a CONTINUE boundary the width is read again. */
  chars(count: number, high: boolean) {
    let s = '';
    let wide = high;
    for (let i = 0; i < count; i++) {
      if (this.seg < this.parts.length && this.at >= this.parts[this.seg].length) {
        this.seg++; this.at = 0;
        if (this.seg < this.parts.length) wide = (this.u8() & 1) === 1;
      }
      s += String.fromCharCode(wide ? this.u16() : this.u8());
    }
    return s;
  }
  /** XLUnicodeRichExtendedString, as the SST holds them. */
  richString() {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const s = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4 + ext);
    return s;
  }
}

/** XLUnicodeString inside one record. */
function unicodeString(d: Uint8Array, at: number, lenBytes: 1 | 2 = 2) {
  const cch = lenBytes === 2 ? d[at] | (d[at + 1] << 8) : d[at];
  const flags = d[at + lenBytes];
  const wide = (flags & 1) === 1;
  let s = '';
  let p = at + lenBytes + 1;
  for (let i = 0; i < cch; i++) {
    s += String.fromCharCode(wide ? d[p] | (d[p + 1] << 8) : d[p]);
    p += wide ? 2 : 1;
  }
  return s;
}

function rk(v: number): number {
  let n: number;
  if (v & 0x02) n = v >> 2; // a 30-bit signed integer
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    buf.setUint32(0, 0, true);
    n = buf.getFloat64(0, true);
  }
  return v & 0x01 ? n / 100 : n;
}

/** Every worksheet in a BIFF8 workbook stream, as rows of cells. */
function readBiff(w: Uint8Array): { name: string; rows: XlsCell[][] }[] {
  const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const recs: { id: number; data: Uint8Array; pos: number }[] = [];
  for (let p = 0; p + 4 <= w.length;) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    recs.push({ id, data: w.subarray(p + 4, p + 4 + len), pos: p });
    p += 4 + len;
  }
  const sst: string[] = [];
  const xfFormat: number[] = [];
  const formats = new Map<number, string>();
  const sheets: { name: string; pos: number }[] = [];
  let date1904 = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.id === 0x0085) {
      const pos = r.data[0] | (r.data[1] << 8) | (r.data[2] << 16) | (r.data[3] << 24);
      if (r.data[5] === 0) sheets.push({ name: unicodeString(r.data, 6, 1), pos: pos >>> 0 });
    } else if (r.id === 0x00e0) xfFormat.push(r.data[2] | (r.data[3] << 8));
    else if (r.id === 0x041e) formats.set(r.data[0] | (r.data[1] << 8), unicodeString(r.data, 2));
    else if (r.id === 0x0022) date1904 = (r.data[0] | (r.data[1] << 8)) === 1;
    else if (r.id === 0x00fc) {
      const parts = [r.data.subarray(8)];
      for (let j = i + 1; j < recs.length && recs[j].id === 0x003c; j++) parts.push(recs[j].data);
      const unique = (r.data[4] | (r.data[5] << 8) | (r.data[6] << 16) | (r.data[7] << 24)) >>> 0;
      const rd = new Reader(parts);
      for (let k = 0; k < unique && !rd.done; k++) sst.push(rd.richString());
    }
  }
  const dated = (xf: number) => {
    const f = xfFormat[xf];
    return f !== undefined && (DATE_FORMATS.has(f) || (formats.has(f) && isDateFormat(formats.get(f)!)));
  };
  const asDate = (serial: number) => new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86_400_000));
  const num = (n: number, xf: number): XlsCell => (dated(xf) && n > 0 ? asDate(n) : n);

  return sheets.map((s) => {
    const rows: XlsCell[][] = [];
    const set = (row: number, col: number, value: XlsCell) => { (rows[row] ??= [])[col] = value; };
    let start = recs.findIndex((r) => r.pos === s.pos);
    if (start < 0) start = 0;
    let pendingFormula: [number, number] | null = null;
    for (let i = start + 1; i < recs.length && recs[i].id !== 0x000a; i++) {
      const { id, data: d } = recs[i];
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const u16 = (o: number) => v.getUint16(o, true);
      if (id === 0x00fd) set(u16(0), u16(2), sst[v.getUint32(6, true)] ?? '');
      else if (id === 0x0204 || id === 0x00d6) set(u16(0), u16(2), unicodeString(d, 6));
      else if (id === 0x0203) set(u16(0), u16(2), num(v.getFloat64(6, true), u16(4)));
      else if (id === 0x027e) set(u16(0), u16(2), num(rk(v.getUint32(6, true)), u16(4)));
      else if (id === 0x00bd) {
        const row = u16(0);
        const first = u16(2);
        const count = (d.length - 6) / 6;
        for (let k = 0; k < count; k++) set(row, first + k, num(rk(v.getUint32(6 + k * 6, true)), u16(4 + k * 6)));
      } else if (id === 0x0205) set(u16(0), u16(2), d[7] ? null : d[6] === 1);
      else if (id === 0x0006) {
        const row = u16(0), col = u16(2), xf = u16(4);
        if (u16(12) === 0xffff) {
          const t = d[6];
          if (t === 0) pendingFormula = [row, col];
          else if (t === 1) set(row, col, d[8] === 1);
          else set(row, col, null);
        } else set(row, col, num(v.getFloat64(6, true), xf));
      } else if (id === 0x0207 && pendingFormula) {
        set(pendingFormula[0], pendingFormula[1], unicodeString(d, 0));
        pendingFormula = null;
      }
    }
    // Rows with nothing in them are holes in the array: counted by hand, not spread.
    let width = 0;
    for (let i = 0; i < rows.length; i++) width = Math.max(width, rows[i]?.length ?? 0);
    return { name: s.name, rows: Array.from({ length: rows.length }, (_, i) => Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? null)) };
  });
}

/** An HTML table saved as .xls (bank downloads): its rows of cell text. */
function htmlGrid(text: string): string[][] {
  if (typeof DOMParser === 'undefined') {
    // Outside a browser (the tests): rows and cells by their tags.
    return [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()));
  }
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const table = [...doc.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!table) return [];
  return [...table.rows].map((r) => [...r.cells].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()));
}

/**
 * The first sheet with anything on it, as rows of cells. A file that is not a
 * compound document comes back as `text`, for the delimited-text reader.
 */
export function readXls(bytes: Uint8Array): { grid: XlsCell[][] } | { text: string } {
  if (!isCompoundFile(bytes)) {
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    if (/^\s*<(!doctype|html|table|\?xml|meta|head|body|style)/i.test(text) || /<table[\s>]/i.test(text.slice(0, 4000))) {
      return { grid: htmlGrid(text) };
    }
    return { text };
  }
  const s = streams(bytes);
  const wb = s.get('Workbook') ?? s.get('Book');
  if (!wb) throw new Error('This .xls file has no workbook inside. Open it in Excel and save it as .xlsx or CSV.');
  const sheets = readBiff(wb);
  const first = sheets.find((sh) => sh.rows.some((r) => r.some((c) => c !== null && c !== '')));
  return { grid: first?.rows ?? [] };
}
