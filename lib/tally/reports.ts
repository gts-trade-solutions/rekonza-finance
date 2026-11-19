// ─────────────────────────────────────────────────────────────────────────────
// Tally's reports, as files: the Trial Balance, the Stock Summary and the
// bills outstanding, in whichever format Tally exported them.
//
// Tally exports any report it shows (Alt+E → Current) as Excel, XML, HTML,
// ASCII (comma separated), SDF (fixed width, Tally.ERP 9), JSON, PDF or a
// picture. Accountants reach for those first, and for a migration three of
// them carry everything the masters would:
//
//   Trial Balance       each ledger's balance on a day, under its group
//   Stock Summary       each item's quantity, rate and value on that day
//   Bills Receivable /  each unpaid bill: party, number, date, due date,
//   Bills Payable       amount
//
// So each is read into the same shape the masters export gives
// (lib/tally/xml TallyMasters) and written out as that export
// (tallyMastersXml), for the import the XML and JSON exports already go
// through. Nothing else changes: the check, the openings, a second run adding
// only what is new.
//
// A report lists groups and ledgers in one column with no mark between them:
//
//   Current Liabilities     2,880.00    1,27,710.00     a group: the totals of
//     Duties & Taxes        2,880.00        1,710.00     what follows it
//       Input CGST          1,440.00
//       …
//
// Excel and HTML show a group bold and a ledger italic and indented, and that
// is used when it is there. ASCII, SDF and XML have no look at all; there a
// group is told by its totals, which are exactly those of the rows under it,
// debit and credit apart (buildTree).
//
// Tally carries balances into a new year by closing income and expenses into
// Profit & Loss A/c, its closing stock counted. A Trial Balance is brought in
// the same way (combineTallyReports), so it gives the same openings as Tally's
// own "Export closing balance as opening balance".
//
// Reports that cannot be posted from (a Day Book in Excel has one line per
// voucher, not its entries; a Balance Sheet only group totals) are named, with
// what to export instead. Shared by the browser and the tests; no server code.
// ─────────────────────────────────────────────────────────────────────────────

import Papa from 'papaparse';
import { tag, unescapeXml, type TallyLedger, type TallyMasters, type TallyStockItem } from './xml';
import { unitOfFormat, type StyledCell } from './xlsx';

export type ReportKind =
  | 'trial-balance' | 'stock-summary' | 'bills-receivable' | 'bills-payable'
  /** Bills outstanding whose side (receivable or payable) is told by their sign. */
  | 'bills'
  | 'balance-sheet' | 'profit-loss' | 'day-book' | 'ledger' | 'register' | 'list-of-accounts' | 'other';

export type ReportFormat = 'Excel' | 'HTML' | 'XML' | 'ASCII' | 'SDF' | 'CSV' | 'PDF' | 'picture';

/** One row of a report: debit and credit in paise, both positive. */
export interface ReportLine {
  name: string;
  dr: number;
  cr: number;
  qty?: number;
  unit?: string | null;
  /** How far in it is indented, when the file shows it. */
  depth?: number;
  /** The row's look, when the file shows it: italic is a ledger or item; bold or plain, a group. */
  look?: 'leaf' | 'group';
}

export interface TallyBill { party: string; ref: string; date: string | null; due: string | null; amountPaise: number }

export interface TallyReport {
  kind: ReportKind;
  /** "Trial Balance", as the file calls it. */
  label: string;
  format: ReportFormat;
  company: string | null;
  /** The day the figures are on (ISO), when the file says. */
  asAt: string | null;
  /** What it brings in, as the masters export would. */
  masters: TallyMasters;
  /** A Trial Balance's opening stock (the year's start), debit positive. */
  openingStockPaise: number;
  /** A Stock Summary's closing value. */
  closingStockPaise: number | null;
  bills: number;
  notes: string[];
  /** Why this file cannot be brought in, and what to export instead. Nothing is brought in from it. */
  problem: string | null;
}

// ── Tally's own groups ───────────────────────────────────────────────────────

const PRIMARY = [
  'branch / divisions', 'capital account', 'current assets', 'current liabilities', 'direct expenses', 'direct incomes',
  'fixed assets', 'indirect expenses', 'indirect incomes', 'investments', 'loans (liability)', 'misc. expenses (asset)',
  'purchase accounts', 'sales accounts', 'suspense a/c',
  // the names some releases show
  'expenses (direct)', 'expenses (indirect)', 'income (direct)', 'income (indirect)',
];
const SUB = [
  'bank accounts', 'bank od a/c', 'bank occ a/c', 'cash-in-hand', 'deposits (asset)', 'duties & taxes', 'loans & advances (asset)',
  'provisions', 'reserves & surplus', 'retained earnings', 'secured loans', 'stock-in-hand', 'sundry creditors', 'sundry debtors', 'unsecured loans',
];
const PREDEFINED = new Set([...PRIMARY, ...SUB]);
const PRIMARY_SET = new Set(PRIMARY);
/** The primary groups whose ledgers close into Profit & Loss A/c at the year's end. */
const PL_GROUPS = new Set(['sales accounts', 'purchase accounts', 'direct incomes', 'direct expenses', 'indirect incomes', 'indirect expenses',
  'expenses (direct)', 'expenses (indirect)', 'income (direct)', 'income (indirect)']);

const lower = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const isOpeningStock = (n: string) => /^opening stock$/i.test(n.trim());
const isClosingStock = (n: string) => /^(less:\s*)?closing stock$/i.test(n.trim());
const isPLAccount = (n: string) => /^profit\s*&\s*loss\s*a\/c$/i.test(n.trim());
const isDifference = (n: string) => /^diff(erence|\.)?\s*in\s*opening\s*balances?$/i.test(n.trim());
const isTotal = (n: string) => /^(grand\s*)?total$/i.test(n.trim());

// ── Figures and dates as Tally writes them ──────────────────────────────────

/** "5,00,000.00", "-16700.00", "1,180.00 Dr", "(1,200.00)" → rupees, signed; null when it is no figure. */
export function figure(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[₹ ]/g, '').replace(/^Rs\.?\s*/i, '');
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bDr\.?$/i.test(s)) { sign = -1; s = s.replace(/\s*Dr\.?$/i, ''); } // Tally's own sign: a debit is negative
  else if (/\bCr\.?$/i.test(s)) s = s.replace(/\s*Cr\.?$/i, '');
  s = s.replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return sign * Number(s);
}
const paise = (rupees: number) => Math.round(rupees * 100);
const mag = (v: unknown) => Math.abs(paise(figure(v) ?? 0));

/** "35 Nos" → 35 and "Nos". */
function quantity(v: unknown, fmt?: string): { qty: number; unit: string | null } | null {
  if (typeof v === 'number') return { qty: v, unit: unitOfFormat(fmt) };
  if (typeof v !== 'string' || !v.trim()) return null;
  const m = /^\s*(-?[\d,]*\.?\d+)\s*([A-Za-z][A-Za-z0-9./ -]{0,15})?\s*$/.exec(v);
  return m ? { qty: Number(m[1].replace(/,/g, '')), unit: m[2]?.trim() || unitOfFormat(fmt) } : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
const year = (y: string) => (y.length <= 2 ? 2000 + Number(y) : Number(y));

/** "1-Apr-26", "1-Sep-2026", "20260401", "01-04-2026", or an Excel day number → ISO. */
export function tallyDay(v: unknown): string | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{1,2})[-\s/.]([A-Za-z]{3})[a-z]*[-\s/.,]*(\d{2,4})$/.exec(s);
  if (m) return MONTHS[m[2].toLowerCase()] ? iso(year(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])) : null;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) return iso(year(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** "1-Apr-26 to 31-Mar-27", "as at 31-Mar-2026" → the last day. */
function periodEnd(s: string): string | null {
  const m = /(?:to|as\s+(?:at|on))\s+(\d{1,2}[-\s/.][A-Za-z]{3}[a-z]*[-\s/.,]*\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s*$/i.exec(s.trim());
  return m ? tallyDay(m[1]) : null;
}
const looksLikePeriod = (s: string) => periodEnd(s) !== null || /^\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+to\s+/i.test(s.trim());

// ── Which report a title names ──────────────────────────────────────────────

const TITLES: [RegExp, ReportKind, string][] = [
  [/^trial\s*balance/i, 'trial-balance', 'Trial Balance'],
  [/^stock\s*summary/i, 'stock-summary', 'Stock Summary'],
  [/^bills\s*receivable/i, 'bills-receivable', 'Bills Receivable'],
  [/^bills\s*payable/i, 'bills-payable', 'Bills Payable'],
  [/outstandings?\b.*(sundry\s*debtors|receivable)/i, 'bills-receivable', 'Outstandings (Sundry Debtors)'],
  [/outstandings?\b.*(sundry\s*creditors|payable)/i, 'bills-payable', 'Outstandings (Sundry Creditors)'],
  [/^balance\s*sheet/i, 'balance-sheet', 'Balance Sheet'],
  [/^profit\s*(&|and)\s*loss/i, 'profit-loss', 'Profit & Loss'],
  [/^day\s*book/i, 'day-book', 'Day Book'],
  [/register/i, 'register', 'register'],
  [/^ledger(\s*vouchers)?\b|^ledger\s*:/i, 'ledger', 'Ledger'],
  [/^(list\s*of\s*(accounts|ledgers)|chart\s*of\s*accounts|group\s*summary)/i, 'list-of-accounts', 'List of Accounts'],
  [/^(cash\s*flow|funds?\s*flow|ratio|cash\s*\/?\s*bank|stock\s*(item|group|category)|godown|movement|gstr|gst\b|tds|tcs|statistics|outstandings?)/i, 'other', ''],
];
function kindOfTitle(title: string): { kind: ReportKind; label: string } | null {
  for (const [re, kind, label] of TITLES) if (re.test(title.trim())) return { kind, label: label || title.trim() };
  return null;
}

/** Tally's own names for a report's export file ("TrialBal.pdf"), for the pictures, which cannot be read inside. */
const FILE_NAMES: [RegExp, ReportKind, string][] = [
  [/^trial\s*bal/i, 'trial-balance', 'Trial Balance'],
  [/^stk\s*sum|^stock\s*summ/i, 'stock-summary', 'Stock Summary'],
  [/^bills?\s*rec|^billsrec/i, 'bills-receivable', 'Bills Receivable'],
  [/^bills?\s*pay|^billspay/i, 'bills-payable', 'Bills Payable'],
  [/^bal\s*sheet|^balance\s*sheet/i, 'balance-sheet', 'Balance Sheet'],
  [/^prof\s*loss|^profit/i, 'profit-loss', 'Profit & Loss'],
  [/^day\s*book|^daybook/i, 'day-book', 'Day Book'],
  [/^ledger/i, 'ledger', 'Ledger'],
];

// ── What to do instead, for what cannot come in ─────────────────────────────

const EXPORT_VOUCHERS = 'In Tally, export the vouchers instead: Alt+E → Transactions, File Format XML (Data Interchange) or JSON (Data Exchange). A Day Book open on screen exports the same way with Alt+E → Current and either of those formats.';
const EXPORT_TB = 'Bring the Trial Balance instead (detailed, with every level shown) and the Stock Summary as at the same day: between them they carry each ledger, each item and its value.';
const EXPORT_MASTERS = 'Or export the masters: Alt+E → Masters, Type of master "All Masters", File Format XML or JSON, with "Export closing balance as opening balance" set to Yes.';
const EXPAND_ALL = 'In Tally, open the Trial Balance, press Alt+F5 to make it Detailed, and under F12 (Configure) set "Expand all levels in Detailed format" to Yes; then export it again.';

function problemFor(kind: ReportKind, label: string, format: ReportFormat): string | null {
  switch (kind) {
    case 'day-book': case 'ledger': case 'register':
      return `A ${label} in ${format} has one line for each voucher, not all its entries, so its vouchers cannot be posted from it. ${EXPORT_VOUCHERS}`;
    case 'balance-sheet': case 'profit-loss':
      return `A ${label} gives the totals by group, not every ledger's balance. ${EXPORT_TB}`;
    case 'list-of-accounts':
      return `This list has the names of the groups and ledgers without their balances or their groups. ${EXPORT_MASTERS}`;
    case 'other':
      return `Tally's ${label} is a report Rekonza does not bring in. ${EXPORT_TB} ${EXPORT_VOUCHERS}`;
    default:
      return null;
  }
}

// ── A group and its rows, from the totals ───────────────────────────────────

export interface ReportNode { line: ReportLine; children: ReportNode[] }

const STEP_LIMIT = 300_000;

/**
 * The rows of a report as groups and what is under them. With indents (Excel,
 * HTML) by those; otherwise by the totals: a row is a group when the rows that
 * follow it add up, debit and credit apart, to exactly its figures. Tally's own
 * group names are tried as groups first and a row that looks like a ledger
 * (italic) never is one. Null when no reading of the totals fits.
 */
export function buildTree(lines: ReportLine[]): ReportNode[] | null {
  if (lines.length && lines.every((l) => l.depth !== undefined)) {
    const tree = byDepth(lines);
    if (sumsHold(tree)) return tree;
  }
  return bySums(lines);
}

function byDepth(lines: ReportLine[]): ReportNode[] {
  const roots: ReportNode[] = [];
  const stack: ReportNode[] = [];
  for (const line of lines) {
    const node: ReportNode = { line, children: [] };
    while (stack.length && (stack.at(-1)!.line.depth ?? 0) >= (line.depth ?? 0)) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

function sumsHold(nodes: ReportNode[]): boolean {
  return nodes.every((n) => !n.children.length || (
    n.children.reduce((t, c) => t + c.line.dr, 0) === n.line.dr &&
    n.children.reduce((t, c) => t + c.line.cr, 0) === n.line.cr && sumsHold(n.children)));
}

/**
 * Every reading of the rows that their totals allow is tried, in a sensible
 * order, until one fits the whole report. A Trial Balance's top level is
 * Tally's primary groups, so a group there must end just before the next
 * primary group (or the report's end): that rules out a reading in which a
 * ledger happens to equal the sum of the ledgers after it. When no reading
 * fits that, as with a primary group of the company's own, the first that
 * fits the totals is taken.
 */
function bySums(lines: ReportLine[]): ReportNode[] | null {
  const n = lines.length;
  let steps = 0;
  const special = (l: ReportLine) => isOpeningStock(l.name) || isClosingStock(l.name) || isPLAccount(l.name) || isDifference(l.name);
  const topRow = (l: ReportLine) => PRIMARY_SET.has(lower(l.name)) || isPLAccount(l.name) || isDifference(l.name) || isOpeningStock(l.name);
  /** Leaf or group first, for one row. */
  const order = (l: ReportLine, top: boolean): boolean[] => {
    if (l.look === 'leaf' || special(l)) return [false];
    if (top || l.look === 'group' || PREDEFINED.has(lower(l.name))) return [true, false];
    return [false, true];
  };
  type Run = { nodes: ReportNode[]; end: number };
  /** Each run of rows from `start` that are exactly the children of a group with these totals. */
  function* kids(start: number, tDr: number, tCr: number): Generator<Run> {
    if (tDr === 0 && tCr === 0) return;
    const acc: ReportNode[] = [];
    function* dfs(i: number, aDr: number, aCr: number): Generator<Run> {
      if (++steps > STEP_LIMIT) throw new Error('too many readings');
      if (aDr === tDr && aCr === tCr && acc.length) { yield { nodes: [...acc], end: i }; return; }
      if (i >= n || aDr > tDr || aCr > tCr) return;
      const l = lines[i];
      for (const asGroup of order(l, false)) {
        if (asGroup) {
          for (const sub of kids(i + 1, l.dr, l.cr)) {
            acc.push({ line: l, children: sub.nodes });
            yield* dfs(sub.end, aDr + l.dr, aCr + l.cr);
            acc.pop();
          }
        } else {
          acc.push({ line: l, children: [] });
          yield* dfs(i + 1, aDr + l.dr, aCr + l.cr);
          acc.pop();
        }
      }
    }
    yield* dfs(start, 0, 0);
  }
  /**
   * The rows from `i` to the end as top-level nodes; the first reading that
   * covers them all. Strict: every top-level row is one of Tally's primary
   * groups (or Profit & Loss A/c, opening stock, the difference line).
   */
  const roots = (i: number, strict: boolean): ReportNode[] | null => {
    if (i >= n) return [];
    const l = lines[i];
    if (strict && !topRow(l)) return null;
    for (const asGroup of order(l, true)) {
      if (asGroup) {
        for (const sub of kids(i + 1, l.dr, l.cr)) {
          const rest = roots(sub.end, strict);
          if (rest) return [{ line: l, children: sub.nodes }, ...rest];
        }
      } else {
        const rest = roots(i + 1, strict);
        if (rest) return [{ line: l, children: [] }, ...rest];
      }
    }
    return null;
  };
  try {
    return roots(0, true) ?? ((steps = 0), roots(0, false));
  } catch {
    // Too many readings to try, or a group too long to follow: the caller says to export it as Excel.
    return null;
  }
}

// ── Lines into what they bring in ───────────────────────────────────────────

const emptyMasters = (): TallyMasters => ({ groups: new Map(), ledgers: [], stockItems: [], voucherTypes: new Map() });
const blankLedger = (name: string, parent: string, balancePaise: number): TallyLedger => ({
  name, parent, balancePaise, gstin: null, pan: null, stateName: null, email: null, phone: null, address: null, pincode: null, creditDays: null, bills: [],
});
const rupeeText = (p: number) => `₹${(Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function base(kind: ReportKind, label: string, format: ReportFormat, company: string | null, asAt: string | null): TallyReport {
  return {
    kind, label, format, company, asAt, masters: emptyMasters(), openingStockPaise: 0, closingStockPaise: null, bills: 0, notes: [],
    problem: problemFor(kind, label, format),
  };
}

/** A Trial Balance's rows as Tally's groups and ledgers, each ledger with its balance. */
function trialBalance(r: TallyReport, lines: ReportLine[]): TallyReport {
  if (!lines.length) { r.problem = 'No ledgers were found in this Trial Balance.'; return r; }
  const tree = buildTree(lines);
  if (!tree) {
    r.problem = `The groups and ledgers in this Trial Balance could not be told apart from its totals. Export it as Excel, or as XML or JSON from Alt+E → Masters. ${EXPAND_ALL}`;
    return r;
  }
  const totalsOnly: string[] = [];
  let anyGroup = false;
  const walk = (nodes: ReportNode[], parent: string | null) => {
    for (const { line, children } of nodes) {
      if (children.length) {
        anyGroup = true;
        r.masters.groups.set(line.name, parent ?? '');
        walk(children, line.name);
        continue;
      }
      const net = line.dr - line.cr;
      if (isOpeningStock(line.name)) { r.openingStockPaise += net; continue; }
      if (isClosingStock(line.name)) { r.closingStockPaise = (r.closingStockPaise ?? 0) + net; continue; }
      if (isDifference(line.name)) { r.notes.push(`Tally shows a difference in opening balances of ${rupeeText(net)}; it stays in Opening Balance Adjustments here until it is explained.`); continue; }
      if (isPLAccount(line.name)) { r.masters.ledgers.push(blankLedger('Profit & Loss A/c', '', net)); continue; }
      // A group with nothing under it: the report shows its total only (Tally's own, or one the look gives away).
      if (PREDEFINED.has(lower(line.name)) || line.look === 'group') { if (net) totalsOnly.push(line.name); continue; }
      r.masters.ledgers.push(blankLedger(line.name, parent ?? '', net));
    }
  };
  walk(tree, null);
  if (!anyGroup || (totalsOnly.length && totalsOnly.every((g) => PRIMARY_SET.has(lower(g))))) {
    r.problem = `This Trial Balance shows the groups only (${totalsOnly.slice(0, 4).join(', ')}${totalsOnly.length > 4 ? '…' : ''}), not their ledgers. ${EXPAND_ALL}`;
  } else if (totalsOnly.length) {
    r.problem = `This Trial Balance shows only the total of ${totalsOnly.slice(0, 5).join(', ')}${totalsOnly.length > 5 ? ` and ${totalsOnly.length - 5} more` : ''}, not each ledger in ${totalsOnly.length === 1 ? 'it' : 'them'}. ${EXPAND_ALL}`;
  }
  if (r.problem) { r.masters = emptyMasters(); return r; }
  return r;
}

/** A Stock Summary's items, each with its quantity and value; stock groups are only totals and are left out. */
function stockSummary(r: TallyReport, lines: ReportLine[]): TallyReport {
  const tree = buildTree(lines) ?? lines.map((line) => ({ line, children: [] }));
  const items: TallyStockItem[] = [];
  const negative: string[] = [];
  const walk = (nodes: ReportNode[]) => {
    for (const { line, children } of nodes) {
      if (children.length) { walk(children); continue; }
      const value = line.dr - line.cr;
      if ((line.qty ?? 0) < 0 || value < 0) { negative.push(line.name); continue; }
      items.push({ name: line.name, unit: line.unit ?? null, hsn: null, gstRatePct: null, qty: line.qty ?? 0, valuePaise: value });
    }
  };
  walk(tree);
  if (!items.length) { r.problem = 'No stock items with a quantity were found in this Stock Summary.'; return r; }
  r.masters.stockItems = items;
  r.closingStockPaise = items.reduce((t, s) => t + s.valuePaise, 0);
  if (negative.length) r.notes.push(`${negative.length} item${negative.length === 1 ? ' is' : 's are'} below zero in Tally (${negative.slice(0, 3).join(', ')}${negative.length > 3 ? '…' : ''}) and come in without opening stock.`);
  return r;
}

/** Bills outstanding: one ledger for each party, under Sundry Debtors or Sundry Creditors, its bills under it. */
function billsReport(r: TallyReport, bills: TallyBill[]): TallyReport {
  if (!bills.length) { r.problem = 'No unpaid bills were found in this report.'; return r; }
  // Owed to us is a debit (positive here). The sign says which side, when the title does not.
  if (r.kind === 'bills') {
    r.kind = bills.reduce((t, b) => t + b.amountPaise, 0) >= 0 ? 'bills-receivable' : 'bills-payable';
  }
  const receivable = r.kind === 'bills-receivable';
  const byParty = new Map<string, TallyLedger>();
  for (const b of bills) {
    const l = byParty.get(b.party) ?? blankLedger(b.party, receivable ? 'Sundry Debtors' : 'Sundry Creditors', 0);
    const owed = receivable ? Math.abs(b.amountPaise) : -Math.abs(b.amountPaise);
    const days = b.date && b.due ? Math.round((Date.parse(b.due) - Date.parse(b.date)) / 86400000) : null;
    l.bills.push({ ref: b.ref || 'Opening', date: b.date, amountPaise: owed, creditDays: days !== null && days >= 0 ? days : null });
    l.balancePaise += owed;
    byParty.set(b.party, l);
  }
  r.masters.ledgers = [...byParty.values()];
  r.bills = bills.length;
  return r;
}

function finish(r: TallyReport, lines: ReportLine[], bills: TallyBill[]): TallyReport {
  if (r.problem) return r;
  if (r.kind === 'trial-balance') return trialBalance(r, lines);
  if (r.kind === 'stock-summary') return stockSummary(r, lines);
  if (r.kind === 'bills-receivable' || r.kind === 'bills-payable' || r.kind === 'bills') return billsReport(r, bills);
  return r;
}

// ── XML (Tally's report XML, not the data interchange) ──────────────────────

/** A report exported as XML: <DSPACCNAME>…<DSPACCINFO>…, as opposed to the masters' <LEDGER> blocks. */
export function isTallyReportXml(xml: string): boolean {
  return /<(DSPACCNAME|BSNAME|DSPPERIOD|BILLFIXED|DSPSTKINFO)>/.test(xml) && !/<(LEDGER|VOUCHER|STOCKITEM|GROUP)[\s>]/.test(xml);
}

function fromReportXml(xml: string): TallyReport | null {
  if (!isTallyReportXml(xml)) return null;
  const name = (b: string) => unescapeXml(tag(b, 'DSPDISPNAME') ?? '').trim();
  if (/<DSPCLDRAMT>|<DSPCLCRAMT>/.test(xml)) {
    const lines: ReportLine[] = [];
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPACCINFO>([\s\S]*?)<\/DSPACCINFO>/g)) {
      const n = name(m[1]);
      if (n) lines.push({ name: n, dr: mag(tag(m[2], 'DSPCLDRAMTA')), cr: mag(tag(m[2], 'DSPCLCRAMTA')) });
    }
    return finish(base('trial-balance', 'Trial Balance', 'XML', null, null), lines, []);
  }
  if (/<DSPSTKINFO>/.test(xml)) {
    const lines: ReportLine[] = [];
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPSTKINFO>([\s\S]*?)<\/DSPSTKINFO>/g)) {
      const n = name(m[1]);
      const q = quantity(tag(m[2], 'DSPCLQTY'));
      const value = -paise(figure(tag(m[2], 'DSPCLAMTA')) ?? 0); // Tally writes stock, a debit, negative
      // An item has a rate; a stock group, only totals.
      const look = figure(tag(m[2], 'DSPCLRATE')) !== null ? 'leaf' as const : undefined;
      if (n) lines.push({ name: n, dr: Math.max(value, 0), cr: Math.max(-value, 0), qty: q?.qty ?? 0, unit: q?.unit ?? null, look });
    }
    return finish(base('stock-summary', 'Stock Summary', 'XML', null, null), lines, []);
  }
  if (/<BILLFIXED>/.test(xml)) {
    const bills: TallyBill[] = [];
    for (const m of xml.matchAll(/<BILLFIXED>([\s\S]*?)<\/BILLFIXED>([\s\S]*?)(?=<BILLFIXED>|<\/ENVELOPE>|$)/g)) {
      const party = unescapeXml(tag(m[1], 'BILLPARTY') ?? '').trim();
      if (!party) continue;
      bills.push({
        party, ref: unescapeXml(tag(m[1], 'BILLREF') ?? '').trim(), date: tallyDay(tag(m[1], 'BILLDATE')),
        due: tallyDay(tag(m[2], 'BILLDUE')), amountPaise: -paise(figure(tag(m[2], 'BILLCL')) ?? 0),
      });
    }
    return finish(base('bills', 'Bills outstanding', 'XML', null, null), [], bills);
  }
  if (/<BSNAME>/.test(xml)) return base('balance-sheet', 'Balance Sheet', 'XML', null, null);
  if (/<PLAMT>|<PLSUBAMT>/.test(xml)) return base('profit-loss', 'Profit & Loss', 'XML', null, null);
  return base('other', 'month-by-month report', 'XML', null, null);
}

// ── ASCII and SDF: rows with no headings ────────────────────────────────────

const isDayText = (s: string) => /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s.trim());
const isNumText = (s: string) => figure(s) !== null;
const isQtyText = (s: string) => /^\s*-?[\d,]*\.?\d+\s+[A-Za-z][A-Za-z0-9./-]{0,15}\s*$/.test(s);

/** Rows of cells from Tally's headingless exports, told apart by their shape. */
function fromRows(rows: string[][], format: ReportFormat): TallyReport | null {
  const data = rows.map((r) => r.map((c) => c.trim())).map((r) => { while (r.length && r.at(-1) === '') r.pop(); return r; }).filter((r) => r.length);
  if (data.length < 1) return null;
  // Stock Summary: name, "35 Nos", rate, value.
  if (data.every((r) => r.length >= 2 && r.length <= 4 && !isNumText(r[0]) && (r[1] === '' || isQtyText(r[1]))) && data.some((r) => isQtyText(r[1] ?? ''))) {
    const lines = data.map((r): ReportLine => {
      const q = quantity(r[1]);
      const value = -paise(figure(r[3] ?? r[2]) ?? 0);
      // An item has a rate; a stock group, only totals.
      return { name: r[0], dr: Math.max(value, 0), cr: Math.max(-value, 0), qty: q?.qty ?? 0, unit: q?.unit ?? null, look: r.length >= 4 && isNumText(r[2]) ? 'leaf' : undefined };
    });
    return finish(base('stock-summary', 'Stock Summary', format, null, null), lines, []);
  }
  // Day Book, a register or a ledger: a date first, then the account, then the voucher type.
  if (data.filter((r) => isDayText(r[0])).length >= Math.ceil(data.length / 2) && data.some((r) => r.length >= 4 && !isNumText(r[2] ?? '') && !isDayText(r[2] ?? ''))) {
    if (data.every((r) => r.length >= 4 && isDayText(r[0])) && data.some((r) => isDayText(r[4] ?? ''))) {
      // Bills: date, ref, party, amount, due date, days overdue.
      const bills = data.map((r) => ({ party: r[2], ref: r[1], date: tallyDay(r[0]), due: tallyDay(r[4] ?? ''), amountPaise: -paise(figure(r[3]) ?? 0) }));
      return finish(base('bills', 'Bills outstanding', format, null, null), [], bills);
    }
    return base('day-book', 'Day Book', format, null, null);
  }
  // A list of names only: List of Accounts.
  if (data.every((r) => r.length === 1 && !isNumText(r[0]))) return base('list-of-accounts', 'List of Accounts', format, null, null);
  // Name, then figures: a Trial Balance (debit, written negative, then credit), or a Balance Sheet or Profit & Loss
  // (whose empty groups are a name alone).
  if (data.some((r) => r.length >= 2) && data.every((r) => r.length <= 3 && !isNumText(r[0]) && r.slice(1).every((c) => c === '' || isNumText(c)))) {
    const names = new Set(data.map((r) => lower(r[0])));
    const pl = [...names].some((nm) => /^(cost of sales|add:|less:|gross (profit|loss)|nett? (profit|loss))/.test(nm));
    const tbShape = data.every((r) => (figure(r[1] ?? '') ?? 0) <= 0 && (figure(r[2] ?? '') ?? 0) >= 0);
    if (pl) return base('profit-loss', 'Profit & Loss', format, null, null);
    if (!tbShape) return base('balance-sheet', 'Balance Sheet', format, null, null);
    const lines = data.map((r) => ({ name: r[0], dr: mag(r[1] ?? ''), cr: mag(r[2] ?? '') }));
    return finish(base('trial-balance', 'Trial Balance', format, null, null), lines, []);
  }
  return null;
}

/** Fixed-width lines (SDF) as cells: the name, then each figure in the column its right edge falls in. */
function sdfRows(text: string): string[][] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length || lines.some((l) => /","|^"/.test(l))) return null;
  const parsed = lines.map((line) => {
    const tokens: { text: string; end: number }[] = [];
    const re = /(-?[\d,]*\.?\d+(?:\s[A-Za-z][A-Za-z./-]{0,9})?)(?=\s{2,}|\s*$)/g;
    const nameEnd = /\S(?=\s{2,}\S|\s*$)/.exec(line)?.index ?? line.length;
    for (const m of line.slice(nameEnd + 1).matchAll(re)) tokens.push({ text: m[1], end: nameEnd + 1 + m.index! + m[1].length });
    return { name: line.slice(0, nameEnd + 1).trim(), tokens };
  });
  if (!parsed.some((p) => p.tokens.length)) return null;
  const ends = [...new Set(parsed.flatMap((p) => p.tokens.map((t) => t.end)))].sort((a, b) => a - b);
  // Columns: right edges within a few characters of each other are one column.
  const cols: number[] = [];
  for (const e of ends) if (!cols.length || e - cols.at(-1)! > 3) cols.push(e);
  return parsed.map((p) => {
    const row = [p.name, ...cols.map(() => '')];
    for (const t of p.tokens) {
      const at = cols.reduce((best, c, i) => (Math.abs(c - t.end) < Math.abs(cols[best] - t.end) ? i : best), 0);
      row[at + 1] = t.text;
    }
    return row;
  });
}

// ── Grids with headings: Excel, HTML, CSV saved from Excel ──────────────────

type Cell = StyledCell;
const cellText = (c: Cell | undefined) => (c?.v === null || c?.v === undefined ? '' : String(c.v).trim());

/** The columns a report's headings name, by role. */
interface Columns { dr?: number; cr?: number; qty?: number; rate?: number; value?: number; date?: number; ref?: number; party?: number; amount?: number; due?: number; vchType?: number }

const ROLES: [RegExp, keyof Columns][] = [
  [/^debit( amount)?$/, 'dr'],
  [/^credit( amount)?$/, 'cr'],
  [/^quantity$|^qty\.?$/, 'qty'],
  [/^rate$/, 'rate'],
  [/pending\s*amount|^balance$|outstanding/, 'amount'],
  [/^value$|^amount$/, 'value'],
  [/^date$/, 'date'],
  [/^ref\.?\s*no\.?$|^ref(erence)?$|^bill\s*(no|ref)/, 'ref'],
  [/party'?s?\s*name|^party$/, 'party'],
  [/^due\s*on$|due\s*date/, 'due'],
  [/^vch\.?\s*type$|voucher\s*type/, 'vchType'],
];

/**
 * The columns a report's headings name. A heading can be stacked over two
 * lines ("Pending" over "Amount", "Closing Balance" over "Debit"): it is
 * matched whole first, then by its last line.
 */
function columnsOf(labels: (string | string[])[]): Columns {
  const c: Columns = {};
  labels.forEach((raw, i) => {
    const parts = (Array.isArray(raw) ? raw : [raw]).map(lower).filter(Boolean);
    if (!parts.length) return;
    for (const l of [parts.join(' '), parts.at(-1)!]) {
      const hit = ROLES.find(([re, role]) => re.test(l) && c[role] === undefined);
      if (hit) { c[hit[1]] = i; return; }
    }
  });
  return c;
}

/** A Tally report laid out on a grid, as Excel, HTML or a CSV of either gives it. Null when it is not one. */
export function readTallyReportGrid(grid: Cell[][], format: ReportFormat): TallyReport | null {
  // The title: one of the first rows names a Tally report.
  let titleRow = -1;
  let found: { kind: ReportKind; label: string } | null = null;
  for (let r = 0; r < Math.min(grid.length, 10) && !found; r++) {
    for (const c of grid[r] ?? []) {
      const t = cellText(c);
      if (t && t.length < 80) { found = kindOfTitle(t); if (found) { titleRow = r; break; } }
    }
  }
  // The headings: a row with "Particulars", or a date and a party or voucher type.
  let head = -1;
  for (let r = Math.max(titleRow, 0); r < Math.min(grid.length, 20) && head < 0; r++) {
    const texts = (grid[r] ?? []).map((c) => lower(cellText(c)));
    if (texts.includes('particulars') || (texts.includes('date') && texts.some((t) => /party|ref\.?\s*no|vch/.test(t)))) head = r;
  }
  if (!found && head < 0) return null;
  if (!found) {
    // Headings that are Tally's, with no title above them: say which by the columns.
    const cols = columnsOf([...(grid[head] ?? []).map(cellText)].map((t, i) => [t, cellText(grid[head + 1]?.[i])].filter(Boolean)));
    if (cols.party !== undefined && (cols.amount !== undefined || cols.value !== undefined)) found = { kind: 'bills', label: 'Bills outstanding' };
    else return null;
  }
  const company = titleRow > 0 ? cellText(grid[0]?.[0]) || null : null;
  let asAt: string | null = null;
  for (let r = 0; r < Math.min(grid.length, Math.max(head, titleRow) + 4); r++) {
    for (const c of grid[r] ?? []) { const t = cellText(c); if (t && looksLikePeriod(t)) { asAt = periodEnd(t); if (asAt) break; } }
    if (asAt) break;
  }
  const r0 = base(found.kind, found.label, format, company, asAt);
  if (r0.problem || head < 0) {
    if (!r0.problem) r0.problem = `The headings of this ${found.label} were not found. Export it from Tally again, as Excel, XML or JSON.`;
    return r0;
  }
  // The heading rows run down to the first row with a figure in it; each column's labels, top to bottom, name it.
  const labels: string[][] = [];
  const addLabels = (row: Cell[]) => row.forEach((c, i) => {
    const t = cellText(c);
    if (t && !looksLikePeriod(t) && t !== company) (labels[i] ??= []).push(t);
  });
  addLabels(grid[head] ?? []);
  let first = head + 1;
  while (first < grid.length) {
    const row = grid[first] ?? [];
    const hasFigure = row.slice(1).some((c) => typeof c.v === 'number' || figure(cellText(c)) !== null || quantity(cellText(c)) !== null);
    const name = cellText(row[0]);
    if (hasFigure || (name && !/^particulars$/i.test(name) && row.slice(1).every((c) => !cellText(c)))) break;
    addLabels(row);
    first++;
  }
  const cols = columnsOf(Array.from(labels, (l) => l ?? []));
  const rows = grid.slice(first);
  const end = rows.findIndex((row) => isTotal(cellText(row[0])));
  const body = (end >= 0 ? rows.slice(0, end) : rows).filter((row) => cellText(row[0]) || row.some((c) => cellText(c)));
  const styled = body.some((row) => row[0]?.italic);
  const indents = body.every((row) => row[0]?.indent !== undefined || row[0]?.bold || row[0]?.italic);
  const lineOf = (row: Cell[]): ReportLine => {
    const c0 = row[0];
    const line: ReportLine = { name: cellText(c0), dr: 0, cr: 0 };
    if (styled) line.look = c0?.italic ? 'leaf' : 'group';
    if (styled && indents) line.depth = Math.round((c0?.indent ?? 0) / 3);
    return line;
  };

  if (r0.kind === 'trial-balance') {
    if (cols.dr === undefined && cols.cr === undefined) { r0.problem = 'This Trial Balance has no Debit and Credit columns. In Tally, show the closing balance (F12 Configure) and export it again.'; return r0; }
    const lines = body.filter((row) => cellText(row[0])).map((row) => {
      const l = lineOf(row);
      l.dr = cols.dr !== undefined ? mag(row[cols.dr]?.v ?? '') : 0;
      l.cr = cols.cr !== undefined ? mag(row[cols.cr]?.v ?? '') : 0;
      return l;
    });
    return finish(r0, lines, []);
  }
  if (r0.kind === 'stock-summary') {
    const lines = body.filter((row) => cellText(row[0])).map((row) => {
      const l = lineOf(row);
      const q = cols.qty !== undefined ? quantity(row[cols.qty]?.v ?? '', row[cols.qty]?.fmt) : null;
      const v = cols.value !== undefined ? figure(row[cols.value]?.v ?? '') : null;
      // Excel shows a value as it reads, positive.
      l.dr = Math.abs(paise(v ?? 0));
      l.qty = q?.qty ?? 0;
      l.unit = q?.unit ?? null;
      // An item has a rate; a stock group, only totals.
      if (!l.look && cols.rate !== undefined && figure(row[cols.rate]?.v ?? '') !== null) l.look = 'leaf';
      return l;
    });
    return finish(r0, lines, []);
  }
  if (r0.kind === 'bills-receivable' || r0.kind === 'bills-payable' || r0.kind === 'bills') {
    if (cols.party === undefined || cols.amount === undefined) { r0.problem = `This ${found.label} has no "Party's Name" and "Pending Amount" columns. Export it from Tally again, as Excel, XML or JSON.`; return r0; }
    const receivable = r0.kind === 'bills-receivable';
    const bills: TallyBill[] = body.filter((row) => cellText(row[cols.party!])).map((row) => {
      const amountCell = row[cols.amount!];
      const n = figure(amountCell?.v ?? '') ?? 0;
      const text = cellText(amountCell);
      // A figure marked Dr or Cr carries its side; a bare one is on the report's own side.
      const signed = /dr|cr/i.test(text) ? -n : receivable ? Math.abs(n) : -Math.abs(n);
      return {
        party: cellText(row[cols.party!]), ref: cols.ref !== undefined ? cellText(row[cols.ref]) : '',
        date: cols.date !== undefined ? tallyDay(row[cols.date]?.v ?? '') : null, due: cols.due !== undefined ? tallyDay(row[cols.due]?.v ?? '') : null,
        amountPaise: paise(signed),
      };
    });
    return finish(r0, [], bills);
  }
  return r0;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const HTML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unhtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => HTML_ENT[e.toLowerCase()])
  .replace(/&#(\d+);/g, (_, n: string) => (n === '160' ? ' ' : String.fromCharCode(Number(n)))).replace(/\s+/g, ' ').trim();

/**
 * Tally's HTML export as a grid. Each line of the report is a table row of
 * its own, inside tables nested level by level, so a cell's place on the page
 * is not comparable from one line to the next; its order in the line is. A
 * line is: empty cells that indent it (the first one wider at each level), the
 * name, a wide empty filler, then one cell for each column, an empty figure
 * still a cell. Narrow spacer cells sit between them all.
 */
function htmlGrid(html: string): { grid: Cell[][]; title: string | null } | null {
  if (!/<TABLE/i.test(html)) return null;
  const title = (/<TH[^>]*>([\s\S]*?)<\/TH>/i.exec(html)?.[1] ?? null);
  type HCell = { text: string; bold: boolean; italic: boolean; width: number; x: number };
  const lines: { cells: HCell[]; width: number }[] = [];
  for (const m of html.matchAll(/<TR[^>]*>((?:(?!<TABLE|<TR)[\s\S])*?)<\/TR>/gi)) {
    let x = 0;
    const cells = [...m[1].matchAll(/<TD([^>]*)>([\s\S]*?)<\/TD>/gi)].map((c) => {
      const width = Number(/width="(\d+)"/i.exec(c[1])?.[1] ?? 0);
      const cell = { text: unhtml(c[2]), bold: /font:\s*bold/i.test(c[1]), italic: /italic/i.test(c[1]), width, x };
      x += width;
      return cell;
    });
    if (cells.some((c) => c.text)) lines.push({ cells, width: x });
  }
  if (!lines.length) return null;
  const parsed = lines.map(({ cells, width }) => {
    // The name: the line's first text, when it is in the left half (a heading over the figures is not).
    const first = cells.findIndex((c) => c.text);
    const nameAt = first >= 0 && cells[first].x < width / 2 ? first : -1;
    // The indent: the first empty cell before the name, wider at each level.
    const indent = nameAt > 0 && !cells[0].text ? cells[0].width : 0;
    // A heading line with nothing in the name's place still has a cell there: the columns start after it.
    const holder = nameAt < 0 ? cells.findIndex((c) => !c.text && c.width >= 30 && c.width <= 400 && c.x < width / 2) : -1;
    // The columns: what follows the name, less the narrow spacers and the wide filler.
    const after = nameAt >= 0 ? nameAt : holder;
    const rest = cells.filter((c, i) => i > after && (c.text || (c.width >= 30 && c.width <= 400)));
    return { name: nameAt >= 0 ? cells[nameAt] : null, indent, rest };
  });
  const levels = [...new Set(parsed.filter((p) => p.name).map((p) => p.indent))].sort((a, b) => a - b);
  const grid: Cell[][] = parsed.map((p) => [
    p.name ? { v: p.name.text, bold: p.name.bold, italic: p.name.italic, indent: levels.indexOf(p.indent) * 3 } : { v: '' },
    ...p.rest.map((c) => ({ v: c.text || null })),
  ]);
  return { grid, title: title ? unhtml(title) : null };
}

/** Tally's HTML export of a report: read as the grid Excel would give. */
function fromHtml(html: string): TallyReport | null {
  const g = htmlGrid(html);
  if (!g) return null;
  // The title first, as Excel has it, so the grid reader finds it.
  if (g.title && !g.grid.slice(0, 5).some((r) => kindOfTitle(cellText(r[0])))) g.grid.unshift([{ v: g.title }]);
  return readTallyReportGrid(g.grid, 'HTML');
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * A Tally report from a text file: the report XML, HTML, ASCII (comma
 * separated) or SDF (fixed width). Null when the text is none of these.
 */
export function readTallyReportText(text: string, fileName = ''): TallyReport | null {
  const t = text.replace(/^﻿/, '');
  const head = t.slice(0, 600).trimStart();
  if (head.startsWith('<')) {
    if (/^<(!doctype\s+)?html/i.test(head) || /<TABLE/i.test(head)) return fromHtml(t);
    return fromReportXml(t);
  }
  if (/\.(html?|xml)$/i.test(fileName)) return null;
  // ASCII: Tally's comma-separated rows, quoted names, a comma at each line's end.
  if (/^"[^"]*",|^\d{1,2}-[A-Za-z]{3}-\d{2,4},/m.test(head)) {
    const rows = Papa.parse<string[]>(t, { delimiter: ',', skipEmptyLines: 'greedy' }).data;
    return fromRows(rows, 'ASCII');
  }
  const sdf = sdfRows(t);
  return sdf ? fromRows(sdf, 'SDF') : null;
}

/** A picture of a report (PDF, JPEG), known by Tally's name for its file: it cannot be read inside. */
export function tallyReportPicture(fileName: string): TallyReport | null {
  const baseName = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[a-z0-9]+$/i, '');
  const hit = FILE_NAMES.find(([re]) => re.test(baseName));
  if (!hit) return null;
  const format: ReportFormat = /\.pdf$/i.test(fileName) ? 'PDF' : 'picture';
  const r = base(hit[1], hit[2], format, null, null);
  r.problem = `This is a ${format === 'PDF' ? 'PDF' : 'picture'} of Tally's ${hit[2]}: it shows the figures but they cannot be read out of it. Export it from Tally again with File Format set to Excel, XML or JSON${hit[1] === 'day-book' || hit[1] === 'ledger' ? ' (for vouchers, XML or JSON from Alt+E → Transactions)' : ''}.`;
  return r;
}

// ── Several reports, one import ─────────────────────────────────────────────

export interface CombinedReports {
  masters: TallyMasters;
  company: string | null;
  notes: string[];
  /** What is brought in, for the screen. */
  ledgers: number;
  stockItems: number;
  bills: number;
}

/** The primary group a ledger's group leads to, through the groups the reports showed. */
function primaryOf(groups: Map<string, string>, parent: string): string | null {
  let g = parent;
  for (let i = 0; i < 30 && g; i++) {
    if (PRIMARY_SET.has(lower(g)) || SUB.includes(lower(g))) {
      // A sub-group of Tally's own sits under a primary one; walk on for the P&L test.
      const up = groups.get(g);
      if (!up || PRIMARY_SET.has(lower(g))) return lower(g);
    }
    g = groups.get(g) ?? '';
  }
  return null;
}

/**
 * The reports chosen together, as one masters export: the Trial Balance's
 * ledgers, each party's bills from the bills reports, the items from the
 * Stock Summary. Income and expenses are closed into Profit & Loss A/c with
 * the year's opening and closing stock, as Tally carries balances forward.
 */
export function combineTallyReports(reports: TallyReport[]): CombinedReports {
  const ok = reports.filter((r) => !r.problem);
  const out = emptyMasters();
  const notes: string[] = [];
  const byName = new Map<string, TallyLedger>();
  const company = ok.find((r) => r.company)?.company ?? null;
  for (const r of ok) for (const [k, v] of r.masters.groups) if (!out.groups.has(k)) out.groups.set(k, v);

  const tbs = ok.filter((r) => r.kind === 'trial-balance');
  for (const r of tbs) for (const l of r.masters.ledgers) {
    const have = byName.get(lower(l.name));
    if (have) { have.balancePaise += l.balancePaise; continue; }
    const copy = { ...l, bills: [...l.bills] };
    byName.set(lower(l.name), copy);
    out.ledgers.push(copy);
  }

  let bills = 0;
  for (const r of ok.filter((x) => x.kind === 'bills-receivable' || x.kind === 'bills-payable')) {
    for (const l of r.masters.ledgers) {
      bills += l.bills.length;
      const have = byName.get(lower(l.name));
      if (!have) {
        const copy = { ...l, bills: [...l.bills] };
        byName.set(lower(l.name), copy);
        out.ledgers.push(copy);
        continue;
      }
      have.bills.push(...l.bills);
      const sum = have.bills.reduce((t, b) => t + b.amountPaise, 0);
      if (sum !== have.balancePaise) {
        notes.push(`${have.name}: the Trial Balance has ${rupeeText(have.balancePaise)} and its bills come to ${rupeeText(sum)}; the bills are brought in, so the difference stays in Opening Balance Adjustments.`);
      }
    }
  }

  const seenItem = new Set<string>();
  let closing: number | null = null;
  for (const r of ok.filter((x) => x.kind === 'stock-summary')) {
    for (const s of r.masters.stockItems) {
      if (seenItem.has(lower(s.name))) continue;
      seenItem.add(lower(s.name));
      out.stockItems.push({ ...s });
    }
    closing = (closing ?? 0) + (r.closingStockPaise ?? 0);
  }

  // Close the year, as Tally does when it carries balances forward.
  if (tbs.length) {
    const opening = tbs.reduce((t, r) => t + r.openingStockPaise, 0);
    const tbClosing = tbs.reduce<number | null>((t, r) => (r.closingStockPaise === null ? t : (t ?? 0) + r.closingStockPaise), null);
    const closingStock = closing ?? tbClosing ?? 0;
    let result = opening - closingStock;
    let any = false;
    for (const l of out.ledgers) {
      const p = primaryOf(out.groups, l.parent);
      if (p && PL_GROUPS.has(p) && l.balancePaise) { result += l.balancePaise; l.balancePaise = 0; any = true; }
    }
    if (any || opening || closingStock) {
      let pl = byName.get('profit & loss a/c');
      if (!pl) { pl = blankLedger('Profit & Loss A/c', '', 0); out.ledgers.push(pl); byName.set('profit & loss a/c', pl); }
      pl.balancePaise += result;
      const asAt = tbs.find((r) => r.asAt)?.asAt;
      notes.push(`Income and expenses${asAt ? ` to ${asAt.split('-').reverse().join('-')}` : ''}, with opening stock of ${rupeeText(opening)} and closing stock of ${rupeeText(closingStock)}, close into Profit & Loss A/c (Retained earnings here) as Tally does when it carries balances into a new year: a ${result > 0 ? 'loss' : 'profit'} of ${rupeeText(result)}.`);
    }
    if (closing === null && tbClosing === null && opening) {
      notes.push('No Stock Summary came with the Trial Balance, so the closing stock is taken as nil and no items are brought in. Add the Stock Summary as at the same day for each item and its value.');
    }
    const tbDay = tbs.find((r) => r.asAt)?.asAt;
    const stockDay = ok.find((r) => r.kind === 'stock-summary' && r.asAt)?.asAt;
    if (tbDay && stockDay && tbDay !== stockDay) {
      notes.push(`The Trial Balance is as at ${tbDay.split('-').reverse().join('-')} and the Stock Summary as at ${stockDay.split('-').reverse().join('-')}: export both for the same day.`);
    }
  }
  for (const r of ok) notes.push(...r.notes);
  return {
    masters: out, company, notes,
    ledgers: out.ledgers.length, stockItems: out.stockItems.length, bills,
  };
}

// ── Back to Tally's XML, for the import ─────────────────────────────────────

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Paise with debits positive, as Tally writes rupees: a debit negative. */
const tallyAmount = (p: number) => (-p / 100).toFixed(2);
const tallyDate = (isoDay: string | null) => (isoDay ? isoDay.replace(/-/g, '') : '');

/** Masters as Tally's own XML export of them, for the import that reads that (lib/tally/xml). */
export function tallyMastersXml(m: TallyMasters, company: string | null = null): string {
  const parts: string[] = [];
  for (const [name, parent] of m.groups) {
    if (PREDEFINED.has(lower(name))) continue;
    parts.push(`<TALLYMESSAGE><GROUP NAME="${escXml(name)}"><NAME.LIST><NAME>${escXml(name)}</NAME></NAME.LIST><PARENT>${escXml(parent)}</PARENT></GROUP></TALLYMESSAGE>`);
  }
  for (const l of m.ledgers) {
    const billsXml = l.bills.map((b) =>
      `<BILLALLOCATIONS.LIST><NAME>${escXml(b.ref)}</NAME>${b.date ? `<BILLDATE>${tallyDate(b.date)}</BILLDATE>` : ''}` +
      `${b.creditDays !== null ? `<BILLCREDITPERIOD>${b.creditDays} Days</BILLCREDITPERIOD>` : ''}<OPENINGBALANCE>${tallyAmount(b.amountPaise)}</OPENINGBALANCE></BILLALLOCATIONS.LIST>`).join('');
    parts.push(`<TALLYMESSAGE><LEDGER NAME="${escXml(l.name)}"><NAME.LIST><NAME>${escXml(l.name)}</NAME></NAME.LIST><PARENT>${escXml(l.parent)}</PARENT>` +
      `<OPENINGBALANCE>${tallyAmount(l.balancePaise)}</OPENINGBALANCE>${l.bills.length ? '<ISBILLWISEON>Yes</ISBILLWISEON>' : ''}${billsXml}</LEDGER></TALLYMESSAGE>`);
  }
  for (const s of m.stockItems) {
    const unit = s.unit ?? 'Nos';
    parts.push(`<TALLYMESSAGE><STOCKITEM NAME="${escXml(s.name)}"><NAME.LIST><NAME>${escXml(s.name)}</NAME></NAME.LIST><BASEUNITS>${escXml(unit)}</BASEUNITS>` +
      `<OPENINGBALANCE> ${s.qty} ${escXml(unit)}</OPENINGBALANCE><OPENINGVALUE>${tallyAmount(s.valuePaise)}</OPENINGVALUE></STOCKITEM></TALLYMESSAGE>`);
  }
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    parts.join('\n') + '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}
