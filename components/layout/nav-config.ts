import {
  Banknote, BarChart3, BookOpen, Boxes, Bot, Building2, CreditCard, FileSpreadsheet,
  FileText, Landmark, LayoutDashboard, type LucideIcon, Package, Receipt,
  ReceiptIndianRupee, Repeat, ScrollText, Settings, ShieldCheck, ShoppingCart,
  Truck, Users, Wallet, FileCheck2, HandCoins, ClipboardList, CalendarClock,
  FileMinus, Building, AlertTriangle, Split, Lock, ChartColumnBig, MonitorDown, PackageCheck, Scale, CalendarDays, LifeBuoy,
  ScanBarcode, BellRing, AlertOctagon, FolderOpen, Radar,
} from 'lucide-react';

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
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Sales',
    icon: ReceiptIndianRupee,
    module: 'sales',
    items: [
      { label: 'Customers', href: '/sales/customers', icon: Users, module: 'sales' },
      { label: 'Items', href: '/sales/items', icon: Package, module: 'sales' },
      { label: 'Price Lists', href: '/sales/price-lists', icon: Receipt, module: 'sales' },
      { label: 'Estimates', href: '/sales/estimates', icon: FileText, module: 'sales' },
      { label: 'Sales Orders', href: '/sales/sales-orders', icon: ClipboardList, module: 'sales' },
      { label: 'Delivery Challans', href: '/sales/challans', icon: Truck, module: 'sales' },
      { label: 'Invoices', href: '/sales/invoices', icon: Receipt, module: 'sales' },
      { label: 'Retainer Invoices', href: '/sales/retainers', icon: HandCoins, module: 'sales' },
      { label: 'Payments Received', href: '/sales/payments', icon: Wallet, module: 'sales' },
      { label: 'Credit Notes', href: '/sales/credit-notes', icon: FileMinus, module: 'sales' },
      { label: 'Recurring Invoices', href: '/sales/recurring', icon: Repeat, module: 'sales' },
      { label: 'Interest on Overdue', href: '/sales/overdue-interest', icon: AlertTriangle, module: 'sales' },
      { label: 'Payment Reminders', href: '/sales/reminders', icon: BellRing, module: 'sales' },
    ],
  },
  {
    label: 'Purchases',
    icon: ShoppingCart,
    module: 'purchases',
    items: [
      { label: 'Vendors', href: '/purchases/vendors', icon: Building2, module: 'purchases' },
      { label: 'Expenses', href: '/purchases/expenses', icon: CreditCard, module: 'purchases' },
      { label: 'Purchase Orders', href: '/purchases/purchase-orders', icon: ClipboardList, module: 'purchases' },
      { label: 'Goods Receipts', href: '/purchases/goods-receipts', icon: PackageCheck, module: 'purchases' },
      { label: 'Bills', href: '/purchases/bills', icon: FileText, module: 'purchases' },
      { label: 'Payments Made', href: '/purchases/payments', icon: Banknote, module: 'purchases' },
      { label: 'Payment Batches', href: '/purchases/payment-batches', icon: Landmark, module: 'purchases' },
      { label: 'Vendor Credits', href: '/purchases/vendor-credits', icon: FileMinus, module: 'purchases' },
      { label: 'MSME Payments', href: '/purchases/msme-tracker', icon: AlertTriangle, module: 'purchases', badge: 'msmeRisk' },
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
    icon: BookOpen,
    module: 'accountant',
    // Ordered as Zoho's Accountant module: journals first, then the chart,
    // then the controls that sit over them.
    items: [
      { label: 'Manual Journals', href: '/accountant/journals', icon: BookOpen, module: 'accountant' },
      { label: 'Recurring Journals', href: '/accountant/recurring-journals', icon: Repeat, module: 'accountant' },
      { label: 'Chart of Accounts', href: '/accountant/chart-of-accounts', icon: ScrollText, module: 'accountant' },
      { label: 'Opening Balances', href: '/accountant/opening-balances', icon: FileCheck2, module: 'accountant' },
      { label: 'Fixed Assets', href: '/accountant/fixed-assets', icon: Building, module: 'accountant', feature: 'fixedAssets' },
      { label: 'Budgets', href: '/accountant/budgets', icon: BarChart3, module: 'accountant' },
      { label: 'Approvals', href: '/approvals', icon: ShieldCheck, module: 'accountant', feature: 'approvals' },
      { label: 'Documents', href: '/documents', icon: FolderOpen, module: 'accountant' },
      { label: 'Risk & Anomalies', href: '/analytics/risk', icon: Radar, module: 'analytics', feature: 'analytics' },
      { label: 'Transaction Locking', href: '/accountant/transaction-locking', icon: Lock, module: 'accountant' },
      { label: 'Foreign Currency', href: '/accountant/foreign-currency', icon: Banknote, module: 'accountant', feature: 'multiCurrency' },
      { label: 'Cost Centres', href: '/accountant/cost-centres', icon: Split, module: 'accountant', feature: 'costCentres' },
      { label: 'Period Close', href: '/accountant/period-close', icon: CalendarClock, module: 'accountant' },
      { label: 'Audit Trail', href: '/accountant/audit-trail', icon: ShieldCheck, module: 'accountant' },
    ],
  },
  {
    label: 'Payroll',
    icon: HandCoins,
    module: 'payroll',
    feature: 'payroll',
    items: [
      { label: 'Payroll', href: '/payroll/runs', icon: Wallet, module: 'payroll' },
      { label: 'Employees', href: '/payroll/employees', icon: Users, module: 'payroll' },
      { label: 'Leave', href: '/payroll/leave', icon: CalendarDays, module: 'payroll' },
      { label: 'Advances & Loans', href: '/payroll/advances', icon: Banknote, module: 'payroll' },
      { label: 'Expense Claims', href: '/payroll/claims', icon: Receipt, module: 'payroll' },
      { label: 'Declarations', href: '/payroll/declarations', icon: FileCheck2, module: 'payroll' },
      { label: 'Form 16 / 130', href: '/payroll/form-16', icon: FileText, module: 'payroll' },
      { label: 'Full & Final', href: '/payroll/full-and-final', icon: HandCoins, module: 'payroll' },
    ],
  },
  {
    label: 'GST & Taxes',
    icon: ShieldCheck,
    module: 'gst',
    items: [
      { label: 'Compliance Calendar', href: '/gst/compliance-calendar', icon: CalendarDays, module: 'gst', badge: 'complianceDue' },
      { label: 'E-Invoices (IRP)', href: '/gst/einvoices', icon: FileCheck2, module: 'gst', badge: 'einvoicePending', registration: 'regular', feature: 'gst' },
      { label: 'E-Way Bills', href: '/gst/eway-bills', icon: Truck, module: 'gst', feature: ['gst', 'ewayBills'] },
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
    label: 'Inventory',
    icon: Boxes,
    module: 'inventory',
    feature: 'inventory',
    items: [
      { label: 'Stock on Hand', href: '/inventory/stock', icon: Boxes, module: 'inventory' },
      { label: 'Adjustments', href: '/inventory/adjustments', icon: ClipboardList, module: 'inventory' },
      { label: 'Transfers', href: '/inventory/transfers', icon: Truck, module: 'inventory' },
      { label: 'Production', href: '/inventory/production', icon: PackageCheck, module: 'inventory' },
      { label: 'Batches & Expiry', href: '/inventory/batches', icon: CalendarClock, module: 'inventory' },
      { label: 'Serial Numbers', href: '/inventory/serials', icon: ScanBarcode, module: 'inventory' },
      { label: 'Warehouses', href: '/inventory/warehouses', icon: Building, module: 'inventory' },
    ],
  },
];

export const TOP_LEVEL: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, module: 'sales' },
  { label: 'Exceptions', href: '/exceptions', icon: AlertOctagon, module: 'exceptions', badge: 'exceptions' },
];

export const BOTTOM_LEVEL: NavItem[] = [
  { label: 'Reports', href: '/reports', icon: BarChart3, module: 'reports' },
  { label: 'Tally', href: '/tally', icon: MonitorDown, module: 'tally', feature: 'tally' },
  { label: 'Analytics', href: '/analytics', icon: ChartColumnBig, module: 'analytics', feature: 'analytics' },
  { label: 'AI Assistant', href: '/ai', icon: Bot, module: 'ai' },
  { label: 'Settings', href: '/settings', icon: Settings, module: 'settings' },
  { label: 'Help', href: '/help', icon: LifeBuoy, module: 'help' },
];
