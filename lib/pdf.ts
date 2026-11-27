// ─────────────────────────────────────────────────────────────────────────────
// A small PDF writer for reports and registers.
//
// Auditors file what they export, and a PDF is the copy that cannot be edited
// by accident and prints the same everywhere. Printing a screen to PDF from
// the browser loses the page numbers and repeats nothing, so this writes the
// file itself: A4 (landscape for wide registers), the company and the report's
// title and filters at the top of the first page, the column headings repeated
// on every page, and "Page n of N" with the time it was made at the foot of
// each. A report printed for an audit file has to say what it covers on its
// face (SA 230, audit documentation), which is why the filters go on it.
//
// It needs nothing but the PDF format: the fourteen standard fonts every PDF
// reader carries (Helvetica and Helvetica-Bold here), text in WinAnsi, and
// uncompressed content streams. Characters WinAnsi has no code for are
// written as their nearest plain form (the rupee sign as "Rs.", an arrow as
// "->"), so no figure is ever lost to a missing glyph. Works in the browser
// and on the server alike.
// ─────────────────────────────────────────────────────────────────────────────

export interface PdfColumn {
  header: string;
  /** Relative width: columns share the page in proportion. */
  width?: number;
  align?: 'left' | 'right';
}

export type PdfRowStyle = 'normal' | 'bold' | 'heading' | 'total' | 'muted' | 'highlight';
export interface PdfRow { cells: (string | number | null | undefined)[]; style?: PdfRowStyle }

export interface PdfTableDoc {
  /** "Audit trail", "Budget vs Actuals". */
  title: string;
  /** The company, at the top of the first page and in every page's running head. */
  org?: string | null;
  /** Under the title: the period, and every filter applied. */
  lines?: string[];
  columns: PdfColumn[];
  rows: (PdfRow | (string | number | null | undefined)[])[];
  landscape?: boolean;
  /** Body text size in points (8 by default). */
  fontSize?: number;
  /** Left of the page number on every page: who made it, and when. */
  footer?: string;
  /** Lines under the table, on the last page. */
  notes?: string[];
}

// Helvetica and Helvetica-Bold advance widths for ASCII 32..126, in 1/1000 em (the fonts' AFM metrics).
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Characters outside Latin-1 that WinAnsi has a code for. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
/** The nearest plain form of what WinAnsi cannot show. */
const PLAIN: Record<string, string> = { '₹': 'Rs.', '→': '->', '←': '<-', '↔': '<->', '≥': '>=', '≤': '<=', '≠': '!=', '✓': 'Yes', '✔': 'Yes', '✗': 'No', '×': 'x', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ' };

/** Text as WinAnsi codes, one per character. */
function codes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const plain = PLAIN[ch];
    if (plain !== undefined) { for (const c of plain) out.push(c.charCodeAt(0)); continue; }
    const cp = ch.codePointAt(0) ?? 63;
    if (cp === 9) out.push(32);
    else if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WIN_ANSI[ch]) out.push(WIN_ANSI[ch]);
    else if (cp >= 32) out.push(63); // '?'
  }
  return out;
}

const widthOf = (c: number[], bold: boolean, size: number) => {
  const t = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const x of c) w += x >= 32 && x <= 126 ? t[x - 32] : 556;
  return (w * size) / 1000;
};

/** A string literal for a content stream: brackets and backslashes escaped, high bytes in octal. */
function literal(c: number[]): string {
  let s = '(';
  for (const x of c) {
    if (x === 40 || x === 41 || x === 92) s += `\\${String.fromCharCode(x)}`;
    else if (x < 32 || x > 126) s += `\\${x.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(x);
  }
  return `${s})`;
}

/** Break a cell's text into lines that fit its width; a word longer than the width is broken by characters. */
function wrap(text: string, width: number, bold: boolean, size: number, maxLines = 40): number[][] {
  const lines: number[][] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line: number[] = [];
    const push = () => { lines.push(line); line = []; };
    for (const word of words) {
      let w = codes(word);
      const candidate = line.length ? [...line, 32, ...w] : w;
      if (widthOf(candidate, bold, size) <= width) { line = candidate; continue; }
      if (line.length) push();
      while (widthOf(w, bold, size) > width && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && widthOf(w.slice(0, n), bold, size) > width) n--;
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    push();
  }
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = [...cut[maxLines - 1].slice(0, Math.max(0, cut[maxLines - 1].length - 3)), 0x85];
    return cut;
  }
  return lines.length ? lines : [[]];
}

const NUMBERISH = /^\(?-?(Rs\.?\s?|₹\s?)?[\d,]+(\.\d+)?\)?%?$/;
const fmt = (n: number) => n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

/** The PDF's bytes. */
export function pdfTable(doc: PdfTableDoc): Uint8Array {
  const landscape = doc.landscape ?? doc.columns.length > 6;
  const W = landscape ? 841.89 : 595.28;
  const H = landscape ? 595.28 : 841.89;
  const M = 32; // margin
  const size = doc.fontSize ?? 8;
  const lead = size * 1.25;
  const pad = 3;
  const tableW = W - 2 * M;
  const total = doc.columns.reduce((t, c) => t + (c.width ?? 1), 0) || 1;
  const colW = doc.columns.map((c) => (tableW * (c.width ?? 1)) / total);
  const colX = colW.map((_, i) => M + colW.slice(0, i).reduce((t, w) => t + w, 0));
  const rows: PdfRow[] = doc.rows.map((r) => (Array.isArray(r) ? { cells: r } : r));
  // Right-align a column whose cells are figures, unless the column says otherwise.
  const align = doc.columns.map((c, i) => c.align ?? (rows.some((r) => r.cells[i] !== undefined && r.cells[i] !== null && r.cells[i] !== '')
    && rows.every((r) => { const v = r.cells[i]; return v === undefined || v === null || v === '' || typeof v === 'number' || NUMBERISH.test(String(v).trim()); })
    ? 'right' : 'left'));

  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const text = (x: number, yy: number, c: number[], bold: boolean, sz = size) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${fmt(sz)} Tf ${fmt(x)} ${fmt(yy)} Td ${literal(c)} Tj ET`);
  const rule = (x1: number, yy: number, x2: number, grey = 0.8, w = 0.4) => ops.push(`${fmt(grey)} G ${fmt(w)} w ${fmt(x1)} ${fmt(yy)} m ${fmt(x2)} ${fmt(yy)} l S`);
  const fill = (x: number, yy: number, w: number, h: number, grey: number) => ops.push(`${fmt(grey)} g ${fmt(x)} ${fmt(yy)} ${fmt(w)} ${fmt(h)} re f 0 g`);

  const headerCells = doc.columns.map((c, i) => wrap(c.header, colW[i] - 2 * pad, true, size, 4));
  const headerH = Math.max(...headerCells.map((l) => l.length)) * lead + 2 * pad;
  const drawHeader = () => {
    fill(M, y - headerH, tableW, headerH, 0.92);
    headerCells.forEach((lines, i) => lines.forEach((l, k) => {
      const ty = y - pad - (k + 1) * lead + (lead - size) / 2 + 1;
      const x = align[i] === 'right' ? colX[i] + colW[i] - pad - widthOf(l, true, size) : colX[i] + pad;
      text(x, ty, l, true);
    }));
    y -= headerH;
    rule(M, y, M + tableW, 0.55, 0.6);
  };
  const newPage = (first: boolean) => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = H - M;
    if (first) {
      if (doc.org) { text(M, y - 12, codes(doc.org), true, 12); y -= 16; }
      text(M, y - 11, codes(doc.title), true, 11); y -= 15;
      for (const l of doc.lines ?? []) {
        for (const w of wrap(l, tableW, false, size + 0.5, 6)) { text(M, y - size - 1, w, false, size + 0.5); y -= lead + 0.5; }
      }
      y -= 6;
    } else {
      text(M, y - size, codes([doc.org, doc.title].filter(Boolean).join(' · ')), false, size);
      y -= lead + 4;
    }
    drawHeader();
  };
  const bottom = M + 18;

  newPage(true);
  for (const r of rows) {
    const bold = r.style === 'bold' || r.style === 'heading' || r.style === 'total';
    const cells = doc.columns.map((_, i) => {
      const v = r.cells[i];
      return wrap(v === undefined || v === null ? '' : String(v), colW[i] - 2 * pad, bold, size);
    });
    const h = Math.max(...cells.map((l) => l.length)) * lead + 2 * pad;
    if (y - h < bottom) newPage(false);
    if (r.style === 'heading') fill(M, y - h, tableW, h, 0.96);
    if (r.style === 'highlight') ops.push(`1 0.93 0.8 rg ${fmt(M)} ${fmt(y - h)} ${fmt(tableW)} ${fmt(h)} re f 0 g`);
    if (r.style === 'muted') ops.push('0.45 g');
    cells.forEach((lines, i) => lines.forEach((l, k) => {
      const ty = y - pad - (k + 1) * lead + (lead - size) / 2 + 1;
      const x = align[i] === 'right' ? colX[i] + colW[i] - pad - widthOf(l, bold, size) : colX[i] + pad;
      text(x, ty, l, bold);
    }));
    if (r.style === 'muted') ops.push('0 g');
    y -= h;
    rule(M, y, M + tableW, r.style === 'total' ? 0.4 : 0.85, r.style === 'total' ? 0.7 : 0.3);
  }
  if (doc.notes?.length) {
    y -= 6;
    for (const n of doc.notes) {
      for (const w of wrap(n, tableW, false, size, 20)) {
        if (y - lead < bottom) newPage(false);
        text(M, y - size, w, false); y -= lead;
      }
    }
  }
  pages.push(ops);

  // Page numbers now that the count is known.
  const n = pages.length;
  pages.forEach((p, i) => {
    const label = codes(`Page ${i + 1} of ${n}`);
    p.push('0.35 g');
    p.push(`BT /F1 7 Tf ${fmt(W - M - widthOf(label, false, 7))} ${fmt(M - 4)} Td ${literal(label)} Tj ET`);
    if (doc.footer) p.push(`BT /F1 7 Tf ${fmt(M)} ${fmt(M - 4)} Td ${literal(codes(doc.footer))} Tj ET`);
    p.push('0 g');
  });

  // ── The file ──
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  const enc = new TextEncoder();
  for (const p of pages) {
    const stream = p.join('\n');
    const content = add(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fmt(W)} ${fmt(H)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${literal(codes(doc.title))} /Producer (Rekonza) >>`);

  // The header with its binary-marker comment, so readers treat the file as binary.
  const head = new Uint8Array([...'%PDF-1.4\n'].map((c) => c.charCodeAt(0)).concat([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  // Every object is ASCII (high bytes are octal escapes in the strings), so offsets count exactly.
  const offsets: number[] = [];
  let at = head.length;
  const bodies = objects.map((body, i) => {
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(at);
    at += enc.encode(obj).length;
    return obj;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  const tail = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  const rest = enc.encode(bodies.join('') + xref + tail);
  const out = new Uint8Array(head.length + rest.length);
  out.set(head, 0);
  out.set(rest, head.length);
  return out;
}

/**
 * Rows as a report hands them to its CSV export, as a PDF: the leading rows
 * narrower than the table are its title lines, the first full-width row its
 * headings; a row with text in its first cell only is a section heading, and
 * one that starts "Total" or "Net" is a total.
 */
export function pdfFromRows(rows: (string | number | null | undefined)[][], opts: { title: string; org?: string | null; footer?: string; lines?: string[] }): Uint8Array {
  const width = Math.max(1, ...rows.map((r) => r.length));
  let i = 0;
  const lines = [...(opts.lines ?? [])];
  while (i < rows.length - 1 && rows[i].length < width) {
    const t = rows[i].filter((c) => c !== null && c !== undefined && c !== '').join(' · ');
    if (t && t !== opts.title) lines.push(t);
    i++;
  }
  const header = rows[i] ?? [];
  const body = rows.slice(i + 1).map((r): PdfRow => {
    const first = String(r[0] ?? '');
    const onlyFirst = r.slice(1).every((c) => c === null || c === undefined || c === '');
    const style: PdfRowStyle = onlyFirst && first ? 'heading' : /^(total|net |gross |grand total)/i.test(first.trim()) ? 'total' : 'normal';
    return { cells: r, style };
  });
  // The first column (account, name) gets the room; figures share the rest.
  const columns: PdfColumn[] = Array.from({ length: width }, (_, k) => ({ header: String(header[k] ?? ''), width: k === 0 ? Math.max(2, Math.min(4, width / 2)) : 1 }));
  return pdfTable({ title: opts.title, org: opts.org, lines, columns, rows: body, footer: opts.footer, landscape: width > 6 });
}

/** In the browser: hand the PDF over as a download. */
export function downloadPdf(filename: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "27 Nov 2026, 14:05 IST", for a footer. */
export function istNow(at = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} IST`;
}
