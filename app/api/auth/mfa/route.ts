import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  confirmEnrolment, disableMfa, mfaRequirement, mfaStatus, regenerateRecoveryCodes, requiredFor, startEnrolment,
} from '@/lib/server/auth/mfa';
import { BRAND } from '@/components/brand/logo';

// One's own two-step sign-in: set it up, turn it off, new recovery codes. Open
// to a user the book requires it of before they have set it up.

export const GET = route(async ({ user, orgId }) => {
  const [status, requirement] = await Promise.all([mfaStatus(db, user.userId), mfaRequirement(db, orgId)]);
  return { ...status, requirement, required: requiredFor(requirement, user.role) };
}, { duringMfaSetup: true });

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('confirm'), code: z.string().trim().min(6).max(10) }),
  z.object({ action: z.literal('disable'), code: z.string().trim().min(6).max(20) }),
  z.object({ action: z.literal('recovery'), code: z.string().trim().min(6).max(20) }),
]);

export const POST = route(async ({ user, orgId, req }) => {
  const input = await body(req, Input);
  const audit = (detail: string) => logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'user', targetId: user.userId,
    targetLabel: user.name, detail, ...auditMeta(req),
  });
  if (input.action === 'start') return startEnrolment(db, user, BRAND.short);
  if (input.action === 'confirm') {
    const recoveryCodes = await confirmEnrolment(db, user.userId, input.code);
    await audit('Turned on two-step sign-in');
    return { recoveryCodes };
  }
  if (input.action === 'disable') {
    await disableMfa(db, user, input.code);
    await audit('Turned off two-step sign-in');
    return { ok: true };
  }
  const recoveryCodes = await regenerateRecoveryCodes(db, user.userId, input.code);
  await audit('Made new recovery codes; the old ones no longer work');
  return { recoveryCodes };
}, { duringMfaSetup: true });
