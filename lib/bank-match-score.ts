// How a bank line is matched to the books, as Zoho Books' "Best Matches" and
// "Possible Matches" do it: the same amount, a party the narration names, a
// document number or reference it carries, and a date near the line's. Pure
// functions over plain values, so the scoring is tested without a database
// (scripts/tests/bank-match.test.ts); lib/server/services/bank-match.ts loads
// what is open in the books and posts the match.

export type CandidateType = 'invoice' | 'bill' | 'payment' | 'expense' | 'transfer' | 'journal';

export interface Candidate {
  /** `${type}:${id}`: unique across types. */
  key: string;
  type: CandidateType;
  id: string;
  number: string;
  /** Who it is with, or what it is for (a transfer's other account, a journal's memo). */
  party: string | null;
  contactId: string | null;
  date: string;
  /** What it would take of the line: an open document's balance, a recorded transaction's amount. */
  amountPaise: number;
  /** An open document's total, when it is partly paid. */
  totalPaise?: number;
  /** Text a bank narration may carry for it: a cheque number, a UTR, a reference. */
  reference?: string | null;
  /** Its party's names, to find in the narration. */
  names?: string[];
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** Why it was offered, in words for the screen. */
  reasons: string[];
  /** Confident: offered under Best Matches with a one-click Match. */
  best: boolean;
}

/** Several open documents of one party that add up to the line exactly. */
export interface GroupMatch {
  key: string;
  party: string | null;
  members: ScoredCandidate[];
  amountPaise: number;
  reasons: string[];
}

export interface BankLineFacts {
  date: string;
  amountPaise: number;
  direction: 'in' | 'out';
  narration: string;
  reference?: string | null;
}

/** Letters and digits only, in capitals: how a document number survives a bank's narration. */
export const bare = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Words that say nothing about who a party is. */
const NOISE = new Set([
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'INC', 'THE', 'AND', 'OF',
  'M/S', 'MS', 'MR', 'MRS', 'SHRI', 'SRI', 'INDIA', 'INDIAN', 'ENTERPRISES', 'ENTERPRISE', 'TRADERS', 'TRADING',
  'SERVICES', 'SERVICE', 'SOLUTIONS', 'INDUSTRIES', 'GROUP', 'AGENCIES', 'AGENCY', 'STORES', 'STORE', 'AND',
]);
/** Words a bank adds to every narration. */
const BANK_WORDS = new Set([
  'NEFT', 'RTGS', 'IMPS', 'UPI', 'MMT', 'INF', 'INFT', 'TRF', 'TRANSFER', 'CR', 'DR', 'BY', 'TO', 'FROM', 'PAY', 'PAYMENT',
  'BANK', 'OF', 'THE', 'AND', 'ACH', 'NACH', 'ECS', 'CHQ', 'CHEQUE', 'CLG', 'POS', 'ATM', 'REF', 'NO', 'IFT',
]);

/** A narration's words, without the bank's own and without bare numbers. */
export function narrationWords(narration: string): string[] {
  return narration.toUpperCase().split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !BANK_WORDS.has(w) && !/^\d+$/.test(w));
}

/** A party name's words that identify it. */
export function nameWords(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !NOISE.has(w));
}

/**
 * How strongly the narration names this party, 0 to 1. A word counts when the
 * narration has it, or a word starting with it ("BONITAA" for "Bonita"), or
 * the whole name run together ("RACEAUTOSPARES"). Part of a name counts only
 * when its first word is there: that is the word that tells "Kochi Motor
 * Mart" from "Apex Motors", where the trade words are the same.
 */
export function nameStrength(narration: string, names: string[]): number {
  const words = narrationWords(narration);
  const flat = bare(narration);
  let best = 0;
  for (const name of names) {
    const want = nameWords(name);
    if (!want.length) continue;
    const joined = want.join('');
    if (joined.length >= 6 && flat.includes(joined)) return 1;
    const hits = want.map((w) => words.some((n) => n === w || (w.length >= 4 && n.startsWith(w)) || (n.length >= 5 && w.startsWith(n))));
    const share = hits.filter(Boolean).length / want.length;
    best = Math.max(best, hits[0] ? share : Math.min(share, 0.25));
  }
  return best;
}

/** The narration carries this number or reference, not as part of a longer number. */
export function carries(text: string, code: string | null | undefined, min = 4): boolean {
  if (!code) return false;
  const key = bare(code);
  if (key.length < min) return false;
  return new RegExp(`${key}(?![0-9])`).test(bare(text));
}

const days = (a: string, b: string) => Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000);

/** One candidate's score for a line, with the reasons behind it. */
export function scoreCandidate(line: BankLineFacts, c: Candidate): ScoredCandidate {
  const text = `${line.narration} ${line.reference ?? ''}`;
  let score = 0;
  const reasons: string[] = [];
  const exact = c.amountPaise === line.amountPaise;
  if (exact) { score += 45; reasons.push('Same amount'); }
  else if (c.amountPaise > line.amountPaise && (c.type === 'invoice' || c.type === 'bill')) {
    score += 5; // could be a part payment of it
  }

  if (carries(text, c.number)) { score += 40; reasons.push(`The narration names ${c.number}`); }
  else if (carries(text, c.reference, 6)) { score += 35; reasons.push('The reference matches'); }

  const named = c.names?.length ? nameStrength(line.narration, c.names) : 0;
  if (named >= 1) { score += 30; reasons.push(`The narration names ${c.party}`); }
  else if (named >= 0.5) { score += 18; reasons.push(`The narration looks like ${c.party}`); }

  const gap = days(line.date, c.date);
  if (c.type === 'invoice' || c.type === 'bill') {
    // Money moves after the document is raised, not long before it.
    if (gap >= -3) score += 10;
    else { score -= 20; reasons.push('Raised after the money moved'); }
  } else {
    const away = Math.abs(gap);
    if (away <= 3) { score += 25; reasons.push(away === 0 ? 'Same day' : `${away} day${away === 1 ? '' : 's'} apart`); }
    else if (away <= 7) { score += 15; reasons.push(`${away} days apart`); }
    else if (away <= 30) score += 5;
    else if (away > 60) score -= 10;
  }

  const best = exact && score >= 70;
  return { ...c, score, reasons, best };
}

/**
 * The line's matches: confident ones first (Best Matches), then the rest worth
 * a look (Possible Matches). A recorded transaction already matched to another
 * line never reaches here; the loader leaves it out.
 */
export function rankCandidates(line: BankLineFacts, pool: Candidate[], limit = 25): { best: ScoredCandidate[]; possible: ScoredCandidate[] } {
  const scored = pool.map((c) => scoreCandidate(line, c)).sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  const best = scored.filter((c) => c.best);
  // Worth a look: the same amount, or something the narration points at. For an open invoice or bill
  // that is its party, so the party's other documents show for a part payment or several at once; for
  // something already recorded, its party within a month, or its number or reference. A date alone is not enough.
  const possible = scored.filter((c) => {
    if (c.best) return false;
    if (c.amountPaise === line.amountPaise) return true;
    const numbered = c.reasons.some((r) => r.startsWith(`The narration names ${c.number}`) || r === 'The reference matches');
    const named = c.reasons.some((r) => r.startsWith('The narration names') || r.startsWith('The narration looks'));
    if (c.type === 'invoice' || c.type === 'bill') return named || numbered;
    return numbered || (named && Math.abs(days(line.date, c.date)) <= 30);
  });
  return { best: best.slice(0, 5), possible: possible.slice(0, limit) };
}

/**
 * Open documents of one party the narration names that add up to the line to
 * the paisa: two invoices settled by one transfer. Up to four documents among
 * a party's twelve oldest, so the search stays small.
 */
export function groupMatches(line: BankLineFacts, scored: ScoredCandidate[]): GroupMatch[] {
  const docs = scored.filter((c) => (c.type === 'invoice' || c.type === 'bill') && c.reasons.some((r) => r.startsWith('The narration names') || r.startsWith('The narration looks')));
  const byParty = new Map<string, ScoredCandidate[]>();
  for (const d of docs) {
    const k = d.contactId ?? d.party ?? '';
    byParty.set(k, [...(byParty.get(k) ?? []), d]);
  }
  const out: GroupMatch[] = [];
  for (const [, list] of byParty) {
    const pick = list.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
    if (pick.length < 2) continue;
    const found: ScoredCandidate[][] = [];
    const walk = (start: number, chosen: ScoredCandidate[], sum: number) => {
      if (found.length) return;
      if (sum === line.amountPaise && chosen.length >= 2) { found.push([...chosen]); return; }
      if (chosen.length === 4 || sum >= line.amountPaise) return;
      for (let i = start; i < pick.length; i++) walk(i + 1, [...chosen, pick[i]], sum + pick[i].amountPaise);
    };
    walk(0, [], 0);
    if (found.length) {
      const members = found[0];
      out.push({
        key: members.map((m) => m.key).join('+'),
        party: members[0].party,
        members,
        amountPaise: line.amountPaise,
        reasons: [`${members.length} of ${members[0].party ?? 'this party'}’s open documents add up to the amount`],
      });
    }
  }
  return out;
}

/** How a mode of payment reads in a narration. */
export function modeFromNarration(narration: string): 'upi' | 'neft' | 'rtgs' | 'imps' | 'cheque' | 'card' | 'other' {
  const t = narration.toUpperCase();
  if (/\bUPI\b|UPI\//.test(t)) return 'upi';
  if (/RTGS/.test(t)) return 'rtgs';
  if (/IMPS|MMT/.test(t)) return 'imps';
  if (/NEFT/.test(t)) return 'neft';
  if (/\bCHQ\b|CHEQUE|CLG/.test(t)) return 'cheque';
  if (/\bPOS\b|CARD/.test(t)) return 'card';
  return 'other';
}
