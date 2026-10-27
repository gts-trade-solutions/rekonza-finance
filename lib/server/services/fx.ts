import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Foreign currency: rates, and restating open balances at a period end.
//
// Receivables and payables in another currency are monetary items: at each
// balance sheet date they are restated at the closing rate and the difference
// taken to profit or loss (AS 11, Ind AS 21). The restatement is reversed the
// next day, so documents keep their booked rupee value and the gain or loss
// on settlement is worked out against it as usual. Advances are not restated:
// they are settled by goods or services, not money.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict } from '../http';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export async function setRate(trx: Trx, orgId: number, o: { currency: string; date: string; rate: number; source?: string | null }) {
  const currency = o.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'INR') throw badRequest('A currency is a three-letter code other than INR.');
  if (!(o.rate > 0)) throw badRequest('A rate is rupees for one unit, above zero.');
  await trx.insertInto('exchange_rates').values({ org_id: orgId, currency, rate_date: o.date, rate: String(o.rate), source: o.source ?? null })
    .onDuplicateKeyUpdate({ rate: String(o.rate), source: o.source ?? null }).execute();
}

export async function listRates(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('exchange_rates').selectAll().where('org_id', '=', orgId)
    .orderBy('rate_date', 'desc').orderBy('currency').limit(200).execute();
  return rows.map((r) => ({ id: String(r.id), currency: r.currency, date: String(r.rate_date).slice(0, 10), rate: Number(r.rate), source: r.source }));
}

/** The latest rate on or before a date. */
export async function rateOn(ex: Executor, orgId: number, currency: string, date: string): Promise<number | null> {
  const r = await ex.selectFrom('exchange_rates').select('rate').where('org_id', '=', orgId).where('currency', '=', currency)
    .where('rate_date', '<=', date).orderBy('rate_date', 'desc').executeTakeFirst();
  return r ? Number(r.rate) : null;
}

export interface ExposureRow {
  kind: 'invoice' | 'bill'; id: string; number: string; contactId: string; party: string; currency: string;
  foreignOpenPaise: Paise; bookedRate: number; carriedPaise: Paise; closingRate: number | null; restatedPaise: Paise | null; differencePaise: Paise | null;
}

/** Open foreign-currency documents at a date, carried and at the closing rate. */
export async function exposure(ex: Executor, orgId: number, date: string): Promise<ExposureRow[]> {
  const { rows } = await sql<{
    kind: 'invoice' | 'bill'; id: number; number: string; contact_id: number; party: string; currency: string;
    exchange_rate: string; fc_total: string; fc_amount_paid: string; total: string; amount_paid: string;
  }>`
    SELECT 'invoice' AS kind, i.id, i.number, i.customer_id AS contact_id, c.display_name AS party, i.currency, i.exchange_rate,
           i.fc_total, i.fc_amount_paid, i.total, i.amount_paid
      FROM invoices i JOIN contacts c ON c.id = i.customer_id
     WHERE i.org_id = ${orgId} AND i.currency <> 'INR' AND i.status NOT IN ('draft', 'void') AND i.invoice_date <= ${date}
       AND i.fc_total > i.fc_amount_paid
    UNION ALL
    SELECT 'bill', b.id, b.internal_no, b.vendor_id, c.display_name, b.currency, b.exchange_rate,
           b.fc_total, b.fc_amount_paid, b.total, b.amount_paid
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.currency <> 'INR' AND b.status NOT IN ('draft', 'void') AND b.bill_date <= ${date}
       AND b.fc_total > b.fc_amount_paid
  `.execute(ex);
  const rates = new Map<string, number | null>();
  const out: ExposureRow[] = [];
  for (const r of rows) {
    if (!rates.has(r.currency)) rates.set(r.currency, await rateOn(ex, orgId, r.currency, date));
    const closing = rates.get(r.currency) ?? null;
    const fcOpen = toPaiseFromSql(r.fc_total) - toPaiseFromSql(r.fc_amount_paid);
    const carried = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
    const restated = closing === null ? null : Math.round(fcOpen * closing);
    out.push({
      kind: r.kind, id: String(r.id), number: r.number, contactId: String(r.contact_id), party: r.party, currency: r.currency,
      foreignOpenPaise: fcOpen, bookedRate: Number(r.exchange_rate), carriedPaise: carried, closingRate: closing,
      restatedPaise: restated, differencePaise: restated === null ? null : restated - carried,
    });
  }
  return out.sort((a, b) => a.party.localeCompare(b.party));
}

/** Restate open balances at the date's closing rates, and reverse it the next day. */
export async function revalue(trx: Trx, orgId: number, userId: number | null, date: string) {
  const done = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId)
    .where('source_type', '=', 'fx_revaluation').where('entry_date', '=', date).executeTakeFirst();
  if (done) throw conflict(`Foreign balances are already restated at ${date}.`);
  const rows = await exposure(trx, orgId, date);
  const missing = [...new Set(rows.filter((r) => r.closingRate === null).map((r) => r.currency))];
  if (missing.length) throw badRequest(`Enter the closing rate for ${missing.join(', ')} on or before ${date} first.`);
  const acc = await accountIds(trx, orgId);
  const lines: DraftLine[] = [];
  let net = 0;
  for (const r of rows) {
    const d = r.differencePaise ?? 0;
    if (!d) continue;
    // A receivable worth more in rupees is an asset gained; a payable worth more is a liability grown.
    const control = requireAccount(acc, r.kind === 'invoice' ? CODE.AR : CODE.AP);
    const effect = r.kind === 'invoice' ? d : -d;
    lines.push(effect > 0
      ? { accountId: control, debit: d > 0 ? d : -d, contactId: Number(r.contactId), description: `${r.number} at ${r.closingRate}` }
      : { accountId: control, credit: d > 0 ? d : -d, contactId: Number(r.contactId), description: `${r.number} at ${r.closingRate}` });
    net += effect;
  }
  if (!lines.length) throw badRequest('Nothing to restate: open balances already stand at the closing rates.');
  lines.push(net > 0
    ? { accountId: requireAccount(acc, CODE.FX_GAIN), credit: net, description: 'Unrealised exchange gain' }
    : { accountId: requireAccount(acc, CODE.FX_LOSS), debit: -net, description: 'Unrealised exchange loss' });
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const entry = await postEntry(trx, {
    orgId, branchId: branch, date, userId, module: 'accountant', sourceType: 'fx_revaluation', sourceId: null,
    memo: `Foreign-currency balances restated at closing rates on ${date}`, lines,
  });
  await reverseEntry(trx, orgId, entry.id, { date: nextDay(date), memo: `Restatement of ${date} reversed`, userId, module: 'accountant' });
  return { entryId: entry.id, netPaise: net, documents: lines.length - 1 };
}
