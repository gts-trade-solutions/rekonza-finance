import { z } from 'zod';
import type { Executor } from './db';
import { badRequest } from './http';
import type { BillTemplateLine, ExpenseTemplate } from './services/recurring';

// A recurring bill or expense profile as the form sends it, shared by New
// (POST /api/recurring-purchases) and Edit (PUT /api/recurring-purchases/[id]):
// a route file may only export its handlers.

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const id = z.union([z.string(), z.number()]);

const BillLine = z.object({
  itemId: id.nullish(),
  accountId: id.nullish(),
  description: z.string().trim().max(500).nullish(),
  qty: z.number().positive(),
  ratePaise: z.number().int().nonnegative(),
  gstRatePct: z.number().min(0).max(50).default(18),
  hsnSac: z.string().trim().max(10).nullish(),
});

export const RecurringPurchaseBody = z.object({
  kind: z.enum(['bill', 'expense']),
  name: z.string().trim().min(1, 'Give the profile a name.').max(200),
  vendorId: id.nullish(),
  frequency: z.enum(FREQUENCIES),
  startDate: DATE,
  endDate: DATE.nullish(),
  dueDays: z.number().int().min(0).max(365).default(30),
  autoRun: z.boolean().optional(),
  lines: z.array(BillLine).max(100).optional(),
  expense: z.object({
    accountId: id,
    paidThroughBankAccountId: id,
    amountPaise: z.number().int().positive('Enter an amount above zero.'),
    gstRatePct: z.number().min(0).max(50).default(0),
    itcEligibility: z.enum(['eligible', 'ineligible', 'capital_goods']).default('eligible'),
    notes: z.string().trim().max(500).nullish(),
  }).optional(),
});
export type RecurringPurchaseBodyInput = z.infer<typeof RecurringPurchaseBody>;

/** Checked against the book: what the profile row holds for this input. */
export async function recurringPurchaseValues(ex: Executor, orgId: number, input: RecurringPurchaseBodyInput) {
  const vendorId = input.vendorId ? Number(input.vendorId) : null;
  if (vendorId) {
    const v = await ex.selectFrom('contacts').select('id').where('id', '=', vendorId).where('org_id', '=', orgId).executeTakeFirst();
    if (!v) throw badRequest('That vendor does not exist.');
  }
  if (input.endDate && input.endDate < input.startDate) throw badRequest('The profile cannot end before it starts.');

  let template: BillTemplateLine[] | ExpenseTemplate;
  let paidThrough: number | null = null;
  if (input.kind === 'bill') {
    if (!vendorId) throw badRequest('A recurring bill needs the vendor it comes from.');
    if (!input.lines?.length) throw badRequest('A recurring bill needs at least one line.');
    if (input.lines.some((l) => !l.itemId && !l.accountId)) throw badRequest('Each line needs an item, or the account it is booked to.');
    template = input.lines.map((l) => ({
      itemId: l.itemId ? Number(l.itemId) : null, accountId: l.accountId ? Number(l.accountId) : null,
      description: l.description ?? null, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, hsnSac: l.hsnSac ?? null,
    }));
  } else {
    if (!input.expense) throw badRequest('Say what the expense is booked to, what it is paid from and how much.');
    const e = input.expense;
    const [acc, bank] = await Promise.all([
      ex.selectFrom('accounts').select(['id', 'type']).where('id', '=', Number(e.accountId)).where('org_id', '=', orgId).executeTakeFirst(),
      ex.selectFrom('bank_accounts').select('id').where('id', '=', Number(e.paidThroughBankAccountId)).where('org_id', '=', orgId).executeTakeFirst(),
    ]);
    if (!acc || acc.type !== 'expense') throw badRequest('Book a recurring expense to an expense account.');
    if (!bank) throw badRequest('That account to pay from does not exist.');
    paidThrough = bank.id;
    template = { accountId: acc.id, amountPaise: e.amountPaise, gstRatePct: e.gstRatePct, itcEligibility: e.itcEligibility, notes: e.notes ?? null };
  }
  return {
    profile_name: input.name, vendor_id: vendorId, frequency: input.frequency, start_date: input.startDate,
    end_date: input.endDate ?? null, due_days: input.dueDays, paid_through_bank_account_id: paidThrough,
    template: JSON.stringify(template), auto_run: input.autoRun ? 1 : 0,
  };
}
