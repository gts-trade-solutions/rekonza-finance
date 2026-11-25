import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { exposure, listRates, revalue, setRate } from '@/lib/server/services/fx';
import { feedCurrencies, getFxFeed, refreshRates, setFxFeed } from '@/lib/server/services/fx-feed';
import { deleteRate, deleteRestatement, editRate, listRestatements } from '@/lib/server/services/accountant-changes';

// Exchange rates (typed, or fetched each day by the feed: services/fx-feed.ts),
// and open foreign-currency balances restated at a period end.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: date.optional() }));
    const asOf = q.asOf ?? localToday();
    const [rates, open, feed, currencies, restatements] = await Promise.all([listRates(db, orgId), exposure(db, orgId, asOf), getFxFeed(db, orgId), feedCurrencies(db, orgId), listRestatements(db, orgId)]);
    return { asOf, rates, exposure: open, feed: { ...feed, currencies }, restatements };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rate'), currency: z.string().length(3), date, rate: z.number().positive(), source: z.string().max(60).nullish() }),
  z.object({ action: z.literal('revalue'), date }),
  z.object({ action: z.literal('feed'), enabled: z.boolean() }),
  z.object({ action: z.literal('fetch') }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    if (input.action === 'fetch') {
      // Outside a transaction: the feed is a call to another service, and a slow one should not hold locks.
      const r = await refreshRates(orgId, user.userId);
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'exchange_rate', targetId: 'feed',
        detail: r.saved.length ? `Rates fetched for ${r.date}: ${r.saved.map((s) => `${s.currency} ₹${s.rate}`).join(', ')}` : 'Rates fetched: nothing new', ...auditMeta(req),
      });
      return r;
    }
    return transaction(async (trx) => {
      if (input.action === 'feed') {
        await setFxFeed(trx, orgId, user.userId, input.enabled);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'exchange_rate', targetId: 'feed',
          detail: input.enabled ? 'Exchange rate feed switched on' : 'Exchange rate feed switched off', ...auditMeta(req),
        });
        return { enabled: input.enabled };
      }
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

/** Edit a rate: its date and figure (services/accountant-changes.ts). Booked documents keep their own rate. */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ id: z.union([z.string(), z.number()]).transform(Number), date, rate: z.number().positive() }));
    return transaction(async (trx) => {
      const r = await editRate(trx, orgId, input.id, { date: input.date, rate: input.rate });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'exchange_rate',
        targetId: `${r.currency}:${input.date}`, targetLabel: r.currency, detail: `${r.currency} rate edited: ₹${input.rate} on ${input.date}`, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'accountant', action: 'edit' } },
);

/**
 * Delete a rate (?rate=<id>), or a restatement (?restatement=<entry id>): the
 * restatement and its next-day reversal are both undone on their own dates.
 */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({
      rate: z.coerce.number().int().positive().optional(),
      restatement: z.coerce.number().int().positive().optional(),
      reason: z.string().max(300).optional(),
    }));
    return transaction(async (trx) => {
      if (q.restatement) {
        const r = await deleteRestatement(trx, orgId, user.userId, q.restatement, q.reason);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'journal', targetId: q.restatement,
          targetLabel: `Restatement ${r.date}`, detail: `Deleted the restatement #${r.entryNo} of ${r.date} (undone by #${r.undoEntryNo})${q.reason ? ` — ${q.reason}` : ''}`, ...auditMeta(req),
        });
        return { ok: true };
      }
      if (!q.rate) throw badRequest('Say which rate or restatement to delete.');
      const r = await deleteRate(trx, orgId, q.rate);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'exchange_rate',
        targetId: `${r.currency}:${r.date}`, targetLabel: r.currency, detail: `Deleted the ${r.currency} rate of ₹${r.rate} on ${r.date}${q.reason ? ` — ${q.reason}` : ''}`, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'accountant', action: 'void' } },
);
