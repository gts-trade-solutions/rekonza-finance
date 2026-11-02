// Exchange rate feeds, as Zoho Books offers them (services/fx-feed.ts): each
// day's rate for the currencies the book deals in, fetched and saved once the
// feed is on; a rate typed by hand for the day is kept; a currency the feed
// does not carry is skipped; a failure is recorded, not hidden. The feed is
// answered by a stand-in, never the network.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-feed.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../../lib/server/db';
import { setRate, rateOn } from '../../lib/server/services/fx';
import { FEED_SOURCE, feedCurrencies, getFxFeed, refreshRates, runFxFeeds, setFxFeed, setFxFetcher } from '../../lib/server/services/fx-feed';
import { wipeOrganizations } from '../../lib/server/seed/wipe';

// Units per rupee, as the ECB-based feed quotes them from INR.
const PER_RUPEE: Record<string, number> = { USD: 0.0119, EUR: 0.0102, GBP: 0.0089 };
const asked: string[] = [];
function stand_in(url: string) {
  asked.push(url);
  const to = new URL(url).searchParams.get('to')!.split(',');
  if (to.some((c) => !(c in PER_RUPEE))) return Promise.resolve(new Response(JSON.stringify({ message: 'not found' }), { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify({ amount: 1, base: 'INR', date: '2026-10-30', rates: Object.fromEntries(to.map((c) => [c, PER_RUPEE[c]])) })));
}

test('the feed saves the day’s rates, keeps a typed one, skips what it does not carry, and runs once a day when on', async () => {
  setFxFetcher(stand_in);
  let orgId = 0;
  try {
    orgId = await transaction(async (trx) => {
      const id = Number((await trx.insertInto('organizations').values({ name: 'FX Feed Co (temporary)' }).executeTakeFirstOrThrow()).insertId);
      for (const [name, currency] of [['US Buyer', 'USD'], ['Euro Buyer', 'EUR'], ['Odd Buyer', 'XYZ'], ['Local', 'INR']]) {
        await trx.insertInto('contacts').values({ org_id: id, kind: 'customer', display_name: name, state_code: '33', gst_treatment: 'overseas', currency } as never).execute();
      }
      // Someone typed the euro rate for that day already.
      await setRate(trx, id, { currency: 'EUR', date: '2026-10-30', rate: 97.5, source: null });
      return id;
    });
    assert.deepEqual(await feedCurrencies(db, orgId), ['EUR', 'USD', 'XYZ']);
    assert.equal((await getFxFeed(db, orgId)).enabled, false, 'off until switched on');

    const r = await refreshRates(orgId, null, new Date('2026-10-31T06:00:00Z'));
    assert.equal(r.date, '2026-10-30');
    assert.deepEqual(r.saved, [{ currency: 'USD', rate: 84.0336 }], 'rupees for one dollar, from units per rupee');
    assert.deepEqual(r.kept, ['EUR'], 'the typed rate stays');
    assert.deepEqual(r.missing, ['XYZ']);
    assert.equal(asked.length, 4, 'one request for all, then one each when the feed refused one of them');
    assert.equal(await rateOn(db, orgId, 'USD', '2026-11-02'), 84.0336, 'the weekend uses Friday’s rate');
    assert.equal(await rateOn(db, orgId, 'EUR', '2026-10-30'), 97.5);
    const usd = await db.selectFrom('exchange_rates').select('source').where('org_id', '=', orgId).where('currency', '=', 'USD').executeTakeFirstOrThrow();
    assert.equal(usd.source, FEED_SOURCE);

    // The daily run: nothing while off; once on, one fetch a day.
    assert.equal(await runFxFeeds(new Date('2026-11-01T06:00:00Z')), 0);
    await transaction((trx) => setFxFeed(trx, orgId, null, true));
    const before = asked.length;
    const ran = await runFxFeeds(new Date('2026-11-01T06:00:00Z'));
    assert.ok(ran >= 1, 'this book was fetched');
    assert.ok(asked.length > before);
    const state = await getFxFeed(db, orgId);
    assert.deepEqual([state.enabled, state.lastRunOn, state.lastDate, state.lastError], [true, '2026-11-01', '2026-10-30', null]);
    const afterFirst = asked.length;
    await runFxFeeds(new Date('2026-11-01T18:00:00Z'));
    assert.equal(asked.length, afterFirst, 'not twice the same day');

    // A feed that fails says so.
    setFxFetcher(() => Promise.reject(new Error('network down')));
    await assert.rejects(refreshRates(orgId, null, new Date('2026-11-02T06:00:00Z')), /network down/);
    assert.equal((await getFxFeed(db, orgId)).lastError, 'network down');
  } finally {
    setFxFetcher(null);
    if (orgId) await wipeOrganizations(db, [orgId]);
  }
});

test.after(async () => {
  await db.destroy();
});
