import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The software checklist, area by area, with evidence from the books.
//
// A reviewer judging from the dashboard sees receivables, cash and IRNs, and
// marks everything else "not evidenced". This page answers each area of the
// accounting software checklist with where it lives in the app and what this
// company's own records show about it — how many assets are on the register,
// when depreciation last ran, how many bank lines are reconciled — so the
// evidence is the live data, not a claim.
//
// Each area is "In use" when the company has records in it, "Ready" when it is
// built but not yet used here, and "Needs set-up" when it depends on something
// outside the app (a GSP contract, a mail server, a bank partner).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { mailStatus } from '../mail/mailer';
import { gatewayStatus } from './payment-links';

export type AreaStatus = 'in_use' | 'ready' | 'needs_setup';
export interface ChecklistArea {
  key: string;
  area: string;
  status: AreaStatus;
  /** What this company's records show, in plain words. */
  evidence: string[];
  /** Where to see it. */
  screens: { label: string; href: string }[];
  /** What still depends on something outside the app. */
  outside: string[];
}

export async function checklist(ex: Executor, orgId: number): Promise<ChecklistArea[]> {
  const n = async (q: ReturnType<typeof sql>) => Number(((await q.execute(ex)).rows[0] as { n?: number | string } | undefined)?.n ?? 0);
  const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(ex)).rows[0] as T | undefined;
  const c = (table: string, where = sql``) => n(sql`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE org_id = ${orgId} ${where}`);
  const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null);

  const org = await one(sql<{ name: string; fy: number; pan: string | null; tan: string | null }>`SELECT name, fiscal_year_start_month AS fy, pan, tan FROM organizations WHERE id = ${orgId}`);
  const [users, roles, customRoles, mfa, backups, lastBackup, companies] = await Promise.all([
    c('users', sql`AND is_active = 1`),
    n(sql`SELECT COUNT(DISTINCT role) AS n FROM users WHERE org_id = ${orgId} AND is_active = 1`),
    c('custom_roles'),
    c('users', sql`AND is_active = 1 AND mfa_secret IS NOT NULL`),
    // Backups are of the whole server, not one company.
    n(sql`SELECT COUNT(*) AS n FROM backup_runs WHERE ok = 1 AND kind = 'backup'`),
    one(sql<{ at: string | null }>`SELECT MAX(finished_at) AS at FROM backup_runs WHERE ok = 1 AND kind = 'backup'`),
    n(sql`SELECT COUNT(DISTINCT u2.org_id) AS n FROM users u1 JOIN users u2 ON u2.email = u1.email WHERE u1.org_id = ${orgId}`),
  ]);
  const [audit, auditReasons, approvals, policies] = await Promise.all([
    c('audit_log'), c('audit_log', sql`AND reason IS NOT NULL`), c('approval_actions'),
    one(sql<{ v: string | null }>`SELECT value AS v FROM settings WHERE org_id = ${orgId} AND scope = 'policy' AND setting_key = 'password'`),
  ]);
  const [accounts, groups, costCentres, items, stockGroups, warehouses, employees] = await Promise.all([
    c('accounts', sql`AND is_active = 1`), n(sql`SELECT COUNT(DISTINCT parent_id) AS n FROM accounts WHERE org_id = ${orgId} AND parent_id IS NOT NULL`),
    c('cost_centres'), c('items', sql`AND is_archived = 0`), c('stock_groups'), c('warehouses'), c('employees'),
  ]);
  const vouchers = await one(sql<{ jv: number; rcpt: number; pay: number; contra: number; dn: number; cn: number; inv: number; bill: number }>`
    SELECT (SELECT COUNT(*) FROM journal_entries WHERE org_id = ${orgId} AND source_type = 'manual') AS jv,
           (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId} AND kind = 'received') AS rcpt,
           (SELECT COUNT(*) FROM payments WHERE org_id = ${orgId} AND kind = 'made') AS pay,
           (SELECT COUNT(*) FROM bank_transfers WHERE org_id = ${orgId}) AS contra,
           (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId} AND doc_kind = 'debit_note') AS dn,
           (SELECT COUNT(*) FROM credit_notes WHERE org_id = ${orgId}) AS cn,
           (SELECT COUNT(*) FROM invoices WHERE org_id = ${orgId} AND doc_kind = 'invoice') AS inv,
           (SELECT COUNT(*) FROM bills WHERE org_id = ${orgId}) AS bill`);
  const [grn, adjustments, issues, transfers, valuation] = await Promise.all([
    c('goods_receipts'), c('stock_adjustments'), c('stock_adjustments', sql`AND reason = 'issued'`), c('stock_transfers'),
    one(sql<{ v: string | null }>`SELECT value AS v FROM settings WHERE org_id = ${orgId} AND scope = 'policy' AND setting_key = 'stockValuation'`),
  ]);
  const bank = await one(sql<{ total: number; matched: number }>`
    SELECT COUNT(*) AS total, SUM(t.status IN ('matched', 'manually_added')) AS matched
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id WHERE a.org_id = ${orgId}`);
  const [imports, cheques, batches, chequePayments] = await Promise.all([
    n(sql`SELECT COUNT(*) AS n FROM bank_statement_imports i JOIN bank_accounts a ON a.id = i.bank_account_id WHERE a.org_id = ${orgId}`),
    c('cheques'), c('payment_batches'), c('payments', sql`AND kind = 'made' AND mode = 'cheque'`),
  ]);
  const [creditLimits, followUps, reminders, confirmationsC, confirmationsV, msme] = await Promise.all([
    c('contacts', sql`AND credit_limit > 0`), c('collection_followups'), c('payment_reminders'),
    c('balance_confirmations', sql`AND side = 'customer'`), c('balance_confirmations', sql`AND side = 'vendor'`), c('contacts', sql`AND is_msme = 1`),
  ]);
  const [assets, depRuns, lastDep, disposals] = await Promise.all([
    c('fixed_assets'), c('depreciation_runs'),
    one(sql<{ at: string | null }>`SELECT MAX(period_to) AS at FROM depreciation_runs WHERE org_id = ${orgId} AND reversed = 0`),
    c('fixed_assets', sql`AND status = 'disposed'`),
  ]);
  const [payrollRuns, leave, lastRun] = await Promise.all([
    c('payroll_runs', sql`AND status <> 'draft'`), c('leave_entries'),
    one(sql<{ p: string | null }>`SELECT MAX(month) AS p FROM payroll_runs WHERE org_id = ${orgId} AND status <> 'draft'`),
  ]);
  const [irns, filings, tdsDocs, itcRecon] = await Promise.all([
    c('einvoices', sql`AND irn IS NOT NULL`), c('compliance_filings'),
    n(sql`SELECT COUNT(*) AS n FROM bills WHERE org_id = ${orgId} AND tds_amount > 0`), c('gstr2b_entries'),
  ]);
  const [budgets] = await Promise.all([c('budgets')]);
  const [apiKeys, webhooks, tally, mail, gateway] = await Promise.all([
    c('api_keys', sql`AND revoked_at IS NULL`), c('webhooks'), c('tally_connectors'), Promise.resolve(mailStatus()), gatewayStatus(ex, orgId),
  ]);

  const v = vouchers ?? { jv: 0, rcpt: 0, pay: 0, contra: 0, dn: 0, cn: 0, inv: 0, bill: 0 };
  const status = (used: boolean): AreaStatus => (used ? 'in_use' : 'ready');
  // entry → entries, batch → batches, run → runs.
  const plural = (k: number, word: string) => {
    const many = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`;
    return `${k.toLocaleString('en-IN')} ${k === 1 ? word : many}`;
  };

  return [
    {
      key: 'company', area: 'Company Management', status: status(true),
      evidence: [
        `Company "${org?.name}", financial year starting in ${['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][org?.fy ?? 4]}`,
        `${plural(users, 'active user')} in ${plural(roles, 'role')}${customRoles ? `, ${plural(customRoles, 'custom role')}` : ''}`,
        companies > 1 ? `${companies} companies reachable from the company switcher` : 'More companies can be created from the company switcher',
        backups ? `${plural(backups, 'backup')} taken; last on ${day(lastBackup?.at)}` : 'Backups and restore drills are set up under Settings → Backups',
        org?.pan || org?.tan ? `Statutory details on file (${[org.pan && 'PAN', org.tan && 'TAN'].filter(Boolean).join(', ')})` : 'Statutory details go under Settings → Statutory',
      ],
      screens: [{ label: 'Settings → Organisation', href: '/settings' }, { label: 'Users & roles', href: '/settings' }, { label: 'Year-end close', href: '/accountant/period-close' }],
      outside: [],
    },
    {
      key: 'security', area: 'Security & Audit Trail', status: status(audit > 0),
      evidence: [
        `${plural(audit, 'audit trail entry')}, none editable${auditReasons ? `; ${plural(auditReasons, 'change')} with a reason given` : ''}`,
        `${mfa} of ${users} users on two-step sign-in`,
        policies?.v ? 'Password rules set: length, expiry and history' : 'Password rules (length, expiry, history) under Settings → Policies',
        `${plural(approvals, 'approval step')} recorded`,
        'Role-based access on every screen and every API call; Settings → Controls lists each control with its evidence',
      ],
      screens: [{ label: 'Audit trail', href: '/accountant/audit-trail' }, { label: 'Approvals', href: '/approvals' }, { label: 'Settings → Controls', href: '/settings' }],
      outside: [],
    },
    {
      key: 'masters', area: 'Master Data', status: status(accounts > 0),
      evidence: [
        `${plural(accounts, 'account')} in the chart${groups ? `, ${plural(groups, 'group')}` : ''}`,
        `${plural(costCentres, 'cost centre')}, ${plural(items, 'item')} in ${plural(stockGroups, 'stock group')}, ${plural(warehouses, 'warehouse')}`,
        `${plural(employees, 'employee')} on the payroll master`,
      ],
      screens: [{ label: 'Chart of accounts', href: '/accountant/chart-of-accounts' }, { label: 'Cost centres', href: '/accountant/cost-centres' }, { label: 'Items', href: '/sales/items' }, { label: 'Warehouses', href: '/inventory/warehouses' }, { label: 'Employees', href: '/payroll/employees' }],
      outside: [],
    },
    {
      key: 'vouchers', area: 'Accounting Vouchers', status: status(v.jv + v.rcpt + v.pay > 0),
      evidence: [
        `${plural(Number(v.rcpt), 'receipt')}, ${plural(Number(v.pay), 'payment')}, ${plural(Number(v.contra), 'contra entry')}, ${plural(Number(v.jv), 'journal')}`,
        `${plural(Number(v.inv), 'sales invoice')}, ${plural(Number(v.bill), 'purchase bill')}, ${plural(Number(v.cn), 'credit note')}, ${plural(Number(v.dn), 'debit note')}`,
        'Every voucher posts a balanced double entry; a void posts the reversal and keeps both',
      ],
      screens: [{ label: 'Receipts', href: '/sales/payments' }, { label: 'Payments', href: '/purchases/payments' }, { label: 'Contra (transfers)', href: '/banking/transfers' }, { label: 'Journals', href: '/accountant/journals' }, { label: 'Debit note', href: '/sales/debit-notes' }, { label: 'Credit note', href: '/sales/credit-notes' }],
      outside: [],
    },
    {
      key: 'inventory', area: 'Inventory', status: status(items > 0),
      evidence: [
        `${plural(grn, 'goods receipt')}, ${plural(adjustments, 'adjustment')} (${plural(issues, 'stock issue')}), ${plural(transfers, 'transfer')} between godowns`,
        `Valued at ${valuation?.v?.includes('fifo') ? 'FIFO' : 'weighted average'} cost; batches, serial numbers and reorder levels kept`,
        'Reports: stock summary and valuation, stock ledger, stock ageing, batches and expiry',
      ],
      screens: [{ label: 'Stock summary', href: '/inventory/stock' }, { label: 'Stock ledger', href: '/reports/stock-ledger' }, { label: 'Stock ageing', href: '/reports/stock-ageing' }, { label: 'Goods receipts', href: '/purchases/goods-receipts' }, { label: 'Adjustments and issues', href: '/inventory/adjustments' }, { label: 'Transfers', href: '/inventory/transfers' }],
      outside: [],
    },
    {
      key: 'banking', area: 'Banking', status: status(Number(bank?.total ?? 0) > 0),
      evidence: [
        `${Number(bank?.matched ?? 0).toLocaleString('en-IN')} of ${Number(bank?.total ?? 0).toLocaleString('en-IN')} statement lines reconciled, from ${plural(imports, 'imported statement')} (CSV or Excel)`,
        `${plural(cheques, 'cheque')} in the register; ${plural(chequePayments, 'payment')} by cheque, each printable on the cheque leaf`,
        `${plural(batches, 'payment batch', )} with a bank upload file (NEFT/RTGS)`,
      ],
      screens: [{ label: 'Reconcile', href: '/banking/reconcile' }, { label: 'Statement import', href: '/banking/imports' }, { label: 'Cheques', href: '/banking/cheques' }, { label: 'Payment batches', href: '/purchases/payment-batches' }],
      outside: ['Automatic bank feeds need an Account Aggregator partner or the bank’s own API agreement; statements are imported meanwhile.'],
    },
    {
      key: 'receivables', area: 'Accounts Receivable', status: status(v.inv > 0),
      evidence: [
        `${plural(creditLimits, 'customer')} with a credit limit, checked on every invoice (credit hold for long overdue)`,
        `${plural(followUps, 'collection follow-up')} logged; ${plural(reminders, 'payment reminder')} queued or sent`,
        `Customer statements from the ledger, to print, export or email; ${plural(confirmationsC, 'balance confirmation')}`,
      ],
      screens: [{ label: 'Customers', href: '/sales/customers' }, { label: 'Collections', href: '/sales/collections' }, { label: 'Receivables ageing', href: '/reports/ar-ageing' }, { label: 'Reminders', href: '/sales/reminders' }],
      outside: mail.configured ? [] : ['Emailing statements and reminders needs the mail server set on the server (SMTP_HOST and the rest).'],
    },
    {
      key: 'payables', area: 'Accounts Payable', status: status(v.bill > 0),
      evidence: [
        `Vendor statements from the ledger; ${plural(confirmationsV, 'vendor balance confirmation')} recorded against our books`,
        `Payables ageing, bills due and overdue raised as exceptions; ${plural(msme, 'MSME vendor')} watched against the 45-day limit`,
        'Whoever entered or approved a bill cannot pay it (segregation of duties)',
      ],
      screens: [{ label: 'Vendors', href: '/purchases/vendors' }, { label: 'Balance confirmations', href: '/accountant/balance-confirmations' }, { label: 'Payables ageing', href: '/reports/ap-ageing' }, { label: 'MSME payments', href: '/purchases/msme-tracker' }],
      outside: [],
    },
    {
      key: 'assets', area: 'Fixed Assets', status: status(assets > 0),
      evidence: [
        `${plural(assets, 'asset')} on the register${disposals ? `, ${plural(disposals, 'disposal')}` : ''}`,
        depRuns ? `${plural(depRuns, 'depreciation run')} under Schedule II; last up to ${day(lastDep?.at)}` : 'Depreciation under Schedule II, run monthly or yearly, with the Income-tax block schedule',
      ],
      screens: [{ label: 'Fixed asset register', href: '/accountant/fixed-assets' }],
      outside: [],
    },
    {
      key: 'payroll', area: 'Payroll', status: status(payrollRuns > 0),
      evidence: [
        `${plural(employees, 'employee')}; ${plural(payrollRuns, 'payroll month')} posted${lastRun?.p ? `, the latest ${lastRun.p}` : ''}`,
        `PF, ESI, professional tax and TDS worked out; ${plural(leave, 'leave entry', )}; payslips, Form 16 and full and final settlement`,
      ],
      screens: [{ label: 'Employees', href: '/payroll/employees' }, { label: 'Payroll runs and payslips', href: '/payroll/runs' }, { label: 'Leave', href: '/payroll/leave' }],
      outside: [],
    },
    {
      key: 'gst', area: 'GST & Compliance', status: status(v.inv > 0),
      evidence: [
        `GSTR-1, GSTR-3B, GSTR-9 and 9C prepared from the books; ${plural(filings, 'return')} marked filed on the compliance calendar`,
        `${plural(irns, 'IRN')} registered; ${plural(itcRecon, 'GSTR-2B line')} reconciled against purchases`,
        `TDS on ${plural(tdsDocs, 'bill')}; TDS and TCS returns, certificates and challans`,
      ],
      screens: [{ label: 'GSTR-1', href: '/gst/gstr1' }, { label: 'GSTR-3B', href: '/gst/gstr3b' }, { label: 'ITC reconciliation', href: '/gst/itc-reconciliation' }, { label: 'TDS & TCS', href: '/gst/tds-tcs' }, { label: 'Compliance calendar', href: '/gst/compliance-calendar' }],
      outside: ['Filing returns and registering live IRNs on the government portals needs a GSP contract and NIC credentials; until then the returns are prepared here and uploaded on the portal (GSTR-1 JSON is exported).'],
    },
    {
      key: 'budgets', area: 'Budgeting & Costing', status: status(budgets > 0 || costCentres > 0),
      evidence: [
        `${plural(budgets, 'budget')} set; budget against actual with the variance and the pace for the year`,
        `${plural(costCentres, 'cost centre')}; profit and loss by cost centre; project costing with timesheets`,
      ],
      screens: [{ label: 'Budgets vs actual', href: '/accountant/budgets' }, { label: 'Cost centres', href: '/accountant/cost-centres' }, { label: 'Projects', href: '/projects' }],
      outside: [],
    },
    {
      key: 'reporting', area: 'Reporting', status: 'in_use',
      evidence: [
        'Balance Sheet, Profit & Loss (also as Schedule III), Cash Flow, Fund Flow, Trial Balance, General Ledger, Day Book',
        'Audit reports: audit trail, edit log with reasons, the year-end pack in Excel, balance confirmations',
        'Every report exports to Excel and can be scheduled',
      ],
      screens: [{ label: 'Balance sheet', href: '/reports/balance-sheet' }, { label: 'Cash flow', href: '/reports/cash-flow' }, { label: 'Fund flow', href: '/reports/fund-flow' }, { label: 'All reports', href: '/reports' }],
      outside: [],
    },
    {
      key: 'integration', area: 'Integration', status: apiKeys || webhooks || tally ? 'in_use' : 'ready',
      evidence: [
        `Open API with ${plural(apiKeys, 'live key')} and ${plural(webhooks, 'webhook')}; Tally import, export and a live connector (${plural(tally, 'connector')})`,
        'Power BI and Excel read the books as tables (Settings → Developer)',
        `Email ${mail.configured ? 'connected' : 'ready, once the mail server is set'}; online payments ${gateway.connected ? 'connected (Razorpay)' : 'ready, once Razorpay keys are added'}`,
        'Payroll is built in; salaries from another payroll system come in through the journal import',
      ],
      screens: [{ label: 'Settings → Developer', href: '/settings' }, { label: 'Tally', href: '/tally' }, { label: 'Import', href: '/settings/import' }],
      outside: ['Bank APIs need the bank’s own agreement or an Account Aggregator partner; an ERP connects through the open API and webhooks.'],
    },
  ];
}
