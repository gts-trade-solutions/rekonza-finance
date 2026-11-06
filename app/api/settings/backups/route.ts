import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { getPolicies } from '@/lib/server/services/org-settings';

// ─────────────────────────────────────────────────────────────────────────────
// Is the data safe? Read from backup_runs, which scripts/db-backup.mjs writes
// on every backup, check and restore drill.
//
// Two numbers matter. The age of the newest good backup is the most work a
// disaster could cost (the recovery point); the law asks for a backup every
// day. And the last successful restore drill says whether any of it can
// actually be brought back, and how long that takes (the recovery time).
// ─────────────────────────────────────────────────────────────────────────────

/** A couple of hours' grace on the recovery point, for a slow night. */
const GRACE_HOURS = 2;
/** A restore proved at least monthly. */
const DRILL_DUE_DAYS = 31;

export const GET = route(
  async ({ orgId }) => {
    const { recovery } = await getPolicies(db, orgId);
    const BACKUP_DUE_HOURS = recovery.rpoHours + GRACE_HOURS;
    const latest = (kind: 'backup' | 'verify' | 'drill', ok?: boolean) =>
      db.selectFrom('backup_runs').selectAll()
        .where('kind', '=', kind)
        .$if(ok !== undefined, (q) => q.where('ok', '=', ok ? 1 : 0))
        .orderBy('started_at', 'desc').limit(1).executeTakeFirst();

    const [backup, backupFailed, verify, drill, drillFailed, recent, guards] = await Promise.all([
      latest('backup', true), latest('backup', false), latest('verify', true), latest('drill', true), latest('drill', false),
      db.selectFrom('backup_runs').selectAll().orderBy('started_at', 'desc').limit(20).execute(),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME IN ('trg_audit_log_no_update', 'trg_audit_log_no_delete',
                                'trg_journal_entries_no_update', 'trg_journal_entries_no_delete',
                                'trg_journal_lines_no_update', 'trg_journal_lines_no_delete')
      `.execute(db),
    ]);

    const iso = (d: unknown) => (d ? (d instanceof Date ? d : new Date(String(d))).toISOString() : null);
    const hoursSince = (d: unknown) => (d ? (Date.now() - new Date(iso(d)!).getTime()) / 3_600_000 : null);
    const backupAge = hoursSince(backup?.started_at);
    const drillAge = hoursSince(drill?.started_at);

    const warnings: string[] = [];
    if (backupAge === null) warnings.push('No backup has ever been recorded. Schedule npm run db:backup to run daily.');
    else if (backupAge > BACKUP_DUE_HOURS) warnings.push(`The newest backup is ${Math.floor(backupAge / 24)} day(s) old. Rule 3(5) asks for one every day.`);
    if (backupFailed && (!backup || new Date(iso(backupFailed.started_at)!) > new Date(iso(backup.started_at)!))) {
      warnings.push(`The last backup attempt failed: ${backupFailed.detail ?? 'no detail'}`);
    }
    if (drillAge === null) warnings.push('No restore has ever been proved. Run npm run db:backup -- drill once a month.');
    else if (drillAge > DRILL_DUE_DAYS * 24) warnings.push(`The last successful restore drill was ${Math.floor(drillAge / 24)} days ago; aim for monthly.`);
    const drillSeconds = drill?.finished_at ? (new Date(iso(drill.finished_at)!).getTime() - new Date(iso(drill.started_at)!).getTime()) / 1000 : null;
    if (drillSeconds !== null && drillSeconds > recovery.rtoMinutes * 60) {
      warnings.push(`The last restore took ${Math.ceil(drillSeconds / 60)} minutes, longer than the ${recovery.rtoMinutes}-minute recovery time set.`);
    }
    const isProtected = Number(guards.rows[0]?.n ?? 0) === 6;
    if (!isProtected) warnings.push('The database does not yet refuse edits to the audit trail and journal. Run npm run db:protect.');

    const run = (r: typeof recent[number] | undefined) => r && {
      kind: r.kind, ok: !!r.ok, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), file: r.file,
      bytes: r.bytes === null ? null : Number(r.bytes), filesCount: r.files_count, detail: r.detail, host: r.host,
      seconds: r.finished_at ? Math.round((new Date(iso(r.finished_at)!).getTime() - new Date(iso(r.started_at)!).getTime()) / 1000) : null,
    };

    return {
      lastBackup: run(backup) ?? null,
      lastVerify: run(verify) ?? null,
      lastDrill: run(drill) ?? null,
      lastDrillFailure: run(drillFailed) ?? null,
      recoveryPointHours: backupAge === null ? null : Math.round(backupAge * 10) / 10,
      databaseProtected: isProtected,
      warnings,
      recent: recent.map((r) => run(r)!),
      targets: { backupDueHours: BACKUP_DUE_HOURS, drillDueDays: DRILL_DUE_DAYS, rpoHours: recovery.rpoHours, rtoMinutes: recovery.rtoMinutes },
      recoveryPointMet: backupAge !== null && backupAge <= BACKUP_DUE_HOURS,
      recoveryTimeMet: drillSeconds !== null ? drillSeconds <= recovery.rtoMinutes * 60 : null,
    };
  },
  { permission: { module: 'settings', action: 'view' } },
);
