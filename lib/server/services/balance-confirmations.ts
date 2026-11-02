import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Balance confirmations: asking a customer or vendor to confirm what they owe
// us, or we them, on a date — the auditor's circularisation — and recording
// their answer beside our figure (migration 090).
//
// Our figure is the party's ledger balance on the date (reports/party-statement.ts),
// fixed when the request is made, so a later entry back-dated into the period
// cannot quietly move the number they were asked to confirm. The statement
// itself can be emailed with the request (mail/documents.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { partyStatement, type StatementSide } from '../reports/party-statement';

export async function requestConfirmation(trx: Trx, orgId: number, userId: number | null, input: { contactId: number; side: StatementSide; asOf: string; notes?: string | null }) {
  const open = await trx.selectFrom('balance_confirmations').select('id')
    .where('org_id', '=', orgId).where('contact_id', '=', input.contactId).where('side', '=', input.side).where('as_of', '=', input.asOf).executeTakeFirst();
  if (open) throw conflict('A confirmation for this party on this date is already recorded.');
  const s = await partyStatement(trx, orgId, input.contactId, input.side, input.asOf, input.asOf);
  const r = await trx.insertInto('balance_confirmations').values({
    org_id: orgId, contact_id: input.contactId, side: input.side, as_of: input.asOf, our_balance: toSqlFromPaise(s.closingPaise),
    notes: input.notes?.trim() || null, requested_by_user_id: userId,
  }).executeTakeFirstOrThrow();
  return { id: Number(r.insertId), ourBalancePaise: s.closingPaise };
}

/** Their answer: agreed when their figure is ours, disputed otherwise, with what they said. */
export async function recordReply(trx: Trx, orgId: number, id: number, input: { theirBalancePaise: Paise; notes?: string | null }) {
  const row = await trx.selectFrom('balance_confirmations').select(['id', 'our_balance', 'notes']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That confirmation does not exist.');
  if (!Number.isInteger(input.theirBalancePaise)) throw badRequest('Give their balance in rupees and paise.');
  const agreed = input.theirBalancePaise === toPaiseFromSql(row.our_balance);
  await trx.updateTable('balance_confirmations').set({
    their_balance: toSqlFromPaise(input.theirBalancePaise), status: agreed ? 'agreed' : 'disputed', responded_at: new Date(),
    notes: input.notes?.trim() || row.notes,
  }).where('id', '=', id).execute();
  return { agreed, differencePaise: toPaiseFromSql(row.our_balance) - input.theirBalancePaise };
}

export async function listConfirmations(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('balance_confirmations as b').innerJoin('contacts as c', 'c.id', 'b.contact_id')
    .select(['b.id', 'b.contact_id', 'b.side', 'b.as_of', 'b.our_balance', 'b.their_balance', 'b.status', 'b.notes', 'b.responded_at', 'b.created_at', 'c.display_name'])
    .where('b.org_id', '=', orgId).orderBy('b.as_of', 'desc').orderBy('b.id', 'desc').limit(500).execute();
  return rows.map((r) => {
    const ours = toPaiseFromSql(r.our_balance);
    const theirs = r.their_balance == null ? null : toPaiseFromSql(r.their_balance);
    return {
      id: String(r.id), contactId: String(r.contact_id), party: r.display_name, side: r.side, asOf: String(r.as_of).slice(0, 10),
      ourBalancePaise: ours, theirBalancePaise: theirs, differencePaise: theirs == null ? null : ours - theirs,
      status: r.status, notes: r.notes, respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
    };
  });
}
