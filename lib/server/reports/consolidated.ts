import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated statements across the companies one person works in.
//
// Each company's profit and loss, balance sheet and trial balance, account by
// account in columns, an Eliminations column, and the group total. Every book
// carries the same chart, so an account code means the same thing in each.
// Only companies where the person may see the financial statements can be
// chosen; any subset of them can be consolidated.
//
// The method is AS 21 (Consolidated Financial Statements) and Ind AS 110: the
// companies' figures added line by line, and then —
//
//   1. Inter-company balances and trade eliminated (AS 21 para 16; Ind AS 110
//      B86(c)). A company's customer or vendor is another group company when
//      its PAN (or the PAN inside its GSTIN) is that company's PAN, or when the
//      group set-up links it by hand. What each is owed by the others and owes
//      them (as at the date), and what each sold to and bought from the others
//      (over the period, taxable value), come out. Where one side's figure does
//      not agree with the other's (a bill not yet entered, money in transit),
//      the difference is shown, so a gap is explained rather than hidden.
//
//   2. Unrealised profit in stock eliminated in full (AS 21 para 16-17; Ind AS
//      110 B86(c)). Goods one group company sold another and the buyer still
//      holds at the date carry the seller's profit, which the group has not
//      earned until the goods leave it. The buyer's closing stock of each item
//      is traced to its latest purchases (first in, first out: what is left is
//      what came in last); the part bought from a group company is valued at
//      what was paid less the seller's own cost of the same item (matched by
//      SKU, else by name); where the item cannot be matched, the seller's gross
//      margin for the period is used and said so. Losses are not eliminated
//      (para 17: they may show the cost cannot be recovered). The profit held
//      at the start of the period was eliminated then and is realised now, so
//      the period's charge is closing less opening.
//
//   3. The parent's investment set against the subsidiary's equity at
//      acquisition (AS 21 para 13; Ind AS 103/110): the investment, less the
//      parent's share of the subsidiary's share capital and the reserves it had
//      when acquired, is goodwill if positive and capital reserve if negative.
//      The investment account is the one named in the group set-up, or the
//      parent's Non-current Investments account (1700) when it holds a
//      balance; otherwise the screen says what to map.
//
//   4. Non-controlling interest (AS 21 para 13(c), 25; Ind AS 110 B94): where
//      the parent owns less than 100%, the minority's share of the
//      subsidiary's profit and of its net assets is shown apart, bearing its
//      share of unrealised profit on the subsidiary's own sales to the group.
//
// Nothing here posts an entry: consolidation adjustments live in the group
// statements only, as they do in practice; each company's books are its own.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { hasPermission, type CustomPermissions } from '../../rbac';
import { CODE } from '../ledger/chart-of-accounts';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, forbidden } from '../http';
import { balanceSheet, generalLedger, profitAndLoss, trialBalance, type AccountBalance } from './statements';
import { dayBefore, fiscalStartMonth, fyStartFor, stockPosition } from './stock';

export interface ConsolidatedRow { code: string; name: string; by: Record<string, Paise>; elimination: Paise; total: Paise; computed?: boolean }

export interface InterCompany {
  fromOrgId: string; fromName: string; toOrgId: string; toName: string;
  /** What `from` is owed by `to`, and what `to` says it owes `from`. */
  receivablePaise: Paise; counterpartPayablePaise: Paise;
  /** What `from` sold to `to` in the period, and what `to` says it bought from `from`. */
  salesPaise: Paise; counterpartPurchasesPaise: Paise;
}

type Company = { orgId: string; name: string; pan: string | null; role: string };

/** The companies whose statements this person may see. */
export async function companiesFor(ex: Executor, email: string): Promise<Company[]> {
  const rows = await ex.selectFrom('users as u').innerJoin('organizations as o', 'o.id', 'u.org_id')
    .leftJoin('custom_roles as r', 'r.id', 'u.custom_role_id')
    .select(['u.org_id', 'o.name', 'o.legal_name', 'o.pan', 'u.role', 'r.permissions'])
    .where('u.email', '=', email).where('u.is_active', '=', 1).orderBy('o.name').execute();
  return rows
    .filter((r) => hasPermission(r.role as RoleName, 'reports.financial', 'view',
      r.role !== 'admin' && r.permissions ? (typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions) as CustomPermissions : null))
    .map((r) => ({ orgId: String(r.org_id), name: r.legal_name ?? r.name, pan: r.pan?.toUpperCase() ?? null, role: r.role }));
}

/** Rows merged by account code, or by name for figures the statements compute (closing stock, earnings). */
function merge(sets: { orgId: string; rows: AccountBalance[] }[], elim: Map<string, Paise> = new Map()): ConsolidatedRow[] {
  const by = new Map<string, ConsolidatedRow>();
  for (const s of sets) {
    for (const r of s.rows) {
      const key = r.code || r.name;
      const row = by.get(key) ?? { code: r.code, name: r.name, by: {}, elimination: 0, total: 0, computed: !r.code };
      row.by[s.orgId] = (row.by[s.orgId] ?? 0) + r.balancePaise;
      row.total += r.balancePaise;
      by.set(key, row);
    }
  }
  for (const [code, amount] of elim) {
    if (!amount) continue;
    const row = by.get(code);
    if (!row) continue;
    row.elimination += amount;
    row.total += amount;
  }
  return [...by.values()].filter((r) => r.total !== 0 || r.elimination !== 0 || Object.values(r.by).some((v) => v !== 0)).sort((a, b) => (a.code || 'zzzz').localeCompare(b.code || 'zzzz'));
}

/** An eliminations-only row: a figure that exists only in the group's statements. */
const groupRow = (_key: string, name: string, elimination: Paise): ConsolidatedRow => ({ code: '', name, by: {}, elimination, total: elimination, computed: true });

/** In each chosen company: which of its contacts is which other group company (PAN, or linked by hand). */
async function groupContacts(ex: Executor, companies: Company[]) {
  const byPan = new Map(companies.filter((c) => c.pan).map((c) => [c.pan!, c]));
  const ids = companies.map((c) => Number(c.orgId));
  const links = ids.length ? await ex.selectFrom('consolidation_contact_links').select(['org_id', 'contact_id', 'counterpart_org_id']).where('org_id', 'in', ids).execute() : [];
  const out = new Map<string, Map<number, Company>>();
  for (const c of companies) {
    const orgId = Number(c.orgId);
    const map = new Map<number, Company>();
    if (byPan.size) {
      const pans = [...byPan.keys()];
      const contacts = await ex.selectFrom('contacts').select(['id', 'pan', 'gstin'])
        .where('org_id', '=', orgId)
        .where((eb) => eb.or([eb('pan', 'in', pans), eb(sql<string>`SUBSTRING(gstin, 3, 10)`, 'in', pans)]))
        .execute();
      for (const k of contacts) {
        const co = byPan.get((k.pan ?? k.gstin?.slice(2, 12) ?? '').toUpperCase());
        if (co && co.orgId !== c.orgId) map.set(Number(k.id), co);
      }
    }
    for (const l of links.filter((x) => Number(x.org_id) === orgId)) {
      const co = companies.find((x) => x.orgId === String(l.counterpart_org_id));
      if (co && co.orgId !== c.orgId) map.set(Number(l.contact_id), co);
    }
    out.set(c.orgId, map);
  }
  return out;
}

/** Each company's dealings with the others. */
async function interCompany(ex: Executor, companies: Company[], contactsOf: Map<string, Map<number, Company>>, from: string, to: string): Promise<InterCompany[]> {
  const out = new Map<string, InterCompany>();
  const pair = (a: Company, b: Company) => {
    const k = `${a.orgId}>${b.orgId}`;
    const v = out.get(k) ?? { fromOrgId: a.orgId, fromName: a.name, toOrgId: b.orgId, toName: b.name, receivablePaise: 0, counterpartPayablePaise: 0, salesPaise: 0, counterpartPurchasesPaise: 0 };
    out.set(k, v);
    return v;
  };
  for (const c of companies) {
    const orgId = Number(c.orgId);
    const other = contactsOf.get(c.orgId) ?? new Map();
    if (!other.size) continue;
    const ids = [...other.keys()];
    const balances = await sql<{ contact_id: number; code: string; b: string }>`
      SELECT jl.contact_id, a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS b
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.org_id = ${orgId} AND jl.entry_date <= ${to} AND a.code IN (${CODE.AR}, ${CODE.AP})
         AND jl.contact_id IN (${sql.join(ids)})
       GROUP BY jl.contact_id, a.code
    `.execute(ex);
    const sales = await sql<{ customer_id: number; v: string }>`
      SELECT customer_id, COALESCE(SUM(subtotal), 0) AS v FROM invoices
       WHERE org_id = ${orgId} AND status NOT IN ('draft','void') AND invoice_date BETWEEN ${from} AND ${to} AND customer_id IN (${sql.join(ids)})
       GROUP BY customer_id
    `.execute(ex);
    const buys = await sql<{ vendor_id: number; v: string }>`
      SELECT vendor_id, COALESCE(SUM(subtotal), 0) AS v FROM bills
       WHERE org_id = ${orgId} AND status NOT IN ('draft','void') AND bill_date BETWEEN ${from} AND ${to} AND vendor_id IN (${sql.join(ids)})
       GROUP BY vendor_id
    `.execute(ex);
    for (const r of balances.rows) {
      const co = other.get(Number(r.contact_id))!;
      const v = toPaiseFromSql(r.b);
      // A receivable in this book is the pair (this → them); a payable is (them → this) seen from the other side.
      if (r.code === CODE.AR) pair(c, co).receivablePaise += v;
      else pair(co, c).counterpartPayablePaise += -v;
    }
    for (const r of sales.rows) pair(c, other.get(Number(r.customer_id))!).salesPaise += toPaiseFromSql(r.v);
    for (const r of buys.rows) pair(other.get(Number(r.vendor_id))!, c).counterpartPurchasesPaise += toPaiseFromSql(r.v);
  }
  return [...out.values()].filter((x) => x.receivablePaise || x.counterpartPayablePaise || x.salesPaise || x.counterpartPurchasesPaise);
}

// ── Unrealised profit in stock ──────────────────────────────────────────────

export interface UnrealisedLine {
  sellerOrgId: string; sellerName: string; buyerOrgId: string; buyerName: string;
  item: string; qtyHeld: number; unitPricePaise: Paise; sellerUnitCostPaise: Paise | null; profitPaise: Paise;
  /** How the seller's cost was found: its own item, or its gross margin for the period. */
  basis: 'item' | 'margin';
  note: string | null;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Profit still held in stock bought from another group company, at a date. */
async function unrealisedProfit(ex: Executor, companies: Company[], contactsOf: Map<string, Map<number, Company>>, asOf: string, marginFrom: string): Promise<UnrealisedLine[]> {
  const out: UnrealisedLine[] = [];
  const sellerItems = new Map<string, { id: number; name: string; sku: string | null; purchase_price: string; standard_cost: string | null }[]>();
  const sellerStock = new Map<string, Map<string, number>>();
  const sellerMargin = new Map<string, number>();
  for (const buyer of companies) {
    const vendors = [...(contactsOf.get(buyer.orgId) ?? new Map()).entries()];
    if (!vendors.length) continue;
    const bOrg = Number(buyer.orgId);
    const stock = await stockPosition(ex, bOrg, asOf, { includeArchived: true });
    const held = stock.lines.filter((l) => l.qty > 0);
    if (!held.length) continue;
    for (const line of held) {
      // The item's purchases, newest first: closing stock is what came in last.
      const { rows: buys } = await sql<{ vendor_id: number; qty: string; taxable: string }>`
        SELECT b.vendor_id, bl.qty, bl.taxable FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
         WHERE b.org_id = ${bOrg} AND bl.item_id = ${Number(line.itemId)} AND b.status NOT IN ('draft', 'void') AND b.bill_date <= ${asOf}
         ORDER BY b.bill_date DESC, b.id DESC, bl.id DESC`.execute(ex);
      let left = line.qty;
      const fromSeller = new Map<string, { qty: number; cost: number }>();
      for (const p of buys) {
        if (left <= 0) break;
        const q = Math.min(left, Number(p.qty));
        left -= q;
        const seller = vendors.find(([id]) => id === Number(p.vendor_id))?.[1];
        if (!seller) continue;
        const unit = Number(p.qty) ? toPaiseFromSql(p.taxable) / Number(p.qty) : 0;
        const acc = fromSeller.get(seller.orgId) ?? { qty: 0, cost: 0 };
        acc.qty += q; acc.cost += q * unit;
        fromSeller.set(seller.orgId, acc);
      }
      for (const [sellerId, h] of fromSeller) {
        if (h.qty <= 0) continue;
        const seller = companies.find((c) => c.orgId === sellerId)!;
        const sOrg = Number(sellerId);
        if (!sellerItems.has(sellerId)) {
          sellerItems.set(sellerId, await ex.selectFrom('items').select(['id', 'name', 'sku', 'purchase_price', 'standard_cost']).where('org_id', '=', sOrg).execute() as never);
          const pos = await stockPosition(ex, sOrg, asOf, { includeArchived: true });
          sellerStock.set(sellerId, new Map(pos.lines.map((l) => [l.itemId, l.unitCostPaise])));
        }
        const items = sellerItems.get(sellerId)!;
        const match = (line.sku && items.find((i) => i.sku && norm(i.sku) === norm(line.sku))) || items.find((i) => norm(i.name) === norm(line.name));
        const unitPrice = Math.round(h.cost / h.qty);
        let unitCost: number | null = null;
        let basis: UnrealisedLine['basis'] = 'item';
        let note: string | null = null;
        if (match) {
          unitCost = sellerStock.get(sellerId)!.get(String(match.id)) || toPaiseFromSql(match.standard_cost ?? '0') || toPaiseFromSql(match.purchase_price) || null;
        }
        let profit: number;
        if (unitCost) {
          profit = Math.round(h.qty * (unitPrice - unitCost));
        } else {
          basis = 'margin';
          if (!sellerMargin.has(sellerId)) {
            const pl = await profitAndLoss(ex, sOrg, marginFrom, asOf);
            sellerMargin.set(sellerId, pl.totalIncome > 0 ? Math.max(0, pl.grossProfit / pl.totalIncome) : 0);
          }
          const m = sellerMargin.get(sellerId)!;
          profit = Math.round(h.cost * m);
          note = `${seller.name} has no item matching "${line.name}" by SKU or name, so its gross margin for the period (${(m * 100).toFixed(1)}%) was used. Give the item the same name or SKU in both books for an exact figure.`;
        }
        if (profit <= 0) continue; // a loss is not eliminated (AS 21 para 17)
        out.push({
          sellerOrgId: sellerId, sellerName: seller.name, buyerOrgId: buyer.orgId, buyerName: buyer.name, item: line.name,
          qtyHeld: Math.round(h.qty * 1000) / 1000, unitPricePaise: unitPrice, sellerUnitCostPaise: unitCost, profitPaise: profit, basis, note,
        });
      }
    }
  }
  return out;
}

// ── The group set-up ────────────────────────────────────────────────────────

export interface GroupSetup {
  id: string; parentOrgId: string; parentName: string; name: string;
  members: { orgId: string; name: string; ownershipPct: number; acquiredOn: string | null; investmentAccountId: string | null; investmentAccountName: string | null }[];
}

async function groupFor(ex: Executor, companies: Company[]): Promise<GroupSetup | null> {
  const ids = companies.map((c) => Number(c.orgId));
  if (!ids.length) return null;
  const g = await ex.selectFrom('consolidation_groups').selectAll().where('org_id', 'in', ids).orderBy('id').executeTakeFirst();
  if (!g) return null;
  const members = await ex.selectFrom('consolidation_members as m').leftJoin('accounts as a', 'a.id', 'm.investment_account_id')
    .select(['m.member_org_id', 'm.ownership_pct', 'm.acquired_on', 'm.investment_account_id', 'a.code', 'a.name'])
    .where('m.group_id', '=', g.id).execute();
  return {
    id: String(g.id), parentOrgId: String(g.org_id), parentName: companies.find((c) => c.orgId === String(g.org_id))?.name ?? '', name: g.name,
    members: members.filter((m) => companies.some((c) => c.orgId === String(m.member_org_id))).map((m) => ({
      orgId: String(m.member_org_id), name: companies.find((c) => c.orgId === String(m.member_org_id))!.name,
      ownershipPct: Number(m.ownership_pct), acquiredOn: m.acquired_on ? String(m.acquired_on).slice(0, 10) : null,
      investmentAccountId: m.investment_account_id ? String(m.investment_account_id) : null, investmentAccountName: m.code ? `${m.code} ${m.name}` : null,
    })),
  };
}

/** What the group set-up screen needs: each company's contacts (to link) and the parent's asset accounts (to name the investment). */
export async function setupOptions(ex: Executor, email: string, chosen?: string[]) {
  const allowed = await companiesFor(ex, email);
  const companies = chosen?.length ? allowed.filter((c) => chosen.includes(c.orgId)) : allowed;
  const group = await groupFor(ex, companies);
  const contactsOf = await groupContacts(ex, companies);
  const out = [];
  for (const c of companies) {
    const contacts = await ex.selectFrom('contacts').select(['id', 'display_name', 'kind', 'pan']).where('org_id', '=', Number(c.orgId)).orderBy('display_name').limit(1000).execute();
    const investments = await ex.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', Number(c.orgId)).where('type', '=', 'asset').orderBy('code').execute();
    const links = contactsOf.get(c.orgId) ?? new Map();
    out.push({
      orgId: c.orgId, name: c.name, pan: c.pan, canEdit: c.role === 'admin' || c.role === 'accountant',
      contacts: contacts.map((k) => ({ id: String(k.id), name: k.display_name, kind: k.kind, groupCompanyOrgId: links.get(Number(k.id))?.orgId ?? null })),
      assetAccounts: investments.map((a) => ({ id: String(a.id), code: a.code, name: a.name })),
    });
  }
  return { group, companies: out };
}

/** Save the group: its parent, each subsidiary's share, and the contacts that are group companies. */
export async function saveGroup(trx: Trx, email: string, userId: number, input: {
  parentOrgId: string; name: string;
  members: { orgId: string; ownershipPct: number; acquiredOn?: string | null; investmentAccountId?: string | null }[];
  links: { orgId: string; contactId: string; counterpartOrgId: string | null }[];
}) {
  const allowed = await companiesFor(trx, email);
  const can = (orgId: string) => allowed.find((c) => c.orgId === orgId);
  const parent = can(input.parentOrgId);
  if (!parent) throw forbidden('You cannot see that company\'s books.');
  if (parent.role !== 'admin' && parent.role !== 'accountant') throw forbidden('Only an admin or accountant of the parent company can set up the group.');
  for (const m of input.members) {
    if (!can(m.orgId)) throw forbidden('You cannot see one of those companies\' books.');
    if (m.orgId === input.parentOrgId) throw badRequest('The parent is not its own subsidiary.');
    if (!(m.ownershipPct > 0 && m.ownershipPct <= 100)) throw badRequest('Ownership is a percentage above 0 and at most 100.');
    if (m.investmentAccountId) {
      const a = await trx.selectFrom('accounts').select('type').where('id', '=', Number(m.investmentAccountId)).where('org_id', '=', Number(input.parentOrgId)).executeTakeFirst();
      if (!a || a.type !== 'asset') throw badRequest('The investment account must be an asset account in the parent company\'s books.');
    }
  }
  const pOrg = Number(input.parentOrgId);
  // One group per parent; another group naming these companies is replaced.
  const old = await trx.selectFrom('consolidation_groups').select('id').where('org_id', '=', pOrg).executeTakeFirst();
  let gid: number;
  if (old) {
    gid = Number(old.id);
    await trx.updateTable('consolidation_groups').set({ name: input.name.trim() || `${parent.name} group` }).where('id', '=', gid).execute();
    await trx.deleteFrom('consolidation_members').where('group_id', '=', gid).execute();
  } else {
    gid = Number((await trx.insertInto('consolidation_groups').values({ org_id: pOrg, name: input.name.trim() || `${parent.name} group`, created_by_user_id: userId }).executeTakeFirstOrThrow()).insertId);
  }
  if (input.members.length) {
    await trx.insertInto('consolidation_members').values(input.members.map((m) => ({
      org_id: pOrg, group_id: gid, member_org_id: Number(m.orgId), ownership_pct: String(m.ownershipPct),
      acquired_on: m.acquiredOn || null, investment_account_id: m.investmentAccountId ? Number(m.investmentAccountId) : null,
    }))).execute();
  }
  for (const l of input.links) {
    if (!can(l.orgId)) throw forbidden('You cannot see one of those companies\' books.');
    const contact = await trx.selectFrom('contacts').select('id').where('id', '=', Number(l.contactId)).where('org_id', '=', Number(l.orgId)).executeTakeFirst();
    if (!contact) throw badRequest('That customer or vendor is not in that company\'s books.');
    await trx.deleteFrom('consolidation_contact_links').where('org_id', '=', Number(l.orgId)).where('contact_id', '=', Number(l.contactId)).execute();
    if (l.counterpartOrgId) {
      if (!can(l.counterpartOrgId) || l.counterpartOrgId === l.orgId) throw badRequest('Link a customer or vendor to another group company.');
      await trx.insertInto('consolidation_contact_links').values({ org_id: Number(l.orgId), contact_id: Number(l.contactId), counterpart_org_id: Number(l.counterpartOrgId), created_by_user_id: userId }).execute();
    }
  }
  return gid;
}

// ── The statements ──────────────────────────────────────────────────────────

export async function consolidatedStatements(ex: Executor, email: string, from: string, to: string, chosen?: string[]) {
  const allowed = await companiesFor(ex, email);
  const companies = chosen?.length ? allowed.filter((c) => chosen.includes(c.orgId)) : allowed;
  const firstOrg = Number(companies[0]?.orgId ?? allowed[0]?.orgId ?? 0);
  const fyStart = firstOrg ? fyStartFor(to, await fiscalStartMonth(ex, firstOrg)) : `${to.slice(0, 4)}-04-01`;
  const each = await Promise.all(companies.map(async (c) => {
    const id = Number(c.orgId);
    const [pl, bs, tb] = await Promise.all([profitAndLoss(ex, id, from, to), balanceSheet(ex, id, to), trialBalance(ex, id, to)]);
    return { c, pl, bs, tb };
  }));
  const contactsOf = await groupContacts(ex, companies);
  const pairs = await interCompany(ex, companies, contactsOf, from, to);
  const group = await groupFor(ex, companies);
  const notes: string[] = [];

  const sumOf = (k: keyof InterCompany) => pairs.reduce((t, p) => t + Number(p[k]), 0);
  // Each side taken out as its own book records it.
  const elimReceivable = sumOf('receivablePaise');
  const elimPayable = sumOf('counterpartPayablePaise');
  const elimSales = sumOf('salesPaise');
  const elimPurchases = sumOf('counterpartPurchasesPaise');

  // Unrealised profit: at the date, at the start of the period, and at the start of the year.
  const [upClose, upOpen, upFy] = companies.length > 1 ? await Promise.all([
    unrealisedProfit(ex, companies, contactsOf, to, fyStart),
    from > '1900-01-01' ? unrealisedProfit(ex, companies, contactsOf, dayBefore(from), fyStart) : Promise.resolve([]),
    unrealisedProfit(ex, companies, contactsOf, dayBefore(fyStart), fyStart),
  ]) : [[], [], []];
  const upTotal = (l: UnrealisedLine[], seller?: string) => l.filter((x) => !seller || x.sellerOrgId === seller).reduce((t, x) => t + x.profitPaise, 0);
  const UPc = upTotal(upClose), UPo = upTotal(upOpen), UPf = upTotal(upFy);
  for (const l of upClose) if (l.note) notes.push(l.note);

  // Investment against equity, and the minority's share, subsidiary by subsidiary.
  const investments: { subsidiaryOrgId: string; subsidiary: string; ownershipPct: number; investmentPaise: Paise; shareCapitalPaise: Paise; preAcquisitionPaise: Paise; goodwillPaise: Paise; capitalReservePaise: Paise; identified: boolean; note: string | null }[] = [];
  const nci: { orgId: string; name: string; pct: number; profitSharePaise: Paise; netAssetsSharePaise: Paise }[] = [];
  const parent = group && companies.some((c) => c.orgId === group.parentOrgId) ? each.find((x) => x.c.orgId === group.parentOrgId) : undefined;
  if (companies.length > 1 && !parent) {
    notes.push('No parent is set up for these companies, so they are added together as equals (each 100% of the group): no investment is set against share capital and no non-controlling interest is shown. Use Group set-up to name the parent and each subsidiary\'s ownership.');
  }
  if (parent) {
    for (const x of each) {
      if (x.c.orgId === parent.c.orgId) continue;
      const m = group!.members.find((mm) => mm.orgId === x.c.orgId);
      const pct = m?.ownershipPct ?? 100;
      const p = pct / 100;
      if (!m) notes.push(`${x.c.name} is not in the group set-up, so it is treated as 100% owned by ${parent.c.name}.`);
      const sc = x.bs.equityRows.filter((r) => r.code === CODE.CAPITAL).reduce((t, r) => t + r.balancePaise, 0);
      let investment = 0;
      let identified = false;
      if (m?.investmentAccountId) {
        investment = parent.tb.rows.filter((r) => r.accountId === m.investmentAccountId).reduce((t, r) => t + r.debitSide - r.creditSide, 0);
        identified = true;
      } else {
        const inv = parent.tb.rows.find((r) => r.code === CODE.INVESTMENTS);
        if (inv && inv.debitSide - inv.creditSide !== 0 && each.length === 2) { investment = inv.debitSide - inv.creditSide; identified = true; }
      }
      let preAcq = 0;
      if (identified && m?.acquiredOn && m.acquiredOn > '1900-01-01') {
        const atAcq = await balanceSheet(ex, Number(x.c.orgId), m.acquiredOn);
        preAcq = atAcq.totalEquity - atAcq.equityRows.filter((r) => r.code === CODE.CAPITAL).reduce((t, r) => t + r.balancePaise, 0);
      }
      const gw = identified ? investment - Math.round(p * (sc + preAcq)) : 0;
      investments.push({
        subsidiaryOrgId: x.c.orgId, subsidiary: x.c.name, ownershipPct: pct, investmentPaise: investment, shareCapitalPaise: sc, preAcquisitionPaise: preAcq,
        goodwillPaise: gw > 0 ? gw : 0, capitalReservePaise: gw < 0 ? -gw : 0, identified,
        note: identified ? null : `${parent.c.name}'s investment in ${x.c.name} could not be found: name the investment account in Group set-up (or keep it in 1700 Non-current Investments), so it can be set against ${x.c.name}'s share capital.`,
      });
      if (!identified) notes.push(investments[investments.length - 1].note!);
      if (p < 1) {
        const upstream = upTotal(upClose, x.c.orgId), upstreamOpen = upTotal(upOpen, x.c.orgId);
        nci.push({
          orgId: x.c.orgId, name: x.c.name, pct: 100 - pct,
          profitSharePaise: Math.round((1 - p) * (x.pl.netProfit - (upstream - upstreamOpen))),
          netAssetsSharePaise: Math.round((1 - p) * (x.bs.totalEquity - upstream)),
        });
      }
    }
  }
  const sumInv = (k: 'investmentPaise' | 'goodwillPaise' | 'capitalReservePaise') => investments.filter((i) => i.identified).reduce((t, i) => t + i[k], 0);
  const eliminatedEquity = investments.filter((i) => i.identified).reduce((t, i) => t + Math.round((i.ownershipPct / 100) * (i.shareCapitalPaise + i.preAcquisitionPaise)), 0);
  const nciAssets = nci.reduce((t, n) => t + n.netAssetsSharePaise, 0);
  const nciProfit = nci.reduce((t, n) => t + n.profitSharePaise, 0);

  const sum = (f: (x: (typeof each)[number]) => Paise, elimination = 0) => {
    const by: Record<string, Paise> = {};
    for (const x of each) by[x.c.orgId] = f(x);
    return { by, elimination, total: Object.values(by).reduce((t, v) => t + v, 0) + elimination };
  };
  // The year's profit and earlier years' as equity rows, so the balance sheet's lines add up to its totals.
  const equityRows = (x: (typeof each)[number]): AccountBalance[] => [
    ...x.bs.equityRows,
    { accountId: 'prior-earnings', code: '', name: 'Profit of earlier years', type: 'equity', subtype: 'reserves', debitPaise: 0, creditPaise: 0, balancePaise: x.bs.priorYearsEarnings },
    { accountId: 'current-earnings', code: '', name: 'Profit for the year to date', type: 'equity', subtype: 'reserves', debitPaise: 0, creditPaise: 0, balancePaise: x.bs.currentPeriodEarnings },
  ];
  const upCharge = UPc - UPo;
  const profitElim = -elimSales + elimPurchases - upCharge;

  const investmentCodes = new Map<string, Paise>();
  for (const i of investments.filter((v) => v.identified)) {
    const m = group?.members.find((mm) => mm.orgId === i.subsidiaryOrgId);
    const code = m?.investmentAccountId ? parent!.tb.rows.find((r) => r.accountId === m.investmentAccountId)?.code ?? CODE.INVESTMENTS : CODE.INVESTMENTS;
    investmentCodes.set(code, (investmentCodes.get(code) ?? 0) - i.investmentPaise);
  }
  const assets = merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.bs.assetRows })), new Map([[CODE.AR, -elimReceivable], ...investmentCodes]));
  if (UPc) assets.push(groupRow('up', 'Less: unrealised profit in group stock', -UPc));
  if (sumInv('goodwillPaise')) assets.push(groupRow('goodwill', 'Goodwill on consolidation', sumInv('goodwillPaise')));
  const equity = merge(each.map((x) => ({ orgId: x.c.orgId, rows: equityRows(x) })), new Map([
    ['Profit for the year to date', -(UPc - UPf)], ['Profit of earlier years', -UPf],
  ]));
  if (eliminatedEquity) equity.push(groupRow('pre-acq', "Subsidiaries' share capital and pre-acquisition reserves (set against the investment)", -eliminatedEquity));
  if (sumInv('capitalReservePaise')) equity.push(groupRow('capital-reserve', 'Capital reserve on consolidation', sumInv('capitalReservePaise')));
  if (nciAssets) {
    equity.push(groupRow('nci-out', "Non-controlling interest's share of subsidiaries' equity", -nciAssets));
    equity.push(groupRow('nci', 'Non-controlling interest', nciAssets));
  }
  const expenses = merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.expenseRows })), new Map([[CODE.PURCHASES, -elimPurchases]]));
  if (upCharge) expenses.push(groupRow('up-charge', 'Unrealised profit in closing stock (eliminated; net of what was held at the start)', upCharge));

  const totalAssets = sum((x) => x.bs.totalAssets, -elimReceivable - sumInv('investmentPaise') + sumInv('goodwillPaise') - UPc);
  const totalLiabilities = sum((x) => x.bs.totalLiabilities, -elimPayable);
  const totalEquity = sum((x) => x.bs.totalEquity, -UPc - eliminatedEquity + sumInv('capitalReservePaise'));
  const netProfit = sum((x) => x.pl.netProfit, profitElim);

  // The consolidated trial balance: each company's ledger balances by account,
  // with the inter-company balances and trade taken out. Stock, unrealised
  // profit, goodwill and the minority are adjustments to the statements, not
  // ledger balances, and are left to them.
  const tbRows = new Map<string, ConsolidatedRow>();
  for (const x of each) {
    for (const r of x.tb.rows) {
      const row = tbRows.get(r.code) ?? { code: r.code, name: r.name, by: {}, elimination: 0, total: 0 };
      row.by[x.c.orgId] = (row.by[x.c.orgId] ?? 0) + r.debitSide - r.creditSide;
      row.total += r.debitSide - r.creditSide;
      tbRows.set(r.code, row);
    }
  }
  const tbElim = (code: string, name: string, v: Paise) => {
    if (!v) return;
    const row = tbRows.get(code) ?? { code, name, by: {}, elimination: 0, total: 0 };
    row.elimination += v; row.total += v;
    tbRows.set(code, row);
  };
  tbElim(CODE.AR, 'Accounts Receivable', -elimReceivable);
  tbElim(CODE.AP, 'Accounts Payable', elimPayable);
  tbElim(CODE.SALES, 'Sales', elimSales);
  tbElim(CODE.PURCHASES, 'Purchases', -elimPurchases);
  const tbDiff = elimReceivable - elimPayable - elimSales + elimPurchases;
  if (tbDiff) tbRows.set('ic-diff', { code: '', name: 'Inter-company difference, not yet agreed between the books', by: {}, elimination: tbDiff, total: tbDiff, computed: true });
  const tbList = [...tbRows.values()].filter((r) => r.total || r.elimination || Object.values(r.by).some(Boolean)).sort((a, b) => (a.code || 'zzzz').localeCompare(b.code || 'zzzz'));
  const tbTotals = (side: 1 | -1) => {
    const by: Record<string, Paise> = {};
    for (const x of each) by[x.c.orgId] = tbList.reduce((t, r) => t + Math.max(0, side * (r.by[x.c.orgId] ?? 0)), 0);
    const elimination = tbList.reduce((t, r) => t + Math.max(0, side * r.elimination), 0);
    return { by, elimination, total: tbList.reduce((t, r) => t + Math.max(0, side * r.total), 0) };
  };

  const groupAssets = totalAssets.total;
  const groupLE = totalLiabilities.total + totalEquity.total;
  return {
    from, to, fyStart,
    companies: allowed.map((c) => ({ orgId: c.orgId, name: c.name, pan: c.pan, included: companies.some((x) => x.orgId === c.orgId) })),
    group,
    interCompany: pairs.map((p) => ({ ...p, balanceDifferencePaise: p.receivablePaise - p.counterpartPayablePaise, tradeDifferencePaise: p.salesPaise - p.counterpartPurchasesPaise })),
    income: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.incomeRows })), new Map([[CODE.SALES, -elimSales]])),
    expenses,
    assets,
    liabilities: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.bs.liabilityRows })), new Map([[CODE.AP, -elimPayable]])),
    equity,
    totalIncome: sum((x) => x.pl.totalIncome, -elimSales),
    // The ledger's expenses, adjusted by the change in stock, as each P&L shows them.
    totalExpense: sum((x) => x.pl.totalExpense + x.pl.openingStockPaise - x.pl.closingStockPaise, -elimPurchases + upCharge),
    netProfit,
    /** Who the group's profit belongs to (AS 21 para 25; Ind AS 110 B94). */
    profitAttributable: { ownersPaise: netProfit.total - nciProfit, nciPaise: nciProfit },
    totalAssets,
    totalLiabilities,
    totalEquity,
    unrealisedProfit: { closing: upClose, closingPaise: UPc, openingPaise: UPo, yearStartPaise: UPf, chargePaise: upCharge },
    investments,
    nci,
    trialBalance: { rows: tbList, debit: tbTotals(1), credit: tbTotals(-1) },
    /** The consolidation check: each company and the group, and whether each balances. */
    check: {
      companies: each.map((x) => ({
        orgId: x.c.orgId, name: x.c.name, income: x.pl.totalIncome, netProfit: x.pl.netProfit, assets: x.bs.totalAssets,
        liabilitiesAndEquity: x.bs.totalLiabilities + x.bs.totalEquity, balanced: x.bs.balanced, tbBalanced: x.tb.balanced,
      })),
      eliminations: { income: -elimSales, netProfit: profitElim, assets: totalAssets.elimination, liabilitiesAndEquity: totalLiabilities.elimination + totalEquity.elimination },
      group: { income: sum((x) => x.pl.totalIncome, -elimSales).total, netProfit: netProfit.total, assets: groupAssets, liabilitiesAndEquity: groupLE, nciPaise: nciAssets, balanced: groupAssets === groupLE },
    },
    notes,
    /** What the eliminations leave unexplained: one side's figure not matching the other's. */
    unreconciledPaise: elimReceivable - elimPayable,
  };
}

/** One account's ledger in one of the group's companies, without moving into it: the drill-down. */
export async function companyLedger(ex: Executor, email: string, orgId: string, code: string, from: string, to: string) {
  const allowed = await companiesFor(ex, email);
  if (!allowed.some((c) => c.orgId === orgId)) throw forbidden('You cannot see that company\'s books.');
  const account = await ex.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('org_id', '=', Number(orgId)).where('code', '=', code).executeTakeFirst();
  if (!account) return { company: allowed.find((c) => c.orgId === orgId)!.name, account: null, openingPaise: 0, closingPaise: 0, lines: [] };
  const gl = await generalLedger(ex, Number(orgId), account.id, from, to);
  return { company: allowed.find((c) => c.orgId === orgId)!.name, account: { code: account.code, name: account.name, type: account.type }, ...gl };
}
