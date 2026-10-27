import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Maker and checker.
//
// A rule says: invoices (or bills) of at least this amount need approving by
// this role. Such a document is saved as a draft and submitted; it posts only
// when someone with the role approves it, and that someone is never the person
// who submitted it. The check sits where the ledger is written, in
// postInvoice and postBill, so no screen, import or conversion can go round it.
//
// With no rules, nothing changes: documents post as they always have.
//
// A rule can also cover manual journals. Those have no draft state of their
// own, so one that a rule catches waits in held_journals (held-journals.ts)
// and is approved from the same inbox. And payment batches: a batch the rule
// catches is released to the bank only by a second person (payment-batches.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../http';

export type ApprovalDoc = 'invoice' | 'bill';
/** What a rule can cover: documents, and manual journals. */
export type RuleDoc = ApprovalDoc | 'journal' | 'payment_batch';

export interface ApprovalRule {
  id: string;
  documentType: RuleDoc;
  thresholdPaise: Paise;
  approverRole: RoleName;
  isActive: boolean;
}

const LABEL: Record<RuleDoc, string> = { invoice: 'Invoices', bill: 'Bills', journal: 'Journals', payment_batch: 'Payment batches' };

export async function listRules(ex: Executor, orgId: number): Promise<ApprovalRule[]> {
  const rows = await ex.selectFrom('approval_rules').selectAll().where('org_id', '=', orgId)
    .orderBy('document_type').orderBy('threshold_amount').execute();
  return rows.map((r) => ({
    id: String(r.id),
    documentType: r.document_type,
    thresholdPaise: toPaiseFromSql(r.threshold_amount),
    approverRole: r.approver_role as RoleName,
    isActive: !!r.is_active,
  }));
}

export async function saveRule(
  trx: Trx, orgId: number,
  input: { id?: number | null; documentType: RuleDoc; thresholdPaise: Paise; approverRole: RoleName; isActive: boolean },
) {
  if (input.thresholdPaise < 0) throw badRequest('The amount cannot be negative.');
  if (input.approverRole === 'viewer') throw badRequest('A viewer cannot approve anything; choose another role.');
  const values = {
    document_type: input.documentType,
    threshold_amount: toSqlFromPaise(input.thresholdPaise),
    approver_role: input.approverRole,
    is_active: input.isActive ? 1 : 0,
  };
  if (input.id) {
    const r = await trx.updateTable('approval_rules').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That rule was not found.');
    return input.id;
  }
  return Number((await trx.insertInto('approval_rules').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

export async function deleteRule(trx: Trx, orgId: number, id: number) {
  await trx.deleteFrom('approval_rules').where('id', '=', id).where('org_id', '=', orgId).execute();
}

/** The rule that catches a document of this amount, if any: the highest threshold it reaches. */
export async function ruleFor(ex: Executor, orgId: number, doc: RuleDoc, amountPaise: Paise) {
  const row = await ex.selectFrom('approval_rules').select(['approver_role', 'threshold_amount'])
    .where('org_id', '=', orgId).where('document_type', '=', doc).where('is_active', '=', 1)
    .where('threshold_amount', '<=', toSqlFromPaise(amountPaise))
    .orderBy('threshold_amount', 'desc').limit(1).executeTakeFirst();
  return row ? { approverRole: row.approver_role as RoleName, thresholdPaise: toPaiseFromSql(row.threshold_amount) } : null;
}

/** An admin may approve anything; otherwise the role must be the rule's. */
export const mayApprove = (role: RoleName, ruleRole: RoleName) => role === 'admin' || role === ruleRole;

/**
 * Called by postInvoice and postBill before they write to the ledger. Throws
 * when a rule catches the document and it has not been approved.
 */
export async function assertApproved(
  ex: Executor, orgId: number, doc: ApprovalDoc,
  row: { total: string; approval_status: string; number: string },
) {
  if (row.approval_status === 'approved') return;
  const rule = await ruleFor(ex, orgId, doc, toPaiseFromSql(row.total));
  if (!rule) return;
  throw new ApiError(
    403,
    `${LABEL[doc]} of ₹${(rule.thresholdPaise / 100).toLocaleString('en-IN')} and above need approval by ` +
      `${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`} before they post. ` +
      `Save ${row.number} as a draft and submit it for approval.`,
    'needs_approval',
  );
}

const TABLE = { invoice: 'invoices', bill: 'bills' } as const;

async function load(trx: Trx, orgId: number, doc: ApprovalDoc, id: number) {
  const row = doc === 'invoice'
    ? await trx.selectFrom('invoices').select(['id', 'number', 'status', 'total', 'approval_status', 'submitted_by_user_id'])
        .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst()
    : await trx.selectFrom('bills').select(['id', 'internal_no as number', 'status', 'total', 'approval_status', 'submitted_by_user_id'])
        .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound(`That ${doc} was not found.`);
  return row;
}

export async function recordApprovalAction(trx: Trx, orgId: number, doc: RuleDoc, id: number, action: 'submitted' | 'approved' | 'rejected', userId: number | null, note?: string | null) {
  await trx.insertInto('approval_actions').values({
    org_id: orgId, document_type: doc, document_id: id, action, user_id: userId, note: note ?? null,
  }).execute();
}

export async function submitForApproval(trx: Trx, orgId: number, userId: number | null, doc: ApprovalDoc, id: number) {
  const row = await load(trx, orgId, doc, id);
  if (row.status !== 'draft') throw conflict(`${row.number} is not a draft; only a draft is submitted for approval.`);
  if (row.approval_status === 'pending') throw conflict(`${row.number} is already waiting for approval.`);
  const rule = await ruleFor(trx, orgId, doc, toPaiseFromSql(row.total));
  if (!rule) throw badRequest(`No approval rule covers ${row.number}; it can be posted directly.`);
  await trx.updateTable(TABLE[doc]).set({
    approval_status: 'pending', submitted_by_user_id: userId, submitted_at: new Date(), rejection_reason: null,
  }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, doc, id, 'submitted', userId);
  return { approverRole: rule.approverRole };
}

/**
 * Approve and post. `post` is the posting function for the kind, passed in so
 * this module stays out of the sales and purchase services' imports.
 */
export async function approve(
  trx: Trx, orgId: number, user: { userId: number; role: RoleName }, doc: ApprovalDoc, id: number,
  post: (trx: Trx, orgId: number, userId: number, id: number) => Promise<unknown>,
  note?: string | null,
) {
  const row = await load(trx, orgId, doc, id);
  if (row.approval_status !== 'pending') throw conflict(`${row.number} is not waiting for approval.`);
  if (row.submitted_by_user_id === user.userId) {
    throw forbidden(`You submitted ${row.number}. Someone else has to approve it.`);
  }
  const rule = await ruleFor(trx, orgId, doc, toPaiseFromSql(row.total));
  if (rule && !mayApprove(user.role, rule.approverRole)) {
    throw forbidden(`${row.number} needs approval by ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`}.`);
  }
  await trx.updateTable(TABLE[doc]).set({
    approval_status: 'approved', approved_by_user_id: user.userId, approved_at: new Date(),
  }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, doc, id, 'approved', user.userId, note);
  await post(trx, orgId, user.userId, id);
}

export async function reject(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, doc: ApprovalDoc, id: number, reason: string) {
  const row = await load(trx, orgId, doc, id);
  if (row.approval_status !== 'pending') throw conflict(`${row.number} is not waiting for approval.`);
  if (!reason.trim()) throw badRequest('Say why it is being sent back.');
  const rule = await ruleFor(trx, orgId, doc, toPaiseFromSql(row.total));
  if (rule && !mayApprove(user.role, rule.approverRole) && row.submitted_by_user_id !== user.userId) {
    throw forbidden(`Only ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`} can send ${row.number} back.`);
  }
  await trx.updateTable(TABLE[doc]).set({ approval_status: 'rejected', rejection_reason: reason.trim() }).where('id', '=', id).execute();
  await recordApprovalAction(trx, orgId, doc, id, 'rejected', user.userId, reason);
}

export interface PendingApproval {
  documentType: RuleDoc;
  id: string;
  number: string;
  partyName: string;
  date: string;
  totalPaise: Paise;
  submittedBy: string | null;
  submittedById: string | null;
  submittedAt: string | null;
  approverRole: RoleName | null;
}

export async function pendingApprovals(ex: Executor, orgId: number): Promise<PendingApproval[]> {
  const [inv, bills, journals, batches] = await Promise.all([
    ex.selectFrom('invoices as d').innerJoin('contacts as c', 'c.id', 'd.customer_id')
      .leftJoin('users as u', 'u.id', 'd.submitted_by_user_id')
      .select(['d.id', 'd.number', 'd.invoice_date as date', 'd.total', 'c.display_name', 'u.name as submitted_by', 'd.submitted_by_user_id', 'd.submitted_at'])
      .where('d.org_id', '=', orgId).where('d.approval_status', '=', 'pending').execute(),
    ex.selectFrom('bills as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
      .leftJoin('users as u', 'u.id', 'd.submitted_by_user_id')
      .select(['d.id', 'd.internal_no as number', 'd.bill_date as date', 'd.total', 'c.display_name', 'u.name as submitted_by', 'd.submitted_by_user_id', 'd.submitted_at'])
      .where('d.org_id', '=', orgId).where('d.approval_status', '=', 'pending').execute(),
    ex.selectFrom('held_journals as d').leftJoin('users as u', 'u.id', 'd.created_by_user_id')
      .select(['d.id', 'd.entry_date as date', 'd.total_amount as total', 'd.memo', 'u.name as submitted_by', 'd.created_by_user_id', 'd.created_at'])
      .where('d.org_id', '=', orgId).where('d.kind', '=', 'approval').where('d.status', '=', 'held').execute(),
    ex.selectFrom('payment_batches as d').leftJoin('users as u', 'u.id', 'd.created_by_user_id')
      .select((eb) => ['d.id', 'd.number', 'd.pay_date as date', 'd.total_amount as total', 'u.name as submitted_by', 'd.created_by_user_id', 'd.submitted_at',
        eb.selectFrom('payment_batch_lines as l').select((e) => e.fn.count<string>('l.vendor_id').distinct().as('n')).whereRef('l.batch_id', '=', 'd.id').as('suppliers')])
      .where('d.org_id', '=', orgId).where('d.status', '=', 'pending').execute(),
  ]);
  const out: PendingApproval[] = [];
  for (const [doc, rows] of [['invoice', inv], ['bill', bills]] as const) {
    for (const r of rows) {
      const rule = await ruleFor(ex, orgId, doc, toPaiseFromSql(r.total));
      out.push({
        documentType: doc, id: String(r.id), number: r.number, partyName: r.display_name,
        date: String(r.date).slice(0, 10), totalPaise: toPaiseFromSql(r.total),
        submittedBy: r.submitted_by, submittedById: r.submitted_by_user_id ? String(r.submitted_by_user_id) : null,
        submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
        approverRole: rule?.approverRole ?? null,
      });
    }
  }
  for (const r of journals) {
    const rule = await ruleFor(ex, orgId, 'journal', toPaiseFromSql(r.total));
    out.push({
      documentType: 'journal', id: String(r.id), number: `Journal H-${r.id}`, partyName: r.memo,
      date: String(r.date).slice(0, 10), totalPaise: toPaiseFromSql(r.total),
      submittedBy: r.submitted_by, submittedById: r.created_by_user_id ? String(r.created_by_user_id) : null,
      submittedAt: new Date(r.created_at).toISOString(), approverRole: rule?.approverRole ?? null,
    });
  }
  for (const r of batches) {
    const rule = await ruleFor(ex, orgId, 'payment_batch', toPaiseFromSql(r.total));
    const n = Number(r.suppliers ?? 0);
    out.push({
      documentType: 'payment_batch', id: String(r.id), number: r.number, partyName: `${n} supplier${n === 1 ? '' : 's'}`,
      date: String(r.date).slice(0, 10), totalPaise: toPaiseFromSql(r.total),
      submittedBy: r.submitted_by, submittedById: r.created_by_user_id ? String(r.created_by_user_id) : null,
      submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, approverRole: rule?.approverRole ?? null,
    });
  }
  return out.sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
}

export async function approvalHistory(ex: Executor, orgId: number, doc: RuleDoc, id: number) {
  const rows = await ex.selectFrom('approval_actions as a').leftJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.action', 'a.note', 'a.created_at', 'u.name'])
    .where('a.org_id', '=', orgId).where('a.document_type', '=', doc).where('a.document_id', '=', id)
    .orderBy('a.created_at').orderBy('a.id').execute();
  return rows.map((r) => ({ action: r.action, note: r.note, by: r.name, at: new Date(r.created_at).toISOString() }));
}
