'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Reports index, following Zoho Books' catalogue: the same nine categories in
// the same order, with search and starred favourites. Every figure is derived
// live from journal entries — there is no stored report data anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Folder, House, Search, Star } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useForceNavCollapsed } from '@/components/layout/nav-state';
import { PageHeader } from '@/components/shared/page-header';
import { journal, type JournalResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { cn } from '@/lib/utils';
import { hasPermission } from '@/lib/rbac';
import { reportModule } from '@/lib/report-groups';
import { useAppStore } from '@/lib/store';

interface ReportDef {
  title: string;
  href: string;
  description: string;
  /** Not yet built — shown but not linked. */
  soon?: boolean;
}

/** Zoho's categories, in Zoho's order. */
const CATALOGUE: { group: string; blurb: string; reports: ReportDef[] }[] = [
  {
    group: 'Business Overview',
    blurb: 'How the business performed, and what it is worth.',
    reports: [
      { title: 'Profit and Loss', href: '/reports/profit-and-loss', description: 'Income less expenses over a period, grouped by category — did we make money?' },
      { title: 'Horizontal Profit and Loss', href: '/reports/profit-and-loss?format=horizontal', description: 'The trading and profit and loss account in T-form: expenses on the left, income on the right.' },
      { title: 'Profit and Loss (Schedule III)', href: '/reports/schedule-iii?tab=pl', description: 'The statement of profit and loss in the Companies Act layout, with last year beside it.' },
      { title: 'Cash Flow Statement', href: '/reports/cash-flow', description: 'Where cash actually came from and went.' },
      { title: 'Fund Flow Statement', href: '/reports/fund-flow', description: 'Sources and applications of funds, with the change in working capital.' },
      { title: 'Cash-flow Forecast', href: '/reports/cash-forecast', description: 'Bank and cash over the next weeks, from what is due in and out.' },
      { title: 'Balance Sheet', href: '/reports/balance-sheet', description: 'What we own and owe on a single date, grouped by category.' },
      { title: 'Horizontal Balance Sheet', href: '/reports/balance-sheet?format=horizontal', description: 'Liabilities and equities beside assets, in T-form.' },
      { title: 'Balance Sheet (Schedule III)', href: '/reports/schedule-iii', description: 'The balance sheet in the Companies Act layout, with last year and the ageing tables.' },
      { title: 'Business Performance Ratios', href: '/reports/business-ratios', description: 'Margin, liquidity and collection speed, explained in plain terms.' },
      { title: 'Movement of Equity', href: '/reports/movement-of-equity', description: "How the owners' stake changed, and why." },
      { title: 'Consolidated statements', href: '/reports/consolidated', description: 'Every company you work in, side by side and summed.' },
    ],
  },
  {
    group: 'Accountant',
    blurb: 'The raw books. Every other report is a view over these.',
    reports: [
      { title: 'Account Transactions', href: '/reports/account-transactions', description: 'Every journal line, across every account.' },
      { title: 'Account Type Summary', href: '/reports/account-type-summary', description: 'The five account families at a glance.' },
      { title: 'General Ledger', href: '/reports/general-ledger', description: 'One account, in order, with a running balance.' },
      { title: 'Journal Report', href: '/reports/journal-report', description: 'Every entry with its full double-entry detail.' },
      { title: 'Trial Balance', href: '/reports/trial-balance', description: 'Proof the books balance, account by account.' },
      { title: 'Day Book', href: '/reports/day-book', description: 'Everything that happened, day by day.' },
      { title: 'Bank Statement as on Date', href: '/reports/bank-statement', description: 'The bank reconciliation statement on any day: books worked through to the bank balance.' },
      { title: 'Cash & Bank Book', href: '/reports/cash-book', description: 'Receipts and payments of one account with its running balance; count the cash.' },
      { title: 'Reconciliation Status', href: '/reports/reconciliation-status', description: 'Each bank account: statement lines matched and still to match, and the books against the statement.' },
      { title: 'Realised Exchange Gain or Loss', href: '/reports/realised-fx', description: 'The exchange difference on foreign-currency invoices and bills settled in the period.' },
      { title: 'Unrealised Exchange Gain or Loss', href: '/reports/unrealised-fx', description: 'What open foreign-currency documents would gain or lose at the closing rates.' },
      // Status review 7 (builder A).
      { title: 'Budget vs Actuals', href: '/reports/budget-vs-actuals', description: 'Each account against its budget by month, quarter or year: variance in rupees and per cent, favourable or not.' },
      { title: 'Cost Centre Costing', href: '/accountant/budgets?tab=costing', description: 'Each cost centre’s budget against its own income and expense.' },
      { title: 'Reversed Vouchers', href: '/accountant/reversed-vouchers', description: 'Every reversal pair with its reason and who did it.' },
    ],
  },
  {
    group: 'Sales',
    blurb: 'What sold, to whom, and through whom.',
    reports: [
      { title: 'Sales by Customer', href: '/reports/sales-by-customer', description: 'Revenue ranked by who generated it.' },
      { title: 'Sales by Item', href: '/reports/sales-by-item', description: 'What actually sells, by value and quantity.' },
      { title: 'Sales by Salesperson', href: '/reports/sales-by-salesperson', description: 'Who booked it, and how much they collected.' },
      { title: 'Sales Summary', href: '/reports/sales-summary', description: 'Month by month: invoices, credit notes, net sales and GST charged.' },
      { title: 'Sales by Supply', href: '/reports/sales-by-supply', description: 'Domestic and international, goods and services separately; exports under LUT (IGST nil) and with IGST paid.' },
    ],
  },
  {
    group: 'Receivables',
    blurb: 'Who owes you, and how long they have owed it.',
    reports: [
      { title: 'Customer Balances', href: '/reports/customer-balances', description: 'Invoiced, received and outstanding, per customer.' },
      { title: 'AR Ageing Summary', href: '/reports/ar-ageing', description: 'Outstanding invoices by age bucket.' },
      { title: 'AR Ageing Details', href: '/reports/ar-ageing-details', description: 'Every unpaid invoice, aged individually.' },
      { title: 'Invoice Details', href: '/reports/invoice-details', description: 'Every invoice raised, with its balance.' },
      { title: 'Service Invoice Details', href: '/reports/retainer-details', description: 'Advances collected, and how much is still unearned.' },
      { title: 'Sales Order Details', href: '/reports/sales-order-details', description: 'Confirmed orders and what is left to invoice.' },
      { title: 'Pending Sales Orders', href: '/reports/pending-sales-orders', description: 'Line by line: what is still to deliver and to invoice.' },
      { title: 'Quote Details', href: '/reports/estimate-details', description: 'Quotes sent, and what became of them.' },
      { title: 'Receivable Details', href: '/reports/receivable-details', description: 'Every invoice, debit note, credit note and retainer, with its balance.' },
    ],
  },
  {
    group: 'Payments Received',
    blurb: 'Money in, and how quickly it arrives.',
    reports: [
      { title: 'Payments Received', href: '/reports/payments-received', description: 'Every receipt, with TDS withheld and amounts on account.' },
      { title: 'Time to Get Paid', href: '/reports/time-to-get-paid', description: 'How long invoices really take to settle.' },
      { title: 'Credit Note Details', href: '/reports/credit-note-details', description: 'Credits issued, and the reason GST requires on each.' },
      { title: 'Refund History', href: '/reports/refund-history', description: 'Credits settled in cash, in both directions.' },
    ],
  },
  {
    group: 'Payables',
    blurb: 'What you owe, and to whom.',
    reports: [
      { title: 'Vendor Balances', href: '/reports/vendor-balances', description: 'Billed, paid and outstanding, per supplier.' },
      { title: 'AP Ageing Summary', href: '/reports/ap-ageing', description: 'Unpaid bills by age bucket.' },
      { title: 'AP Ageing Details', href: '/reports/ap-ageing-details', description: 'Every unpaid bill, aged individually; MSME suppliers marked.' },
      { title: 'Bill Details', href: '/reports/bill-details', description: 'Every supplier bill, with TDS withheld.' },
      { title: 'Vendor Credit Details', href: '/reports/vendor-credit-details', description: 'Credits from suppliers, and what is still to use.' },
      { title: 'Purchase Order Details', href: '/reports/purchase-order-details', description: 'Every order raised, with what arrived, what was billed, and the vendor’s answer.' },
      { title: 'Payable Details', href: '/reports/payable-details', description: 'Every bill and vendor credit, with its balance.' },
      { title: 'Pending Purchase Orders', href: '/reports/pending-purchase-orders', description: 'Line by line: what is still to receive and to bill.' },
      { title: 'Payments Made', href: '/reports/payments-made', description: 'Every payment out, and the account it left from.' },
    ],
  },
  {
    group: 'Purchases and Expenses',
    blurb: 'Where the money goes.',
    reports: [
      { title: 'Purchases by Vendor', href: '/reports/purchases-by-vendor', description: 'Spending ranked by supplier.' },
      { title: 'Purchases by Item', href: '/reports/purchases-by-item', description: 'What was bought, how much, and the average price paid.' },
      { title: 'Expenses by Category', href: '/reports/expenses-by-category', description: 'Spend grouped by expense account.' },
      { title: 'Expense Details', href: '/reports/expense-details', description: 'Every expense line, with input credit claimed.' },
      { title: 'Expenses by Customer', href: '/reports/expenses-by-customer', description: 'Spending incurred for each customer, billable or not.' },
      { title: 'Expenses by Project', href: '/reports/expenses-by-project', description: 'What each project has cost in expenses.' },
      { title: 'Billable Expense Details', href: '/reports/billable-expense-details', description: 'Expenses to charge on: billed already, or still to bill.' },
    ],
  },
  {
    group: 'Inventory',
    blurb: 'What is in stock, what moved, and how long it has sat.',
    reports: [
      { title: 'Stock Summary and Valuation', href: '/inventory/stock', description: 'Opening, in, out and closing for every item, valued at weighted average or FIFO.' },
      { title: 'Stock Ledger', href: '/reports/stock-ledger', description: 'Every receipt, issue, sale and adjustment of one item, with a running balance.' },
      { title: 'Stock Ageing', href: '/reports/stock-ageing', description: 'How long the stock on hand has been sitting, in buckets.' },
      { title: 'Inventory Valuation Summary', href: '/reports/inventory-valuation', description: 'Each item’s quantity, unit cost and value at a date.' },
      { title: 'Committed Stock Details', href: '/reports/committed-stock', description: 'Promised on open sales orders against what is on hand.' },
      { title: 'ABC Classification', href: '/reports/abc-classification', description: 'Items ranked by sales into A, B and C: where stock care pays most.' },
      { title: 'Batches and Expiry', href: '/inventory/batches', description: 'Stock by batch, and what is expiring.' },
      { title: 'Stock Transfers', href: '/inventory/transfers', description: 'Goods moved between godowns, in transit included.' },
    ],
  },
  {
    group: 'Projects and Timesheets',
    blurb: 'Hours, billing and margin on the work you do for customers.',
    reports: [
      { title: 'Project Summary', href: '/reports/project-summary', description: 'Each project: hours, invoiced, spent and the margin.' },
      { title: 'Timesheet Details', href: '/reports/timesheet-details', description: 'Every hour logged, by person, project and task.' },
    ],
  },
  {
    group: 'Fixed Assets, Budgets and Payroll',
    blurb: 'Registers and comparisons kept beside the books.',
    reports: [
      { title: 'Fixed Asset Register', href: '/accountant/fixed-assets', description: 'Every asset, its depreciation under Schedule II, and disposals.' },
      { title: 'Budget vs Actual', href: '/accountant/budgets', description: 'Each account against its budget, with the variance and the pace.' },
      { title: 'Cost Centre Profit and Loss', href: '/accountant/cost-centres', description: 'Income and expense by cost centre.' },
      { title: 'Profit by Reporting Tag', href: '/reports/profit-by-tag', description: 'Income, expense and profit under each value of a tag: region, channel, product line.' },
      { title: 'Payroll Register', href: '/payroll/runs', description: 'Each month’s salaries, deductions and payslips.' },
    ],
  },
  {
    group: 'Taxes',
    blurb: 'Everything the GST portal and your CA will ask for.',
    reports: [
      { title: 'GSTR-1 Summary', href: '/gst/gstr1', description: 'Outward supplies, section by section.' },
      { title: 'GSTR-3B Summary', href: '/gst/gstr3b', description: 'Monthly liability with input credit set-off.' },
      { title: 'ITC Reconciliation', href: '/gst/itc-reconciliation', description: "Your books against the government's GSTR-2B." },
      { title: 'TDS & TCS', href: '/gst/tds-tcs', description: 'Tax withheld, by section and party.' },
      { title: 'E-invoice Register', href: '/gst/einvoices', description: 'IRN status and the 30-day reporting window.' },
    ],
  },
  {
    group: 'Activity',
    blurb: 'Who did what, and when.',
    reports: [
      { title: 'Audit Trail', href: '/accountant/audit-trail', description: 'Every create, change and void. Never editable.' },
      { title: 'Scheduled Reports', href: '/reports/scheduled', description: 'Reports made on their own, kept here and announced under the bell.' },
      { title: 'Portal Activities', href: '/reports/portal-activities', description: 'What customers and vendors did on their portal: opened, paid, commented, accepted, sent files.' },
      { title: 'System Mails', href: '/reports/system-mails', description: 'Every email the books sent, to whom, and whether it went.' },
    ],
  },
];

/** The permission a report needs: its report group, or the area its page lives in. */
const needs = (href: string) =>
  href === '/reports/scheduled' ? 'reports'
    : href.startsWith('/reports/stock-') || href.startsWith('/inventory/') ? 'inventory'
    : href.startsWith('/payroll/') ? 'payroll'
    : href.startsWith('/reports/') ? reportModule(href.slice('/reports/'.length)) : href.startsWith('/gst/') ? 'gst' : 'accountant';
const VISIT_KEY = 'rekonza.reports.visited';
const FAV_KEY = 'rekonza-report-favourites';

export default function ReportsPage() {
  // Only the count is needed, so one row comes back and the summary carries the
  // total — the gallery does not need the journal itself.
  const ledger = useApi<JournalResponse>(() => journal.list({ limit: 1 }), []);
  const entryCount = ledger.data?.summary.count ?? 0;
  const [query, setQuery] = useState('');
  const [favourites, setFavourites] = useState<string[]>([]);
  // Report-level rights: a custom role may see some groups of reports and not others.
  const role = useAppStore((s) => s.session?.role);
  const catalogue = useMemo(() => CATALOGUE
    .map((g) => ({ ...g, reports: g.reports.filter((r) => hasPermission(role, needs(r.href), 'view')) }))
    .filter((g) => g.reports.length), [role]);
  const ALL = useMemo(() => catalogue.flatMap((g) => g.reports.map((r) => ({ ...r, group: g.group }))), [catalogue]);

  // Favourites are a per-viewer convenience, so local storage is the right home.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavourites(JSON.parse(raw));
    } catch {
      /* storage can be unavailable; favourites are optional */
    }
  }, []);

  const toggleFav = (href: string) => {
    setFavourites((f) => {
      const next = f.includes(href) ? f.filter((x) => x !== href) : [...f, href];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.group.toLowerCase().includes(q),
    );
  }, [query, ALL]);

  const favReports = ALL.filter((r) => favourites.includes(r.href));

  // Zoho's Reports Center: the sidebar folds to its rail, a panel of
  // categories on the left, and every report in one table on the right with
  // its star, its category, who made it and when it was last opened.
  useForceNavCollapsed(true);
  const [view, setView] = useState<string>('home');
  const [visits, setVisits] = useState<Record<string, string>>({});
  useEffect(() => {
    try { setVisits(JSON.parse(localStorage.getItem(VISIT_KEY) ?? '{}')); } catch { /* optional */ }
  }, []);
  const visited = (href: string) => {
    const next = { ...visits, [href]: new Date().toISOString() };
    setVisits(next);
    try { localStorage.setItem(VISIT_KEY, JSON.stringify(next)); } catch { /* optional */ }
  };

  const listed = matches
    ?? (view === 'home' ? ALL : view === 'favourites' ? favReports : ALL.filter((r) => r.group === view));
  const heading = matches ? `Results for “${query}”` : view === 'home' ? 'All Reports' : view === 'favourites' ? 'Favorites' : view;

  const NavButton = ({ value, icon: Icon, label, count }: { value: string; icon: typeof Folder; label: string; count?: number }) => (
    <button
      type="button"
      onClick={() => { setView(value); setQuery(''); }}
      data-slot="report-category"
      data-active={view === value && !matches ? '1' : undefined}
      className={cn(
        'flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors',
        view === value && !matches ? 'bg-sidebar-accent text-foreground' : 'hover:bg-row-hover',
      )}
    >
      <Icon className={cn('size-4 shrink-0', value === 'home' ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.6} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="text-[11px] tabular text-muted-foreground">{count}</span>}
    </button>
  );

  return (
    <>
      <PageHeader
        title="Reports Center"
        description={
          entryCount
            ? `No report data is stored anywhere. Every figure is calculated live from ${entryCount} journal entries, which is why they can never disagree with each other.`
            : 'No report data is stored anywhere. Every figure is calculated live from the journal, which is why they can never disagree with each other.'
        }
        actions={
          <div className="relative w-[300px] max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-primary" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reports"
              className="border-transparent bg-[#f1f1fa] pl-8 dark:bg-muted"
              data-slot="report-search"
            />
          </div>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[250px_1fr]" data-slot="reports-center">
        <Card className="gap-0 p-3">
          <NavButton value="home" icon={House} label="Home" />
          <NavButton value="favourites" icon={Star} label="Favorites" count={favReports.length || undefined} />
          <p className="px-2.5 pb-1.5 pt-5 text-[12px] font-medium uppercase text-muted-foreground">Report Category</p>
          {catalogue.map((g) => <NavButton key={g.group} value={g.group} icon={Folder} label={g.group} />)}
        </Card>

        <Card className="gap-0 py-0">
          <div className="flex items-center gap-2 border-b px-4 py-3.5">
            <h2 className="text-[16px] font-medium">{heading}</h2>
            <span className="rounded-full bg-[#e1ebfc] px-2 text-[12px] font-medium leading-5 text-[#1c5bd9] tabular">{listed.length}</span>
            {view !== 'home' && view !== 'favourites' && !matches && (
              <p className="ml-3 hidden truncate text-[12px] text-muted-foreground md:block">{catalogue.find((g) => g.group === view)?.blurb}</p>
            )}
          </div>
          {listed.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              {matches ? 'No report matches that. Try a category name like “payables” or “tax”.' : view === 'favourites' ? 'Star a report to keep it here.' : 'Nothing here.'}
            </p>
          ) : (
            <div className="overflow-x-auto thin-scroll">
              <table className="w-full text-[13px]" data-slot="reports-table">
                <thead>
                  <tr className="border-b bg-table-head text-left text-[11px] font-semibold uppercase text-table-head-foreground">
                    <th className="px-4 pb-2 pt-3 font-semibold">Report Name</th>
                    <th className="px-4 pb-2 pt-3 font-semibold">Report Category</th>
                    <th className="px-4 pb-2 pt-3 font-semibold">Created By</th>
                    <th className="px-4 pb-2 pt-3 font-semibold">Last Visited</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((r) => {
                    const fav = favourites.includes(r.href);
                    return (
                      <tr key={r.href} className="border-b last:border-0 hover:bg-row-hover" data-slot="report-row">
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
                              onClick={() => toggleFav(r.href)}
                              className="shrink-0"
                            >
                              <Star className={cn('size-4', fav ? 'fill-[#ff7a1a] text-[#ff7a1a]' : 'text-[#b8bccb] hover:text-[#ff7a1a]')} strokeWidth={1.6} />
                            </button>
                            {r.soon ? (
                              <span className="text-muted-foreground" title={r.description}>{r.title}</span>
                            ) : (
                              <Link href={r.href} onClick={() => visited(r.href)} title={r.description} className="font-medium text-link hover:underline">
                                {r.title}
                              </Link>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3">{r.group}</td>
                        <td className="px-4 py-3">System Generated</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {visits[r.href] ? new Date(visits[r.href]).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
