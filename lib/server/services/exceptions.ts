import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Exceptions: problems with an owner, a date, and an end.
//
// A screen that shows thirty-one invoices without an IRN is information; it
// becomes control only when someone is answerable for each, by a date, and
// somebody more senior hears about it when that date passes. An auditor's
// review of this software said exactly that — issues were detected but not
// escalated, and an overdue customer stayed overdue because nobody was
// assigned. So the scheduler runs the detectors below for every book, and
// each thing they find becomes a row here:
//
//   raised   — given an owner (the customer's own account owner, or the first
//              person in the role that deals with that kind of thing) and a
//              date to deal with it by, and the owner is told.
//   worked   — the owner starts on it, adds notes, hands it on.
//   closed   — resolved with what was done, or waived with why it is
//              accepted; and when the condition itself goes away (the invoice
//              is paid, the IRN comes through) the exception closes by itself.
//   escalated — past its date, the owner is reminded; a few days later still,
//              every admin is told.
//
// A row marked resolved while the condition is still there is raised again a
// day later: resolving means the problem is gone, not that it was looked at.
// A waived one stays quiet until the condition clears, because waiving is a
// decision to live with it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Executor, type Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, forbidden, notFound } from '../http';
import { getPolicies, type OrgPolicies } from './org-settings';
import { notify } from './notifications';
import { msmeOpenBills } from './msme';
import { indiaToday } from './held-journals';
import { stockPosition } from '../reports/stock';
import { isValidGstin } from '../../tax/gst';
import { EXCEPTION_KINDS, SEVERITY_RANK, type ExceptionKind, type ExceptionSeverity, type ExceptionStatus } from '../../exceptions';

const DAY = 86_400_000;
const rupees = (p: Paise) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const dateAt = (ymd: string) => new Date(`${ymd}T18:30:00Z`); // the end of that day in India
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

interface Finding {
  kind: ExceptionKind;
  subjectType: string;
  subjectId: number;
  title: string;
  detail: string;
  severity: ExceptionSeverity;
  amountPaise?: Paise | null;
  href: string;
  /** A particular person, when the thing has one (a customer's account owner). */
  ownerUserId?: number | null;
  dueAt: Date;
}

interface Ctx {
  orgId: number;
  today: string;
  now: Date;
  policies: OrgPolicies;
}

// ── Detectors ────────────────────────────────────────────────────────────────

/** Invoices still without an IRN a day after issue, or refused by the IRP. */
async function irns(ex: Executor, c: Ctx): Promise<Finding[]> {
  const rows = await ex.selectFrom('einvoices as e').innerJoin('invoices as i', 'i.id', 'e.invoice_id')
    .innerJoin('contacts as ct', 'ct.id', 'i.customer_id')
    .select(['i.id', 'i.number', 'i.invoice_date', 'i.total', 'ct.display_name', 'e.status', 'e.error_message', 'e.created_at'])
    .where('e.org_id', '=', c.orgId).where('e.status', 'in', ['pending', 'failed'])
    .where('i.status', 'not in', ['draft', 'void']).execute();
  const out: Finding[] = [];
  for (const r of rows) {
    const failed = r.status === 'failed';
    // A pending one is given a day: the automatic registration normally gets there first.
    if (!failed && c.now.getTime() - new Date(r.created_at).getTime() < DAY) continue;
    const date = String(r.invoice_date).slice(0, 10);
    const windowEnds = addDays(dateAt(date), 30);
    const daysLeft = Math.ceil((windowEnds.getTime() - c.now.getTime()) / DAY);
    out.push({
      kind: failed ? 'irn_failed' : 'irn_pending',
      subjectType: 'invoice', subjectId: r.id,
      title: `${r.number} (${r.display_name}) has no IRN`,
      detail: failed
        ? `The IRP refused it: ${r.error_message ?? 'no reason given'}. A B2B invoice without an IRN is not a valid tax invoice.`
        : `Issued on ${date} and still not registered. ${daysLeft > 0 ? `${daysLeft} days left in the 30-day reporting window.` : 'The 30-day reporting window has passed: the IRP will refuse it, and a credit note and fresh invoice are the remedy.'}`,
      severity: daysLeft <= 5 ? 'critical' : failed ? 'high' : 'medium',
      amountPaise: toPaiseFromSql(r.total),
      href: `/sales/invoices/${r.id}`,
      dueAt: failed ? addDays(c.now, 1) : new Date(Math.min(windowEnds.getTime(), addDays(c.now, 2).getTime())),
    });
  }
  return out;
}

/** Customers with something 15 or more days past due, by the oldest: the 15/30/60/90-day ladder. */
async function receivables(ex: Executor, c: Ctx): Promise<Finding[]> {
  const { rows } = await sql<{ customer_id: number; display_name: string; owner_user_id: number | null; due: string; oldest: string; n: string }>`
    SELECT i.customer_id, ct.display_name, ct.owner_user_id, SUM(i.total - i.amount_paid) AS due, MIN(i.due_date) AS oldest, COUNT(*) AS n
      FROM invoices i JOIN contacts ct ON ct.id = i.customer_id
     WHERE i.org_id = ${c.orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
       AND i.due_date <= DATE_SUB(${c.today}, INTERVAL 15 DAY)
     GROUP BY i.customer_id, ct.display_name, ct.owner_user_id
  `.execute(ex);
  return rows.map((r) => {
    const days = daysBetween(String(r.oldest).slice(0, 10), c.today);
    const severity: ExceptionSeverity = days >= 90 ? 'critical' : days >= 60 ? 'high' : days >= 30 ? 'medium' : 'low';
    const stage = days >= 90 ? 90 : days >= 60 ? 60 : days >= 30 ? 30 : 15;
    const n = Number(r.n);
    return {
      kind: 'receivable_overdue' as const,
      subjectType: 'contact', subjectId: r.customer_id,
      title: `${r.display_name}: ${rupees(toPaiseFromSql(r.due))} over ${stage} days past due`,
      detail: `${n} invoice${n === 1 ? '' : 's'} unpaid past due; the oldest fell due ${days} days ago. Call, send a statement, and agree a date — or stop supplying on credit.`,
      severity,
      amountPaise: toPaiseFromSql(r.due),
      href: `/sales/customers/${r.customer_id}`,
      ownerUserId: r.owner_user_id,
      dueAt: addDays(c.now, 7),
    };
  });
}

/** What each customer owes now, for the credit-limit and concentration checks. */
async function owedByCustomer(ex: Executor, orgId: number) {
  const { rows } = await sql<{ id: number; display_name: string; owner_user_id: number | null; credit_limit: string | null; due: string }>`
    SELECT ct.id, ct.display_name, ct.owner_user_id, ct.credit_limit, SUM(i.total - i.amount_paid) AS due
      FROM invoices i JOIN contacts ct ON ct.id = i.customer_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
     GROUP BY ct.id, ct.display_name, ct.owner_user_id, ct.credit_limit
  `.execute(ex);
  return rows.map((r) => ({ ...r, due: toPaiseFromSql(r.due), limit: r.credit_limit === null ? 0 : toPaiseFromSql(r.credit_limit) }));
}

async function exposure(ex: Executor, c: Ctx): Promise<Finding[]> {
  const owed = await owedByCustomer(ex, c.orgId);
  const out: Finding[] = [];
  for (const r of owed) {
    if (r.limit > 0 && r.due > r.limit) {
      out.push({
        kind: 'credit_limit', subjectType: 'contact', subjectId: r.id,
        title: `${r.display_name} owes ${rupees(r.due)}, over their ${rupees(r.limit)} limit`,
        detail: `${rupees(r.due - r.limit)} above the credit limit on their account. Collect before supplying more, or raise the limit deliberately.`,
        severity: 'high', amountPaise: r.due, href: `/sales/customers/${r.id}`, ownerUserId: r.owner_user_id, dueAt: addDays(c.now, 7),
      });
    }
  }
  // Concentration: one customer holding too much of what is owed. Measured
  // only when there is a spread to measure against.
  const total = owed.reduce((t, r) => t + Math.max(0, r.due), 0);
  if (owed.length >= 3 && total > 0) {
    for (const r of owed) {
      const share = (r.due / total) * 100;
      if (share <= c.policies.controls.concentrationPct) continue;
      out.push({
        kind: 'concentration', subjectType: 'contact', subjectId: r.id,
        title: `${r.display_name} is ${share.toFixed(0)}% of receivables`,
        detail: `${rupees(r.due)} of ${rupees(total)} owed to the business is owed by one customer, above the ${c.policies.controls.concentrationPct}% set under Controls. If they pay late or fail, the business feels all of it.`,
        severity: share >= c.policies.controls.concentrationPct * 2 ? 'high' : 'medium',
        amountPaise: r.due, href: `/sales/customers/${r.id}`, ownerUserId: r.owner_user_id, dueAt: addDays(c.now, 30),
      });
    }
  }
  return out;
}

/** Bills falling due within the days set under Controls, and bills already overdue. */
async function payables(ex: Executor, c: Ctx): Promise<Finding[]> {
  const { rows } = await sql<{ id: number; internal_no: string; vendor_invoice_no: string; due_date: string; due: string; display_name: string; is_msme: number }>`
    SELECT b.id, b.internal_no, b.vendor_invoice_no, b.due_date, b.total - b.amount_paid AS due, ct.display_name, ct.is_msme
      FROM bills b JOIN contacts ct ON ct.id = b.vendor_id
     WHERE b.org_id = ${c.orgId} AND b.status NOT IN ('draft', 'void') AND b.total > b.amount_paid
       AND b.due_date <= DATE_ADD(${c.today}, INTERVAL ${c.policies.controls.billsDueDays} DAY)
  `.execute(ex);
  return rows.filter((r) => !r.is_msme).map((r) => {
    const due = String(r.due_date).slice(0, 10);
    const late = daysBetween(due, c.today);
    return late > 0
      ? {
          kind: 'bill_overdue' as const, subjectType: 'bill', subjectId: r.id,
          title: `${r.internal_no} to ${r.display_name} is ${late} days overdue`,
          detail: `${rupees(toPaiseFromSql(r.due))} on their invoice ${r.vendor_invoice_no} fell due on ${due}. Pay it, or agree new terms with the supplier and note them here.`,
          severity: late > 30 ? 'high' as const : 'medium' as const,
          amountPaise: toPaiseFromSql(r.due), href: `/purchases/bills/${r.id}`, dueAt: addDays(c.now, 3),
        }
      : {
          kind: 'bill_due' as const, subjectType: 'bill', subjectId: r.id,
          title: `${r.internal_no} to ${r.display_name} falls due ${late === 0 ? 'today' : `in ${-late} days`}`,
          detail: `${rupees(toPaiseFromSql(r.due))} on their invoice ${r.vendor_invoice_no}, due ${due}. Approve and schedule the payment.`,
          severity: 'low' as const,
          amountPaise: toPaiseFromSql(r.due), href: `/purchases/bills/${r.id}`, dueAt: dateAt(due),
        };
  });
}

/** MSME bills from day 30 on: section 43B(h) disallows the expense if not paid by day 45 (or the agreed day). */
async function msme(ex: Executor, c: Ctx): Promise<Finding[]> {
  const bills = await msmeOpenBills(ex, c.orgId, c.today);
  return bills.filter((b) => b.balancePaise > 0 && (b.age >= 30 || b.risk !== 'safe')).map((b) => ({
    kind: 'msme_due' as const, subjectType: 'bill', subjectId: Number(b.billId),
    title: b.daysLeft < 0
      ? `${b.internalNo} to ${b.vendorName}: MSME deadline passed ${-b.daysLeft} days ago`
      : `${b.internalNo} to ${b.vendorName}: ${b.daysLeft} days left of the MSME ${b.limitDays}`,
    detail: `${rupees(b.balancePaise)} unpaid on day ${b.age}. Unless paid by ${b.deadline}, section 43B(h) disallows the expense this year and MSMED Act interest at three times the bank rate runs on it.`,
    severity: b.daysLeft <= 5 ? 'critical' as const : 'high' as const,
    amountPaise: b.balancePaise, href: `/purchases/bills/${b.billId}`, dueAt: dateAt(b.deadline),
  }));
}

/** Statement lines left unmatched for more than 30 days: the reconciliation is not being done. */
async function bank(ex: Executor, c: Ctx): Promise<Finding[]> {
  const { rows } = await sql<{ id: number; name: string; n: string; oldest: string }>`
    SELECT a.id, a.name, COUNT(*) AS n, MIN(t.txn_date) AS oldest
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id
     WHERE t.org_id = ${c.orgId} AND t.status = 'unmatched' AND t.txn_date <= DATE_SUB(${c.today}, INTERVAL 30 DAY)
     GROUP BY a.id, a.name
  `.execute(ex);
  return rows.map((r) => ({
    kind: 'bank_unreconciled' as const, subjectType: 'bank_account', subjectId: r.id,
    title: `${r.name}: ${r.n} statement lines unreconciled over 30 days`,
    detail: `The oldest is from ${String(r.oldest).slice(0, 10)}. Until they are matched, the bank balance in the books is not proven against the bank's.`,
    severity: Number(r.n) > 20 ? 'high' as const : 'medium' as const,
    href: '/banking/reconcile', dueAt: addDays(c.now, 7),
  }));
}

async function stock(ex: Executor, c: Ctx): Promise<Finding[]> {
  if (!c.policies.features.inventory) return [];
  const mins = await ex.selectFrom('items').select(['id', 'min_level']).where('org_id', '=', c.orgId)
    .where('is_archived', '=', 0).where('track_inventory', '=', 1).where('min_level', '>', '0').execute();
  if (!mins.length) return [];
  const min = new Map(mins.map((m) => [String(m.id), Number(m.min_level)]));
  const pos = await stockPosition(ex, c.orgId, c.today);
  return pos.lines.filter((l) => min.has(l.itemId) && l.qty < min.get(l.itemId)!).map((l) => ({
    kind: 'stock_below_min' as const, subjectType: 'item', subjectId: Number(l.itemId),
    title: `${l.name}: ${l.qty} ${l.uqc} on hand, below the minimum of ${min.get(l.itemId)}`,
    detail: 'Reorder before it runs out.',
    severity: l.qty <= 0 ? 'high' as const : 'low' as const,
    href: '/inventory/stock', dueAt: addDays(c.now, 7),
  }));
}

/** Parties whose GSTIN fails its check digit, or registered parties with none. */
async function masterData(ex: Executor, c: Ctx): Promise<Finding[]> {
  const parties = await ex.selectFrom('contacts').select(['id', 'display_name', 'kind', 'gstin', 'gst_treatment'])
    .where('org_id', '=', c.orgId).where('is_archived', '=', 0).execute();
  const out: Finding[] = [];
  for (const p of parties) {
    const registered = ['registered', 'registered_composition', 'sez'].includes(p.gst_treatment);
    const problem = p.gstin && !isValidGstin(p.gstin)
      ? `GSTIN ${p.gstin} fails its check digit: a character is wrong.`
      : registered && !p.gstin ? 'Marked as GST-registered but has no GSTIN.' : null;
    if (!problem) continue;
    out.push({
      kind: 'master_data', subjectType: 'contact', subjectId: p.id,
      title: `${p.display_name}: ${registered && !p.gstin ? 'no GSTIN' : 'invalid GSTIN'}`,
      detail: `${problem} Invoices and bills with this party carry it, and the IRP and GSTR-2B matching will not accept them.`,
      severity: 'medium', href: p.kind === 'vendor' ? '/purchases/vendors' : `/sales/customers/${p.id}`, dueAt: addDays(c.now, 7),
    });
  }
  return out;
}

/** Errors the server did not expect, not yet resolved (error-log.ts). */
async function systemErrors(ex: Executor, c: Ctx): Promise<Finding[]> {
  const row = await ex.selectFrom('error_events').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('last_seen_at').as('last')])
    .where('org_id', '=', c.orgId).where('status', '<>', 'resolved').executeTakeFirst();
  const n = Number(row?.n ?? 0);
  if (!n) return [];
  return [{
    kind: 'system_errors', subjectType: 'org', subjectId: c.orgId,
    title: `${n} system error${n === 1 ? '' : 's'} not yet resolved`,
    detail: 'Errors the software did not expect, with when and where they happened. Find the cause, fix it, and record both under Settings → System health.',
    severity: 'medium', href: '/settings?tab=health', dueAt: addDays(c.now, 3),
  }];
}

/** Contracts, licences and certificates in the library running out within 30 days. */
async function documents(ex: Executor, c: Ctx): Promise<Finding[]> {
  const rows = await ex.selectFrom('documents').select(['id', 'title', 'category', 'expires_on'])
    .where('org_id', '=', c.orgId).where('archived_at', 'is', null).where('expires_on', 'is not', null)
    .where('expires_on', '<=', sql<string>`DATE_ADD(${c.today}, INTERVAL 30 DAY)`).execute();
  return rows.map((d) => {
    const on = String(d.expires_on).slice(0, 10);
    const left = daysBetween(c.today, on);
    return {
      kind: 'document_expiring' as const, subjectType: 'document', subjectId: d.id,
      title: left < 0 ? `${d.title} expired ${-left} days ago` : `${d.title} expires ${left === 0 ? 'today' : `in ${left} days`}`,
      detail: `The ${d.category} runs out on ${on}. Renew it, or archive it in the document library if it is no longer needed.`,
      severity: left < 0 ? 'high' as const : left <= 7 ? 'medium' as const : 'low' as const,
      href: '/documents', dueAt: dateAt(on),
    };
  });
}

const DETECTORS = [irns, receivables, exposure, payables, msme, bank, stock, masterData, systemErrors, documents];

// ── Owners ──────────────────────────────────────────────────────────────────

/** Who deals with each kind, by role, first match wins. */
const OWNER_ROLES: Record<string, RoleName[]> = {
  GST: ['accountant', 'admin'],
  Receivables: ['sales', 'accountant', 'admin'],
  Payables: ['accountant', 'admin'],
  Banking: ['accountant', 'admin'],
  Inventory: ['staff', 'accountant', 'admin'],
  'Data quality': ['accountant', 'admin'],
  System: ['admin'],
  Documents: ['accountant', 'admin'],
};

async function ownerPicker(ex: Executor, orgId: number) {
  const users = await ex.selectFrom('users').select(['id', 'role']).where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('id').execute();
  const active = new Set(users.map((u) => u.id));
  return (kind: ExceptionKind, preferred?: number | null): number | null => {
    if (preferred && active.has(preferred)) return preferred;
    for (const role of OWNER_ROLES[EXCEPTION_KINDS[kind].area] ?? ['admin']) {
      const u = users.find((x) => x.role === role);
      if (u) return u.id;
    }
    return users[0]?.id ?? null;
  };
}

async function admins(ex: Executor, orgId: number): Promise<number[]> {
  return (await ex.selectFrom('users').select('id').where('org_id', '=', orgId).where('is_active', '=', 1).where('role', '=', 'admin').execute()).map((u) => u.id);
}

async function event(ex: Executor, orgId: number, exceptionId: number, userId: number | null, action: string, note?: string | null) {
  await ex.insertInto('exception_events').values({ org_id: orgId, exception_id: exceptionId, user_id: userId, action, note: note?.slice(0, 1000) ?? null }).execute();
}

const keyOf = (f: { kind: string; subjectType: string; subjectId: number }) => `${f.kind}:${f.subjectType}:${f.subjectId}`;

// ── The sweep ───────────────────────────────────────────────────────────────

export interface ScanResult { raised: number; updated: number; cleared: number; reopened: number; escalated: number }

/** Run every detector for one book and bring its exceptions up to date. */
export async function scanExceptions(orgId: number, now = new Date()): Promise<ScanResult> {
  return transaction((trx) => scanIn(trx, orgId, now));
}

/** The same, inside a transaction the caller holds (and a test rolls back). */
export async function scanIn(trx: Trx, orgId: number, now = new Date()): Promise<ScanResult> {
  const policies = await getPolicies(trx, orgId);
  const c: Ctx = { orgId, today: indiaToday(now), now, policies };
  const findings: Finding[] = [];
  // One after another: a transaction's connection runs one query at a time.
  for (const d of DETECTORS) findings.push(...await d(trx, c));
  return apply(trx, c, findings);
}

async function apply(trx: Trx, c: Ctx, findings: Finding[]): Promise<ScanResult> {
  const r: ScanResult = { raised: 0, updated: 0, cleared: 0, reopened: 0, escalated: 0 };
  const owner = await ownerPicker(trx, c.orgId);
  const open = await trx.selectFrom('exceptions').selectAll().where('org_id', '=', c.orgId).where('open_key', 'is not', null).forUpdate().execute();
  const byKey = new Map(open.map((x) => [x.open_key as string, x]));
  const seen = new Set<string>();

  for (const f of findings) {
    const key = keyOf(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byKey.get(key);
    const values = {
      title: f.title.slice(0, 200), detail: f.detail.slice(0, 1000), severity: f.severity, href: f.href,
      amount: f.amountPaise == null ? null : (f.amountPaise / 100).toFixed(4), last_seen_at: c.now,
    };
    if (!row) {
      const ownerId = owner(f.kind, f.ownerUserId);
      const id = Number((await trx.insertInto('exceptions').values({
        org_id: c.orgId, kind: f.kind, subject_type: f.subjectType, subject_id: f.subjectId, open_key: key,
        owner_user_id: ownerId, due_at: f.dueAt, detected_at: c.now, ...values,
      }).executeTakeFirstOrThrow()).insertId);
      await event(trx, c.orgId, id, null, 'raised', `Found by the scheduler and given to its owner, to deal with by ${indiaToday(f.dueAt)}.`);
      if (ownerId) await notify(trx, c.orgId, [ownerId], { kind: 'exception', title: f.title, body: 'Assigned to you to resolve.', href: `/exceptions?id=${id}` });
      r.raised++;
      continue;
    }
    await trx.updateTable('exceptions').set(values).where('id', '=', row.id).execute();
    r.updated++;
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[row.severity] && row.status !== 'waived') {
      await event(trx, c.orgId, row.id, null, 'worsened', `Now ${f.severity}: ${f.title}`);
    }
    // Marked resolved, but still there a day later: it was not resolved.
    if (row.status === 'resolved' && row.closed_at && c.now.getTime() - new Date(row.closed_at).getTime() > DAY) {
      await trx.updateTable('exceptions').set({
        status: 'open', closed_at: null, closed_by_user_id: null, escalation_level: 0, escalated_at: null, due_at: f.dueAt,
      }).where('id', '=', row.id).execute();
      await event(trx, c.orgId, row.id, null, 'reopened', 'Still found a day after it was marked resolved.');
      if (row.owner_user_id) await notify(trx, c.orgId, [row.owner_user_id], { kind: 'exception', title: `Reopened: ${f.title}`, href: `/exceptions?id=${row.id}` });
      r.reopened++;
    }
  }

  // Gone: the invoice was paid, the IRN came through. Closed by itself.
  for (const row of open) {
    if (seen.has(row.open_key as string)) continue;
    const working = row.status === 'open' || row.status === 'in_progress';
    await trx.updateTable('exceptions').set({
      open_key: null,
      ...(working ? { status: 'resolved' as const, closed_at: c.now, resolution: 'Cleared by itself: the condition is no longer found.' } : {}),
    }).where('id', '=', row.id).execute();
    await event(trx, c.orgId, row.id, null, 'cleared', 'The condition is no longer found.');
    r.cleared++;
  }

  // Past their date: the owner is reminded; some days later, the admins are told.
  const late = await trx.selectFrom('exceptions').selectAll().where('org_id', '=', c.orgId)
    .where('status', 'in', ['open', 'in_progress']).where('due_at', '<', c.now).execute();
  const after = c.policies.controls.escalateAfterDays;
  const adminIds = late.length ? await admins(trx, c.orgId) : [];
  for (const x of late) {
    if (x.escalation_level === 0) {
      await trx.updateTable('exceptions').set({ escalation_level: 1, escalated_at: c.now }).where('id', '=', x.id).execute();
      await event(trx, c.orgId, x.id, null, 'escalated', 'Past its date: the owner was reminded.');
      if (x.owner_user_id) await notify(trx, c.orgId, [x.owner_user_id], { kind: 'exception', title: `Past its date: ${x.title}`, href: `/exceptions?id=${x.id}` });
      r.escalated++;
    } else if (x.escalation_level === 1 && x.due_at && c.now.getTime() - new Date(x.due_at).getTime() > after * DAY) {
      await trx.updateTable('exceptions').set({ escalation_level: 2, escalated_at: c.now }).where('id', '=', x.id).execute();
      await event(trx, c.orgId, x.id, null, 'escalated', `${after} days past its date: sent to the admins.`);
      await notify(trx, c.orgId, adminIds, { kind: 'exception', title: `Escalated: ${x.title}`, body: 'Past its date and still open.', href: `/exceptions?id=${x.id}` });
      r.escalated++;
    }
  }
  return r;
}

/** Every book, from the scheduler. One book's failure does not stop the rest. */
export async function runExceptions(now = new Date()): Promise<number> {
  const orgs = await db.selectFrom('organizations').select('id').execute();
  let raised = 0;
  for (const o of orgs) {
    try {
      raised += (await scanExceptions(Number(o.id), now)).raised;
    } catch (err) {
      console.error(`[exceptions] org ${o.id} failed`, err);
    }
  }
  return raised;
}

// ── Working them ────────────────────────────────────────────────────────────

export type ExceptionAction = 'assign' | 'start' | 'note' | 'resolve' | 'waive' | 'reopen';

export async function actOnException(
  trx: Trx, orgId: number, user: { userId: number; canManage: boolean },
  id: number, input: { action: ExceptionAction; ownerUserId?: number | null; note?: string | null },
) {
  const row = await trx.selectFrom('exceptions').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That exception was not found.');
  const mine = row.owner_user_id === user.userId;
  const note = input.note?.trim() || null;
  if (!user.canManage && !mine) throw forbidden('This exception is someone else\'s. Ask its owner or a manager.');
  const closed = row.status === 'resolved' || row.status === 'waived';

  switch (input.action) {
    case 'assign': {
      if (!user.canManage) throw forbidden('Handing an exception to someone else needs a manager.');
      const to = input.ownerUserId ? await trx.selectFrom('users').select(['id', 'name']).where('id', '=', input.ownerUserId)
        .where('org_id', '=', orgId).where('is_active', '=', 1).executeTakeFirst() : null;
      if (!to) throw badRequest('Choose an active user to give it to.');
      await trx.updateTable('exceptions').set({ owner_user_id: to.id }).where('id', '=', id).execute();
      await event(trx, orgId, id, user.userId, 'assigned', `Given to ${to.name}.${note ? ` ${note}` : ''}`);
      if (to.id !== user.userId) await notify(trx, orgId, [to.id], { kind: 'exception', title: row.title, body: 'Assigned to you to resolve.', href: `/exceptions?id=${id}` });
      return;
    }
    case 'start':
      if (closed) throw conflict('It is closed. Reopen it first.');
      await trx.updateTable('exceptions').set({ status: 'in_progress' }).where('id', '=', id).execute();
      await event(trx, orgId, id, user.userId, 'started', note);
      return;
    case 'note':
      if (!note) throw badRequest('Write the note.');
      await event(trx, orgId, id, user.userId, 'note', note);
      return;
    case 'resolve':
    case 'waive': {
      if (closed) throw conflict('It is already closed.');
      if (!note || note.length < 5) throw badRequest(input.action === 'resolve' ? 'Say what was done to resolve it.' : 'Say why it is being accepted.');
      if (input.action === 'waive' && !user.canManage) throw forbidden('Waiving an exception — accepting it and stopping the reminders — needs a manager.');
      await trx.updateTable('exceptions').set({
        status: input.action === 'resolve' ? 'resolved' : 'waived', closed_at: new Date(), closed_by_user_id: user.userId, resolution: note.slice(0, 500),
      }).where('id', '=', id).execute();
      await event(trx, orgId, id, user.userId, input.action === 'resolve' ? 'resolved' : 'waived', note);
      return;
    }
    case 'reopen':
      if (!closed) throw conflict('It is not closed.');
      if (!row.open_key) throw conflict('The condition has cleared; there is nothing left to reopen.');
      await trx.updateTable('exceptions').set({ status: 'open', closed_at: null, closed_by_user_id: null, resolution: null }).where('id', '=', id).execute();
      await event(trx, orgId, id, user.userId, 'reopened', note);
      return;
  }
}

// ── Reading them ────────────────────────────────────────────────────────────

export interface ExceptionRow {
  id: string; kind: ExceptionKind; area: string; label: string; title: string; detail: string | null;
  severity: ExceptionSeverity; status: ExceptionStatus; amountPaise: Paise | null; href: string | null;
  ownerId: string | null; ownerName: string | null; detectedAt: string; dueAt: string | null; overdue: boolean;
  escalationLevel: number; closedAt: string | null; resolution: string | null; stillPresent: boolean;
}

function toRow(r: Record<string, unknown>, now: number): ExceptionRow {
  const kind = r.kind as ExceptionKind;
  const status = r.status as ExceptionStatus;
  const due = r.due_at ? new Date(r.due_at as Date) : null;
  return {
    id: String(r.id), kind, area: EXCEPTION_KINDS[kind]?.area ?? 'Other', label: EXCEPTION_KINDS[kind]?.label ?? kind,
    title: r.title as string, detail: (r.detail as string) ?? null, severity: r.severity as ExceptionSeverity, status,
    amountPaise: r.amount == null ? null : toPaiseFromSql(r.amount as string), href: (r.href as string) ?? null,
    ownerId: r.owner_user_id == null ? null : String(r.owner_user_id), ownerName: (r.owner_name as string) ?? null,
    detectedAt: new Date(r.detected_at as Date).toISOString(), dueAt: due ? due.toISOString() : null,
    overdue: !!due && due.getTime() < now && (status === 'open' || status === 'in_progress'),
    escalationLevel: Number(r.escalation_level), closedAt: r.closed_at ? new Date(r.closed_at as Date).toISOString() : null,
    resolution: (r.resolution as string) ?? null, stillPresent: r.open_key != null,
  };
}

export async function listExceptions(
  ex: Executor, orgId: number, filter: { view?: 'active' | 'closed' | 'all'; ownerUserId?: number; kind?: string } = {},
) {
  const view = filter.view ?? 'active';
  const rows = await ex.selectFrom('exceptions as x').leftJoin('users as u', 'u.id', 'x.owner_user_id')
    .selectAll('x').select('u.name as owner_name')
    .where('x.org_id', '=', orgId)
    .$if(view === 'active', (q) => q.where('x.status', 'in', ['open', 'in_progress']))
    .$if(view === 'closed', (q) => q.where('x.status', 'in', ['resolved', 'waived']))
    .$if(!!filter.ownerUserId, (q) => q.where('x.owner_user_id', '=', filter.ownerUserId!))
    .$if(!!filter.kind, (q) => q.where('x.kind', '=', filter.kind!))
    .orderBy(sql`FIELD(x.severity, 'critical', 'high', 'medium', 'low')`).orderBy('x.due_at').limit(500).execute();
  const now = Date.now();
  const counts = await ex.selectFrom('exceptions').select(['status', 'severity', (eb) => eb.fn.countAll<string>().as('n')])
    .where('org_id', '=', orgId).groupBy(['status', 'severity']).execute();
  const active = counts.filter((c) => c.status === 'open' || c.status === 'in_progress');
  return {
    exceptions: rows.map((r) => toRow(r as unknown as Record<string, unknown>, now)),
    summary: {
      active: active.reduce((t, c) => t + Number(c.n), 0),
      critical: active.filter((c) => c.severity === 'critical').reduce((t, c) => t + Number(c.n), 0),
      high: active.filter((c) => c.severity === 'high').reduce((t, c) => t + Number(c.n), 0),
      closed: counts.filter((c) => c.status === 'resolved' || c.status === 'waived').reduce((t, c) => t + Number(c.n), 0),
    },
  };
}

export async function exceptionDetail(ex: Executor, orgId: number, id: number) {
  const row = await ex.selectFrom('exceptions as x').leftJoin('users as u', 'u.id', 'x.owner_user_id')
    .selectAll('x').select('u.name as owner_name').where('x.id', '=', id).where('x.org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That exception was not found.');
  const events = await ex.selectFrom('exception_events as e').leftJoin('users as u', 'u.id', 'e.user_id')
    .select(['e.id', 'e.action', 'e.note', 'e.created_at', 'u.name']).where('e.exception_id', '=', id).orderBy('e.id').execute();
  return {
    exception: toRow(row as unknown as Record<string, unknown>, Date.now()),
    events: events.map((e) => ({ id: String(e.id), action: e.action, note: e.note, at: new Date(e.created_at).toISOString(), by: e.name ?? 'Scheduler' })),
  };
}

/** For the menu badge: what is waiting on this person, or on anyone for a manager. */
export async function activeCount(ex: Executor, orgId: number, userId: number, everyone: boolean): Promise<number> {
  const r = await ex.selectFrom('exceptions').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', orgId).where('status', 'in', ['open', 'in_progress'])
    .$if(!everyone, (q) => q.where('owner_user_id', '=', userId)).executeTakeFirst();
  return Number(r?.n ?? 0);
}
