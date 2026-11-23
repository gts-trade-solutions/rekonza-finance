import { z } from 'zod';
import { asId } from './http';
import type { BankAccountFigures } from './services/bank-overview';
import { BANK_CURRENCIES } from './services/bank-accounts';

// A bank account as the banking routes send it, and Zoho's Add/Edit form as
// they take it (app/api/banking/accounts and accounts/[id]).

export function accountJson(a: BankAccountFigures) {
  return {
    id: asId(a.id),
    kind: a.kind,
    name: a.name,
    code: a.code,
    currency: a.currency,
    accountNumber: a.accountNumber,
    accountLast4: a.accountLast4,
    bankName: a.bankName,
    ifsc: a.ifsc,
    description: a.description,
    userIds: a.userIds?.map(String) ?? [],
    ledgerAccountId: asId(a.ledgerAccountId),
    isPrimary: a.isPrimary,
    isActive: a.isActive,
    // Automatic feeds need a licensed aggregator; always false for now.
    feedConnected: false,
    balancePaise: a.amountInBooksPaise,
    amountInBankPaise: a.amountInBankPaise,
    amountInBankOn: a.amountInBankOn,
    unmatchedCount: a.uncategorized,
  };
}

export const AccountInput = z.object({
  kind: z.enum(['bank', 'card', 'cash', 'wallet']),
  name: z.string().max(150),
  accountCode: z.string().max(30).nullish(),
  currency: z.enum(BANK_CURRENCIES).nullish(),
  accountNumber: z.string().max(40).nullish(),
  /** Older callers send only the last four digits. */
  accountLast4: z.string().max(4).nullish(),
  bankName: z.string().max(150).nullish(),
  ifsc: z.string().max(15).nullish(),
  description: z.string().max(500).nullish(),
  userIds: z.array(z.union([z.string(), z.number()])).max(200).nullish(),
  isPrimary: z.boolean().optional(),
  openingBalancePaise: z.number().int().optional(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

