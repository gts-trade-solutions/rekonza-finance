import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  disconnectReturns, fetchGstr2bFromPortal, fileReturn, listSubmissions, pushReturn, refreshSubmission,
  requestEvcOtp, requestOtp, returnsConnections, returnsProviderOptions, setReturnsUser, verifyOtp,
} from '@/lib/server/integrations/gst/returns-service';
import { retPeriod } from '@/lib/server/integrations/gst/gstn-returns';

// ─────────────────────────────────────────────────────────────────────────────
// The GST portal, for returns (integrations/gst/returns-service.ts): which
// GSTINs are connected and until when, the returns pushed and filed, and the
// actions — connect with the portal username, sign in with the OTP, push a
// return, follow its status, file with EVC, fetch GSTR-2B.
// ─────────────────────────────────────────────────────────────────────────────

const ID = z.union([z.string(), z.number()]).transform(Number);
const TYPE = z.enum(['GSTR1', 'IFF', 'GSTR3B']);
const PERIOD = z.string().regex(/^\d{4}-(\d{2}|Q[1-4])$/, 'Give the period as yyyy-mm, or yyyy-Qn for a quarterly GSTR-3B.');

const Q = z.object({
  branchId: z.string().optional(),
  returnType: TYPE.optional(),
  period: PERIOD.optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const [connections, submissions] = await Promise.all([
      returnsConnections(db, orgId),
      listSubmissions(db, orgId, {
        branchId: q.branchId ? Number(q.branchId) : undefined,
        returnType: q.returnType,
        period: q.period && /^\d{4}-\d{2}$/.test(q.period) ? retPeriod(q.period) : undefined,
      }),
    ]);
    return { providers: returnsProviderOptions(), connections, submissions };
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), branchId: ID, username: z.string().trim().min(3).max(60), provider: z.string().max(40).default('fake') }),
  z.object({ action: z.literal('disconnect'), branchId: ID }),
  z.object({ action: z.literal('request-otp'), branchId: ID }),
  z.object({ action: z.literal('verify-otp'), branchId: ID, otp: z.string().trim() }),
  z.object({ action: z.literal('push'), branchId: ID, returnType: TYPE, period: PERIOD }),
  z.object({ action: z.literal('refresh'), submissionId: ID }),
  z.object({ action: z.literal('evc-otp'), branchId: ID, returnType: TYPE }),
  z.object({ action: z.literal('file'), branchId: ID, returnType: TYPE, period: PERIOD, otp: z.string().trim() }),
  z.object({ action: z.literal('fetch-2b'), branchId: ID, period: z.string().regex(/^\d{4}-\d{2}$/) }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Input);
  const ip = auditMeta(req).ip ?? undefined;
  const need = (module: string, action: 'edit' | 'approve', what: string) => {
    if (!hasPermission(role, module, action)) throw forbidden(`Your role cannot ${what}.`);
  };
  const audit = (detail: string, targetId: number | string) => logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'gst_portal', targetId, detail, ...auditMeta(req),
  });

  switch (input.action) {
    case 'connect': {
      need('settings', 'edit', 'connect a GSTIN to the GST portal');
      await transaction((trx) => setReturnsUser(trx, orgId, user.userId, input.branchId, { username: input.username, provider: input.provider }));
      await audit(`Connected branch ${input.branchId} to the GST portal as "${input.username}" through ${input.provider}`, input.branchId);
      return requestOtp(orgId, input.branchId, ip);
    }
    case 'disconnect':
      need('settings', 'edit', 'disconnect a GSTIN from the GST portal');
      await transaction((trx) => disconnectReturns(trx, orgId, input.branchId));
      await audit(`Disconnected branch ${input.branchId} from the GST portal`, input.branchId);
      return { ok: true };
    case 'request-otp':
      need('gst', 'edit', 'sign in to the GST portal');
      return requestOtp(orgId, input.branchId, ip);
    case 'verify-otp': {
      need('gst', 'edit', 'sign in to the GST portal');
      const r = await verifyOtp(orgId, input.branchId, input.otp, ip);
      await audit(`Signed in to the GST portal for branch ${input.branchId}, until ${r.expiresAt}`, input.branchId);
      return r;
    }
    case 'push': {
      need('gst', 'approve', 'send returns to the GST portal');
      const r = await pushReturn(orgId, input.branchId, user.userId, input.returnType, input.period, ip);
      await audit(`Pushed ${input.returnType} for ${input.period} to the GST portal: reference ${r.referenceId}, ${r.status}`, r.id);
      return r;
    }
    case 'refresh':
      need('gst', 'edit', 'follow returns on the GST portal');
      return refreshSubmission(orgId, input.submissionId, ip);
    case 'evc-otp':
      need('gst', 'approve', 'file returns');
      return requestEvcOtp(orgId, input.branchId, input.returnType, ip);
    case 'file': {
      need('gst', 'approve', 'file returns');
      const r = await fileReturn(orgId, input.branchId, user.userId, input.returnType, input.period, input.otp, ip);
      await audit(`Filed ${input.returnType} for ${input.period} with EVC: ARN ${r.arn}${r.provider === 'fake' ? ' (stand-in, not filed with the GST system)' : ''}`, r.id);
      return r;
    }
    case 'fetch-2b': {
      need('gst', 'edit', 'fetch GSTR-2B');
      const r = await fetchGstr2bFromPortal(orgId, input.branchId, input.period, ip);
      await audit(`Fetched GSTR-2B for ${input.period} from the GST portal: ${r.inserted} new, ${r.updated} updated`, input.branchId);
      return r;
    }
  }
});
