import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  CONSENT_NOTICE, CONSENT_PURPOSES, employeesWithoutConsent, listConsents, recordConsent, withdrawConsent, type ConsentPurpose,
} from '@/lib/server/services/privacy';

// An employee's consent to what their personal data is used for, given and withdrawn.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ employeeId: z.coerce.number().int().positive().optional() }));
    const purposes = Object.entries(CONSENT_PURPOSES).map(([key, label]) => ({ key, label }));
    if (q.employeeId) return { notice: CONSENT_NOTICE, purposes, consents: await listConsents(db, orgId, 'employee', q.employeeId) };
    return { notice: CONSENT_NOTICE, purposes, missing: await employeesWithoutConsent(db, orgId) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      employeeId: Id, purpose: z.enum(Object.keys(CONSENT_PURPOSES) as [ConsentPurpose, ...ConsentPurpose[]]), givenBy: z.string().max(60).nullish(),
    }));
    return transaction(async (trx) => {
      const id = await recordConsent(trx, orgId, user.userId, { subjectType: 'employee', subjectId: input.employeeId, purpose: input.purpose, givenBy: input.givenBy });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'consent', targetId: id,
        targetLabel: CONSENT_PURPOSES[input.purpose], detail: `Consent recorded for employee ${input.employeeId}: ${CONSENT_PURPOSES[input.purpose]}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);

export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ id: Id }));
    return transaction(async (trx) => {
      await withdrawConsent(trx, orgId, input.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'consent', targetId: input.id,
        targetLabel: 'Consent', detail: 'Consent withdrawn', ...auditMeta(req),
      });
      return { id: asId(input.id) };
    });
  },
  { permission: { module: 'payroll', action: 'edit' } },
);
