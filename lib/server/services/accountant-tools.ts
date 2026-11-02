import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' Accountant tools (migration 095).
//
// Journal templates: a manual journal kept to be used again, with or without
// its amounts. Using one fills the journal form; nothing posts from here.
//
// Bulk update: lines on one account moved to another in one go — the fuel
// that was booked to office expenses all year, say. Posted documents are not
// rewritten: their entries stay exactly as they were, and one reclassification
// journal (per branch) moves each chosen line, so the trail shows what moved,
// from where, by whom. A line moved once is not offered again, unless that
// reclassification is reversed. Accounts that other ledgers hang off —
// receivables and payables, bank and cash, GST, stock — cannot be moved into
// or out of this way: their sub-ledgers would no longer agree.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry, type DraftLine } from '../ledger/posting';

// ── Journal templates ───────────────────────────────────────────────────────

export interface TemplateLine {
  accountId: number; debitPaise: Paise; creditPaise: Paise;
  description: string | null; contactId: number | null; costCentreId: number | null;
}

export interface TemplateInput { id?: number | null; name: string; memo?: string | null; withAmounts: boolean; lines: TemplateLine[] }

const readLines = (v: unknown): TemplateLine[] => (typeof v === 'string' ? JSON.parse(v) : v) as TemplateLine[];

export async function listJournalTemplates(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('journal_templates as t').leftJoin('users as u', 'u.id', 't.created_by_user_id')
    .select(['t.id', 't.name', 't.memo', 't.template_lines', 't.with_amounts', 't.updated_at', 'u.name as created_by'])
    .where('t.org_id', '=', orgId).orderBy('t.name').execute();
  const accounts = new Map((await ex.selectFrom('accounts').select(['id', 'name', 'code']).where('org_id', '=', orgId).execute()).map((a) => [a.id, a]));
  return rows.map((r) => {
    const lines = readLines(r.template_lines);
    return {
      id: String(r.id), name: r.name, memo: r.memo, withAmounts: !!r.with_amounts, createdBy: r.created_by, updatedAt: new Date(r.updated_at).toISOString(),
      totalPaise: lines.reduce((t, l) => t + (l.debitPaise ?? 0), 0),
      lines: lines.map((l) => ({
        accountId: String(l.accountId), accountName: accounts.get(l.accountId)?.name ?? '(account removed)', accountCode: accounts.get(l.accountId)?.code ?? '',
        debitPaise: l.debitPaise ?? 0, creditPaise: l.creditPaise ?? 0, description: l.description ?? null,
        contactId: l.contactId ? String(l.contactId) : null, costCentreId: l.costCentreId ? String(l.costCentreId) : null,
      })),
    };
  });
}

export async function saveJournalTemplate(trx: Trx, orgId: number, userId: number | null, input: TemplateInput): Promise<number> {
  const name = input.name.trim().slice(0, 150);
  if (!name) throw badRequest('Give the template a name.');
  const lines = input.lines.filter((l) => l.accountId);
  if (lines.length < 2) throw badRequest('A journal template needs at least two lines.');
  if (lines.length > 50) throw badRequest('A template can have up to 50 lines.');
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const found = await trx.selectFrom('accounts').select(['id', 'is_active']).where('org_id', '=', orgId).where('id', 'in', ids).execute();
  if (found.length !== ids.length) throw badRequest('One of the accounts is not in this book.');
  if (found.some((a) => !a.is_active)) throw badRequest('One of the accounts is inactive. Pick another.');
  const clean = lines.map((l) => {
    const debit = input.withAmounts ? Math.max(0, Math.round(l.debitPaise || 0)) : 0;
    const credit = input.withAmounts ? Math.max(0, Math.round(l.creditPaise || 0)) : 0;
    if (debit && credit) throw badRequest('A line is a debit or a credit, not both.');
    return { accountId: l.accountId, debitPaise: debit, creditPaise: credit, description: l.description?.trim().slice(0, 300) || null, contactId: l.contactId || null, costCentreId: l.costCentreId || null };
  });
  if (input.withAmounts) {
    const dr = clean.reduce((t, l) => t + l.debitPaise, 0);
    const cr = clean.reduce((t, l) => t + l.creditPaise, 0);
    if (!dr || dr !== cr) throw badRequest('A template with amounts must balance: debits equal to credits. Or save it without amounts.');
  }
  const values = { name, memo: input.memo?.trim().slice(0, 500) || null, template_lines: JSON.stringify(clean), with_amounts: input.withAmounts ? 1 : 0 };
  const clash = await trx.selectFrom('journal_templates').select('id').where('org_id', '=', orgId).where('name', '=', name).executeTakeFirst();
  if (clash && clash.id !== (input.id ?? null)) throw conflict(`There is already a template called ${name}.`);
  if (input.id) {
    const r = await trx.updateTable('journal_templates').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That template was not found.');
    return input.id;
  }
  return Number((await trx.insertInto('journal_templates').values({ org_id: orgId, created_by_user_id: userId, ...values }).executeTakeFirstOrThrow()).insertId);
}

export async function deleteJournalTemplate(trx: Trx, orgId: number, id: number) {
  const t = await trx.selectFrom('journal_templates').select('name').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That template was not found.');
  await trx.deleteFrom('journal_templates').where('id', '=', id).execute();
  return t.name;
}

// ── Bulk update ─────────────────────────────────────────────────────────────

const FIXED_SUBTYPES = new Set(['receivable', 'payable', 'bank', 'cash', 'bank_od', 'credit_card', 'tax', 'stock', 'branch', 'advance']);

/** Why an account cannot be moved into or out of in bulk, or null when it can. */
async function lockedReason(ex: Executor, orgId: number, accountId: number) {
  const a = await ex.selectFrom('accounts').select(['id', 'name', 'subtype', 'is_active']).where('id', '=', accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!a) return { name: '', why: 'That account is not in this book.' };
  if (a.subtype && FIXED_SUBTYPES.has(a.subtype)) {
    return { name: a.name, why: `${a.name} has its own sub-ledger (${a.subtype.replace('_', ' ')}), so lines cannot be moved in or out of it in bulk. Correct the documents instead.` };
  }
  const bank = await ex.selectFrom('bank_accounts').select('id').where('org_id', '=', orgId).where('ledger_account_id', '=', accountId).executeTakeFirst();
  if (bank) return { name: a.name, why: `${a.name} is a bank or cash account; its statement would no longer match.` };
  return { name: a.name, why: null as string | null, active: !!a.is_active };
}

export interface ReclassFilter { fromAccountId: number; from: string; to: string; contactId?: number | null; search?: string | null }

/** The lines on an account that a bulk update may move: in the period, not moved already. */
export async function reclassCandidates(ex: Executor, orgId: number, f: ReclassFilter) {
  const locked = await lockedReason(ex, orgId, f.fromAccountId);
  if (locked.why) throw badRequest(locked.why);
  const term = f.search?.trim() ? `%${f.search.trim()}%` : null;
  const { rows } = await sql<{ id: number; entry_id: number; entry_no: number; entry_date: string | Date; source_type: string; memo: string | null; description: string | null; party: string | null; debit: string; credit: string; branch_id: number }>`
    SELECT l.id, e.id AS entry_id, e.entry_no, e.entry_date, e.source_type, e.memo, l.description, c.display_name AS party, l.debit, l.credit, e.branch_id
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts c ON c.id = l.contact_id
     WHERE l.org_id = ${orgId} AND l.account_id = ${f.fromAccountId} AND e.entry_date BETWEEN ${f.from} AND ${f.to}
       AND e.source_type <> 'reclassification'
       ${f.contactId ? sql`AND l.contact_id = ${f.contactId}` : sql``}
       ${term ? sql`AND (l.description LIKE ${term} OR e.memo LIKE ${term} OR c.display_name LIKE ${term})` : sql``}
       AND NOT EXISTS (
         SELECT 1 FROM reclassified_lines r
          WHERE r.journal_line_id = l.id
            AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.reversal_of_entry_id = r.reclass_entry_id))
     ORDER BY e.entry_date, e.entry_no, l.line_no
     LIMIT 2000`.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), entryId: String(r.entry_id), entryNo: r.entry_no, date: String(r.entry_date instanceof Date ? r.entry_date.toISOString() : r.entry_date).slice(0, 10),
    sourceType: r.source_type, memo: r.memo, description: r.description, party: r.party,
    debitPaise: toPaiseFromSql(r.debit), creditPaise: toPaiseFromSql(r.credit),
  }));
}

export async function bulkReclassify(
  trx: Trx, orgId: number, userId: number | null,
  input: { fromAccountId: number; toAccountId: number; lineIds: number[]; date: string; memo?: string | null },
) {
  if (input.fromAccountId === input.toAccountId) throw badRequest('Pick a different account to move the lines to.');
  if (!input.lineIds.length) throw badRequest('Choose the lines to move.');
  if (input.lineIds.length > 2000) throw badRequest('Move up to 2,000 lines at a time.');
  const from = await lockedReason(trx, orgId, input.fromAccountId);
  if (from.why) throw badRequest(from.why);
  const to = await lockedReason(trx, orgId, input.toAccountId);
  if (to.why) throw badRequest(to.why);
  if (!to.active) throw badRequest(`${to.name} is inactive. Make it active first, or pick another.`);

  const ids = [...new Set(input.lineIds)];
  const { rows } = await sql<{ id: number; account_id: number; debit: string; credit: string; contact_id: number | null; cost_centre_id: number | null; description: string | null; entry_no: number; branch_id: number; source_type: string; moved: number }>`
    SELECT l.id, l.account_id, l.debit, l.credit, l.contact_id, l.cost_centre_id, l.description, e.entry_no, e.branch_id, e.source_type,
           EXISTS (SELECT 1 FROM reclassified_lines r WHERE r.journal_line_id = l.id
                    AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.reversal_of_entry_id = r.reclass_entry_id)) AS moved
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.org_id = ${orgId} AND l.id IN (${sql.join(ids)})
     FOR UPDATE`.execute(trx);
  if (rows.length !== ids.length) throw notFound('Some of those lines were not found.');
  for (const r of rows) {
    if (r.account_id !== input.fromAccountId) throw badRequest(`Entry #${r.entry_no} has a line that is not on ${from.name}.`);
    if (Number(r.moved)) throw conflict(`A line of entry #${r.entry_no} was moved already. Refresh the list.`);
    if (r.source_type === 'reclassification') throw badRequest('A reclassification line cannot itself be moved; reverse that reclassification instead.');
  }

  // One entry per branch: the moved lines keep their party, cost centre and branch.
  const byBranch = new Map<number, typeof rows>();
  for (const r of rows) byBranch.set(r.branch_id, [...(byBranch.get(r.branch_id) ?? []), r]);
  const memo = input.memo?.trim() || `Bulk update: ${rows.length} line(s) moved from ${from.name} to ${to.name}`;
  const entries: { id: number; entryNo: number }[] = [];
  let movedPaise = 0;
  for (const [branchId, group] of byBranch) {
    const lines: DraftLine[] = [];
    for (const r of group) {
      const net = toPaiseFromSql(r.debit) - toPaiseFromSql(r.credit);
      if (!net) continue;
      const why = `Moved from ${from.name}, entry #${r.entry_no}${r.description ? `: ${r.description}` : ''}`.slice(0, 300);
      const common = { contactId: r.contact_id, costCentreId: r.cost_centre_id, description: why };
      if (net > 0) {
        lines.push({ accountId: input.toAccountId, debit: net, ...common }, { accountId: input.fromAccountId, credit: net, ...common });
      } else {
        lines.push({ accountId: input.toAccountId, credit: -net, ...common }, { accountId: input.fromAccountId, debit: -net, ...common });
      }
      movedPaise += Math.abs(net);
    }
    if (!lines.length) continue;
    const entry = await postEntry(trx, { orgId, branchId, date: input.date, memo, sourceType: 'reclassification', userId, module: 'accountant', lines });
    entries.push({ id: entry.id, entryNo: entry.entryNo });
    await trx.insertInto('reclassified_lines').values(group.map((r) => ({
      org_id: orgId, journal_line_id: r.id, reclass_entry_id: entry.id, from_account_id: input.fromAccountId, to_account_id: input.toAccountId,
    }))).execute();
  }
  if (!entries.length) throw badRequest('The chosen lines add up to nothing; there is nothing to move.');
  return { entries, lines: rows.length, movedPaise, fromName: from.name, toName: to.name };
}
