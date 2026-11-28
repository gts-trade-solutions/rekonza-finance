import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Which journal lines a report counts: Zoho's "Customize Report" filters, and
// a budget's branch, cost centre or project, in one place, so a figure on a
// filtered report and the same figure on a budget can never disagree.
//
// Every filter works on the journal lines themselves, never on a copy:
//   · branch: the entry's branch (each GST registration is one);
//   · cost centre: the line's own cost centre (posting.ts puts it on income
//     and expense lines only, which is why a balance sheet cut by cost centre
//     cannot balance);
//   · project: the project of the document the entry was posted by (an
//     invoice, bill or expense carries it); a reversal keeps its document, so
//     a voided invoice nets to nil under its project too;
//   · reporting tag: the value its document carries, or a manual journal's
//     own (a journal's reversal counts under the journal's tags);
//   · customer or vendor: the line's own contact, or — for a line that names
//     none, such as an invoice's sales and GST lines — the entry's party when
//     every party on the entry is one of those chosen;
//   · accounts: chosen accounts, or account types.
//
// The SQL assumes journal_lines as `jl` and journal_entries as `e`.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, type RawBuilder } from 'kysely';
import type { Executor } from '../db';
import type { AccountType } from './statements';

export interface LineFilter {
  branchId?: number | null;
  costCentreIds?: number[];
  projectIds?: number[];
  tagOptionIds?: number[];
  contactIds?: number[];
  accountIds?: number[];
  accountTypes?: AccountType[];
}

const ids = (list?: number[]) => (list ?? []).filter((n) => Number.isInteger(n) && n > 0);

/** True when the filter narrows lines by a dimension the stock figures and the balance sheet's equation do not follow. */
export function cutsByDimension(f?: LineFilter | null): boolean {
  return !!f && (ids(f.costCentreIds).length > 0 || ids(f.projectIds).length > 0 || ids(f.tagOptionIds).length > 0 || ids(f.contactIds).length > 0);
}

/** True when the filter leaves out accounts (so totals are of the accounts shown only). */
export function cutsByAccount(f?: LineFilter | null): boolean {
  return !!f && (ids(f.accountIds).length > 0 || (f.accountTypes ?? []).length > 0);
}

export const isEmptyFilter = (f?: LineFilter | null) => !f || (!f.branchId && !cutsByDimension(f) && !cutsByAccount(f));

/** The conditions, each starting with AND, on `jl` and `e`; orgId scopes the subqueries. */
export function lineFilterSql(orgId: number, f?: LineFilter | null): RawBuilder<unknown> {
  if (!f) return sql``;
  const parts: RawBuilder<unknown>[] = [];
  if (f.branchId) parts.push(sql`AND e.branch_id = ${f.branchId}`);
  const cc = ids(f.costCentreIds);
  if (cc.length) parts.push(sql`AND jl.cost_centre_id IN (${sql.join(cc)})`);
  const proj = ids(f.projectIds);
  if (proj.length) {
    parts.push(sql`AND (
         (e.source_type = 'invoice' AND e.source_id IN (SELECT id FROM invoices WHERE org_id = ${orgId} AND project_id IN (${sql.join(proj)})))
      OR (e.source_type = 'bill' AND e.source_id IN (SELECT id FROM bills WHERE org_id = ${orgId} AND project_id IN (${sql.join(proj)})))
      OR (e.source_type = 'expense' AND e.source_id IN (SELECT id FROM expenses WHERE org_id = ${orgId} AND project_id IN (${sql.join(proj)}))))`);
  }
  const tags = ids(f.tagOptionIds);
  if (tags.length) {
    parts.push(sql`AND EXISTS (SELECT 1 FROM reporting_tag_links tl
       WHERE tl.org_id = ${orgId} AND tl.option_id IN (${sql.join(tags)})
         AND ((tl.entity = 'journal_entry' AND tl.entity_id = COALESCE(e.reversal_of_entry_id, e.id))
           OR (tl.entity = e.source_type AND tl.entity_id = e.source_id AND e.source_type IN ('invoice', 'bill', 'expense'))))`);
  }
  const who = ids(f.contactIds);
  if (who.length) {
    parts.push(sql`AND (jl.contact_id IN (${sql.join(who)})
      OR (jl.contact_id IS NULL
          AND EXISTS (SELECT 1 FROM journal_lines c1 WHERE c1.entry_id = jl.entry_id AND c1.contact_id IN (${sql.join(who)}))
          AND NOT EXISTS (SELECT 1 FROM journal_lines c2 WHERE c2.entry_id = jl.entry_id AND c2.contact_id IS NOT NULL AND c2.contact_id NOT IN (${sql.join(who)}))))`);
  }
  const acc = ids(f.accountIds);
  if (acc.length) parts.push(sql`AND jl.account_id IN (${sql.join(acc)})`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

/** The accounts a filter keeps, for a report's rows: chosen accounts and account types. */
export function accountFilterSql(f?: LineFilter | null, alias = 'a'): RawBuilder<unknown> {
  if (!f) return sql``;
  const parts: RawBuilder<unknown>[] = [];
  const acc = ids(f.accountIds);
  if (acc.length) parts.push(sql`AND ${sql.ref(`${alias}.id`)} IN (${sql.join(acc)})`);
  if (f.accountTypes?.length) parts.push(sql`AND ${sql.ref(`${alias}.type`)} IN (${sql.join(f.accountTypes)})`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

/** Parse "1,2,3" into numbers. */
export const idList = (v?: string | null) => (v ? v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) : []);

/** The filter from a request's query: branchId, costCentreIds, projectIds, tagOptionIds, contactIds, accountIds, accountTypes. */
export function filterFromQuery(q: Record<string, string | undefined>): LineFilter | null {
  const f: LineFilter = {
    branchId: q.branchId ? Number(q.branchId) || null : null,
    costCentreIds: idList(q.costCentreIds),
    projectIds: idList(q.projectIds),
    tagOptionIds: idList(q.tagOptionIds),
    contactIds: idList(q.contactIds),
    accountIds: idList(q.accountIds),
    accountTypes: (q.accountTypes ?? '').split(',').map((s) => s.trim()).filter((s): s is AccountType => ['asset', 'liability', 'equity', 'income', 'expense'].includes(s)),
  };
  return isEmptyFilter(f) ? null : f;
}

/** Each filter in words, for a report's heading and its export: auditors print what they relied on. */
export async function describeFilter(ex: Executor, orgId: number, f?: LineFilter | null): Promise<string[]> {
  if (!f) return [];
  const out: string[] = [];
  const names = async (table: 'branches' | 'cost_centres' | 'projects' | 'contacts' | 'accounts', col: string, list: number[]) => {
    if (!list.length) return [] as string[];
    const rows = await ex.selectFrom(table as 'branches').select(['id', sql.ref(col).as('n')] as never).where('org_id', '=', orgId).where('id', 'in', list).execute() as unknown as { id: number; n: string }[];
    return list.map((id) => rows.find((r) => Number(r.id) === id)?.n ?? `#${id}`);
  };
  if (f.branchId) out.push(`Branch: ${(await names('branches', 'name', [f.branchId])).join(', ')}`);
  const cc = ids(f.costCentreIds);
  if (cc.length) out.push(`Cost centre: ${(await names('cost_centres', 'name', cc)).join(', ')}`);
  const proj = ids(f.projectIds);
  if (proj.length) out.push(`Project: ${(await names('projects', 'name', proj)).join(', ')}`);
  const tags = ids(f.tagOptionIds);
  if (tags.length) {
    const rows = await ex.selectFrom('reporting_tag_options as o').innerJoin('reporting_tags as t', 't.id', 'o.tag_id')
      .select(['o.id', 'o.value', 't.name']).where('o.org_id', '=', orgId).where('o.id', 'in', tags).execute();
    out.push(`Reporting tag: ${rows.map((r) => `${r.name} = ${r.value}`).join(', ')}`);
  }
  const who = ids(f.contactIds);
  if (who.length) out.push(`Customer / vendor: ${(await names('contacts', 'display_name', who)).join(', ')}`);
  const acc = ids(f.accountIds);
  if (acc.length) out.push(`Accounts: ${(await names('accounts', 'name', acc)).join(', ')}`);
  if (f.accountTypes?.length) out.push(`Account types: ${f.accountTypes.join(', ')}`);
  return out;
}
