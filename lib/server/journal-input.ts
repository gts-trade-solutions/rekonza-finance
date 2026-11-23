// A manual journal as the post and edit routes take it (POST /api/journal,
// PUT /api/journal/[id]): one schema, one mapping.

import { z } from 'zod';
import type { ManualJournalInput } from './services/journals';

export const JournalInput = z.object({
  /** Defaults to the branch the request is acting in. */
  branchId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  memo: z.string().min(1, 'Say what this entry is for.'),
  lines: z
    .array(
      z.object({
        accountId: z.string(),
        debitPaise: z.number().int().nonnegative().optional(),
        creditPaise: z.number().int().nonnegative().optional(),
        description: z.string().nullish(),
        contactId: z.string().nullish(),
        /** The cost centre of an income or expense line. */
        costCentreId: z.string().nullish(),
        // Against Ref: which of the party's documents this line settles.
        against: z.array(z.object({
          targetType: z.enum(['invoice', 'bill', 'opening']),
          targetId: z.string(),
          amountPaise: z.number().int().positive(),
        })).optional(),
      }),
    )
    .min(2, 'A journal entry needs at least two lines.'),
  /** Reverse the whole entry automatically on this date. */
  reverseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** Post now, keep as an optional voucher, or let the scheduler post it on its date. */
  mode: z.enum(['post', 'optional', 'post_dated']).default('post'),
});

export type JournalBody = z.infer<typeof JournalInput>;

export function toJournalInput(input: JournalBody, branchId: number): ManualJournalInput {
  return {
    branchId: input.branchId ? Number(input.branchId) : branchId,
    date: input.date,
    memo: input.memo,
    reverseOn: input.reverseOn ?? null,
    lines: input.lines.map((l) => ({
      accountId: Number(l.accountId),
      debitPaise: l.debitPaise ?? 0,
      creditPaise: l.creditPaise ?? 0,
      description: l.description,
      contactId: l.contactId ? Number(l.contactId) : null,
      costCentreId: l.costCentreId ? Number(l.costCentreId) : null,
      against: l.against?.map((a) => ({ ...a, targetId: Number(a.targetId) })),
    })),
  };
}
