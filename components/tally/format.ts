// How the Tally screens write dates and balances: the way Tally writes them,
// because the people reading these screens have read Tally's for years.

import { formatINR } from '@/lib/money';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15-Sep-26", Tally's own short date. */
export function tallyDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** "15 Sep 2026". */
export function longDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "₹1,23,456.00 Dr" — a signed balance, positive for a debit. */
export function drcr(paise: number): string {
  if (paise === 0) return '—';
  return `${formatINR(Math.abs(paise))} ${paise > 0 ? 'Dr' : 'Cr'}`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** How long since a connector was heard from, as a state a person can act on. */
export function presence(lastSeenAt: string | null): 'online' | 'recent' | 'offline' {
  if (!lastSeenAt) return 'offline';
  const mins = (Date.now() - new Date(lastSeenAt).getTime()) / 60_000;
  return mins < 15 ? 'online' : mins < 24 * 60 ? 'recent' : 'offline';
}
