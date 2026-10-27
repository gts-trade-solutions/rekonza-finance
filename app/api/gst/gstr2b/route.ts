import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { importGstr2b, parseGstr2b, setImsAction } from '@/lib/server/gst/gstr2b-import';

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
