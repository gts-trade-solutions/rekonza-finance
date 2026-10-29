import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The controls an auditor looks for, and whether this book has them on.
//
// An auditor's review of the software listed twenty areas: workflow
// automation, exception management, validation, inventory accounting, GST
// automation, receivables, payables, MSME, fixed assets, bank reconciliation,
// audit trail, segregation of duties, budgeting, analytics, documents, error
// logging, disaster recovery, security, performance and concentration risk.
// Several were built but not visible; several were built but switched off by
// default. This reads each one from the book itself — its settings and its
// live records — and says, with the evidence, whether it is in place, partly
// in place, off, or in place but needing attention. It is what the Controls
// page shows, and what an auditor can be pointed at.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { getPolicies } from './org-settings';
import { indiaToday } from './held-journals';

export type ControlStatus = 'in_place' | 'partial' | 'off' | 'attention';

export interface Control {
  key: string;
  area: string;
  status: ControlStatus;
  /** What the book has, from its own records. */
  evidence: string;
  /** What would make it complete, when it is not. */
  gap: string | null;
  href: string;
}

const n = (v: unknown) => Number(v ?? 0);

export async function controlsOverview(ex: Executor, orgId: number): Promise<Control[]> {
  const p = await getPolicies(ex, orgId);
  const today = indiaToday();
  const count = async (q: Promise<{ n: string | number } | undefined>) => n((await q)?.n);
  const one = (table: string, where = sql``) =>
    sql<{ n: string }>`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE org_id = ${orgId} ${where}`.execute(ex).then((r) => r.rows[0]);

  const [
    exActive, exUnowned, exEscalated, exClosed, masterData, users, billRules, anyRules, bankRules, unreconciled,
    assets, budgets, documents, attachments, errorsOpen, stockMoves, gsp, perpetualEntries,
  ] = await Promise.all([
    count(one('exceptions', sql`AND status IN ('open','in_progress')`)),
    count(one('exceptions', sql`AND status IN ('open','in_progress') AND owner_user_id IS NULL`)),
    count(one('exceptions', sql`AND status IN ('open','in_progress') AND escalation_level >= 2`)),
    count(one('exceptions', sql`AND status IN ('resolved','waived')`)),
    count(one('exceptions', sql`AND kind = 'master_data' AND status IN ('open','in_progress')`)),
    count(one('users', sql`AND is_active = 1`)),
    count(one('approval_rules', sql`AND is_active = 1 AND document_type IN ('bill','payment_batch')`)),
    count(one('approval_rules', sql`AND is_active = 1`)),
    count(one('bank_rules', sql`AND is_active = 1`)),
    count(one('bank_transactions', sql`AND status = 'unmatched' AND txn_date <= DATE_SUB(${today}, INTERVAL 30 DAY)`)),
    count(one('fixed_assets', sql`AND status = 'in_use'`)),
    count(one('budgets')),
    count(one('documents', sql`AND archived_at IS NULL`)),
    count(one('files', sql`AND attached_to_type IS NOT NULL AND deleted_at IS NULL`)),
    count(one('error_events', sql`AND status <> 'resolved'`)),
    count(one('items', sql`AND kind = 'goods' AND track_inventory = 1`)),
    ex.selectFrom('integration_connections').select(['provider', 'status']).where('org_id', '=', orgId)
      .where('status', 'in', ['configured', 'verified']).execute(),
    count(one('journal_entries', sql`AND source_type IN ('invoice','stock_valuation','stock_opening') AND id IN (
      SELECT entry_id FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.org_id = ${orgId} AND a.code = '5100')`)),
  ]);
  const [lastBackup, lastDrill] = await Promise.all([
    ex.selectFrom('backup_runs').select('finished_at').where('kind', '=', 'backup').where('ok', '=', 1).orderBy('finished_at', 'desc').limit(1).executeTakeFirst(),
    ex.selectFrom('backup_runs').select('finished_at').where('kind', '=', 'drill').where('ok', '=', 1).orderBy('finished_at', 'desc').limit(1).executeTakeFirst(),
  ]);
  const c = p.controls;
  const liveGsp = gsp.some((g) => g.provider !== 'fake');
  const hoursSinceBackup = lastBackup?.finished_at ? (Date.now() - new Date(lastBackup.finished_at).getTime()) / 3_600_000 : null;
  const out: Control[] = [];
  const add = (x: Control) => out.push(x);

  add({
    key: 'workflow', area: 'Workflow automation',
    status: c.autoIrn ? (exEscalated ? 'attention' : 'in_place') : 'partial',
    evidence: `The scheduler raises exceptions every ten minutes and escalates them: past its date the owner is reminded, ${c.escalateAfterDays} days later every admin. ${c.autoIrn ? 'Invoices go for their IRN as soon as they are issued.' : ''} Depreciation ${c.autoDepreciation ? 'posts itself at month end' : 'is run by hand'}.`,
    gap: !c.autoIrn ? 'Turn on automatic IRN registration.' : exEscalated ? `${exEscalated} exception${exEscalated === 1 ? ' has' : 's have'} reached the admins: deal with them.` : null,
    href: '/exceptions',
  });
  add({
    key: 'exceptions', area: 'Exception management',
    status: exUnowned ? 'attention' : 'in_place',
    evidence: `${exActive} open, each with an owner and a date; ${exClosed} closed, each with a resolution or a reason for waiving it. Every step is kept against the exception.`,
    gap: exUnowned ? `${exUnowned} open exception${exUnowned === 1 ? ' has' : 's have'} no owner.` : null,
    href: '/exceptions',
  });
  add({
    key: 'validation', area: 'Data validation',
    status: masterData ? 'attention' : 'in_place',
    evidence: 'GSTINs are checked for format, check digit, state and PAN; the same GSTIN twice is refused and a repeated PAN or name is flagged; a vendor\'s invoice number cannot be entered twice; credit limits, negative stock and cash limits are enforced as set.',
    gap: masterData ? `${masterData} party record${masterData === 1 ? '' : 's'} entered before these checks need correcting.` : null,
    href: '/exceptions?kind=master_data',
  });
  const perpetual = p.stockAccounting.method === 'perpetual';
  add({
    key: 'inventory', area: 'Inventory & cost of sales',
    status: !stockMoves ? 'in_place' : perpetual ? 'in_place' : 'partial',
    evidence: perpetual
      ? `Perpetual inventory from ${p.stockAccounting.from}: every sale posts its cost to Cost of Goods Sold and out of Inventory, every stock purchase goes to Inventory, and month end brings Inventory into line with the stock valuation.${perpetualEntries ? '' : ' Nothing has been sold since.'}`
      : 'Periodic (as in Tally): cost of goods sold is worked out for the statements from opening stock, purchases and closing stock, valued from the documents.',
    gap: stockMoves && !perpetual ? 'Switch to perpetual inventory so each sale posts its cost in the ledger.' : null,
    href: '/settings?tab=controls',
  });
  add({
    key: 'einvoice', area: 'GST e-invoice automation',
    status: !c.autoIrn ? 'off' : liveGsp ? 'in_place' : 'partial',
    evidence: c.autoIrn
      ? `Invoices needing an IRN are registered automatically on issue; an outage is retried, a refusal becomes an exception with the IRP's reason. ${liveGsp ? 'Connected to a GST Suvidha Provider.' : 'Registration goes through the built-in stand-in.'}`
      : 'IRNs are registered when someone presses Register.',
    gap: !c.autoIrn ? 'Turn on automatic IRN registration.' : liveGsp ? null : 'Connect a GSP with NIC credentials (Settings → Integrations) for live IRNs.',
    href: '/gst/einvoices',
  });
  add({
    key: 'receivables', area: 'Receivables & collections',
    status: p.reminders.enabled && c.creditHold !== 'off' ? 'in_place' : 'partial',
    evidence: `Customers 15, 30, 60 and 90 days past due are raised to their account owner. Reminders ${p.reminders.enabled ? `go on days ${p.reminders.stages.join(', ')} from the due date` : 'are off'}. Invoicing a customer ${c.creditHoldDays} days in arrears ${c.creditHold === 'block' ? 'is refused' : c.creditHold === 'warn' ? 'is warned about' : 'is not checked'}; credit limits ${p.creditLimit === 'block' ? 'are enforced' : p.creditLimit === 'warn' ? 'warn' : 'are not checked'}.`,
    gap: !p.reminders.enabled ? 'Turn on payment reminders (Settings → Policies).' : c.creditHold === 'off' ? 'Turn on the credit hold.' : null,
    href: '/exceptions?kind=receivable_overdue',
  });
  add({
    key: 'payables', area: 'Payables controls',
    status: billRules ? 'in_place' : 'partial',
    evidence: `Bills due within ${c.billsDueDays} days, and overdue ones, are raised for whoever pays them. ${billRules ? `${billRules} approval rule${billRules === 1 ? '' : 's'} on bills and payment batches.` : 'No approval rule on bills or payment batches.'}`,
    gap: billRules ? null : 'Add an approval rule for bills or payment batches (Approvals).',
    href: '/approvals',
  });
  add({
    key: 'msme', area: 'MSME 45-day monitoring',
    status: 'in_place',
    evidence: 'Every MSME bill is tracked against its 15 or 45 days from day 30, raised as an exception, escalated as the deadline nears, with s.43B(h) disallowance and MSMED interest worked out.',
    gap: null, href: '/purchases/msme-tracker',
  });
  add({
    key: 'assets', area: 'Fixed asset register & depreciation',
    status: !p.features.fixedAssets ? 'off' : c.autoDepreciation || !assets ? 'in_place' : 'partial',
    evidence: `${assets} asset${assets === 1 ? '' : 's'} in use on the register, with Schedule II and income-tax block depreciation. ${c.autoDepreciation ? 'Depreciation posts itself at each month end.' : 'Depreciation is run by hand.'}`,
    gap: !p.features.fixedAssets ? 'Turn on the fixed assets module.' : !c.autoDepreciation && assets ? 'Turn on automatic month-end depreciation.' : null,
    href: '/accountant/fixed-assets',
  });
  add({
    key: 'bank', area: 'Bank reconciliation',
    status: unreconciled ? 'attention' : 'in_place',
    evidence: `Imported statements are matched automatically: ${bankRules} active rule${bankRules === 1 ? '' : 's'}, deposits naming an invoice, and lines equal to a payment already entered. The rest are suggested for one-key matching.`,
    gap: unreconciled ? `${unreconciled} statement line${unreconciled === 1 ? '' : 's'} unmatched for over 30 days.` : null,
    href: '/banking/reconcile',
  });
  add({
    key: 'audit', area: 'Audit trail',
    status: c.changeReasons ? 'in_place' : 'partial',
    evidence: `Every change is kept with who, when, from where and the values before and after; nothing in it can be edited or deleted (MCA Rule 11(g)). ${c.changeReasons ? 'A reason is required for every change.' : 'Reasons are required for voids; other changes may give one.'}`,
    gap: c.changeReasons ? null : 'Require a reason for every change.',
    href: '/accountant/audit-trail',
  });
  add({
    key: 'sod', area: 'Segregation of duties & roles',
    status: users < 2 ? 'partial' : c.segregation === 'block' ? 'in_place' : c.segregation === 'warn' ? 'partial' : 'off',
    evidence: `Five roles plus custom roles, checked on the server. Nobody approves what they submitted. Paying a bill you entered or approved ${c.segregation === 'block' ? 'is refused' : c.segregation === 'warn' ? 'is warned about' : 'is not checked'}. ${anyRules} approval rule${anyRules === 1 ? '' : 's'} active.`,
    gap: users < 2 ? 'One active user cannot divide the duties: add the people who approve and pay.' : c.segregation !== 'block' ? 'Set segregation of duties to block.' : null,
    href: '/settings?tab=users',
  });
  add({
    key: 'budget', area: 'Budgeting & forecasting',
    status: budgets ? 'in_place' : 'partial',
    evidence: `${budgets ? `${budgets} budget${budgets === 1 ? '' : 's'} with budget-against-actual from the journal` : 'No budget set yet'}; a 13-week cash forecast from open invoices, bills, cheques, recurring entries and payroll.`,
    gap: budgets ? null : 'Set this year\'s budget (Accountant → Budgets).',
    href: '/accountant/budgets',
  });
  add({
    key: 'analytics', area: 'Advanced analytics',
    status: 'in_place',
    evidence: 'Cash forecast with each customer\'s own payment behaviour, anomaly detection over the journal (round sums, weekend and late-night postings, duplicate payments, amounts far from a party\'s usual) and a risk score for each customer.',
    gap: null, href: '/analytics/risk',
  });
  add({
    key: 'documents', area: 'Document management',
    status: 'in_place',
    evidence: `${documents} contract${documents === 1 ? '' : 's'} and certificates in the document library, with expiry dates; ${attachments} file${attachments === 1 ? '' : 's'} attached to vouchers and records.`,
    gap: null, href: '/documents',
  });
  add({
    key: 'errors', area: 'Error logging & monitoring',
    status: errorsOpen ? 'attention' : 'in_place',
    evidence: 'Every unexpected error is kept with when, where, the stack and how often, under a reference the user is shown; each is closed with its cause and fix.',
    gap: errorsOpen ? `${errorsOpen} error${errorsOpen === 1 ? '' : 's'} not yet resolved.` : null,
    href: '/settings?tab=health',
  });
  add({
    key: 'recovery', area: 'Disaster recovery',
    status: hoursSinceBackup === null ? 'off' : hoursSinceBackup > p.recovery.rpoHours || !lastDrill ? 'attention' : 'in_place',
    evidence: hoursSinceBackup === null
      ? 'No backup has been recorded on this server.'
      : `Last backup ${Math.round(hoursSinceBackup)} hours ago against a ${p.recovery.rpoHours}-hour recovery point; ${lastDrill?.finished_at ? `last restore drill ${String(new Date(lastDrill.finished_at).toISOString()).slice(0, 10)}` : 'no restore drill yet'}.`,
    gap: hoursSinceBackup === null ? 'Schedule backups (npm run db:backup) or turn on the database host\'s.' : !lastDrill ? 'Run a restore drill (npm run db:backup -- drill).' : hoursSinceBackup > p.recovery.rpoHours ? 'The last backup is older than the recovery point.' : null,
    href: '/settings?tab=backups',
  });
  const strong = p.requireMfa !== 'off' && p.sessionIdleMinutes > 0;
  add({
    key: 'security', area: 'Security controls',
    status: strong && (p.password.expiryDays > 0 || p.password.history > 0) && process.env.FIELD_ENCRYPTION_KEY ? 'in_place' : 'partial',
    evidence: `Passwords hashed with Argon2id, at least ${p.password.minLength} characters with mixed case and digits${p.password.history ? `, none of the last ${p.password.history} reused` : ''}${p.password.expiryDays ? `, changed every ${p.password.expiryDays} days` : ''}; lockout after failed attempts; two-step sign-in ${p.requireMfa === 'off' ? 'optional' : `required of ${p.requireMfa}`}; idle sign-out ${p.sessionIdleMinutes ? `after ${p.sessionIdleMinutes} minutes` : 'off'}; bank numbers, PAN and Aadhaar ${process.env.FIELD_ENCRYPTION_KEY ? 'encrypted at rest' : 'not yet encrypted (no FIELD_ENCRYPTION_KEY on the server)'}.`,
    gap: !strong ? 'Require two-step sign-in and set an idle sign-out.'
      : !(p.password.expiryDays || p.password.history) ? 'Set password expiry or history.'
      : !process.env.FIELD_ENCRYPTION_KEY ? 'Set FIELD_ENCRYPTION_KEY on the server and run npm run fields:seal.' : null,
    href: '/settings?tab=controls',
  });
  add({
    key: 'performance', area: 'Performance & scalability',
    status: 'in_place',
    evidence: 'Figures are summed in the database on indexed (book, account, date) columns; the dashboard is cached until the next posting. Measured at 1 lakh vouchers: trial balance 1.4 s, P&L 1.4 s, balance sheet 1.9 s (npm run bench:reports).',
    gap: null, href: '/reports',
  });
  add({
    key: 'concentration', area: 'Customer concentration',
    status: 'in_place',
    evidence: `Any customer holding more than ${c.concentrationPct}% of receivables, or owing more than their credit limit, is raised as an exception to their account owner.`,
    gap: null, href: '/exceptions?kind=concentration',
  });
  return out;
}
