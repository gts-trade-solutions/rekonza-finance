import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Filing a return, from inside the books: whether it is filed, by when it was
// due, what filing it late costs, whether a GSP is there to file it through,
// and the mark itself — the date and the ARN the portal gave — with the lock
// that keeps a filed period from changing behind the return.
//
// The mark is kept where the compliance calendar and the return status grid
// read it (compliance_filings), so all three always agree. Marking a return
// filed also keeps its documents as filed (filed-snapshots.ts) and, if asked,
// moves the module locks (transaction_locks) to the end of the period: the
// posting engine then refuses anything dated in it from every screen at once
// (ledger/posting.ts assertPeriodOpen). That is the same lock Settings →
// Transaction locking sets, so unlocking stays possible — and audited — when a
// genuine correction has to be made.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, notFound } from '../http';
import { calendarProfile, obligations } from '../tax/compliance-calendar';
import { returnsProviderOptions } from '../integrations/gst/returns-service';
import { gstr3bForm } from './gstr3b-form';
import { gstr7 } from './gstr7';
import { gstr8 } from './gstr8';
import { gstr9 } from './gstr9';
import { dropSnapshot, snapshotReturn } from './filed-snapshots';
import { toPaiseFromSql } from '../money-sql';
import {
  RETURN_META, daysBetween, monthlyLateFee, periodEnd, periodLabel, type FilingReturn,
} from '../../gst/filing';

const pad = (n: number) => String(n).padStart(2, '0');
const day = (v: unknown) => (v ? String(v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : v).slice(0, 10) : null);

/** The financial year a return period falls in. */
function fyOfPeriod(period: string): number {
  if (/^\d{4}$/.test(period)) return Number(period);
  if (/^\d{4}-Q[1-4]$/.test(period)) return Number(period.slice(0, 4));
  const [y, m] = period.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

export function assertPeriod(type: FilingReturn, period: string) {
  const ok = RETURN_META[type].annual ? /^\d{4}$/.test(period) : /^\d{4}-(\d{2}|Q[1-4])$/.test(period);
  if (!ok) throw badRequest(RETURN_META[type].annual ? 'Give the financial year as the year it starts in, e.g. 2025 for 2025-26.' : 'Give the period as yyyy-mm, or yyyy-Qn for a quarter.');
}

/** The due date the compliance calendar works out for this book; the statute's own where it has none. */
export async function dueDateOf(ex: Executor, orgId: number, type: FilingReturn, period: string): Promise<string> {
  const profile = await calendarProfile(ex, orgId);
  const found = obligations({ ...profile, gstTdsDeductor: true, gstEcoOperator: true, einvoicing: true }, fyOfPeriod(period))
    .find((o) => o.key === type && o.period === period);
  if (found) return found.dueDate;
  if (RETURN_META[type].annual) return `${Number(period) + 1}-12-31`;
  const end = periodEnd(period);
  const [y, m] = end.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  const dayOf: Record<string, number> = { gstr1: 11, iff: 13, gstr3b: 20, gstr7: 10, gstr8: 10 };
  return `${next}-${pad(dayOf[type] ?? 20)}`;
}

export interface FilingStatus {
  returnType: FilingReturn;
  title: string;
  period: string;
  periodLabel: string;
  periodEnd: string;
  dueDate: string;
  status: 'filed' | 'filed_late' | 'overdue' | 'due_soon' | 'upcoming';
  daysLate: number;
  filed: { on: string; arn: string | null; note: string | null; by: string | null } | null;
  /** What filing (or having filed) late costs, as far as the books can tell. */
  estimate: { lateFeeCgstPaise: number; lateFeeSgstPaise: number; interestPaise: number; basis: string };
  /** Filing through a GST Suvidha Provider: set up on this server or not. */
  gsp: { configured: boolean; returnsSupported: boolean; missing: string[]; label: string };
  /** The module locks as they stand. */
  locks: { sales: string | null; purchases: string | null };
  /** The locks a filing of this return should move, and to where. */
  suggestedLocks: ('sales' | 'purchases')[];
  offlineSteps: string[];
  href: string;
}

async function estimateFor(ex: Executor, orgId: number, type: FilingReturn, period: string, today: string, daysLate: number): Promise<FilingStatus['estimate']> {
  const none = (basis: string) => ({ lateFeeCgstPaise: 0, lateFeeSgstPaise: 0, interestPaise: 0, basis });
  if (type === 'iff') return none('IFF is optional: there is no late fee. Invoices not furnished in IFF go in the quarter\'s GSTR-1.');
  if (type === 'gstr9c') return none('GSTR-9C is filed with GSTR-9; its late fee is the one worked out for GSTR-9.');
  if (type === 'gstr3b') {
    const f = await gstr3bForm(ex, orgId, period, { today });
    const i = f.interestLateFee;
    return {
      lateFeeCgstPaise: i.lateFee.cgstPaise, lateFeeSgstPaise: i.lateFee.sgstPaise,
      interestPaise: i.interest.igstPaise + i.interest.cgstPaise + i.interest.sgstPaise + i.interest.cessPaise,
      basis: i.basis,
    };
  }
  if (type === 'gstr7' || type === 'gstr8') {
    const g = type === 'gstr7' ? await gstr7(ex, orgId, period, today) : await gstr8(ex, orgId, period, today);
    const t = g.table6;
    return {
      lateFeeCgstPaise: t.lateFee.cgstPaise, lateFeeSgstPaise: t.lateFee.sgstPaise,
      interestPaise: t.interest.igstPaise + t.interest.cgstPaise + t.interest.sgstPaise, basis: t.basis,
    };
  }
  if (type === 'gstr9') {
    const g = await gstr9(ex, orgId, Number(period), undefined, { today });
    return { lateFeeCgstPaise: g.table19.cgst.payablePaise, lateFeeSgstPaise: g.table19.sgst.payablePaise, interestPaise: 0, basis: g.table19.basis };
  }
  // GSTR-1: no tax is paid with it, so no interest; the late fee by turnover.
  if (daysLate <= 0) return none('Filed by the due date: no late fee.');
  const fy = fyOfPeriod(period);
  const org = await ex.selectFrom('organizations').select('aato_above_5cr').where('id', '=', orgId).executeTakeFirstOrThrow();
  const { rows: [t] } = await sql<{ v: string; n: number }>`
    SELECT COALESCE(SUM(IF(invoice_date < ${`${fy}-04-01`}, subtotal, 0)), 0) AS v,
           SUM(invoice_date BETWEEN ${`${period}-01`} AND ${periodEnd(period)}) AS n
      FROM invoices WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void')
       AND invoice_date BETWEEN ${`${fy - 1}-04-01`} AND ${periodEnd(period)}
  `.execute(ex);
  const nil = !Number(t?.n ?? 0);
  const fee = monthlyLateFee(daysLate, { nil, turnoverPaise: toPaiseFromSql(t?.v ?? '0'), aboveFiveCrore: !!org.aato_above_5cr });
  return {
    lateFeeCgstPaise: fee.cgstPaise, lateFeeSgstPaise: fee.sgstPaise, interestPaise: 0,
    basis: `${daysLate} day${daysLate === 1 ? '' : 's'} after the due date: a late fee of ₹${fee.perDayRupees} a day (half CGST, half SGST), ` +
      `capped at ₹${fee.capRupees.toLocaleString('en-IN')} for ${nil ? 'a nil return' : 'last year\'s turnover'} (section 47, Notification 20/2021-CT). ` +
      'No interest: GSTR-1 carries no tax. The portal charges the fee with the next GSTR-3B.',
  };
}

export async function filingStatus(ex: Executor, orgId: number, type: FilingReturn, period: string, today: string): Promise<FilingStatus> {
  assertPeriod(type, period);
  const meta = RETURN_META[type];
  const [dueDate, mark, locks] = await Promise.all([
    dueDateOf(ex, orgId, type, period),
    ex.selectFrom('compliance_filings as f').leftJoin('users as u', 'u.id', 'f.created_by_user_id')
      .select(['f.done_on', 'f.reference', 'f.note', 'u.name']).where('f.org_id', '=', orgId).where('f.item_key', '=', type).where('f.period', '=', period)
      .executeTakeFirst(),
    ex.selectFrom('transaction_locks').select(['module', 'locked_upto']).where('org_id', '=', orgId).where('module', 'in', ['sales', 'purchases']).execute(),
  ]);
  const filedOn = mark ? day(mark.done_on)! : null;
  const daysLate = Math.max(0, daysBetween(dueDate, filedOn ?? today));
  const status: FilingStatus['status'] = filedOn
    ? (daysLate > 0 ? 'filed_late' : 'filed')
    : daysLate > 0 ? 'overdue' : daysBetween(today, dueDate) <= 7 ? 'due_soon' : 'upcoming';
  const gstn = returnsProviderOptions().find((o) => o.name === 'gstn');
  const lockOf = (m: string) => day(locks.find((l) => l.module === m)?.locked_upto ?? null);
  return {
    returnType: type,
    title: meta.title,
    period,
    periodLabel: periodLabel(period),
    periodEnd: periodEnd(period),
    dueDate,
    status,
    daysLate,
    filed: mark ? { on: filedOn!, arn: mark.reference, note: mark.note, by: mark.name ?? null } : null,
    estimate: await estimateFor(ex, orgId, type, period, today, daysLate),
    gsp: {
      configured: !!gstn && gstn.missing.length === 0,
      // The GSP connection pushes and files GSTR-1, IFF and GSTR-3B; the others are uploaded by hand.
      returnsSupported: ['gstr1', 'iff', 'gstr3b'].includes(type),
      missing: gstn?.missing ?? [],
      label: gstn?.label ?? 'GST system through your GSP',
    },
    locks: { sales: lockOf('sales'), purchases: lockOf('purchases') },
    suggestedLocks: meta.locks,
    offlineSteps: meta.offlineSteps,
    href: meta.href,
  };
}

const ARN = /^[A-Z0-9]{10,20}$/;

export interface MarkFiledInput {
  returnType: FilingReturn;
  period: string;
  filedOn: string;
  arn: string;
  note?: string | null;
  /** Lock these modules up to the end of the period. */
  lock?: ('sales' | 'purchases')[];
}

/**
 * Mark a return filed (or correct the mark: the date or the ARN). Keeps the
 * return's documents as filed and moves the locks asked for. A lock is only
 * ever moved forward here; taking it back is done in Settings → Transaction
 * locking, where the unlock is audited.
 */
export async function markFiled(trx: Trx, orgId: number, userId: number | null, input: MarkFiledInput, today: string) {
  assertPeriod(input.returnType, input.period);
  const arn = input.arn.trim().toUpperCase();
  if (!ARN.test(arn)) throw badRequest('Give the ARN the portal showed after filing: 10 to 20 letters and digits, such as AA3310260123456.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.filedOn)) throw badRequest('Give the date of filing.');
  if (input.filedOn > today) throw badRequest('A return cannot be filed in the future: give the date the portal shows.');
  const start = RETURN_META[input.returnType].annual ? `${input.period}-04-01`
    : /Q/.test(input.period) ? `${input.period.slice(0, 4)}-${pad(4 + (Number(input.period.slice(6)) - 1) * 3)}-01` : `${input.period}-01`;
  if (input.filedOn < start) throw badRequest(`A return for ${periodLabel(input.period)} cannot have been filed before the period began.`);

  const values = { done_on: input.filedOn, reference: arn, note: input.note?.trim() || null, created_by_user_id: userId };
  await trx.insertInto('compliance_filings').values({ org_id: orgId, item_key: input.returnType, period: input.period, ...values })
    .onDuplicateKeyUpdate(values).execute();
  const kept = await snapshotReturn(trx, orgId, input.returnType, input.period);

  const locked: { module: 'sales' | 'purchases'; lockedUpto: string }[] = [];
  const upto = periodEnd(input.period);
  for (const module of [...new Set(input.lock ?? [])]) {
    const cur = await trx.selectFrom('transaction_locks').select(['id', 'locked_upto']).where('org_id', '=', orgId).where('module', '=', module).forUpdate().executeTakeFirst();
    const have = day(cur?.locked_upto ?? null);
    if (have && have >= upto) { locked.push({ module, lockedUpto: have }); continue; }
    const reason = `${RETURN_META[input.returnType].title} for ${periodLabel(input.period)} filed (ARN ${arn})`;
    if (cur) await trx.updateTable('transaction_locks').set({ locked_upto: upto, reason, locked_by_user_id: userId }).where('id', '=', cur.id).execute();
    else await trx.insertInto('transaction_locks').values({ org_id: orgId, module, locked_upto: upto, reason, locked_by_user_id: userId }).execute();
    locked.push({ module, lockedUpto: upto });
  }
  return { arn, kept, locked };
}

/** Take the filed mark off: the return shows as not filed here; nothing on the portal changes. */
export async function unmarkFiled(trx: Trx, orgId: number, type: FilingReturn, period: string) {
  assertPeriod(type, period);
  const r = await trx.deleteFrom('compliance_filings').where('org_id', '=', orgId).where('item_key', '=', type).where('period', '=', period).executeTakeFirst();
  if (!Number(r.numDeletedRows)) throw notFound(`${RETURN_META[type].title} for ${periodLabel(period)} is not marked filed.`);
  await dropSnapshot(trx, orgId, type, period);
}
