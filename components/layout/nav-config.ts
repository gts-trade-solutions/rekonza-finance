import {
  Banknote, BarChart3, BookOpen, Boxes, Bot, Building2, CreditCard, FileSpreadsheet,
  FileText, Landmark, type LucideIcon, Package, Receipt,
  ReceiptIndianRupee, Repeat, ScrollText, Settings, ShieldCheck, ShoppingCart,
  Truck, Users, Wallet, FileCheck2, HandCoins, ClipboardList, CalendarClock,
  FileMinus, Building, AlertTriangle, Split, Lock, ChartColumnBig, MonitorDown, PackageCheck, Scale, CalendarDays, CalendarCheck2, LifeBuoy,
  ScanBarcode, BellRing, Download, Upload, ArrowLeftRight, FileUp, FileDown, AlertOctagon, Radar, FilePlus2, Timer, FolderKanban, Ship, PhoneCall, ListChecks, LayoutTemplate, Shuffle, Globe,
  House, ShoppingBasket, ShoppingBag, Clock, UserRoundCog, ChartNoAxesColumn, Folder,
} from 'lucide-react';
// Status review 7, builder B.
import { Copy, History } from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** RBAC module key checked with hasPermission(role, module, 'view'). */
  module: string;
  badge?: 'einvoicePending' | 'msmeRisk' | 'unmatched' | 'complianceDue' | 'exceptions';
  /** Shown only to a book with this GST registration: the returns differ. */
  registration?: 'regular' | 'composition';
  /** A part of the app a book can switch off (Settings → Policies). */
  feature?: FeatureKey | FeatureKey[];
  /** Lit only on its own address, not on the pages under it (which have rows of their own). */
  exact?: boolean;
  /** false: known to quick find and the print guard, but not drawn in the sidebar (Settings: the top-bar gear). */
  sidebar?: boolean;
}

export type FeatureKey = 'inventory' | 'fixedAssets' | 'tdsTcs' | 'ewayBills' | 'approvals' | 'tally' | 'analytics' | 'payroll' | 'gst' | 'multiCurrency' | 'costCentres';

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  module: string;
  /** A group with no items renders as a single link to `href`. */
  href?: string;
  items: NavItem[];
  badge?: NavItem['badge'];
  feature?: FeatureKey;
  /** Rekonza's own, not Zoho's: drawn below the rule that ends Zoho's menu. */
  extra?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  // ── Zoho Books' own menu, in Zoho's order and Zoho's words ────────────────
  // (the client asked for Zoho exactly). Inside each group Zoho's entries come
  // first; what Rekonza adds that Zoho has not follows them.
  {
    // Zoho: Items, Price Lists, Inventory Adjustments. Stock, transfers and the
    // rest of Rekonza's inventory follow, when the book keeps stock.
    label: 'Items',
    icon: ShoppingBasket,
    module: 'sales',
    items: [
      { label: 'Items', href: '/sales/items', icon: Package, module: 'sales' },
      { label: 'Price Lists', href: '/sales/price-lists', icon: Receipt, module: 'sales' },
      { label: 'Inventory Adjustments', href: '/inventory/adjustments', icon: ClipboardList, module: 'inventory', feature: 'inventory' },
      { label: 'Stock on Hand', href: '/inventory/stock', icon: Boxes, module: 'inventory', feature: 'inventory' },
      { label: 'Transfers', href: '/inventory/transfers', icon: Truck, module: 'inventory', feature: 'inventory' },
      { label: 'Production', href: '/inventory/production', icon: PackageCheck, module: 'inventory', feature: 'inventory' },
      { label: 'Batches & Expiry', href: '/inventory/batches', icon: CalendarClock, module: 'inventory', feature: 'inventory' },
      { label: 'Serial Numbers', href: '/inventory/serials', icon: ScanBarcode, module: 'inventory', feature: 'inventory' },
      { label: 'Warehouses', href: '/inventory/warehouses', icon: Building, module: 'inventory', feature: 'inventory' },
      // Status review 7, item 5: the Inventory account against the valuation, item by item.
      { label: 'Valuation vs Ledger', href: '/reports/stock-reconciliation', icon: Scale, module: 'accountant', feature: 'inventory' },
    ],
  },
  {
    label: 'Sales',
    icon: ShoppingCart,
    module: 'sales',
    items: [
      { label: 'Customers', href: '/sales/customers', icon: Users, module: 'sales' },
      { label: 'Quotes', href: '/sales/estimates', icon: FileText, module: 'sales' },
      // Zoho's "Retainer Invoices": the client asked for "Service Invoices" (their item 24).
      { label: 'Service Invoices', href: '/sales/retainers', icon: HandCoins, module: 'sales' },
      { label: 'Sales Orders', href: '/sales/sales-orders', icon: ClipboardList, module: 'sales' },
      { label: 'Invoices', href: '/sales/invoices', icon: Receipt, module: 'sales' },
      { label: 'Recurring Invoices', href: '/sales/recurring', icon: Repeat, module: 'sales' },
      { label: 'Delivery Challans', href: '/sales/challans', icon: Truck, module: 'sales' },
      { label: 'Payments Received', href: '/sales/payments', icon: Wallet, module: 'sales' },
      { label: 'Credit Notes', href: '/sales/credit-notes', icon: FileMinus, module: 'sales' },
      // Zoho keeps e-way bills under Sales; the GST returns stay in GST & Taxes.
      { label: 'e-Way Bills', href: '/gst/eway-bills', icon: Truck, module: 'gst', feature: ['gst', 'ewayBills'] },
      { label: 'Sales Receipts', href: '/sales/sales-receipts', icon: ReceiptIndianRupee, module: 'sales' },
      { label: 'Debit Notes', href: '/sales/debit-notes', icon: FilePlus2, module: 'sales' },
      { label: 'Interest on Overdue', href: '/sales/overdue-interest', icon: AlertTriangle, module: 'sales' },
      { label: 'Payment Reminders', href: '/sales/reminders', icon: BellRing, module: 'sales' },
      { label: 'Collections', href: '/sales/collections', icon: PhoneCall, module: 'sales' },
    ],
  },
  {
    label: 'Purchases',
    icon: ShoppingBag,
    module: 'purchases',
    items: [
      { label: 'Vendors', href: '/purchases/vendors', icon: Building2, module: 'purchases' },
      { label: 'Expenses', href: '/purchases/expenses', icon: CreditCard, module: 'purchases' },
      { label: 'Recurring Expenses', href: '/purchases/recurring?kind=expense', icon: Repeat, module: 'purchases' },
      { label: 'Purchase Orders', href: '/purchases/purchase-orders', icon: ClipboardList, module: 'purchases' },
      { label: 'Bills', href: '/purchases/bills', icon: FileText, module: 'purchases' },
      { label: 'Recurring Bills', href: '/purchases/recurring?kind=bill', icon: Repeat, module: 'purchases' },
      // Status review 7, item 8: bills saved although they looked like one already in the books.
      { label: 'Possible Duplicate Bills', href: '/purchases/duplicate-bills', icon: Copy, module: 'purchases' },
      { label: 'Payments Made', href: '/purchases/payments', icon: Banknote, module: 'purchases' },
      { label: 'Vendor Credits', href: '/purchases/vendor-credits', icon: FileMinus, module: 'purchases' },
      { label: 'Goods Receipts', href: '/purchases/goods-receipts', icon: PackageCheck, module: 'purchases' },
      { label: 'Bills of Entry (imports)', href: '/purchases/bills-of-entry', icon: Ship, module: 'purchases', feature: 'gst' },
      { label: 'Payment Batches', href: '/purchases/payment-batches', icon: Landmark, module: 'purchases' },
      { label: 'MSME Payments', href: '/purchases/msme-tracker', icon: AlertTriangle, module: 'purchases', badge: 'msmeRisk' },
    ],
  },
  {
    // Time Tracking, as in Zoho: work done for customers, the hours logged to
    // it, and billing them (services/projects.ts).
    label: 'Time Tracking',
    icon: Clock,
    module: 'projects',
    items: [
      { label: 'Projects', href: '/projects', icon: FolderKanban, module: 'projects' },
      { label: 'Timesheet', href: '/projects/timesheet', icon: Timer, module: 'projects' },
    ],
  },
  {
    // One destination, as in Zoho. Accounts, reconcile, imports, rules,
    // transfers and cheques all live inside the Banking workspace.
    label: 'Banking',
    icon: Landmark,
    module: 'banking',
    href: '/banking',
    badge: 'unmatched',
    items: [],
  },
  {
    label: 'Accountant',
    icon: UserRoundCog,
    module: 'accountant',
    // Zoho's Accountant entries first, in Zoho's order, then Rekonza's.
    items: [
      { label: 'Manual Journals', href: '/accountant/journals', icon: BookOpen, module: 'accountant' },
      { label: 'Bulk Update', href: '/accountant/bulk-update', icon: Shuffle, module: 'accountant' },
      { label: 'Currency Adjustments', href: '/accountant/foreign-currency', icon: Banknote, module: 'accountant', feature: 'multiCurrency' },
      { label: 'Chart of Accounts', href: '/accountant/chart-of-accounts', icon: ScrollText, module: 'accountant' },
      { label: 'Budgets', href: '/accountant/budgets', icon: BarChart3, module: 'accountant' },
      { label: 'Transaction Locking', href: '/accountant/transaction-locking', icon: Lock, module: 'accountant' },
      { label: 'Recurring Journals', href: '/accountant/recurring-journals', icon: Repeat, module: 'accountant' },
      { label: 'Journal Templates', href: '/accountant/journal-templates', icon: LayoutTemplate, module: 'accountant' },
      { label: 'Opening Balances', href: '/accountant/opening-balances', icon: FileCheck2, module: 'accountant' },
      { label: 'Fixed Assets', href: '/accountant/fixed-assets', icon: Building, module: 'accountant', feature: 'fixedAssets' },
      { label: 'Balance Confirmations', href: '/accountant/balance-confirmations', icon: Scale, module: 'accountant' },
      { label: 'Approvals', href: '/approvals', icon: ShieldCheck, module: 'accountant', feature: 'approvals' },
      { label: 'Risk & Anomalies', href: '/analytics/risk', icon: Radar, module: 'analytics', feature: 'analytics' },
      { label: 'Cost Centres', href: '/accountant/cost-centres', icon: Split, module: 'accountant', feature: 'costCentres' },
      { label: 'Period Close', href: '/accountant/period-close', icon: CalendarClock, module: 'accountant' },
      { label: 'Audit Trail', href: '/accountant/audit-trail', icon: ShieldCheck, module: 'accountant' },
    ],
  },
  { label: 'Reports', icon: ChartNoAxesColumn, module: 'reports', href: '/reports', items: [] },
  { label: 'Documents', icon: Folder, module: 'accountant', href: '/documents', items: [] },

  // ── What Rekonza has and Zoho has not, below a rule ───────────────────────
  {
    label: 'GST & Taxes',
    icon: ShieldCheck,
    module: 'gst',
    extra: true,
    items: [
      { label: 'Compliance Calendar', href: '/gst/compliance-calendar', icon: CalendarDays, module: 'gst', badge: 'complianceDue' },
      { label: 'Return Status', href: '/gst/return-status', icon: CalendarCheck2, module: 'gst' },
      { label: 'E-Invoices (IRP)', href: '/gst/einvoices', icon: FileCheck2, module: 'gst', badge: 'einvoicePending', registration: 'regular', feature: 'gst' },
      { label: 'GSTR-1', href: '/gst/gstr1', icon: FileText, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'GSTR-3B', href: '/gst/gstr3b', icon: FileSpreadsheet, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'IFF (quarterly filers)', href: '/gst/iff', icon: FileText, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'GSTR-9 (annual)', href: '/gst/gstr9', icon: CalendarClock, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'GSTR-9C (reconciliation)', href: '/gst/gstr9c', icon: Scale, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'ITC Reconciliation (2B)', href: '/gst/itc-reconciliation', icon: Split, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'ITC Reversals', href: '/gst/itc-reversals', icon: FileMinus, module: 'gst', registration: 'regular', feature: 'gst' },
      { label: 'CMP-08 & GSTR-4', href: '/gst/composition', icon: FileSpreadsheet, module: 'gst', registration: 'composition', feature: 'gst' },
      { label: 'Job Work (ITC-04)', href: '/gst/job-work', icon: ClipboardList, module: 'gst', feature: 'gst' },
      { label: 'TDS & TCS', href: '/gst/tds-tcs', icon: Receipt, module: 'gst', feature: 'tdsTcs' },
    ],
  },
  {
    label: 'Payroll',
    icon: HandCoins,
    module: 'payroll',
    feature: 'payroll',
    extra: true,
    items: [
      { label: 'Payroll', href: '/payroll/runs', icon: Wallet, module: 'payroll' },
      { label: 'Employees', href: '/payroll/employees', icon: Users, module: 'payroll' },
      { label: 'Leave', href: '/payroll/leave', icon: CalendarDays, module: 'payroll' },
      { label: 'Advances & Loans', href: '/payroll/advances', icon: Banknote, module: 'payroll' },
      { label: 'Expense Claims', href: '/payroll/claims', icon: Receipt, module: 'payroll' },
      { label: 'Declarations', href: '/payroll/declarations', icon: FileCheck2, module: 'payroll' },
      { label: 'Statutory Registers', href: '/payroll/statutory', icon: FileSpreadsheet, module: 'payroll' },
      { label: 'Form 16 / 130', href: '/payroll/form-16', icon: FileText, module: 'payroll' },
      { label: 'Full & Final', href: '/payroll/full-and-final', icon: HandCoins, module: 'payroll' },
    ],
  },
  {
    // Every way data comes in or goes out: spreadsheets, CSV and any delimited
    // text, QuickBooks and Tally in; CSV, text, Excel, JSON and Tally out.
    label: 'Import & Export',
    icon: ArrowLeftRight,
    module: 'accountant',
    extra: true,
    items: [
      { label: 'Import Excel, CSV, Text', href: '/settings/import', icon: FileUp, module: 'accountant', exact: true },
      { label: 'Import invoices from PDF', href: '/settings/import?tab=pdf', icon: FileUp, module: 'accountant' },
      { label: 'Import from QuickBooks', href: '/settings/import/quickbooks', icon: FileUp, module: 'accountant' },
      // Status review 7, item 3: every import, its rows left out and why, and undo.
      { label: 'Import History', href: '/import/history', icon: History, module: 'accountant' },
      { label: 'Import from Tally', href: '/tally/import', icon: Download, module: 'tally', feature: 'tally' },
      { label: 'Export CSV, Text, Excel', href: '/settings/export', icon: FileDown, module: 'accountant' },
      { label: 'Export to Tally', href: '/tally/export', icon: Upload, module: 'tally', feature: 'tally' },
      { label: 'Tableau, Power BI, OneStream', href: '/settings?tab=developer', icon: ChartColumnBig, module: 'settings' },
    ],
  },
  {
    // Tally's two files, each way, and the PC where TallyPrime runs.
    label: 'Tally',
    icon: MonitorDown,
    module: 'tally',
    feature: 'tally',
    extra: true,
    items: [
      { label: 'Import from Tally', href: '/tally/import', icon: Download, module: 'tally' },
      { label: 'Export to Tally', href: '/tally/export', icon: Upload, module: 'tally' },
      { label: 'Connected Tally', href: '/tally', icon: MonitorDown, module: 'tally', exact: true },
    ],
  },
];

/** Zoho's first entry. */
export const TOP_LEVEL: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: House, module: 'sales' },
];

/** Rekonza's own single screens, after the extra groups. */
export const BOTTOM_LEVEL: NavItem[] = [
  { label: 'Alerts', href: '/exceptions', icon: AlertOctagon, module: 'exceptions', badge: 'exceptions' },
  { label: 'Software Checklist', href: '/checklist', icon: ListChecks, module: 'reports' },
  { label: 'Analytics', href: '/analytics', icon: ChartColumnBig, module: 'analytics', feature: 'analytics' },
  { label: 'AI Assistant', href: '/ai', icon: Bot, module: 'ai' },
  // Settings opens from the gear in the top bar, as in Zoho; it stays listed
  // here so quick find and the print guard still know the screen.
  { label: 'Settings', href: '/settings', icon: Settings, module: 'settings', sidebar: false },
  // Everyone may open the web tabs, as everyone may open Help.
  { label: 'Web Tabs', href: '/web-tabs', icon: Globe, module: 'help' },
  { label: 'Help', href: '/help', icon: LifeBuoy, module: 'help' },
];

/**
 * Every screen the menu knows, single-link groups included (Banking, Reports,
 * Documents): what the print guard reads to find the module a page belongs to,
 * and what quick find offers. A screen missing here would be printable by any
 * role, so this list, not NAV_GROUPS' items alone, is the one to read.
 */
export const ALL_NAV_ITEMS: (NavItem & { group?: string })[] = [
  ...TOP_LEVEL,
  ...NAV_GROUPS.flatMap((g) =>
    g.items.length
      ? g.items.map((i) => ({ ...i, group: g.label }))
      : g.href ? [{ label: g.label, href: g.href, icon: g.icon, module: g.module }] : [],
  ),
  ...BOTTOM_LEVEL,
];

const GUARD_ITEMS = ALL_NAV_ITEMS.map((i) => ({ href: i.href.split('?')[0], module: i.module }));

/** The module a page belongs to: the menu entry whose link is the longest start of its path. */
export function menuModuleForPath(path: string): string | null {
  let best: { len: number; module: string } | null = null;
  for (const i of GUARD_ITEMS) {
    if ((path === i.href || path.startsWith(`${i.href}/`)) && (!best || i.href.length > best.len)) best = { len: i.href.length, module: i.module };
  }
  return best?.module ?? null;
}
