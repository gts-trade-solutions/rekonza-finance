import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Journals held out of the books.
//
// An optional voucher is saved and seen but counted nowhere until someone
// posts it, as in Tally. A post-dated one is posted by the scheduler on its
// date and not a day before, so no report counts next month's rent today. And
// a journal that a journal approval rule catches waits here for a second
// person, as a big invoice or bill does.
//
// A held entry is released through postManualJournal with the lines exactly as
// entered, so it posts precisely as a hand-posted entry would: the balance
// rule, the period lock and the bill-wise settlement all apply then, not now.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, forbidden, notFound } from '../http';
import { postManualJournal, type ManualJournalInput } from './journals';
import { mayApprove, recordApprovalAction, ruleFor } from './approvals';

export type HeldKind = 'optional' | 'post_dated' | 'approval';
export type SaveMode = 'post' | 'optional' | 'post_dated';

/** The date in India, which is the date the books keep, whatever the server's clock zone. */
export function indiaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

const rupees = (p: Paise) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const roleName = (r: RoleName) => (r === 'admin' ? 'an admin' : `an ${r}`);
const totalOf = (input: ManualJournalInput) => input.lines.reduce((t, l) => t + (l.debitPaise ?? 0), 0);

/** The checks that can be made before posting: the rest wait for release. */
async function checkDraft(ex: Executor, orgId: number, input: ManualJournalInput) {
  if (input.lines.length < 2) throw badRequest('A journal entry needs at least two lines.');
  let dr = 0, cr = 0;
  for (const [i, l] of input.lines.entries()) {
    const d = l.debitPaise ?? 0, c = l.creditPaise ?? 0;
    if (d < 0 || c < 0 || (d > 0) === (c > 0)) throw badRequest(`Line ${i + 1} must be a debit or a credit, not both or neither.`);
    dr += d; cr += c;
  }
  if (dr !== cr) throw badRequest(`Debits ${rupees(dr)} and credits ${rupees(cr)} do not agree.`);
  const ids = [...new Set(input.lines.map((l) => l.accountId))];
  const found = await ex.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('id', 'in', ids).execute();
  if (found.length !== ids.length) throw badRequest('One of those accounts does not exist.');
  if (input.reverseOn && input.reverseOn <= input.date) throw badRequest('An entry reverses on a later date than its own.');
}

async function hold(trx: Trx, orgId: number, userId: number | null, kind: HeldKind, input: ManualJournalInput) {
  const res = await trx.insertInto('held_journals').values({
    org_id: orgId, branch_id: input.branchId, kind, entry_date: input.date, memo: input.memo,
    reverse_on: input.reverseOn ?? null, entry_lines: JSON.stringify(input.lines),
    total_amount: toSqlFromPaise(totalOf(input)), created_by_user_id: userId,
  }).executeTakeFirstOrThrow();
  return Number(res.insertId);
}

export type SaveResult =
  | { held: false; entry: Awaited<ReturnType<typeof postManualJournal>> }
  | { held: true; id: number; kind: HeldKind; approverRole?: RoleName };

/**
 * Save a manual journal: post it, or hold it as optional or post-dated. One
 * that a journal approval rule catches is held for approval instead of posted.
 */
export async function saveJournal(
  trx: Trx, orgId: number, userId: number | null, input: ManualJournalInput, mode: SaveMode = 'post',
): Promise<SaveResult> {
  if (mode === 'post') {
    const rule = await ruleFor(trx, orgId, 'journal', totalOf(input));
    if (!rule) return { held: false, entry: await postManualJournal(trx, orgId, userId, input) };
    await checkDraft(trx, orgId, input);
    const id = await hold(trx, orgId, userId, 'approval', input);
    await recordApprovalAction(trx, orgId, 'journal', id, 'submitted', userId);
    return { held: true, id, kind: 'approval', approverRole: rule.approverRole };
  }
  await checkDraft(trx, orgId, input);
  if (mode === 'post_dated' && input.date <= indiaToday()) {
    throw badRequest('A post-dated entry is dated after today. For today or earlier, post it now.');
  }
  return { held: true, id: await hold(trx, orgId, userId, mode, input), kind: mode };
}

async function load(trx: Trx, orgId: number, id: number) {
  const row = await trx.selectFrom('held_journals').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That held entry was not found.');
  if (row.status !== 'held') throw conflict(`That entry was already ${row.status}.`);
  return row;
}

function inputOf(row: { branch_id: number; entry_date: unknown; memo: string; reverse_on: unknown; entry_lines: unknown }): ManualJournalInput {
  return {
    branchId: row.branch_id,
    date: String(row.entry_date).slice(0, 10),
    memo: row.memo,
    reverseOn: row.reverse_on ? String(row.reverse_on).slice(0, 10) : null,
    lines: typeof row.entry_lines === 'string' ? JSON.parse(row.entry_lines) : row.entry_lines as ManualJournalInput['lines'],
  };
}

async function markPosted(trx: Trx, id: number, entryId: number, userId: number | null) {
  await trx.updateTable('held_journals').set({
    status: 'posted', entry_id: entryId, decided_by_user_id: userId, decided_at: new Date(), last_error: null,
  }).where('id', '=', id).execute();
}

/**
 * Post an optional or post-dated entry: by hand, or by the scheduler when
 * `userId` is null. If an approval rule now catches it, it goes for approval
 * rather than posting, whoever released it.
 */
export async function releaseHeldJournal(trx: Trx, orgId: number, userId: number | null, id: number) {
  const row = await load(trx, orgId, id);
  if (row.kind === 'approval') throw conflict('That entry is waiting for approval; it posts when approved.');
  const input = inputOf(row);
  const rule = await ruleFor(trx, orgId, 'journal', totalOf(input));
  if (rule) {
    await trx.updateTable('held_journals').set({ kind: 'approval', last_error: null }).where('id', '=', id).execute();
    await recordApprovalAction(trx, orgId, 'journal', id, 'submitted', userId ?? row.created_by_user_id);
    return { posted: false as const, approverRole: rule.approverRole };
  }
  const entry = await postManualJournal(trx, orgId, row.created_by_user_id, input);
  await markPosted(trx, id, entry.id, userId);
  return { posted: true as const, entry };
}

/** Approve a held journal and post it. Whoever entered it cannot approve it. */
export async function approveHeldJournal(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, id: number, note?: string | null) {
  const row = await load(trx, orgId, id);
  if (row.kind !== 'approval') throw conflict('That entry is not waiting for approval.');
  if (row.created_by_user_id === user.userId) throw forbidden('You entered this journal. Someone else has to approve it.');
  const input = inputOf(row);
  const rule = await ruleFor(trx, orgId, 'journal', totalOf(input));
  if (rule && !mayApprove(user.role, rule.approverRole)) throw forbidden(`This journal needs approval by ${roleName(rule.approverRole)}.`);
  const entry = await postManualJournal(trx, orgId, row.created_by_user_id, { ...input, approved: true });
  await markPosted(trx, id, entry.id, user.userId);
  await recordApprovalAction(trx, orgId, 'journal', id, 'approved', user.userId, note);
  return entry;
}

export async function rejectHeldJournal(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, id: number, reason: string) {
  const row = await load(trx, orgId, id);
  if (row.kind !== 'approval') throw conflict('That entry is not waiting for approval.');
  if (!reason.trim()) throw badRequest('Say why it is being sent back.');
  const rule = await ruleFor(trx, orgId, 'journal', toPaiseFromSql(row.total_amount));
  if (rule && !mayApprove(user.role, rule.approverRole) && row.created_by_user_id !== user.userId) {
    throw forbidden(`Only ${roleName(rule.approverRole)} can send this journal back.`);
  }
  await trx.updateTable('held_journals').set({
    status: 'rejected', note: reason.trim(), decided_by_user_id: user.userId, decided_at: new Date(),
  }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, 'journal', id, 'rejected', user.userId, reason);
}

/** Drop a held entry. Nothing was ever posted, so nothing needs reversing. */
export async function discardHeldJournal(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  await load(trx, orgId, id);
  await trx.updateTable('held_journals').set({
    status: 'discarded', note: reason?.trim() || null, decided_by_user_id: userId, decided_at: new Date(),
  }).where('id', '=', id).execute();
}

export interface HeldJournal {
  id: string;
  kind: HeldKind;
  date: string;
  memo: string;
  reverseOn: string | null;
  totalPaise: Paise;
  createdBy: string | null;
  createdById: string | null;
  createdAt: string;
  lastError: string | null;
  lines: { accountId: string; accountCode: string; accountName: string; debitPaise: Paise; creditPaise: Paise; description: string | null }[];
}

export async function listHeldJournals(ex: Executor, orgId: number): Promise<HeldJournal[]> {
  const rows = await ex.selectFrom('held_journals as h').leftJoin('users as u', 'u.id', 'h.created_by_user_id')
    .selectAll('h').select('u.name as created_by')
    .where('h.org_id', '=', orgId).where('h.status', '=', 'held')
    .orderBy('h.entry_date').orderBy('h.id').execute();
  const inputs = rows.map(inputOf);
  const ids = [...new Set(inputs.flatMap((i) => i.lines.map((l) => l.accountId)))];
  const accounts = new Map(ids.length
    ? (await ex.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', orgId).where('id', 'in', ids).execute()).map((a) => [a.id, a])
    : []);
  return rows.map((r, i) => ({
    id: String(r.id),
    kind: r.kind,
    date: inputs[i].date,
    memo: r.memo,
    reverseOn: inputs[i].reverseOn ?? null,
    totalPaise: toPaiseFromSql(r.total_amount),
    createdBy: r.created_by,
    createdById: r.created_by_user_id ? String(r.created_by_user_id) : null,
    createdAt: new Date(r.created_at).toISOString(),
    lastError: r.last_error,
    lines: inputs[i].lines.map((l) => ({
      accountId: String(l.accountId),
      accountCode: accounts.get(l.accountId)?.code ?? '',
      accountName: accounts.get(l.accountId)?.name ?? 'Unknown account',
      debitPaise: l.debitPaise ?? 0,
      creditPaise: l.creditPaise ?? 0,
      description: l.description ?? null,
    })),
  }));
}
