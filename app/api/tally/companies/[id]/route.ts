import { z } from 'zod';
import { db } from '@/lib/server/db';
import { badRequest, idParam, query, route } from '@/lib/server/http';
import {
  balanceSheet, companyFor, dayBook, ledgerList, ledgerVouchers, profitAndLoss, stockSummary, trialBalance,
} from '@/lib/server/tally/reports';

// One Tally company's books, one view at a time.

const Day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const Q = z.object({
  view: z.enum(['day-book', 'ledgers', 'ledger', 'trial-balance', 'profit-loss', 'balance-sheet', 'stock']),
  from: Day.optional(),
  to: Day.optional(),
  ledgerId: z.string().regex(/^[0-9]+$/).optional(),
});

export const GET = route(
  async ({ orgId, params, req }) => {
    const q = query(req, Q);
    const company = await companyFor(db, orgId, idParam(params));
    const range = () => {
      if (!q.from || !q.to) throw badRequest('Pass from and to as YYYY-MM-DD.');
      if (q.from > q.to) throw badRequest('The period starts after it ends.');
      return { from: q.from, to: q.to };
    };

    switch (q.view) {
      case 'day-book': {
        const r = range();
        return dayBook(db, company, r.from, r.to);
      }
      case 'ledgers':
        return ledgerList(db, company);
      case 'ledger': {
        const r = range();
        if (!q.ledgerId) throw badRequest('Which ledger? Pass ledgerId.');
        return ledgerVouchers(db, company, Number(q.ledgerId), r.from, r.to);
      }
      case 'trial-balance':
        return trialBalance(db, company);
      case 'profit-loss':
        return profitAndLoss(db, company);
      case 'balance-sheet':
        return balanceSheet(db, company);
      case 'stock':
        return stockSummary(db, company);
    }
  },
  { permission: { module: 'tally', action: 'view' } },
);
