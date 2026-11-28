import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The auditors' status review, item by item, with this company's own evidence.
//
// The client's auditors sent the same fourteen items back twice ("6. Updated
// Status Review", then "7. Updated Status Review", 2026-11-27) marked "Not
// Resolved", although most had been built: what they could not find, or could
// not test in their own nearly empty company, counted as not done. So each item
// is listed here in their words, with where it lives, the test they can run
// themselves from nothing, and what this company's books show about it today
// (how many disposals, which reversals, the last import and what it refused).
//
// An item is "In use" when the company has records for it and "Ready to test"
// when it is built but this company has not used it yet. Nothing here is a
// claim the books do not back: every figure is counted from the company's rows.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';

export interface ReviewItem {
  n: number;
  module: string;
  issue: string;
  /** What the auditors wrote in the review. */
  finding: string;
  status: 'in_use' | 'ready';
  /** What this company's records show, in plain words. */
  evidence: string[];
  where: { label: string; href: string }[];
  /** The auditor's own test, from an empty company. */
  test: string[];
}

export async function statusReview(ex: Executor, orgId: number): Promise<ReviewItem[]> {
  const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql<T>>) => ((await q.execute(ex)).rows[0] ?? {}) as Partial<T>;
  const num = (v: unknown) => Number(v ?? 0);
  const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
  const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

  const [
    group, audit, chain, imports, reversals, fifo, stockLines, bulkPay, batches, notes, dupes,
    disposals, payroll, challans, salaryPaid, filings, budgets, views, runs,
  ] = await Promise.all([
    one(sql<{ g: number; m: number }>`SELECT (SELECT COUNT(*) FROM consolidation_groups WHERE org_id = ${orgId}) AS g, (SELECT COUNT(*) FROM consolidation_members WHERE org_id = ${orgId}) AS m`),
    one(sql<{ n: number; exports: number; last_export: Date | null }>`SELECT COUNT(*) AS n, SUM(action = 'export' AND target_id = 'audit-trail') AS exports, MAX(CASE WHEN action = 'export' AND target_id = 'audit-trail' THEN created_at END) AS last_export FROM audit_log WHERE org_id = ${orgId}`),
    one(sql<{ seq: number; ok: number | null; at: Date | null }>`SELECT last_seq AS seq, verified_ok AS ok, verified_at AS at FROM audit_chain_heads WHERE org_id = ${orgId}`),
    one(sql<{ n: number; imported: number; left_out: number; last: Date | null }>`SELECT COUNT(*) AS n, SUM(imported) AS imported, SUM(skipped + failed) AS left_out, MAX(created_at) AS last FROM import_batches WHERE org_id = ${orgId}`),
    one(sql<{ n: number; with_reason: number; due: number }>`SELECT COUNT(*) AS n, SUM(reason IS NOT NULL AND reason <> '') AS with_reason, SUM(reversal_entry_id IS NULL) AS due FROM journal_reversals WHERE org_id = ${orgId}`),
    one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM items WHERE org_id = ${orgId} AND valuation_method = 'fifo' AND track_inventory = 1`),
    one(sql<{ n: number; returns: number }>`SELECT (SELECT COUNT(*) FROM stock_postings WHERE org_id = ${orgId}) AS n, (SELECT COUNT(*) FROM vendor_credit_lines WHERE org_id = ${orgId} AND item_id IS NOT NULL) AS returns`),
    one(sql<{ n: number; paid_rows: number }>`SELECT COUNT(*) AS n, SUM(imported) AS paid_rows FROM import_batches WHERE org_id = ${orgId} AND kind IN ('payments-received', 'payments-made')`),
    one(sql<{ n: number; replied: number }>`SELECT COUNT(*) AS n, SUM(EXISTS (SELECT 1 FROM payment_batch_lines l WHERE l.batch_id = b.id AND l.bank_status IS NOT NULL)) AS replied FROM payment_batches b WHERE b.org_id = ${orgId}`),
    one(sql<{ n: number; applied: number; refunded: number; waiting: number }>`SELECT COUNT(*) AS n, SUM(status = 'applied') AS applied, SUM(status = 'refunded') AS refunded, SUM(approval_status = 'pending') AS waiting FROM credit_notes WHERE org_id = ${orgId}`),
    one(sql<{ n: number; open: number; cleared: number }>`SELECT COUNT(*) AS n, SUM(status = 'open') AS open, SUM(status <> 'open') AS cleared FROM duplicate_reviews WHERE org_id = ${orgId}`),
    one(sql<{ n: number; sold: number; scrapped: number; undone: number }>`SELECT COUNT(*) AS n, SUM(kind = 'sold' AND status <> 'undone') AS sold, SUM(kind = 'scrapped' AND status <> 'undone') AS scrapped, SUM(status = 'undone') AS undone FROM asset_disposals WHERE org_id = ${orgId}`),
    one(sql<{ n: number; last: string | null }>`SELECT COUNT(*) AS n, MAX(month) AS last FROM payroll_runs WHERE org_id = ${orgId} AND status IN ('posted', 'paid')`),
    one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM salary_tds_challans WHERE org_id = ${orgId}`),
    one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM payroll_payments WHERE org_id = ${orgId} AND reversed = 0`),
    one(sql<{ n: number; last: string | null }>`SELECT COUNT(*) AS n, MAX(period) AS last FROM compliance_filings WHERE org_id = ${orgId} AND item_key IN ('gstr1', 'gstr3b', 'gstr9', 'gstr7', 'gstr8', 'iff')`),
    one(sql<{ n: number; fy: string | null }>`SELECT COUNT(*) AS n, MAX(fy_label) AS fy FROM budget_plans WHERE org_id = ${orgId}`),
    one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM saved_views WHERE org_id = ${orgId} AND list LIKE 'report-%'`),
    one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM payroll_runs WHERE org_id = ${orgId} AND journal_entry_id IS NOT NULL`),
  ]);
  const companies = num((await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM users u WHERE u.email = (SELECT email FROM users WHERE org_id = ${orgId} ORDER BY id LIMIT 1) AND u.is_active = 1`)).n);
  const invoicedSales = num((await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM invoices WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void')`)).n);

  const item = (n: number, module: string, issue: string, finding: string, used: boolean, evidence: string[], where: ReviewItem['where'], test: string[]): ReviewItem =>
    ({ n, module, issue, finding, status: used ? 'in_use' : 'ready', evidence: evidence.filter(Boolean), where, test });

  return [
    item(1, 'Company Management', 'Multi-company consolidation', 'Consolidation testing still pending',
      num(group.g) > 0 || companies > 1,
      [num(group.g) ? `Group set up with ${plural(num(group.m), 'subsidiary', 'subsidiaries')}` : 'No group set up yet', `${plural(companies, 'company', 'companies')} under this sign-in`],
      [{ label: 'Reports → Consolidated statements', href: '/reports/consolidated' }],
      ['Add a second company from the company menu (top right).', 'Invoice it from this company; enter the bill and a part payment in the other.', 'Reports → Consolidated statements → Group set-up: parent, ownership %, investment account.', 'See each company, Eliminations (inter-company sales, receivable/payable, unrealised profit in stock), goodwill, minority interest, and a balanced group balance sheet; export to Excel or PDF.']),
    item(2, 'Security & Audit Trail', 'Audit log export', 'Audit log export remains unresolved',
      num(audit.exports) > 0,
      [`${num(audit.n).toLocaleString('en-IN')} events in the trail`, num(audit.exports) ? `Exported ${plural(num(audit.exports), 'time')}, last on ${day(audit.last_export)}` : 'Not exported yet', chain.seq ? `Integrity chain sealed to event ${num(chain.seq)}${chain.at ? `; last verified ${day(chain.at)} — ${chain.ok ? 'intact' : 'problems found'}` : ''}` : ''],
      [{ label: 'Accountant → Audit trail', href: '/accountant/audit-trail' }],
      ['Create, edit and delete an invoice (give a reason).', 'Audit trail: filter by date, user, action and record type.', 'Export as Excel, CSV or PDF: every matching event, IST time, user, IP, reason, old → new values.', 'Verify integrity: the chain shows the trail is intact. The export itself is in the trail.']),
    item(3, 'Master Data', 'Bulk import validation', 'Bulk import validation pending',
      num(imports.n) > 0,
      [num(imports.n) ? `${plural(num(imports.n), 'import')}: ${num(imports.imported)} rows in, ${num(imports.left_out)} left out with reasons; last on ${day(imports.last)}` : 'No imports yet'],
      [{ label: 'Import → Customers', href: '/import/customers' }, { label: 'Import History', href: '/import/history' }],
      ['Download the sample file; add rows with a bad GSTIN, PAN, email, PIN, a duplicate and a missing name.', 'Upload it (.csv, .xls or .xlsx): every bad row is named by row, field and reason, with counts.', 'Download the error report, or import only the valid rows.', 'Import History shows who, when, what went in and what was left out.']),
    item(4, 'Accounting Vouchers', 'Voucher reversal testing', 'Reversal testing pending',
      num(reversals.n) > 0,
      [num(reversals.n) ? `${plural(num(reversals.n), 'reversal')}, ${num(reversals.with_reason)} with a reason${num(reversals.due) ? `; ${num(reversals.due)} still to come` : ''}` : 'No reversals yet'],
      [{ label: 'Accountant → Manual Journals', href: '/accountant/journals' }, { label: 'Reversed Vouchers', href: '/accountant/reversed-vouchers' }],
      ['Post a journal (approved by a second person if a journal rule is on).', 'Reverse it on a date with a reason: the reversal is linked both ways and cannot be repeated.', 'A locked period is refused with the first open date offered.', 'Reversed Vouchers lists each pair with its reason; voided payments and invoices post reversals too.']),
    item(5, 'Inventory', 'FIFO valuation variance', 'FIFO valuation variance remains unresolved',
      num(fifo.n) > 0,
      [`${plural(num(fifo.n), 'item')} valued by FIFO`, num(stockLines.n) ? `Inventory kept item by item: ${num(stockLines.n).toLocaleString('en-IN')} postings` : '', num(stockLines.returns) ? `${plural(num(stockLines.returns), 'goods line')} returned to suppliers` : ''],
      [{ label: 'Reports → Stock Valuation vs Ledger', href: '/reports/stock-reconciliation' }, { label: 'Inventory Valuation', href: '/reports/inventory-valuation' }],
      ['Item on FIFO: bill 10 @ ₹100 and 10 @ ₹120, invoice 15 → cost of goods sold ₹1,600, stock 5 @ ₹120.', 'Return 2 to the supplier (vendor credit with the item); the customer returns 1; adjust 1 damaged.', 'Inventory valuation, the item\'s Stock Layers, the ledger and the P&L agree.', 'Stock Valuation vs Ledger reads a variance of ₹0.00.']),
    item(6, 'Banking', 'Bulk payment upload', 'Bank reconciliation working; upload errors remain',
      num(bulkPay.n) + num(batches.n) > 0,
      [num(bulkPay.n) ? `${plural(num(bulkPay.n), 'payment file')} uploaded, ${num(bulkPay.paid_rows)} payments recorded` : 'No payment files uploaded yet', num(batches.n) ? `${plural(num(batches.n), 'payment batch', 'payment batches')}${num(batches.replied) ? `, ${num(batches.replied)} with the bank's reply read` : ''}` : ''],
      [{ label: 'Import → Customer Payments', href: '/import/payments-received' }, { label: 'Bulk payments (bills)', href: '/purchases/payments/bulk' }, { label: 'Payment Batches', href: '/purchases/payment-batches' }],
      ['Upload a bank-style file of customer receipts naming the invoices (title rows, ₹ and commas, dd-mm-yyyy).', 'Each bad row is refused by name: unknown customer, invoice already paid, amount over the balance, duplicate reference.', 'Record bulk payments for many bills at once; download the bank upload file (generic, HDFC, ICICI, SBI, Axis).', 'Read the bank\'s reply: paid with UTR, or returned with the reason.']),
    item(7, 'Accounts Receivable', 'Credit note workflow', 'Credit note workflow pending',
      num(notes.n) > 0,
      [num(notes.n) ? `${plural(num(notes.n), 'credit note')}: ${num(notes.applied)} applied, ${num(notes.refunded)} refunded${num(notes.waiting) ? `, ${num(notes.waiting)} waiting for approval` : ''}` : 'No credit notes yet'],
      [{ label: 'Sales → Credit Notes', href: '/sales/credit-notes' }, { label: 'Approvals', href: '/approvals' }],
      ['From an invoice: Create Credit Note (part return and a price cut).', 'Under an approval rule it waits; the maker cannot approve it.', 'Apply it to invoices, refund the rest, void one: balances, ledger and stock follow.', 'GSTR-1 lists it against the original invoice; the s.34 time limit is warned.']),
    item(8, 'Accounts Payable', 'Duplicate invoice detection', 'Duplicate invoice detection pending',
      num(dupes.n) > 0,
      [num(dupes.n) ? `${plural(num(dupes.n), 'possible duplicate')} reviewed: ${num(dupes.open)} open, ${num(dupes.cleared)} cleared or confirmed` : 'No possible duplicates recorded yet'],
      [{ label: 'Purchases → Possible Duplicate Bills', href: '/purchases/duplicate-bills' }],
      ['Enter a bill INV-001 from a vendor, then INV-001, "inv001" or "INV/001" again: refused, with a link to the first.', 'Same vendor and amount a few days apart under another number: saved only with a reason.', 'The same number from another vendor is allowed; Edit and the bills import are checked too.', 'Possible Duplicate Bills lists each one to clear or confirm.']),
    item(9, 'Fixed Assets', 'Asset disposal workflow', 'Disposal workflow testing pending',
      num(disposals.n) > 0,
      [num(disposals.n) ? `${num(disposals.sold)} sold, ${num(disposals.scrapped)} scrapped, ${num(disposals.undone)} undone` : 'No disposals yet'],
      [{ label: 'Accountant → Fixed Assets', href: '/accountant/fixed-assets' }],
      ['Add an asset and run depreciation.', 'Open it → Verify & dispose: sold by invoice, sold into a bank, scrapped, or part of it.', 'Depreciation to the day posts first; the gain or loss is shown before posting.', 'Disposals report and the Schedule III note tie to the ledger; Undo with a reason reverses it.']),
    item(10, 'Payroll', 'Statutory deduction reports', 'Reports incomplete',
      num(payroll.n) > 0,
      [num(payroll.n) ? `${plural(num(payroll.n), 'pay run')} posted, the latest for ${payroll.last}` : 'No pay runs yet', num(challans.n) ? `${plural(num(challans.n), 'TDS challan')} recorded` : '', num(salaryPaid.n) ? `${plural(num(salaryPaid.n), 'salary payment')} made employee by employee` : ''],
      [{ label: 'Payroll → Statutory Reports', href: '/payroll/statutory' }, { label: 'Form 16', href: '/payroll/form-16' }],
      ['Add employees above and below the PF and ESI ceilings, in states with professional tax; run payroll.', 'Statutory Reports: PF register and ECR file, ESI upload, PT by state, LWF, TDS challans, Form 24Q.', 'Each report ties to the pay runs and the ledger.', 'Pay the dues and the salaries employee by employee.']),
    item(11, 'GST & Compliance', 'GST return filing reports', 'GST posting verified; return filing reports pending',
      num(filings.n) > 0 || invoicedSales > 0,
      [`${plural(invoicedSales, 'sales document')} feeding the returns`, num(filings.n) ? `${plural(num(filings.n), 'return')} marked filed, the latest for ${filings.last}` : 'No return marked filed yet'],
      [{ label: 'GSTR-1', href: '/gst/gstr1' }, { label: 'GSTR-3B', href: '/gst/gstr3b' }, { label: 'GST Reconciliation', href: '/gst/reconciliation' }, { label: 'GSTR-9', href: '/gst/gstr9' }, { label: 'Return Status', href: '/gst/return-status' }],
      ['GSTR-1: every table, tied to the books, with the portal JSON.', 'GSTR-3B with the GSTR-1 and GSTR-2B comparison and the tax payment.', 'GST Reconciliation: GSTR-1, GSTR-3B and the books month by month.', 'Mark a return filed with its ARN; filing itself is by offline upload until a GSP is contracted.']),
    item(12, 'Budgeting & Costing', 'Variance reporting', 'Variance reporting not completed',
      num(budgets.n) > 0,
      [num(budgets.n) ? `${plural(num(budgets.n), 'budget')}, the latest for FY ${budgets.fy}` : 'No budgets yet'],
      [{ label: 'Accountant → Budgets', href: '/accountant/budgets' }, { label: 'Reports → Budget vs Actuals', href: '/reports/budget-vs-actuals' }],
      ['New budget for the year, monthly; fill from last year, the same every month, or ±%.', 'Budget vs Actuals: variance in ₹ and %, favourable or unfavourable, totals to net profit.', 'By cost centre too (Costing tab); drill down to the ledger; export.']),
    item(13, 'Reporting', 'Custom report filters', 'Financial reports generated; filters pending',
      num(views.n) > 0,
      [num(views.n) ? `${plural(num(views.n), 'saved custom report')}` : 'No custom reports saved yet'],
      [{ label: 'Reports → Custom Reports', href: '/reports/custom-reports' }, { label: 'Profit and Loss → Customize Report', href: '/reports/profit-and-loss' }],
      ['Profit and Loss → Customize Report: period, basis, compare, report by month.', 'Filter by account, branch, cost centre, project, tag, customer or vendor: the figures and the heading change.', 'Save as a custom report; open, edit or delete it under Reports → Custom Reports.']),
    item(14, 'Integration', 'Payroll and inventory integration', 'Integration testing pending',
      num(runs.n) > 0 || num(stockLines.n) > 0,
      [num(runs.n) ? `${plural(num(runs.n), 'pay run')} posted to the ledger` : 'No pay runs posted yet', num(stockLines.n) ? 'Stock movements post to the Inventory account item by item' : ''],
      [{ label: 'Accountant → Integration Check', href: '/accountant/integration-check' }, { label: 'Payroll → Import Salary Register', href: '/payroll/import' }],
      ['Post a pay run; pay salaries and dues.', 'Buy and sell stock items.', 'Integration Check: payroll against the ledger and stock against the Inventory account, each Pass at ₹0.00 difference, with drill-down.']),
  ];
}
