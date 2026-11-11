// ─────────────────────────────────────────────────────────────────────────────
// Tally's own data files, told apart from the files Tally exports.
//
// A Tally company lives in a numbered folder (C:\Users\Public\TallyPrime\data\
// 100000) of files like Company.900, TranMgr.900 and TSTATE.TSF. People reach
// for that folder first, because it is "the Tally data". But it is Tally's
// private database, not an export: only TallyPrime opens it. Decoding it here
// would mean reverse-engineering Tally's format, which its licence forbids,
// and a wrong guess would put wrong figures in somebody's books.
//
// So such files are recognised — loose, or inside a zip of the folder — and
// the import screen says what to do with them instead of refusing in silence.
// A zip of Tally's XML exports, on the other hand, is simply opened.
//
// Zips are read in slices (the directory at the end, then only the XML files
// wanted), so a zipped data folder of a few hundred megabytes is never loaded
// whole into the browser. Shared by the browser and the tests; no server code.
// ─────────────────────────────────────────────────────────────────────────────

/** Company.900, TranMgr.1800, TSTATE.TSF, and a Tally backup's TBK900.001. */
export function isTallyDataFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return /\.(900|1800|tsf)$/i.test(base) || /^tbk\d+\.\d{3}$/i.test(base);
}

/** Tally's export formats that come in as text: XML (and the odd .txt of XML). */
export const isTallyExportFile = (name: string) => /\.(xml|txt)$/i.test(name);

export const isZip = (name: string) => /\.zip$/i.test(name);

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated; anything else is not opened. */
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** The files in a zip, from its central directory. No ZIP64: nobody zips 4 GB of Tally. */
export async function zipEntries(zip: Blob): Promise<ZipEntry[]> {
  // The end-of-central-directory record: the last 22 bytes, plus any comment.
  const tailStart = Math.max(0, zip.size - 65_557);
  const tail = await bytes(zip.slice(tailStart));
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip file, or it is damaged.');
  const count = u16(tail, end + 10);
  const cdSize = u32(tail, end + 12);
  const cdOffset = u32(tail, end + 16);
  const cd = await bytes(zip.slice(cdOffset, cdOffset + cdSize));
  const names = new TextDecoder('utf-8');
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const nameLen = u16(cd, p + 28);
    out.push({
      name: names.decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: u16(cd, p + 10),
      compressedSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      offset: u32(cd, p + 42),
    });
    p += 46 + nameLen + u16(cd, p + 30) + u16(cd, p + 32);
  }
  return out.filter((e) => !e.name.endsWith('/'));
}

/** One file out of a zip, as bytes. */
export async function unzipEntry(zip: Blob, e: ZipEntry): Promise<Uint8Array> {
  const head = await bytes(zip.slice(e.offset, e.offset + 30));
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new Error(`${e.name} could not be found inside the zip.`);
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
  const data = zip.slice(start, start + e.compressedSize);
  if (e.method === 0) return bytes(data);
  if (e.method !== 8) throw new Error(`${e.name} is packed in a way this cannot open. Zip it again with the usual settings.`);
  return bytes(await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob());
}

/** Which of the chosen names are Tally exports to read, Tally data files to explain, zips to open, or none of these. */
export function sortTallyPicks(names: string[]): { exports: string[]; dataFiles: string[]; zips: string[]; other: string[] } {
  const out = { exports: [] as string[], dataFiles: [] as string[], zips: [] as string[], other: [] as string[] };
  for (const n of names) {
    (isTallyDataFile(n) ? out.dataFiles : isZip(n) ? out.zips : isTallyExportFile(n) ? out.exports : out.other).push(n);
  }
  return out;
}
