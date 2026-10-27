import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Storing what a Tally connector sends.
//
// Every message is safe to receive twice. Masters and vouchers are keyed by
// Tally's own names and GUIDs, so a retry after a dropped connection rewrites
// the same rows rather than adding new ones — the failure that makes people
// give up on sync tools. A voucher arriving with an older AlterID than the one
// already held is ignored, so a slow retry can never undo a newer edit.
//
// Nothing here recalculates a balance. The closing balances are Tally's, sent
// as Tally computed them; this side only checks that what arrives is coherent
// enough to store — a voucher whose debits and credits differ is refused, one
// voucher at a time, with the reason.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { ApiError } from '../http';
import type {
  HelloMessage, HelloReply, MastersMessage, SyncMessage, VoucherIndexMessage, VouchersMessage, VouchersReply,
} from '../../tally/protocol';
import type { AuthenticatedConnector } from './connectors';

const CHUNK = 500;

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function companyByGuid(trx: Trx, orgId: number, guid: string) {
  const company = await trx
    .selectFrom('tally_companies')
    .select(['id', 'name', 'voucher_alter_id', 'master_alter_id'])
    .where('org_id', '=', orgId)
    .where('guid', '=', guid)
    .forUpdate()
    .executeTakeFirst();
  if (!company) {
    throw new ApiError(409, 'That company has not been announced yet. Send hello with it first.', 'unknown_company');
  }
  return company;
}

// ── hello ────────────────────────────────────────────────────────────────────

async function hello(trx: Trx, c: AuthenticatedConnector, m: HelloMessage): Promise<HelloReply> {
  await trx
    .updateTable('tally_connectors')
    .set({
      machine_name: m.machineName,
      connector_version: m.connectorVersion,
      tally_version: m.tallyVersion ?? null,
      last_error: null,
    })
    .where('id', '=', c.connectorId)
    .execute();

  const companies: HelloReply['companies'] = [];
  for (const co of m.companies) {
    await trx
      .insertInto('tally_companies')
      .values({
        org_id: c.orgId,
        connector_id: c.connectorId,
        guid: co.guid,
        name: co.name,
        books_from: co.booksFrom ?? null,
        fy_from: co.fyFrom ?? null,
        gstin: co.gstin || null,
        state_name: co.stateName || null,
        maintains_inventory: co.maintainsInventory ? 1 : 0,
      })
      .onDuplicateKeyUpdate({
        // A company opened on another PC now syncs from that PC's connector.
        connector_id: c.connectorId,
        name: co.name,
        books_from: co.booksFrom ?? null,
        fy_from: co.fyFrom ?? null,
        gstin: co.gstin || null,
        state_name: co.stateName || null,
        maintains_inventory: co.maintainsInventory ? 1 : 0,
      })
      .execute();
    const row = await trx
      .selectFrom('tally_companies')
      .select(['id', 'voucher_alter_id', 'master_alter_id'])
      .where('org_id', '=', c.orgId)
      .where('guid', '=', co.guid)
      .executeTakeFirstOrThrow();
    companies.push({
      guid: co.guid,
      companyId: String(row.id),
      voucherAlterId: Number(row.voucher_alter_id),
      masterAlterId: Number(row.master_alter_id),
    });
  }
  return { kind: 'hello', organisation: c.organisation, companies };
}

// ── masters ──────────────────────────────────────────────────────────────────

/** Delete the rows of one master table whose names were not in a full message. */
async function pruneMissing(
  trx: Trx,
  table: 'tally_groups' | 'tally_ledgers' | 'tally_stock_items',
  companyId: number,
  keep: Set<string>,
): Promise<number> {
  const rows = await trx.selectFrom(table).select(['id', 'name']).where('company_id', '=', companyId).execute();
  const gone = rows.filter((r) => !keep.has(r.name)).map((r) => r.id);
  for (const ids of chunks(gone)) await trx.deleteFrom(table).where('id', 'in', ids).execute();
  return gone.length;
}

async function masters(trx: Trx, c: AuthenticatedConnector, m: MastersMessage) {
  const company = await companyByGuid(trx, c.orgId, m.companyGuid);
  const companyId = company.id;

  for (const part of chunks(m.groups)) {
    await trx
      .insertInto('tally_groups')
      .values(
        part.map((g) => ({
          company_id: companyId,
          name: g.name,
          parent: g.parent ?? null,
          nature: g.nature,
          affects_gross_profit: g.affectsGrossProfit ? 1 : 0,
          guid: g.guid ?? null,
        })),
      )
      .onDuplicateKeyUpdate({
        parent: sql`VALUES(parent)`,
        nature: sql`VALUES(nature)`,
        affects_gross_profit: sql`VALUES(affects_gross_profit)`,
        guid: sql`VALUES(guid)`,
      })
      .execute();
  }

  for (const part of chunks(m.ledgers)) {
    await trx
      .insertInto('tally_ledgers')
      .values(
        part.map((l) => ({
          company_id: companyId,
          name: l.name,
          parent: l.parent,
          opening_paise: l.openingPaise,
          closing_paise: l.closingPaise,
          gstin: l.gstin || null,
          state_name: l.stateName || null,
          guid: l.guid ?? null,
        })),
      )
      .onDuplicateKeyUpdate({
        parent: sql`VALUES(parent)`,
        opening_paise: sql`VALUES(opening_paise)`,
        closing_paise: sql`VALUES(closing_paise)`,
        gstin: sql`VALUES(gstin)`,
        state_name: sql`VALUES(state_name)`,
        guid: sql`VALUES(guid)`,
      })
      .execute();
  }

  for (const part of chunks(m.stockItems)) {
    await trx
      .insertInto('tally_stock_items')
      .values(
        part.map((s) => ({
          company_id: companyId,
          name: s.name,
          parent: s.parent ?? null,
          unit: s.unit ?? null,
          hsn: s.hsn ?? null,
          opening_qty: String(s.openingQty),
          opening_value_paise: s.openingValuePaise,
          closing_qty: String(s.closingQty),
          closing_value_paise: s.closingValuePaise,
          guid: s.guid ?? null,
        })),
      )
      .onDuplicateKeyUpdate({
        parent: sql`VALUES(parent)`,
        unit: sql`VALUES(unit)`,
        hsn: sql`VALUES(hsn)`,
        opening_qty: sql`VALUES(opening_qty)`,
        opening_value_paise: sql`VALUES(opening_value_paise)`,
        closing_qty: sql`VALUES(closing_qty)`,
        closing_value_paise: sql`VALUES(closing_value_paise)`,
        guid: sql`VALUES(guid)`,
      })
      .execute();
  }

  let removed = 0;
  if (m.full) {
    removed += await pruneMissing(trx, 'tally_groups', companyId, new Set(m.groups.map((g) => g.name)));
    removed += await pruneMissing(trx, 'tally_ledgers', companyId, new Set(m.ledgers.map((l) => l.name)));
    removed += await pruneMissing(trx, 'tally_stock_items', companyId, new Set(m.stockItems.map((s) => s.name)));
  }

  await trx
    .updateTable('tally_companies')
    .set({
      as_of: m.asOf,
      master_alter_id: Math.max(Number(company.master_alter_id), m.masterAlterId),
      last_synced_at: new Date(),
      last_error: null,
    })
    .where('id', '=', companyId)
    .execute();

  return {
    kind: 'masters' as const,
    groups: m.groups.length,
    ledgers: m.ledgers.length,
    stockItems: m.stockItems.length,
    removed,
    masterAlterId: Math.max(Number(company.master_alter_id), m.masterAlterId),
  };
}

// ── vouchers ─────────────────────────────────────────────────────────────────

/** Why a voucher cannot be stored, or null when it can. */
export function voucherProblem(v: VouchersMessage['vouchers'][number]): string | null {
  if (v.isCancelled) return null;
  const debit = v.entries.reduce((t, e) => t + e.debitPaise, 0);
  const credit = v.entries.reduce((t, e) => t + e.creditPaise, 0);
  if (debit !== credit) {
    return `Debits (${(debit / 100).toFixed(2)}) and credits (${(credit / 100).toFixed(2)}) do not agree.`;
  }
  if (v.entries.some((e) => e.debitPaise > 0 && e.creditPaise > 0)) {
    return 'An entry carries both a debit and a credit.';
  }
  return null;
}

async function vouchers(trx: Trx, c: AuthenticatedConnector, m: VouchersMessage): Promise<VouchersReply> {
  const company = await companyByGuid(trx, c.orgId, m.companyGuid);
  const companyId = company.id;
  const rejected: VouchersReply['rejected'] = [];

  const valid = m.vouchers.filter((v) => {
    const problem = voucherProblem(v);
    if (problem) rejected.push({ guid: v.guid, reason: problem });
    return !problem;
  });

  // The same voucher twice in one message: the later edit wins.
  const byGuid = new Map<string, (typeof valid)[number]>();
  for (const v of valid) {
    const seen = byGuid.get(v.guid);
    if (!seen || v.alterId >= seen.alterId) byGuid.set(v.guid, v);
  }

  let stored = 0;
  let highest = Number(company.voucher_alter_id);

  for (const part of chunks([...byGuid.values()])) {
    const existing = await trx
      .selectFrom('tally_vouchers')
      .select(['guid', 'alter_id'])
      .where('company_id', '=', companyId)
      .where('guid', 'in', part.map((v) => v.guid))
      .execute();
    const held = new Map(existing.map((e) => [e.guid, Number(e.alter_id)]));
    // An older copy than the one already held is a late retry. Ignore it.
    const fresh = part.filter((v) => (held.get(v.guid) ?? -1) <= v.alterId);
    if (!fresh.length) continue;

    await trx
      .insertInto('tally_vouchers')
      .values(
        fresh.map((v) => ({
          company_id: companyId,
          guid: v.guid,
          alter_id: v.alterId,
          voucher_type: v.voucherType,
          base_type: v.baseType,
          number: v.number ?? null,
          date: v.date,
          party: v.party ?? null,
          narration: v.narration ?? null,
          reference: v.reference ?? null,
          amount_paise: v.isCancelled ? 0 : v.entries.reduce((t, e) => t + e.debitPaise, 0),
          is_cancelled: v.isCancelled ? 1 : 0,
          is_optional: v.isOptional ? 1 : 0,
        })),
      )
      .onDuplicateKeyUpdate({
        alter_id: sql`VALUES(alter_id)`,
        voucher_type: sql`VALUES(voucher_type)`,
        base_type: sql`VALUES(base_type)`,
        number: sql`VALUES(number)`,
        date: sql`VALUES(date)`,
        party: sql`VALUES(party)`,
        narration: sql`VALUES(narration)`,
        reference: sql`VALUES(reference)`,
        amount_paise: sql`VALUES(amount_paise)`,
        is_cancelled: sql`VALUES(is_cancelled)`,
        is_optional: sql`VALUES(is_optional)`,
      })
      .execute();

    const ids = await trx
      .selectFrom('tally_vouchers')
      .select(['id', 'guid'])
      .where('company_id', '=', companyId)
      .where('guid', 'in', fresh.map((v) => v.guid))
      .execute();
    const idOf = new Map(ids.map((r) => [r.guid, r.id]));

    // Entries are replaced whole: an edited voucher in Tally can gain, lose or
    // reorder lines, and matching them one by one would only guess.
    await trx.deleteFrom('tally_voucher_entries').where('voucher_id', 'in', [...idOf.values()]).execute();
    const entries = fresh.flatMap((v) =>
      v.isCancelled
        ? []
        : v.entries.map((e, i) => ({
            voucher_id: idOf.get(v.guid)!,
            company_id: companyId,
            line_no: i + 1,
            ledger: e.ledger,
            debit_paise: e.debitPaise,
            credit_paise: e.creditPaise,
          })),
    );
    for (const rows of chunks(entries, 1000)) await trx.insertInto('tally_voucher_entries').values(rows).execute();

    stored += fresh.length;
    for (const v of fresh) highest = Math.max(highest, v.alterId);
  }

  await trx
    .updateTable('tally_companies')
    .set({ voucher_alter_id: highest, last_synced_at: new Date(), last_error: null })
    .where('id', '=', companyId)
    .execute();

  return { kind: 'vouchers', stored, rejected, voucherAlterId: highest };
}

// ── voucher-index ────────────────────────────────────────────────────────────

/**
 * Tally does not report deletions. So every so often the connector sends the
 * complete list of voucher GUIDs in a date window, and anything held here for
 * that window but absent from the list was deleted in Tally.
 */
async function voucherIndex(trx: Trx, c: AuthenticatedConnector, m: VoucherIndexMessage) {
  if (m.from > m.to) throw new ApiError(400, 'The window starts after it ends.', 'bad_window');
  const company = await companyByGuid(trx, c.orgId, m.companyGuid);
  const keep = new Set(m.guids);
  const held = await trx
    .selectFrom('tally_vouchers')
    .select(['id', 'guid'])
    .where('company_id', '=', company.id)
    .where('date', '>=', m.from)
    .where('date', '<=', m.to)
    .execute();
  const gone = held.filter((v) => !keep.has(v.guid)).map((v) => v.id);
  for (const ids of chunks(gone)) await trx.deleteFrom('tally_vouchers').where('id', 'in', ids).execute();
  return { kind: 'voucher-index' as const, held: held.length, deleted: gone.length };
}

// ── status ───────────────────────────────────────────────────────────────────

async function status(trx: Trx, c: AuthenticatedConnector, m: Extract<SyncMessage, { kind: 'status' }>) {
  if (m.companyGuid) {
    await trx
      .updateTable('tally_companies')
      .set({ last_error: m.error })
      .where('org_id', '=', c.orgId)
      .where('guid', '=', m.companyGuid)
      .execute();
  } else {
    await trx.updateTable('tally_connectors').set({ last_error: m.error }).where('id', '=', c.connectorId).execute();
  }
  return { kind: 'status' as const, ok: true };
}

export async function applySync(trx: Trx, connector: AuthenticatedConnector, message: SyncMessage) {
  switch (message.kind) {
    case 'hello':
      return hello(trx, connector, message);
    case 'masters':
      return masters(trx, connector, message);
    case 'vouchers':
      return vouchers(trx, connector, message);
    case 'voucher-index':
      return voucherIndex(trx, connector, message);
    case 'status':
      return status(trx, connector, message);
  }
}
