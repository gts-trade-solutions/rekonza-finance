// ─────────────────────────────────────────────────────────────────────────────
// Domain types — the single source of truth for the whole app.
// Money values are ALWAYS integer paise (see lib/money.ts). Never floats.
// Dates that matter to the books are ISO `YYYY-MM-DD` strings (fiscal dates).
// System timestamps are ISO datetime strings (UTC).
// ─────────────────────────────────────────────────────────────────────────────

export type Paise = number; // integer paise; 100 paise = ₹1

// ── Org & identity ───────────────────────────────────────────────────────────

export type RoleName = 'admin' | 'accountant' | 'sales' | 'staff' | 'viewer';

export interface Permission {
  module: string; // 'sales.invoices', 'banking.reconcile', …
  actions: Array<'view' | 'create' | 'edit' | 'approve' | 'void'>;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  avatarColor: string;
  /** Home branch. Documents this user raises default to it. */
  branchId: string;
  /** Branches this user may raise documents for; defaults to [branchId]. */
  branchAccess?: string[];
}

export interface Branch {
  id: string;
  name: string;
  gstin: string;
  stateCode: string; // '33' TN, '29' KA …
  address: string;
  // Both are mandatory in the e-invoice and e-way bill schemas, on every
  // document, and as their own fields — the portals will not dig them out of
  // an address line.
  city: string;
  pincode: string;
  isPrimary: boolean;
}

export interface Org {
  id: string;
  name: string;
  pan: string;
  gstRegistrationType: 'regular' | 'composition' | 'unregistered';
  aatoAbove5Cr: boolean; // drives e-invoicing mandate
  fiscalYearLabel: string; // 'FY 2026-27'
  fiscalYearStart: string; // '2026-04-01'
  fiscalYearEnd: string; // '2027-03-31'
  baseCurrency: 'INR';
  address: string;
  email: string;
  phone: string;
}

// ── Chart of accounts & ledger ───────────────────────────────────────────────

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isSystem: boolean; // non-deletable (AR, AP, GST ledgers, …)
  isArchived: boolean;
  description?: string;
}

export type SourceType =
  | 'invoice'
  | 'payment_received'
  | 'credit_note'
  | 'retainer'
  | 'bill'
  | 'expense'
  | 'payment_made'
  | 'vendor_credit'
  | 'manual'
  | 'transfer'
  | 'opening'
  | 'stock_adjustment';

export interface JournalLine {
  accountId: string;
  debit: Paise; // exactly one of debit/credit is non-zero
  credit: Paise;
  contactId?: string;
  branchId?: string;
  dimensionValueId?: string;
  description?: string;
}

export interface JournalEntry {
  id: string;
  entryNo: number; // sequential per org
  date: string; // fiscal date
  sourceType: SourceType;
  sourceId: string | null;
  memo: string;
  lines: JournalLine[];
  isReversalOf?: string; // entry id this reverses
  createdAt: string;
  createdBy: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  userId: string;
  userName: string;
  entity: string; // 'invoice', 'bill', …
  entityId: string;
  entityLabel: string; // 'INV/2026-27/0042'
  action: 'create' | 'update' | 'void' | 'approve' | 'send' | 'match' | 'login';
  detail: string; // human-readable summary of the change
}

// ── Contacts & items ─────────────────────────────────────────────────────────

export type GstTreatment =
  | 'registered' // regular B2B
  | 'registered_composition'
  | 'unregistered' // B2C
  | 'consumer'
  | 'overseas'
  | 'sez';

export interface ContactAddress {
  label: string;
  line1: string;
  city: string;
  stateCode: string; // GST state code; '96' = foreign
  pincode: string;
}

export interface Contact {
  id: string;
  kind: 'customer' | 'vendor' | 'both';
  displayName: string;
  companyName: string;
  gstin: string | null;
  gstTreatment: GstTreatment;
  pan: string | null;
  stateCode: string;
  /** The currency they are invoiced or billed in. */
  currency?: string;
  email: string;
  phone: string;
  billingAddress: ContactAddress;
  shippingAddress?: ContactAddress;
  paymentTermsDays: number;
  creditLimit: Paise | null; // customers
  isMsme: boolean; // vendors — drives 43B(h) 45-day tracker
  /** Off: payments settle the oldest open documents first, with no bills named. */
  billWise?: boolean;
  udyamNo?: string;
  tdsSection?: string; // vendors — default TDS section, e.g. '194C'
  customerDeductsTds?: boolean; // customers who deduct TDS on our invoices
  openingBalance: Paise; // +ve: they owe us / we owe them per kind
  portalEnabled?: boolean;
  isArchived: boolean;
}

export type TaxPref = 'taxable' | 'exempt' | 'nil' | 'non_gst';

export interface Item {
  id: string;
  kind: 'goods' | 'service';
  name: string;
  sku: string;
  hsnSac: string;
  uqc: string; // NOS, KGS, MTR …
  salePricePaise: Paise;
  purchasePricePaise: Paise;
  gstRatePct: number; // 0 | 5 | 12 | 18 | 28
  taxPref: TaxPref;
  saleAccountId: string;
  purchaseAccountId: string;
  description?: string;
  isArchived: boolean;
  // Inventory (Wave 7) —
  trackInventory?: boolean;
  /** Bought and sold by batch, with expiry dates. */
  trackBatches?: boolean;
  /** Each piece carries its own serial number. */
  trackSerials?: boolean;
  /** A second unit it is counted in: 1 altUqc = altFactor of uqc. */
  altUqc?: string;
  altFactor?: number;
  mrpPaise?: Paise;
  openingStockQty?: number;
  reorderLevel?: number;
}

// ── Documents (sales & purchase) ─────────────────────────────────────────────

export interface DocTaxBreakup {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

export interface DocLine {
  id: string;
  itemId: string | null;
  description: string;
  hsnSac: string;
  qty: number;
  uqc: string;
  ratePaise: Paise; // per-unit
  discountPct: number;
  gstRatePct: number;
  tax: DocTaxBreakup; // computed & FROZEN at save time — never recomputed
  totalPaise: Paise; // taxable + taxes for the line
  itcEligibility?: 'eligible' | 'ineligible' | 'capital_goods'; // bills only
}

export type SupplyType =
  | 'intra' // CGST + SGST
  | 'inter' // IGST
  | 'export_lut'
  | 'export_with_tax'
  | 'sez'
  | 'nil_or_exempt';

export type InvoiceStatus =
  | 'draft'
  | 'approved'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'overdue' // derived at render, but stored for demo filters
  | 'void'
  | 'written_off';

export interface EInvoiceInfo {
  status: 'not_applicable' | 'pending' | 'submitted' | 'failed' | 'cancelled';
  irn?: string;
  ackNo?: string;
  ackDate?: string;
  qrPayload?: string;
  deadline?: string; // 30-day IRP window end
  error?: string;
}

export interface Invoice {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  dueDate: string;
  placeOfSupply: string; // state code
  supplyType: SupplyType;
  /** Goods, services, or a mixed invoice. Restricts the HSN/SAC codes offered. */
  supplyKind: SupplyKind;
  status: InvoiceStatus;
  lines: DocLine[];
  subtotalPaise: Paise; // Σ line taxable before doc discount
  docDiscountPaise: Paise;
  tax: DocTaxBreakup;
  tcsPaise: Paise;
  roundOffPaise: Paise; // signed
  totalPaise: Paise;
  amountPaidPaise: Paise;
  notes?: string;
  terms?: string;
  salespersonId?: string;
  // ── Zoho-parity header fields
  orderNumber?: string;
  subject?: string;
  paymentTerms?: string; // preset key, e.g. 'net_30'
  shippingChargePaise: Paise;
  adjustmentPaise: Paise; // signed; free-text label below
  adjustmentLabel?: string;
  attachmentCount?: number;
  einvoice: EInvoiceInfo;
  ewayBillNo?: string;
  sourceDocId?: string; // estimate/SO it came from
  journalEntryId?: string;
  createdAt: string;
}

export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';

export interface Estimate {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  expiryDate: string;
  status: EstimateStatus;
  lines: DocLine[];
  totalPaise: Paise;
  tax: DocTaxBreakup;
  notes?: string;
  convertedToId?: string;
}

export type SalesOrderStatus = 'open' | 'partially_invoiced' | 'invoiced' | 'closed' | 'cancelled';

export interface SalesOrder {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  expectedShipDate?: string;
  status: SalesOrderStatus;
  lines: DocLine[];
  totalPaise: Paise;
  tax: DocTaxBreakup;
  invoicedPaise: Paise;
  sourceEstimateId?: string;
}

export interface DeliveryChallan {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  challanType: 'job_work' | 'supply_on_approval' | 'own_use';
  status: 'open' | 'invoiced' | 'returned';
  lines: DocLine[];
  totalPaise: Paise;
}

export interface CreditNote {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  reason: string; // GST reason code label
  againstInvoiceId: string | null;
  status: 'open' | 'applied' | 'refunded' | 'void';
  lines: DocLine[];
  tax: DocTaxBreakup;
  totalPaise: Paise;
  appliedPaise: Paise;
  journalEntryId?: string;
}

export interface RetainerInvoice {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  date: string;
  status: 'draft' | 'sent' | 'paid' | 'partially_applied' | 'applied' | 'void';
  description: string;
  amountPaise: Paise; // collected as liability (Unearned Revenue)
  appliedPaise: Paise;
  journalEntryId?: string;
}

export type BillStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'overdue' | 'void';

export interface Bill {
  id: string;
  number: string; // vendor's invoice number
  internalNo: string; // our series BILL/…
  branchId: string;
  vendorId: string;
  date: string;
  dueDate: string;
  status: BillStatus;
  isRcm: boolean; // reverse charge — we self-account the GST
  lines: DocLine[];
  subtotalPaise: Paise;
  tax: DocTaxBreakup;
  tdsSection?: string;
  tdsPaise: Paise; // withheld from vendor, owed to govt
  totalPaise: Paise; // payable to vendor (after TDS)
  amountPaidPaise: Paise;
  journalEntryId?: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  number: string;
  branchId: string;
  date: string;
  accountId: string; // expense account
  vendorId: string | null;
  paidThroughId: string; // bank/cash/card account id
  amountPaise: Paise;
  gstRatePct: number;
  tax: DocTaxBreakup;
  isBillable: boolean;
  customerId?: string; // when billable
  billedOnInvoiceId?: string;
  notes: string;
  receiptAttached: boolean;
  status: 'recorded' | 'void';
  journalEntryId?: string;
}

export type POStatus = 'draft' | 'issued' | 'partially_billed' | 'billed' | 'closed' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  number: string;
  branchId: string;
  vendorId: string;
  date: string;
  expectedDate?: string;
  status: POStatus;
  lines: DocLine[];
  totalPaise: Paise;
  billedPaise: Paise;
}

export interface VendorCredit {
  id: string;
  number: string;
  branchId: string;
  vendorId: string;
  date: string;
  reason: string;
  againstBillId: string | null;
  status: 'open' | 'applied' | 'refunded' | 'void';
  totalPaise: Paise;
  appliedPaise: Paise;
  journalEntryId?: string;
}

// ── Payments ─────────────────────────────────────────────────────────────────

export type PaymentMode = 'cash' | 'cheque' | 'upi' | 'neft' | 'imps' | 'card' | 'gateway';

export interface PaymentAllocation {
  targetType: 'invoice' | 'bill' | 'credit_note' | 'vendor_credit' | 'retainer';
  targetId: string;
  amountPaise: Paise;
}

export interface Payment {
  id: string;
  number: string;
  kind: 'received' | 'made';
  contactId: string;
  date: string;
  mode: PaymentMode;
  amountPaise: Paise; // gross paid/received
  bankAccountId: string;
  reference: string;
  tdsPaise: Paise; // received: TDS the customer deducted; made: TDS we withheld
  bankChargesPaise: Paise;
  allocations: PaymentAllocation[];
  unappliedPaise: Paise; // advance / on-account remainder
  status: 'cleared' | 'void';
  journalEntryId?: string;
  createdAt: string;
}

// ── Banking ──────────────────────────────────────────────────────────────────

export interface BankAccount {
  id: string;
  /** Bank/branch name shown under the account name, as Zoho does. */
  bankName?: string;
  accountNumber?: string;
  isPrimary?: boolean;
  currency?: 'INR';
  isArchived?: boolean;
  kind: 'bank' | 'card' | 'cash' | 'wallet' | 'clearing';
  name: string;
  accountLast4?: string;
  ifsc?: string;
  ledgerAccountId: string; // linked CoA account
  openingBalancePaise: Paise;
  feedConnected: boolean; // simulated AA feed
}

export type BankTxnStatus = 'unmatched' | 'matched' | 'excluded';

export interface BankTxn {
  id: string;
  bankAccountId: string;
  date: string;
  amountPaise: Paise;
  direction: 'in' | 'out';
  narration: string;
  reference: string;
  status: BankTxnStatus;
  matchedTo?: { type: 'payment' | 'expense' | 'transfer' | 'journal'; id: string; label: string };
  importBatch: string;
}

export interface BankRuleCondition {
  field: 'narration' | 'amount' | 'direction';
  op: 'contains' | 'equals' | 'gt' | 'lt';
  value: string;
}

export interface BankRule {
  id: string;
  name: string;
  priority: number;
  conditions: BankRuleCondition[];
  actionAccountId: string; // categorize to this account
  contactId?: string;
  autoConfirm: boolean;
  isActive: boolean;
}

export interface Cheque {
  id: string;
  kind: 'issued' | 'received';
  contactId: string;
  chequeNo: string;
  bankName: string;
  amountPaise: Paise;
  isPdc: boolean;
  maturityDate: string;
  status: 'in_hand' | 'deposited' | 'cleared' | 'bounced';
}

// ── Compliance ───────────────────────────────────────────────────────────────

export interface TdsSection {
  code: string; // '194C'
  description: string;
  ratePctWithPan: number;
  ratePctWithoutPan: number;
  thresholdSinglePaise: Paise;
  thresholdAnnualPaise: Paise;
}

export interface Gstr2bEntry {
  id: string;
  vendorGstin: string;
  vendorName: string;
  invoiceNo: string;
  invoiceDate: string;
  taxablePaise: Paise;
  taxPaise: Paise;
  matchStatus: 'matched' | 'mismatch' | 'missing_in_books' | 'missing_in_2b';
  matchedBillId?: string;
  note?: string;
}

export interface EwayBill {
  id: string;
  invoiceId: string;
  ewbNo: string;
  vehicleNo: string;
  transporterId?: string;
  distanceKm: number;
  generatedAt: string;
  validUntil: string;
  status: 'active' | 'expired' | 'cancelled';
}

// ── Inventory (Wave 7) ───────────────────────────────────────────────────────

export interface Warehouse {
  id: string;
  name: string;
  branchId: string;
}

export interface StockMove {
  id: string;
  date: string;
  itemId: string;
  warehouseId: string;
  qty: number; // signed
  ratePaise: Paise; // unit cost for WAC
  sourceType: 'opening' | 'purchase' | 'sale' | 'adjustment' | 'transfer';
  sourceId: string | null;
  note?: string;
}

// ── Settings / platform mocks ────────────────────────────────────────────────

export interface NumberSeriesState {
  [key: string]: number; // `${branchId}:${docType}` → next number
}

export interface WorkflowRule {
  id: string;
  name: string;
  module: string;
  trigger: string;
  conditionSummary: string;
  actionSummary: string;
  isActive: boolean;
}

export interface ApprovalRule {
  id: string;
  module: string;
  thresholdPaise: Paise;
  approverRole: RoleName;
  isActive: boolean;
}

export interface CustomFieldDef {
  id: string;
  entity: string;
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'dropdown' | 'checkbox';
  options?: string[];
  showOnPdf: boolean;
}

export interface ApiToken {
  id: string;
  name: string;
  tokenPreview: string; // 'fna_live_…4f2a'
  scopes: string[];
  createdAt: string;
  lastUsed?: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  lastDelivery?: { at: string; status: number };
}

// ── HSN / SAC master ─────────────────────────────────────────────────────────
// GST law requires a valid HSN (goods) or SAC (services) code on every taxable
// line, and GSTR-1 has a dedicated HSN summary table that the portal validates.
// Free-typed codes are the single biggest cause of GSTR-1 rejection, so the
// organisation curates its own short list here and invoices may only pick from
// it. There is no "custom code" escape hatch by design.
export interface HsnCode {
  id: string;
  /** 4, 6 or 8 digits for HSN; 6 digits beginning 99 for SAC. */
  code: string;
  kind: 'hsn' | 'sac';
  description: string;
  /** Default GST rate applied when a line picks this code with no item. */
  gstRatePct: number;
  /** Compensation cess on these goods; 0 when none applies. */
  cessRatePct?: number;
  /** Rates by the date they took effect. When present, they decide a line's rate. */
  rates?: { effectiveFrom: string; gstRatePct: number; cessRatePct: number }[];
  uqc?: string;
  isActive: boolean;
}

/** What an invoice is being raised for. Drives which codes and items are offered. */
export type SupplyKind = 'goods' | 'service' | 'both';
