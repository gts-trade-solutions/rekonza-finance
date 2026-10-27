// ─────────────────────────────────────────────────────────────────────────────
// Single Zustand store, persisted to localStorage. Holds ALL app data (this is
// the demo's "database"). Business logic lives in lib/services/* — components
// never mutate collections directly, they call services. Services are written
// so their signatures match the future real API; swapping the mock for HTTP
// later means changing service internals only.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Account, ApiToken, ApprovalRule, AuditEvent, BankAccount, BankRule, BankTxn,
  Bill, Branch, Cheque, Contact, CreditNote, CustomFieldDef, DeliveryChallan,
  Estimate, EwayBill, Expense, Gstr2bEntry, HsnCode, Invoice, Item, JournalEntry,
  NumberSeriesState, Org, Payment, PurchaseOrder, RetainerInvoice, RoleName,
  SalesOrder, StockMove, User, VendorCredit, Warehouse, WorkflowRule,
} from '../types';

export interface Session {
  userId: string;
  role: RoleName;
}

export interface AppState {
  seeded: boolean;
  session: Session | null;

  org: Org | null;
  branches: Branch[];
  users: User[];
  activeBranchId: string;

  accounts: Account[];
  contacts: Contact[];
  items: Item[];
  hsnCodes: HsnCode[];

  invoices: Invoice[];
  estimates: Estimate[];
  salesOrders: SalesOrder[];
  challans: DeliveryChallan[];
  creditNotes: CreditNote[];
  retainers: RetainerInvoice[];

  bills: Bill[];
  expenses: Expense[];
  purchaseOrders: PurchaseOrder[];
  vendorCredits: VendorCredit[];

  payments: Payment[];

  bankAccounts: BankAccount[];
  bankTxns: BankTxn[];
  bankRules: BankRule[];
  cheques: Cheque[];

  entries: JournalEntry[];
  nextEntryNo: number;
  series: NumberSeriesState;
  /**
   * The next document numbers, peeked from the database sequences.
   *
   * Held here so a form can show what it will actually be assigned. Peeked,
   * never allocated — showing a number must not consume one, or every
   * abandoned draft leaves a gap in a series GST requires to be unbroken.
   */
  nextNumbers: { invoice: string | null; bill: string | null };
  /** The company's standard terms and notes for a new invoice, if it has set them. */
  invoiceDefaults: { terms: string | null; notes: string | null };
  audit: AuditEvent[];

  gstr2b: Gstr2bEntry[];
  ewayBills: EwayBill[];

  warehouses: Warehouse[];
  stockMoves: StockMove[];

  workflows: WorkflowRule[];
  approvals: ApprovalRule[];
  customFields: CustomFieldDef[];
  apiTokens: ApiToken[];
  webhooks: { id: string; url: string; events: string[]; isActive: boolean }[];

  // ── session actions (the only logic that lives in the store itself)
  login: (userId: string, role: RoleName) => void;
  logout: () => void;
  setActiveBranch: (branchId: string) => void;
}

export const EMPTY_COLLECTIONS = {
  seeded: false,
  session: null,
  org: null,
  branches: [] as Branch[],
  users: [] as User[],
  activeBranchId: '',
  accounts: [] as Account[],
  contacts: [] as Contact[],
  items: [] as Item[],
  hsnCodes: [] as HsnCode[],
  invoices: [] as Invoice[],
  estimates: [] as Estimate[],
  salesOrders: [] as SalesOrder[],
  challans: [] as DeliveryChallan[],
  creditNotes: [] as CreditNote[],
  retainers: [] as RetainerInvoice[],
  bills: [] as Bill[],
  expenses: [] as Expense[],
  purchaseOrders: [] as PurchaseOrder[],
  vendorCredits: [] as VendorCredit[],
  payments: [] as Payment[],
  bankAccounts: [] as BankAccount[],
  bankTxns: [] as BankTxn[],
  bankRules: [] as BankRule[],
  cheques: [] as Cheque[],
  entries: [] as JournalEntry[],
  nextEntryNo: 1,
  series: {} as NumberSeriesState,
  nextNumbers: { invoice: null, bill: null } as { invoice: string | null; bill: string | null },
  invoiceDefaults: { terms: null, notes: null } as { terms: string | null; notes: string | null },
  audit: [] as AuditEvent[],
  gstr2b: [] as Gstr2bEntry[],
  ewayBills: [] as EwayBill[],
  warehouses: [] as Warehouse[],
  stockMoves: [] as StockMove[],
  workflows: [] as WorkflowRule[],
  approvals: [] as ApprovalRule[],
  customFields: [] as CustomFieldDef[],
  apiTokens: [] as ApiToken[],
  webhooks: [] as { id: string; url: string; events: string[]; isActive: boolean }[],
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...EMPTY_COLLECTIONS,
      login: (userId, role) =>
        set((s) => {
          // A user works within their branch, so signing in adopts it.
          const home = s.users.find((u) => u.id === userId)?.branchId;
          return {
            session: { userId, role },
            activeBranchId: home ?? s.activeBranchId,
          };
        }),
      logout: () => set({ session: null }),
      setActiveBranch: (branchId) => set({ activeBranchId: branchId }),
    }),
    {
      name: 'finance-app-demo-v1',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Convenience typed getters used by services. */
export const getState = () => useAppStore.getState();
export const setState = useAppStore.setState;
