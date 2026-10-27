// ─────────────────────────────────────────────────────────────────────────────
// One sync: every company open in TallyPrime, sent to the portal.
//
//   1. hello        the open companies; the portal answers with where each
//                   one's sync should resume
//   2. vouchers     only those changed since the last AlterID the portal
//                   holds — the first time, the current and previous
//                   financial year, a month at a time
//   3. balances     groups, ledgers and stock items with the closing balances
//                   Tally computes, whenever anything changed, and at least
//                   once a day so "as at" moves with the calendar
//   4. deletions    once a day, the complete list of voucher GUIDs, month by
//                   month, so vouchers deleted in Tally are removed too
//
// A company that fails does not stop the others; its error is reported to the
// portal against that company. Tally being closed is not an error worth
// alarming anyone about — it is reported once, and the next sync tries again.
// ─────────────────────────────────────────────────────────────────────────────

import {
  MAX_INDEX_GUIDS, MAX_MASTERS_PER_MESSAGE, TALLY_PROTOCOL_VERSION,
  type HelloMessage, type HelloReply, type MastersMessage, type VouchersReply,
} from '../../lib/tally/protocol';
import type { CompanyState } from './config';
import {
  addDays, baseTypeOf, currentFyStart, debitPaise, months, natureOf, quantity, toVouchers, yes,
} from './mapper';
import type { PortalLink } from './portal';
import { fetchRows, TallyUnavailable, type TallyAddress } from './tally-client';
import { requests } from './tally-requests';

const VOUCHER_BATCH = 500;

export interface SyncOptions {
  tally: TallyAddress;
  portal: PortalLink;
  /** Per company, by GUID. Updated in place; the caller saves it. */
  state: Record<string, CompanyState>;
  machineName: string;
  connectorVersion: string;
  /** YYYY-MM-DD on this PC. Passed in by tests. */
  today?: string;
  log?: (line: string) => void;
}

export interface CompanySummary {
  name: string;
  vouchersSent: number;
  vouchersRejected: { guid: string; reason: string }[];
  mastersSent: boolean;
  deletions: number;
  error?: string;
}

export interface SyncSummary {
  companies: CompanySummary[];
  /** Set when Tally itself could not be reached. */
  tallyError?: string;
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const yearBefore = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function syncOnce(o: SyncOptions): Promise<SyncSummary> {
  const log = o.log ?? (() => {});
  const today = o.today ?? localToday();

  let companyRows;
  try {
    companyRows = (await fetchRows(requests.companies(), o.tally)).filter((c) => c.guid && c.name);
  } catch (err) {
    const message = (err as Error).message;
    await o.portal.send({ kind: 'status', error: message.slice(0, 500) }).catch(() => {});
    if (err instanceof TallyUnavailable) return { companies: [], tallyError: message };
    throw err;
  }
  if (!companyRows.length) {
    const message = 'No company is open in TallyPrime. Open the companies to sync, and the next sync will send them.';
    await o.portal.send({ kind: 'status', error: message }).catch(() => {});
    return { companies: [], tallyError: message };
  }

  // What each company needs worked out before hello: its year, and whether it keeps stock.
  const prepared = [];
  for (const c of companyRows) {
    const name = c.name!;
    const fyFrom = currentFyStart(c.startingFrom, today);
    const booksFrom = c.booksFrom ?? fyFrom;
    // The current year and the one before, or everything if the books are younger.
    const syncFrom = booksFrom > yearBefore(fyFrom) ? booksFrom : yearBefore(fyFrom);
    const items = await fetchRows(requests.stockItems(name, fyFrom, today), o.tally);
    prepared.push({
      guid: c.guid!,
      name,
      fyFrom,
      booksFrom,
      syncFrom,
      items,
      altMstId: Math.floor(quantity(c.altMstId)),
      altVchId: Math.floor(quantity(c.altVchId)),
    });
  }

  const hello: HelloMessage = {
    kind: 'hello',
    protocol: TALLY_PROTOCOL_VERSION,
    machineName: o.machineName,
    connectorVersion: o.connectorVersion,
    tallyVersion: null,
    companies: prepared.map((p) => ({
      guid: p.guid,
      name: p.name,
      booksFrom: p.booksFrom,
      fyFrom: p.fyFrom,
      gstin: null,
      stateName: null,
      maintainsInventory: p.items.length > 0,
    })),
  };
  const reply = await o.portal.send<HelloReply>(hello);
  const resume = new Map(reply.companies.map((c) => [c.guid, c]));

  const summaries: CompanySummary[] = [];
  for (const p of prepared) {
    const summary: CompanySummary = { name: p.name, vouchersSent: 0, vouchersRejected: [], mastersSent: false, deletions: 0 };
    summaries.push(summary);
    const state = (o.state[p.guid] ??= {});
    const held = resume.get(p.guid);
    const heldVoucherAlterId = held?.voucherAlterId ?? 0;
    // Post-dated vouchers are real vouchers: read a year past today as well.
    const vouchersTo = addDays(today, 366);

    try {
      // ── Vouchers changed since the portal's last AlterID ──
      const vouchersChanged = p.altVchId > heldVoucherAlterId;
      if (vouchersChanged) {
        const types = await fetchRows(requests.voucherTypes(p.name), o.tally);
        const parents = new Map(types.filter((t) => t.name).map((t) => [t.name!, t.parent]));
        const windows = heldVoucherAlterId === 0 ? months(p.syncFrom, vouchersTo) : [{ from: p.syncFrom, to: vouchersTo }];
        for (const w of windows) {
          // Tally does not always keep to the period it is given: asked for the
          // month the books begin in, a real TallyPrime answers with every
          // voucher the company has. Keeping only the ones inside the window
          // stops the same voucher being sent once per window.
          const all = await fetchRows(requests.vouchers(p.name, w.from, w.to, heldVoucherAlterId), o.tally);
          const rows = all.filter((r) => r.date && r.date >= w.from && r.date <= w.to);
          if (!rows.length) continue;
          const inWindow = new Set(rows.map((r) => r.guid));
          const entries = (await fetchRows(requests.entries(p.name, w.from, w.to, heldVoucherAlterId), o.tally))
            .filter((e) => inWindow.has(e.guid));
          const vouchers = toVouchers(rows, entries, parents);
          for (const batch of chunks(vouchers, VOUCHER_BATCH)) {
            const r = await o.portal.send<VouchersReply>({ kind: 'vouchers', companyGuid: p.guid, vouchers: batch });
            summary.vouchersSent += r.stored;
            summary.vouchersRejected.push(...r.rejected);
          }
        }
        log(`${p.name}: ${summary.vouchersSent} voucher(s) sent${summary.vouchersRejected.length ? `, ${summary.vouchersRejected.length} refused` : ''}`);
      }

      // ── Balances, whenever anything changed, and daily ──
      const mastersChanged = p.altMstId > (held?.masterAlterId ?? 0) || vouchersChanged || state.mastersSentOn !== today;
      if (mastersChanged) {
        await sendMasters(o, p, today);
        state.mastersSentOn = today;
        summary.mastersSent = true;
        log(`${p.name}: balances as at ${today} sent`);
      }

      // ── Deletions, daily ──
      if (state.indexSentOn !== today) {
        for (const w of months(p.syncFrom, vouchersTo)) {
          // Filtered by the date Tally gives back, not by the period it was
          // asked for: a list that reached beyond the window would be compared
          // against the window's stored vouchers and could read as a deletion.
          const guids = (await fetchRows(requests.voucherGuids(p.name, w.from, w.to), o.tally))
            .filter((g) => g.guid && g.date && g.date >= w.from && g.date <= w.to)
            .map((g) => g.guid!);
          // A month too large to send whole is skipped rather than sent in part:
          // a partial list would read as deletions that never happened.
          if (guids.length > MAX_INDEX_GUIDS) continue;
          const r = await o.portal.send<{ deleted: number }>({ kind: 'voucher-index', companyGuid: p.guid, from: w.from, to: w.to, guids });
          summary.deletions += r.deleted;
        }
        state.indexSentOn = today;
        if (summary.deletions) log(`${p.name}: ${summary.deletions} voucher(s) deleted in Tally removed`);
      }

      await o.portal.send({ kind: 'status', companyGuid: p.guid, error: null });
    } catch (err) {
      summary.error = (err as Error).message;
      log(`${p.name}: ${summary.error}`);
      await o.portal.send({ kind: 'status', companyGuid: p.guid, error: summary.error.slice(0, 500) }).catch(() => {});
      if (err instanceof TallyUnavailable) return { companies: summaries, tallyError: summary.error };
    }
  }

  await o.portal.send({ kind: 'status', error: null }).catch(() => {});
  return { companies: summaries };
}

type Prepared = {
  guid: string;
  name: string;
  fyFrom: string;
  booksFrom: string;
  items: Awaited<ReturnType<typeof fetchRows<ReturnType<typeof requests.stockItems>['columns']>>>;
  altMstId: number;
};

async function sendMasters(o: SyncOptions, p: Prepared, today: string) {
  const groupRows = await fetchRows(requests.groups(p.name), o.tally);
  const groups = groupRows
    .filter((g) => g.name)
    .map((g) => ({
      name: g.name!,
      parent: g.parent || null,
      nature: natureOf(yes(g.isRevenue), yes(g.isDeemedPositive)),
      affectsGrossProfit: yes(g.affectsGrossProfit),
      guid: g.guid,
    }));
  const revenue = new Set(groupRows.filter((g) => g.name && yes(g.isRevenue)).map((g) => g.name!));

  // Openings as at the start of this financial year. For books that began in
  // an earlier year, that is the closing balance the day before it began —
  // Tally's own opening balance field is as at the start of the books.
  const earlier = p.booksFrom < p.fyFrom;
  const dayBefore = addDays(p.fyFrom, -1);
  const ledgerRows = await fetchRows(requests.ledgers(p.name, p.fyFrom, today), o.tally);
  const ledgersBefore = earlier ? await fetchRows(requests.ledgers(p.name, p.booksFrom, dayBefore), o.tally) : [];
  const closingBefore = new Map(ledgersBefore.map((l) => [l.name, l.closing]));
  const ledgers = ledgerRows
    .filter((l) => l.name)
    .map((l) => ({
      name: l.name!,
      parent: l.parent || 'Primary',
      openingPaise: revenue.has(l.parent ?? '') ? 0 : debitPaise(earlier ? (closingBefore.get(l.name) ?? null) : l.opening),
      closingPaise: debitPaise(l.closing),
      gstin: l.gstin?.slice(0, 15) || null,
      stateName: l.state?.slice(0, 60) || null,
      guid: l.guid,
    }));

  const itemsBefore = earlier && p.items.length ? await fetchRows(requests.stockItems(p.name, p.booksFrom, dayBefore), o.tally) : [];
  const before = new Map(itemsBefore.map((s) => [s.name, s]));
  const stockItems = p.items
    .filter((s) => s.name)
    .map((s) => {
      const b = before.get(s.name);
      return {
        name: s.name!,
        parent: s.parent || null,
        unit: s.unit?.slice(0, 30) || null,
        hsn: s.hsn?.slice(0, 12) || null,
        openingQty: earlier ? quantity(b?.closingQty ?? null) : quantity(s.openingQty),
        openingValuePaise: Math.abs(debitPaise(earlier ? (b?.closingValue ?? null) : s.openingValue)),
        closingQty: quantity(s.closingQty),
        closingValuePaise: Math.abs(debitPaise(s.closingValue)),
        guid: s.guid,
      };
    });

  const whole = groups.length <= MAX_MASTERS_PER_MESSAGE && ledgers.length <= MAX_MASTERS_PER_MESSAGE && stockItems.length <= MAX_MASTERS_PER_MESSAGE;
  if (whole) {
    const message: MastersMessage = { kind: 'masters', companyGuid: p.guid, asOf: today, masterAlterId: p.altMstId, full: true, groups, ledgers, stockItems };
    await o.portal.send(message);
    return;
  }
  // Too many to send at once: in parts, adding and updating only. Masters
  // deleted in Tally stay until the company is small enough to send whole.
  const parts = Math.max(
    Math.ceil(groups.length / MAX_MASTERS_PER_MESSAGE),
    Math.ceil(ledgers.length / MAX_MASTERS_PER_MESSAGE),
    Math.ceil(stockItems.length / MAX_MASTERS_PER_MESSAGE),
  );
  for (let i = 0; i < parts; i++) {
    const slice = <T>(list: T[]) => list.slice(i * MAX_MASTERS_PER_MESSAGE, (i + 1) * MAX_MASTERS_PER_MESSAGE);
    await o.portal.send({
      kind: 'masters',
      companyGuid: p.guid,
      asOf: today,
      masterAlterId: i === parts - 1 ? p.altMstId : 0,
      full: false,
      groups: slice(groups),
      ledgers: slice(ledgers),
      stockItems: slice(stockItems),
    });
  }
}

export { baseTypeOf };
