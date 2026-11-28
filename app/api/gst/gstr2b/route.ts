import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { deleteGstr2bPeriod } from '@/lib/server/gst/changes';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { importGstr2b, parseGstr2b, setImsAction } from '@/lib/server/gst/gstr2b-import';
import { setClaimDecision } from '@/lib/server/gst/itc-claims';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-2B in, IMS actions recorded.
//
// The statement itself is read by the GST screens (/api/gst?view=itc). This
// endpoint changes what the book holds: it loads a downloaded 2B file, and it
// records the accept / reject / pending decision taken on each supplier line in
// the portal's Invoice Management System.
// ─────────────────────────────────────────────────────────────────────────────

const Input = z.discriminatedUnion('action', [
  // The parsed contents of the JSON file the portal gives for download.
  z.object({ action: z.literal('import'), file: z.unknown() }),
  z.object({
    action: z.literal('ims'),
    ids: z.array(z.string()).min(1).max(1000),
    // Null clears a recorded action: the line goes back to deemed-accepted.
    imsAction: z.enum(['accepted', 'rejected', 'pending']).nullable(),
    note: z.string().trim().max(300).nullish(),
  }),
  // After matching, when the credit on our own bills is taken: accept (its
  // own month), defer (until the supplier files), or claim later in a named
  // month (gst/itc-claims.ts). GSTR-3B 4(A)(5) follows it.
  z.object({
    action: z.literal('claim'),
    billIds: z.array(z.union([z.string(), z.number()]).transform(Number)).min(1).max(500),
    decision: z.enum(['accept', 'defer', 'claim_later']),
    claimPeriod: z.string().regex(/^\d{4}-\d{2}$/, 'Give the month as yyyy-mm.').nullish(),
    note: z.string().trim().max(300).nullish(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);

    if (input.action === 'import') {
      const parsed = parseGstr2b(input.file);
      const result = await transaction((trx) => importGstr2b(trx, orgId, parsed));
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'import',
        targetType: 'gstr2b', targetLabel: `${result.gstin} ${result.returnPeriod}`,
        detail: `Imported GSTR-2B for ${result.gstin}, ${result.returnPeriod}: ` +
          `${result.inserted} new, ${result.updated} updated, ${result.skipped.length} unreadable`,
        ...auditMeta(req),
      });
      return result;
    }

    if (input.action === 'claim') {
      return transaction(async (trx) => {
        const r = await setClaimDecision(trx, orgId, user.userId, input);
        const what = input.decision === 'accept' ? 'claimed in its own month' : input.decision === 'defer' ? 'held back until the supplier files' : `to be claimed in ${input.claimPeriod}`;
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'gst_itc_claim', targetLabel: r.bills.join(', '),
          detail: `ITC on ${r.bills.join(', ')}: ${what}${input.note ? ` — ${input.note}` : ''}`, ...auditMeta(req),
        });
        return r;
      });
    }

    const updated = await transaction((trx) =>
      setImsAction(trx, orgId, user.userId, input.ids.map(Number), input.imsAction, input.note));
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'gstr2b', targetLabel: `${updated} line(s)`,
      detail: `IMS: marked ${updated} supplier line(s) ${input.imsAction ?? 'as no action'}`,
      ...auditMeta(req),
    });
    return { updated };
  },
  { permission: { module: 'gst', action: 'edit' } },
);

/**
 * Take out a month's GSTR-2B brought in (the wrong file, or to bring it in
 * again from scratch), with the IMS actions recorded on it (gst/changes.ts).
 */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ period: z.string().regex(/^\d{6}$/, 'Give the return period as mmyyyy.'), gstin: z.string().length(15).optional() }));
    return transaction(async (trx) => {
      const r = await deleteGstr2bPeriod(trx, orgId, q.period, q.gstin);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'gstr2b', targetLabel: `${q.gstin ?? 'all registrations'} ${q.period}`,
        detail: `Deleted the GSTR-2B held for ${q.period}${q.gstin ? ` (${q.gstin})` : ''}: ${r.lines} line(s), with their IMS actions`, ...auditMeta(req),
      });
      return { deleted: r.lines };
    });
  },
  { permission: { module: 'gst', action: 'void' } },
);
