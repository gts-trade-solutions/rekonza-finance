import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Exchange rate feeds, as Zoho Books offers them: once switched on, each day's
// rate for every currency the book deals in is fetched and saved, so nobody
// types them in. The rates are the European Central Bank's daily reference
// rates, through the Frankfurter service (no key needed; FX_FEED_URL points
// elsewhere if the business prefers another source of the same shape). A rate
// someone typed for a day is never overwritten by the feed.
//
// Kept in settings (scope fx_feed): whether it is on, and how the last fetch went.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Executor, type Trx } from '../db';
import { setRate } from './fx';

export const FEED_SOURCE = 'Feed: ECB reference rate';
const SCOPE = 'fx_feed';

type Fetcher = (url: string) => Promise<Response>;
const realFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
let fetcher: Fetcher = realFetch;
/** For tests: answer the feed without the network. */
export function setFxFetcher(f: Fetcher | null) { fetcher = f ?? realFetch; }

const feedUrl = () => (process.env.FX_FEED_URL || 'https://api.frankfurter.dev/v1').replace(/\/$/, '');
const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

export interface FeedState { enabled: boolean; lastRunOn: string | null; lastDate: string | null; lastError: string | null; lastSaved: number }

export async function getFxFeed(ex: Executor, orgId: number): Promise<FeedState> {
  const row = await ex.selectFrom('settings').select('value').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'config').executeTakeFirst();
  let v: Partial<FeedState> = {};
  try { v = (typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value ?? {}) as Partial<FeedState>; } catch { /* the default */ }
  return { enabled: v.enabled === true, lastRunOn: v.lastRunOn ?? null, lastDate: v.lastDate ?? null, lastError: v.lastError ?? null, lastSaved: v.lastSaved ?? 0 };
}

async function saveState(ex: Executor, orgId: number, userId: number | null, state: FeedState) {
  const value = JSON.stringify(state);
  const exists = await ex.selectFrom('settings').select('setting_key').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'config').executeTakeFirst();
  if (exists) await ex.updateTable('settings').set({ value, updated_by_user_id: userId }).where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', 'config').execute();
  else await ex.insertInto('settings').values({ org_id: orgId, scope: SCOPE, setting_key: 'config', value, updated_by_user_id: userId }).execute();
}

export async function setFxFeed(trx: Trx, orgId: number, userId: number | null, enabled: boolean) {
  const s = await getFxFeed(trx, orgId);
  await saveState(trx, orgId, userId, { ...s, enabled });
}

/** The currencies the book deals in: on contacts, on documents, and those it has rates for. */
export async function feedCurrencies(ex: Executor, orgId: number): Promise<string[]> {
  const [contacts, invoices, bills, rates] = await Promise.all([
    ex.selectFrom('contacts').select('currency').distinct().where('org_id', '=', orgId).where('is_archived', '=', 0).execute(),
    ex.selectFrom('invoices').select('currency').distinct().where('org_id', '=', orgId).execute(),
    ex.selectFrom('bills').select('currency').distinct().where('org_id', '=', orgId).execute(),
    ex.selectFrom('exchange_rates').select('currency').distinct().where('org_id', '=', orgId).execute(),
  ]);
  const all = [...contacts, ...invoices, ...bills, ...rates].map((r) => String(r.currency ?? '').toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c) && c !== 'INR');
  return [...new Set(all)].sort();
}

/**
 * Rupees for one unit of each currency, on the feed's latest day. The feed
 * answers in units per rupee; a currency it does not carry is left out.
 */
export async function fetchFeedRates(currencies: string[]): Promise<{ date: string; rates: Record<string, number>; missing: string[] }> {
  const ask = async (list: string[]) => {
    const res = await fetcher(`${feedUrl()}/latest?from=INR&to=${list.join(',')}`);
    if (!res.ok) throw new Error(`The rate feed answered ${res.status}.`);
    const body = await res.json() as { date?: string; rates?: Record<string, number> };
    if (!body.date || !body.rates) throw new Error('The rate feed answered with something other than rates.');
    return { date: body.date, rates: body.rates };
  };
  const rates: Record<string, number> = {};
  let date = '';
  try {
    const all = await ask(currencies);
    date = all.date;
    Object.assign(rates, all.rates);
  } catch (err) {
    // One currency the feed does not know spoils the whole request: ask one at a time.
    if (currencies.length === 1) throw err;
    for (const c of currencies) {
      try { const one = await ask([c]); date ||= one.date; Object.assign(rates, one.rates); } catch { /* not carried */ }
    }
    if (!date) throw err;
  }
  const out: Record<string, number> = {};
  for (const c of currencies) {
    const perRupee = rates[c];
    if (perRupee > 0) out[c] = Math.round((1 / perRupee) * 10_000) / 10_000;
  }
  return { date, rates: out, missing: currencies.filter((c) => !(c in out)) };
}

/** Fetch and save today's rates for one book. A rate typed by hand for the same day stays. */
export async function refreshRates(orgId: number, userId: number | null = null, now = new Date()) {
  const state = await getFxFeed(db, orgId);
  const currencies = await feedCurrencies(db, orgId);
  if (!currencies.length) {
    await saveState(db, orgId, userId, { ...state, lastRunOn: todayIso(now), lastError: null, lastSaved: 0 });
    return { date: null, saved: [] as { currency: string; rate: number }[], kept: [] as string[], missing: [] as string[] };
  }
  try {
    const feed = await fetchFeedRates(currencies);
    return await transaction(async (trx) => {
      const saved: { currency: string; rate: number }[] = [];
      const kept: string[] = [];
      for (const [currency, rate] of Object.entries(feed.rates)) {
        const own = await trx.selectFrom('exchange_rates').select('source').where('org_id', '=', orgId).where('currency', '=', currency).where('rate_date', '=', feed.date).executeTakeFirst();
        if (own && !String(own.source ?? '').startsWith('Feed:')) { kept.push(currency); continue; }
        await setRate(trx, orgId, { currency, date: feed.date, rate, source: FEED_SOURCE });
        saved.push({ currency, rate });
      }
      await saveState(trx, orgId, userId, { ...state, lastRunOn: todayIso(now), lastDate: feed.date, lastError: null, lastSaved: saved.length });
      return { date: feed.date, saved, kept, missing: feed.missing };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveState(db, orgId, userId, { ...state, lastRunOn: todayIso(now), lastError: message });
    throw err;
  }
}

/** The day's fetch for every book that has the feed on and has not fetched today. */
export async function runFxFeeds(now = new Date()): Promise<number> {
  const rows = await db.selectFrom('settings').select(['org_id', 'value']).where('scope', '=', SCOPE).where('setting_key', '=', 'config').execute();
  let done = 0;
  for (const r of rows) {
    const s = await getFxFeed(db, r.org_id);
    if (!s.enabled || s.lastRunOn === todayIso(now)) continue;
    try { await refreshRates(r.org_id, null, now); done++; } catch (err) {
      console.error('[fx-feed]', r.org_id, err instanceof Error ? err.message : err);
    }
  }
  return done;
}
