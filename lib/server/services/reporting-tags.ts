import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reporting tags: dimensions of the business beyond the chart of accounts and
// the cost centre — region, channel, product line — each with its values
// (migration 091). A document carries one value of a tag at most, and the
// profit and loss can be cut by any tag: every income and expense line counts
// under the value its document carries, or under "Untagged".
//
// Tags go on invoices, bills, expenses and manual journals, and the report
// follows each ledger entry back to its document to find them.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

export const TAGGABLE = ['invoice', 'bill', 'expense', 'journal_entry'] as const;
export type Taggable = (typeof TAGGABLE)[number];

export async function listTags(ex: Executor, orgId: number) {
  const [tags, options] = await Promise.all([
    ex.selectFrom('reporting_tags').selectAll().where('org_id', '=', orgId).orderBy('name').execute(),
    ex.selectFrom('reporting_tag_options').selectAll().where('org_id', '=', orgId).orderBy('value').execute(),
  ]);
  return tags.map((t) => ({
    id: String(t.id), name: t.name, isActive: !!t.is_active,
    options: options.filter((o) => o.tag_id === t.id).map((o) => ({ id: String(o.id), value: o.value, isActive: !!o.is_active })),
  }));
}

/** Create or change a tag. A value left out is switched off, not deleted: documents keep it. */
export async function saveTag(trx: Trx, orgId: number, input: { id?: number | null; name: string; values: string[]; isActive?: boolean }) {
  const name = input.name.trim();
  if (!name) throw badRequest('Name the tag.');
  const values = [...new Set(input.values.map((v) => v.trim()).filter(Boolean))];
  if (!values.length) throw badRequest('A tag needs at least one value.');
  let id = input.id ?? null;
  if (id) {
    const r = await trx.updateTable('reporting_tags').set({ name, is_active: input.isActive === false ? 0 : 1 }).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That tag does not exist.');
  } else {
    const clash = await trx.selectFrom('reporting_tags').select('id').where('org_id', '=', orgId).where('name', '=', name).executeTakeFirst();
    if (clash) throw conflict(`There is already a tag called ${name}.`);
    id = Number((await trx.insertInto('reporting_tags').values({ org_id: orgId, name }).executeTakeFirstOrThrow()).insertId);
  }
  const existing = await trx.selectFrom('reporting_tag_options').select(['id', 'value']).where('tag_id', '=', id).execute();
  for (const v of values) {
    const found = existing.find((e) => e.value.toLowerCase() === v.toLowerCase());
    if (found) await trx.updateTable('reporting_tag_options').set({ is_active: 1, value: v }).where('id', '=', found.id).execute();
    else await trx.insertInto('reporting_tag_options').values({ org_id: orgId, tag_id: id, value: v }).execute();
  }
  const off = existing.filter((e) => !values.some((v) => v.toLowerCase() === e.value.toLowerCase())).map((e) => e.id);
  if (off.length) await trx.updateTable('reporting_tag_options').set({ is_active: 0 }).where('id', 'in', off).execute();
  return id;
}

const TABLE: Record<Taggable, 'invoices' | 'bills' | 'expenses' | 'journal_entries'> = { invoice: 'invoices', bill: 'bills', expense: 'expenses', journal_entry: 'journal_entries' };

/** A document's tags as {tagId: optionId}; null clears that tag. */
export async function setTags(trx: Trx, orgId: number, entity: Taggable, entityId: number, values: Record<string, string | null>) {
  const doc = await trx.selectFrom(TABLE[entity]).select('id').where('id', '=', entityId).where('org_id', '=', orgId).executeTakeFirst();
  if (!doc) throw notFound('That document does not exist.');
  for (const [tagKey, optionKey] of Object.entries(values)) {
    const tagId = Number(tagKey);
    if (!optionKey) {
      await trx.deleteFrom('reporting_tag_links').where('tag_id', '=', tagId).where('entity', '=', entity).where('entity_id', '=', entityId).execute();
      continue;
    }
    const opt = await trx.selectFrom('reporting_tag_options').select(['id', 'tag_id', 'is_active']).where('id', '=', Number(optionKey)).where('org_id', '=', orgId).executeTakeFirst();
    if (!opt || opt.tag_id !== tagId) throw badRequest('That value is not one of the tag’s.');
    if (!opt.is_active) throw badRequest('That value is switched off.');
    const r = await trx.updateTable('reporting_tag_links').set({ option_id: opt.id }).where('tag_id', '=', tagId).where('entity', '=', entity).where('entity_id', '=', entityId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) await trx.insertInto('reporting_tag_links').values({ org_id: orgId, tag_id: tagId, option_id: opt.id, entity, entity_id: entityId }).execute();
  }
}

export async function tagsFor(ex: Executor, orgId: number, entity: Taggable, entityId: number): Promise<Record<string, string>> {
  const rows = await ex.selectFrom('reporting_tag_links').select(['tag_id', 'option_id']).where('org_id', '=', orgId).where('entity', '=', entity).where('entity_id', '=', entityId).execute();
  return Object.fromEntries(rows.map((r) => [String(r.tag_id), String(r.option_id)]));
}

export interface TagProfitRow { option: string; incomePaise: Paise; expensePaise: Paise; profitPaise: Paise }

/** Income and expense for the period, under each value of the tag. */
export async function profitByTag(ex: Executor, orgId: number, tagId: number, from: string, to: string): Promise<{ tag: string; rows: TagProfitRow[] }> {
  const tag = await ex.selectFrom('reporting_tags').select('name').where('id', '=', tagId).where('org_id', '=', orgId).executeTakeFirst();
  if (!tag) throw notFound('That tag does not exist.');
  // Each ledger line's document: the entry itself for a manual journal, else its source.
  const { rows } = await sql<{ opt: string | null; type: string; v: string }>`
    SELECT o.value AS opt, a.type, SUM(jl.credit - jl.debit) AS v
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN journal_entries e ON e.id = jl.entry_id
      LEFT JOIN reporting_tag_links l ON l.tag_id = ${tagId} AND (
             (l.entity = 'journal_entry' AND l.entity_id = e.id)
          OR (l.entity = e.source_type AND l.entity_id = e.source_id AND e.source_type IN ('invoice', 'bill', 'expense')))
      LEFT JOIN reporting_tag_options o ON o.id = l.option_id
     WHERE jl.org_id = ${orgId} AND a.type IN ('income', 'expense') AND jl.entry_date BETWEEN ${from} AND ${to}
     GROUP BY o.value, a.type
  `.execute(ex);
  const byOpt = new Map<string, TagProfitRow>();
  for (const r of rows) {
    const key = r.opt ?? 'Untagged';
    const row = byOpt.get(key) ?? { option: key, incomePaise: 0, expensePaise: 0, profitPaise: 0 };
    const v = toPaiseFromSql(r.v);
    if (r.type === 'income') row.incomePaise += v; else row.expensePaise += -v;
    row.profitPaise = row.incomePaise - row.expensePaise;
    byOpt.set(key, row);
  }
  return { tag: tag.name, rows: [...byOpt.values()].sort((a, b) => (a.option === 'Untagged' ? 1 : b.option === 'Untagged' ? -1 : a.option.localeCompare(b.option))) };
}
