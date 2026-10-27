import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { exposure, listRates, revalue, setRate } from '@/lib/server/services/fx';

// Exchange rates, and open foreign-currency balances restated at a period end.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: date.optional() }));
    const asOf = q.asOf ?? localToday();
    const [rates, open] = await Promise.all([listRates(db, orgId), exposure(db, orgId, asOf)]);
    return { asOf, rates, exposure: open };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rate'), currency: z.string().length(3), date, rate: z.number().positive(), source: z.string().max(60).nullish() }),
  z.object({ action: z.literal('revalue'), date }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'rate') {
        await setRate(trx, orgId, input);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'exchange_rate',
          targetId: `${input.currency}:${input.date}`, targetLabel: input.currency,
          detail: `${input.currency.toUpperCase()} at ₹${input.rate} on ${input.date}`, ...auditMeta(req),
        });
        return { ok: true };
      }
      const r = await revalue(trx, orgId, user.userId, input.date);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'journal', targetId: r.entryId,
        targetLabel: `Restatement ${input.date}`,
        detail: `Foreign balances restated at ${input.date}: net ${r.netPaise >= 0 ? 'gain' : 'loss'} of ₹${(Math.abs(r.netPaise) / 100).toLocaleString('en-IN')}`,
        ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
