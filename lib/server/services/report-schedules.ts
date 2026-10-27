import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled reports: a report made on its day, for a period worked out from
// that day — last month's profit and loss on the 1st, the receivables ageing
// every Monday — kept as a workbook and announced to the people it is for.
//
// Recipients are checked when it runs: someone whose role no longer includes
// the report (report-level rights) is left out, and told nothing.
// A run that fell behind runs once for today; reports are not caught up.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { db, transaction, type Executor, type Trx } from '../db';
import { reportModule } from '../../report-groups';
import { workbook } from '../../xlsx';
import { badRequest, notFound } from '../http';
import { fileStore } from '../files/store';
import { tabulate, SCHEDULABLE, type SchedulableReport } from '../reports/tabulate';
import { advancePeriod } from './recurring';
import { indiaToday } from './held-journals';
import { notify, usersWhoCan } from './notifications';
import { queueEvent } from '../integrations/webhooks';

export const PERIODS = {
  last_month: 'Last month',
  month_to_date: 'This month so far',
  last_week: 'Last week (Mon–Sun)',
  last_quarter: 'Last quarter',
  fy_to_date: 'This financial year so far',
  as_of_today: 'As at the day it runs',
} as const;
export type Period = keyof typeof PERIODS;
export type Frequency = 'daily' | 'weekly' | 'monthly';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** The period a report covers when it runs on `day`. */
export function periodRange(period: Period, day: string): { from: string; to: string } {
  const d = utc(day);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const fyStart = iso(new Date(Date.UTC(m >= 3 ? y : y - 1, 3, 1)));
  switch (period) {
    case 'last_month': return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'month_to_date': return { from: iso(new Date(Date.UTC(y, m, 1))), to: day };
    case 'last_week': {
      const monday = addDays(day, -(((d.getUTCDay() + 6) % 7) + 7));
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'last_quarter': {
      const q = Math.floor(m / 3);
      return { from: iso(new Date(Date.UTC(y, (q - 1) * 3, 1))), to: iso(new Date(Date.UTC(y, q * 3, 0))) };
    }
    case 'fy_to_date': return { from: fyStart, to: day };
    case 'as_of_today': return { from: fyStart, to: day };
  }
}

const step = (date: string, f: Frequency) => (f === 'daily' ? addDays(date, 1) : f === 'weekly' ? addDays(date, 7) : advancePeriod(date, 'monthly'));

export async function saveSchedule(
  trx: Trx, orgId: number, userId: number | null,
  input: { id?: number | null; name: string; report: string; period: string; frequency: Frequency; firstRun: string; recipients: number[]; isActive?: boolean },
) {
  if (!(input.report in SCHEDULABLE)) throw badRequest('That report cannot be scheduled.');
  if (!(input.period in PERIODS)) throw badRequest('Choose the period the report covers.');
  if (!input.recipients.length) throw badRequest('Choose who receives it.');
  const users = await trx.selectFrom('users').select('id').where('org_id', '=', orgId).where('id', 'in', input.recipients).execute();
  if (users.length !== new Set(input.recipients).size) throw badRequest('One of those people is not a user of this book.');
  const values = {
    name: input.name.trim() || SCHEDULABLE[input.report as SchedulableReport], report: input.report, period: input.period,
    frequency: input.frequency, next_run: input.firstRun, recipients: JSON.stringify([...new Set(input.recipients)]), is_active: input.isActive === false ? 0 : 1,
  };
  if (input.id) {
    const r = await trx.updateTable('report_schedules').set({ ...values, last_error: null }).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That schedule was not found.');
    return input.id;
  }
  return Number((await trx.insertInto('report_schedules').values({ org_id: orgId, ...values, created_by_user_id: userId }).executeTakeFirstOrThrow()).insertId);
}

export async function deleteSchedule(trx: Trx, orgId: number, id: number) {
  await trx.deleteFrom('report_schedules').where('id', '=', id).where('org_id', '=', orgId).execute();
}

const list = (v: unknown) => ((typeof v === 'string' ? JSON.parse(v) : v) as number[]).map(Number);

export async function listSchedules(ex: Executor, orgId: number) {
  const [schedules, files] = await Promise.all([
    ex.selectFrom('report_schedules').selectAll().where('org_id', '=', orgId).orderBy('next_run').execute(),
    ex.selectFrom('report_files').selectAll().where('org_id', '=', orgId).orderBy('id', 'desc').limit(60).execute(),
  ]);
  return {
    schedules: schedules.map((s) => ({
      id: String(s.id), name: s.name, report: s.report, period: s.period, frequency: s.frequency,
      nextRun: String(s.next_run).slice(0, 10), recipients: list(s.recipients).map(String), isActive: !!s.is_active,
      lastRunAt: s.last_run_at ? new Date(s.last_run_at).toISOString() : null, lastError: s.last_error,
    })),
    files: files.map((f) => ({
      id: String(f.id), scheduleId: f.schedule_id ? String(f.schedule_id) : null, report: f.report, name: f.name,
      from: f.period_from ? String(f.period_from).slice(0, 10) : null, to: String(f.period_to).slice(0, 10), bytes: f.byte_size,
      at: new Date(f.created_at).toISOString(),
    })),
  };
}

/** Who may receive a report: active, in the book, and allowed to see that report. */
const allowed = (ex: Executor, orgId: number, userIds: number[], report: string) =>
  usersWhoCan(ex, orgId, reportModule(report), 'view', userIds);

/** Make one run of a schedule: the workbook, the file, the notifications. */
export async function runSchedule(trx: Trx, orgId: number, id: number, day: string) {
  const s = await trx.selectFrom('report_schedules').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!s) throw notFound('That schedule was not found.');
  const range = periodRange(s.period as Period, day);
  const bytes = Buffer.from(workbook(await tabulate(trx, orgId, s.report as SchedulableReport, range)));
  const key = `${orgId}/reports/${day.slice(0, 4)}/${day.slice(5, 7)}/${randomUUID()}.xlsx`;
  await fileStore().put(key, bytes);
  const label = s.period === 'as_of_today' ? `as at ${range.to}` : `${range.from} to ${range.to}`;
  const fileId = Number((await trx.insertInto('report_files').values({
    org_id: orgId, schedule_id: id, report: s.report, name: `${s.name}, ${label}`,
    period_from: s.period === 'as_of_today' ? null : range.from, period_to: range.to, storage_key: key, byte_size: bytes.length,
  }).executeTakeFirstOrThrow()).insertId);
  const to = await allowed(trx, orgId, list(s.recipients), s.report);
  await notify(trx, orgId, to, { kind: 'report', title: `${s.name} is ready`, body: label, href: `/reports/scheduled?file=${fileId}` });
  await queueEvent(trx, orgId, 'report.generated', { type: 'report_file', id: String(fileId), label: `${s.name}, ${label}`, detail: s.report, actor: 'Scheduler' });
  let next = step(String(s.next_run).slice(0, 10), s.frequency as Frequency);
  while (next <= day) next = step(next, s.frequency as Frequency);
  await trx.updateTable('report_schedules').set({ last_run_at: new Date(), next_run: next, last_error: null }).where('id', '=', id).execute();
  return { fileId, recipients: to.length, nextRun: next };
}

/** Every schedule due today, each in its own transaction. Run by the scheduler. */
export async function runDueReports(day = indiaToday()) {
  const due = await db.selectFrom('report_schedules').select(['id', 'org_id']).where('is_active', '=', 1).where('next_run', '<=', day).execute();
  let made = 0;
  for (const s of due) {
    try {
      await transaction((trx) => runSchedule(trx, s.org_id, s.id, day));
      made++;
    } catch (err) {
      await db.updateTable('report_schedules').set({ last_error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).where('id', '=', s.id).execute();
    }
  }
  return made;
}

export async function readReportFile(ex: Executor, orgId: number, id: number) {
  const f = await ex.selectFrom('report_files').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!f) throw notFound('That report file was not found.');
  return { name: f.name, report: f.report, bytes: await fileStore().get(f.storage_key) };
}
