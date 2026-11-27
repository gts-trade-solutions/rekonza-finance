import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { reversalRegister } from '@/lib/server/services/voucher-reversals';

// The Reversed vouchers register: every reversal pair in the books in the
// period — journals and documents (invoices, bills, payments, transfers) —
// with its reason and who asked for it and approved it, and the reversals
// still to come: waiting for approval, or due on a later date
// (services/voucher-reversals.ts).

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: DATE.optional(), to: DATE.optional() }));
    return { pairs: await reversalRegister(db, orgId, { from: q.from, to: q.to }) };
  },
  { permission: { module: 'accountant', action: 'view' } },
);
