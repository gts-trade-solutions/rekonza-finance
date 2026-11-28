// ─────────────────────────────────────────────────────────────────────────────
// Finding the row of headings in a file people actually get from a bank or
// another system (status review 7, item 6, "upload errors remain"):
//
//   · a bank's logo, name, account and period lines above the headings, so
//     the headings are on row 5 or 12, not row 1;
//   · headings over two rows where Excel merged a cell ("Amount" spread over
//     "Debit" and "Credit" underneath), which a spreadsheet reader gives as
//     the text in the first cell and nothing in the ones it covered.
//
// The heading row is the one (within the first 30) whose cells name the most
// of the columns being looked for; a second row of sub-headings under it,
// holding no dates or amounts, is joined onto it, with a merged heading
// carried across the cells it covered. Plain functions over a grid of cells,
// shared by the import screens and the bank statement reader.
// ─────────────────────────────────────────────────────────────────────────────

const text = (c: unknown) => (c === null || c === undefined ? '' : String(c instanceof Date ? c.toISOString().slice(0, 10) : c)).replace(/^﻿/, '').trim();
const looksLikeData = (c: string) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(c) || /^[₹(+-]?\s*[\d,]+(\.\d+)?\)?\s*(dr|cr)?$/i.test(c);

export interface HeaderFound {
  /** The row (0-based) the headings are on; the data starts after `bodyFrom`. */
  headerAt: number;
  bodyFrom: number;
  headings: string[];
}

/**
 * The heading row of `grid`: the one scoring highest by `score` (how many of
 * its cells are headings the caller knows), at least `min`; else the first
 * row with two or more cells. A sub-heading row under it is joined on.
 */
export function findHeader(grid: unknown[][], score: (cells: string[]) => number, min = 2): HeaderFound | null {
  const rows = grid.slice(0, 30).map((r) => (r ?? []).map(text));
  let best = -1;
  let bestScore = 0;
  rows.forEach((r, i) => {
    const s = score(r);
    if (s > bestScore) { best = i; bestScore = s; }
  });
  if (best < 0 || bestScore < min) {
    best = rows.findIndex((r) => r.filter(Boolean).length >= 2);
    if (best < 0) return null;
  }
  const head = [...rows[best]];
  // A merged heading covers the empty cells after it, up to the next heading.
  const width = Math.max(head.length, ...(rows[best + 1] ? [rows[best + 1].length] : [0]));
  const carried: string[] = [];
  let last = '';
  for (let i = 0; i < width; i++) {
    if (head[i]) last = head[i];
    carried.push(head[i] || '');
    if (!head[i] && last) carried[i] = last;
  }
  const sub = rows[best + 1] ?? [];
  const isSub = sub.some(Boolean) && !sub.some((c) => c && looksLikeData(c))
    && sub.some((c, i) => c && (!head[i] || carried[i] === carried[i - 1] || carried[i] === carried[i + 1]));
  if (isSub) {
    const headings = Array.from({ length: width }, (_, i) => [carried[i], sub[i]].filter(Boolean).join(' ').trim());
    return { headerAt: best, bodyFrom: best + 2, headings };
  }
  return { headerAt: best, bodyFrom: best + 1, headings: head };
}
