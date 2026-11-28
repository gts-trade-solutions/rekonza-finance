import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, query, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { DOC_PREF_TYPES, getDocPreferences, saveDocPreferences, type DocPrefType } from '@/lib/server/services/doc-preferences';

// Zoho Books' Quote, Sales Order, Invoice, Delivery Challan and Credit Note
// Preferences (services/doc-preferences.ts). Read by anyone who raises sales
// documents — the forms start from them — and changed under Settings.

const Type = z.enum(DOC_PREF_TYPES as [DocPrefType, ...DocPrefType[]]);

export const GET = route(async ({ orgId, req }) => {
  const q = query(req, z.object({ type: Type }));
  return getDocPreferences(db, orgId, q.type);
}, { permission: { module: 'sales', action: 'view' } });

export const PUT = route(async ({ orgId, user, req }) => {
  const input = await body(req, z.object({
    type: Type,
    notes: z.string().max(5000).nullish(),
    terms: z.string().max(5000).nullish(),
    settings: z.object({
      allowEditAfterSending: z.boolean().optional(),
      onQuoteAccepted: z.enum(['nothing', 'invoice', 'sales_order']).optional(),
    }).optional(),
  }));
  return transaction(async (trx) => {
    // Each setting's old and new value, for the edit log (Companies (Accounts) Rules, rule 3(1)).
    const before = await getDocPreferences(trx, orgId, input.type);
    const saved = await saveDocPreferences(trx, orgId, user.userId, input.type, input);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'settings', targetId: orgId,
      detail: `${input.type.replace('_', ' ')} preferences changed`, payload: { before, after: saved }, ...auditMeta(req),
    });
    return saved;
  });
}, { permission: { module: 'settings', action: 'edit' } });
