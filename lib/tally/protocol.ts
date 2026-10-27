// ─────────────────────────────────────────────────────────────────────────────
// What the Tally connector sends, and what it gets back.
//
// The connector runs beside TallyPrime on the customer's PC, reads the company
// over Tally's local port, and pushes it here. Every message is one of five
// kinds, posted to /api/tally/sync with the connector's token:
//
//   hello           which companies are open in Tally; answered with where
//                   each one's sync should resume
//   masters         groups, ledgers and stock items, with Tally's own closing
//                   balances as at a date
//   vouchers        vouchers changed since the last AlterID, each with its
//                   ledger entries
//   voucher-index   every voucher GUID Tally holds in a date window, so ones
//                   deleted in Tally are deleted here too
//   status          a heartbeat, or an error the connector hit
//
// The connector does the converting: Tally's decimal rupees become integer
// paise, and its signed amounts become a debit or a credit. This side only
// checks and stores, so a figure here is never a second calculation of one
// Tally already made.
//
// Framework-neutral on purpose: the connector imports this file too.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Bump when a message changes shape. The server refuses a connector it cannot read. */
export const TALLY_PROTOCOL_VERSION = 1;

export const MAX_VOUCHERS_PER_MESSAGE = 1000;
export const MAX_ENTRIES_PER_VOUCHER = 500;
export const MAX_MASTERS_PER_MESSAGE = 20_000;
export const MAX_INDEX_GUIDS = 20_000;

const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'Use YYYY-MM-DD.');
const Name = z.string().trim().min(1).max(200);
const Guid = z.string().trim().min(1).max(100);
/** Integer paise. Tally's amounts reach two decimals, so this is exact. */
const Paise = z.number().int().refine(Number.isSafeInteger, 'Out of range.');
const NonNegPaise = Paise.refine((n) => n >= 0, 'Must not be negative.');
const Qty = z.number().finite();

export const NATURES = ['assets', 'liabilities', 'income', 'expenses'] as const;
export type TallyNature = (typeof NATURES)[number];

/**
 * The accounting voucher types Tally ships with. A company's own types
 * ("GST Sales", "Cash Receipt") are sent with the one they are based on.
 */
export const ACCOUNTING_BASE_TYPES = [
  'Sales', 'Purchase', 'Receipt', 'Payment', 'Contra', 'Journal', 'Credit Note', 'Debit Note',
] as const;

// ── Messages ─────────────────────────────────────────────────────────────────

export const HelloMessage = z.object({
  kind: z.literal('hello'),
  protocol: z.literal(TALLY_PROTOCOL_VERSION),
  machineName: z.string().trim().min(1).max(100),
  connectorVersion: z.string().trim().min(1).max(30),
  tallyVersion: z.string().trim().max(80).nullish(),
  companies: z
    .array(
      z.object({
        guid: Guid,
        name: Name,
        booksFrom: Day.nullish(),
        fyFrom: Day.nullish(),
        gstin: z.string().trim().max(15).nullish(),
        stateName: z.string().trim().max(60).nullish(),
        maintainsInventory: z.boolean().default(false),
      }),
    )
    .max(200),
});

export const TallyGroup = z.object({
  name: Name,
  /** Null for a primary group. */
  parent: Name.nullish(),
  nature: z.enum(NATURES),
  affectsGrossProfit: z.boolean().default(false),
  guid: Guid.nullish(),
});

export const TallyLedger = z.object({
  name: Name,
  parent: Name,
  /**
   * Signed: positive is a debit. As at the company's `fyFrom`, the way Tally
   * reports a ledger for the year — zero for an income or expense ledger,
   * brought forward for everything else.
   */
  openingPaise: Paise,
  /** Signed, as Tally computed it on the message's `asOf`. */
  closingPaise: Paise,
  gstin: z.string().trim().max(15).nullish(),
  stateName: z.string().trim().max(60).nullish(),
  guid: Guid.nullish(),
});

export const TallyStockItem = z.object({
  name: Name,
  parent: Name.nullish(),
  unit: z.string().trim().max(30).nullish(),
  hsn: z.string().trim().max(12).nullish(),
  /** As at the company's `fyFrom`, like a ledger's opening. */
  openingQty: Qty,
  openingValuePaise: Paise,
  closingQty: Qty,
  closingValuePaise: Paise,
  guid: Guid.nullish(),
});

export const MastersMessage = z.object({
  kind: z.literal('masters'),
  companyGuid: Guid,
  /** The date the closing balances are as at — normally the day of the sync. */
  asOf: Day,
  masterAlterId: z.number().int().min(0),
  /**
   * Everything Tally holds, not only what changed. Masters here that are not
   * in a full message were deleted in Tally, and are deleted here too.
   */
  full: z.boolean(),
  groups: z.array(TallyGroup).max(MAX_MASTERS_PER_MESSAGE),
  ledgers: z.array(TallyLedger).max(MAX_MASTERS_PER_MESSAGE),
  stockItems: z.array(TallyStockItem).max(MAX_MASTERS_PER_MESSAGE),
});

export const TallyVoucher = z.object({
  guid: Guid,
  alterId: z.number().int().min(0),
  voucherType: z.string().trim().min(1).max(100),
  baseType: z.string().trim().min(1).max(40),
  number: z.string().trim().max(100).nullish(),
  date: Day,
  party: Name.nullish(),
  narration: z.string().max(1000).nullish(),
  reference: z.string().trim().max(100).nullish(),
  isCancelled: z.boolean().default(false),
  isOptional: z.boolean().default(false),
  entries: z
    .array(
      z.object({
        ledger: Name,
        debitPaise: NonNegPaise,
        creditPaise: NonNegPaise,
      }),
    )
    .max(MAX_ENTRIES_PER_VOUCHER),
});

export const VouchersMessage = z.object({
  kind: z.literal('vouchers'),
  companyGuid: Guid,
  vouchers: z.array(TallyVoucher).max(MAX_VOUCHERS_PER_MESSAGE),
});

export const VoucherIndexMessage = z.object({
  kind: z.literal('voucher-index'),
  companyGuid: Guid,
  from: Day,
  to: Day,
  guids: z.array(Guid).max(MAX_INDEX_GUIDS),
});

export const StatusMessage = z.object({
  kind: z.literal('status'),
  companyGuid: Guid.nullish(),
  /** Null clears an error reported earlier. */
  error: z.string().max(500).nullable(),
});

export const SyncMessage = z.discriminatedUnion('kind', [
  HelloMessage,
  MastersMessage,
  VouchersMessage,
  VoucherIndexMessage,
  StatusMessage,
]);

export type SyncMessage = z.infer<typeof SyncMessage>;
export type HelloMessage = z.infer<typeof HelloMessage>;
export type MastersMessage = z.infer<typeof MastersMessage>;
export type VouchersMessage = z.infer<typeof VouchersMessage>;
export type VoucherIndexMessage = z.infer<typeof VoucherIndexMessage>;
export type TallyVoucher = z.infer<typeof TallyVoucher>;

// ── Replies ──────────────────────────────────────────────────────────────────

export interface HelloReply {
  kind: 'hello';
  organisation: string;
  companies: { guid: string; companyId: string; voucherAlterId: number; masterAlterId: number }[];
}

export interface VouchersReply {
  kind: 'vouchers';
  stored: number;
  /** Refused one by one, so one bad voucher does not hold back the rest. */
  rejected: { guid: string; reason: string }[];
  voucherAlterId: number;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export const PairRequest = z.object({
  code: z.string().trim().min(8).max(20),
  machineName: z.string().trim().min(1).max(100),
  connectorVersion: z.string().trim().min(1).max(30),
});

export interface PairReply {
  token: string;
  organisation: string;
  connectorId: string;
}
