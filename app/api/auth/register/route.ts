import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { bootstrap } from '@/lib/server/seed/bootstrap';
import { passwordProblems } from '@/lib/server/auth/password';
import { createSession, cookieOptions, SESSION_COOKIE } from '@/lib/server/auth/session';
import { route, body, ApiError, asId } from '@/lib/server/http';
import { logAudit } from '@/lib/server/audit';
import { GST_STATES, isValidGstin } from '@/lib/tax/gst';

// ─────────────────────────────────────────────────────────────────────────────
// Sign up: create an organisation, its first GST registration, and its owner.
//
// What this deliberately does NOT do is copy the demo book. A new business gets
// the standard chart of accounts, one Cash in Hand account, and numbering
// series that start at one. Nothing else. Somebody else's customers sitting in
// your ledger on day one is not a head start, it is contamination — and the
// first person to notice is the auditor.
//
// Everything happens in one transaction. A half-created organisation would be
// an account you can sign into and cannot use, which is worse than a failed
// sign-up you can simply retry.
// ─────────────────────────────────────────────────────────────────────────────

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const RegisterInput = z.object({
  businessName: z.string().trim().min(2, 'Enter your business name.').max(200),
  stateCode: z
    .string()
    .trim()
    .refine((c) => c in GST_STATES, 'Choose the state you are registered in.'),
  // Optional: plenty of businesses trade below the registration threshold, and
  // refusing them an account would be refusing the customers who most need
  // simple books.
  gstin: z.string().trim().toUpperCase().optional().or(z.literal('')),
  pan: z.string().trim().toUpperCase().optional().or(z.literal('')),
  name: z.string().trim().min(2, 'Enter your name.').max(150),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(255),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  password: z.string().min(1, 'Choose a password.'),
});

/** New organisations allowed from one address per hour. */
const SIGNUPS_PER_IP_PER_HOUR = 5;

export const POST = route(
  async ({ req }) => {
    const input = await body(req, RegisterInput);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent');

    // ── Password ─────────────────────────────────────────────────────────────
    const problems = passwordProblems(input.password);
    if (problems.length) {
      throw new ApiError(400, problems.join(' '), 'weak_password', { problems });
    }

    // ── GSTIN ────────────────────────────────────────────────────────────────
    //
    // Checked properly, not merely for shape. A GSTIN carries its own mod-36
    // check digit, and its first two characters are the state code — so a
    // mismatch between the two fields means one of them is a typo, and getting
    // it wrong here would put CGST+SGST where IGST belongs on every invoice
    // this business ever raises.
    const gstin = input.gstin || null;
    if (gstin) {
      if (!isValidGstin(gstin)) {
        throw new ApiError(400, 'That GSTIN is not valid. Check it against your registration certificate.', 'bad_gstin');
      }
      if (gstin.slice(0, 2) !== input.stateCode) {
        throw new ApiError(
          400,
          `That GSTIN belongs to ${GST_STATES[gstin.slice(0, 2)] ?? 'another state'}, but you chose ${GST_STATES[input.stateCode]}.`,
          'gstin_state_mismatch',
        );
      }
    }

    // Characters 3–12 of a GSTIN are the holder's PAN, so it never has to be
    // asked for twice.
    const pan = (input.pan || (gstin ? gstin.slice(2, 12) : '')) || null;
    if (pan && !PAN_RE.test(pan)) {
      throw new ApiError(400, 'That PAN is not in the right format (AAAAA9999A).', 'bad_pan');
    }

    // ── Uniqueness ───────────────────────────────────────────────────────────
    const existingUser = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (existingUser) {
      throw new ApiError(
        409,
        'An account already exists for that email. Sign in instead, or use another address.',
        'email_taken',
      );
    }

    if (gstin) {
      const existingGstin = await db
        .selectFrom('branches')
        .select('id')
        .where('gstin', '=', gstin)
        .executeTakeFirst();
      if (existingGstin) {
        throw new ApiError(
          409,
          'That GSTIN is already registered here. Ask the account owner to invite you.',
          'gstin_taken',
        );
      }
    }

    // ── Throttle ─────────────────────────────────────────────────────────────
    //
    // Counted from the audit trail rather than a separate store, because the
    // trail is written anyway and a sign-up is exactly the kind of event it
    // exists to record. Enough to stop a script; not so tight that an office
    // behind one NAT address cannot onboard a few colleagues.
    if (ip) {
      const recent = await db
        .selectFrom('audit_log')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('action', '=', 'create')
        .where('target_type', '=', 'organization')
        .where('ip', '=', ip)
        .where('created_at', '>', sql<Date>`DATE_SUB(NOW(), INTERVAL 1 HOUR)`)
        .executeTakeFirst();
      if (Number(recent?.n ?? 0) >= SIGNUPS_PER_IP_PER_HOUR) {
        throw new ApiError(429, 'Too many accounts created from here. Try again in an hour.', 'rate_limited');
      }
    }

    // ── Create ───────────────────────────────────────────────────────────────
    const created = await transaction(async (trx) =>
      bootstrap(trx, {
        minimal: true,
        org: {
          name: input.businessName,
          pan,
          email: input.email,
          phone: input.phone || null,
          // A business with no GSTIN is unregistered until it says otherwise.
          // Defaulting the other way would have the app charging GST on every
          // invoice raised by someone who is not allowed to collect it.
          gstRegistrationType: gstin ? 'regular' : 'unregistered',
        },
        branch: {
          name: `${GST_STATES[input.stateCode]} — ${input.businessName}`.slice(0, 150),
          stateCode: input.stateCode,
          gstin,
          address: null,
        },
        admin: { name: input.name, email: input.email, password: input.password },
      }),
    );

    const adminId = Object.values(created.users)[0];
    const branchId = Object.values(created.branches)[0] ?? null;

    await logAudit({
      orgId: created.orgId,
      actorUserId: adminId,
      actorName: input.name,
      action: 'create',
      targetType: 'organization',
      targetId: created.orgId,
      targetLabel: input.businessName,
      detail: `Organisation created — ${gstin ? `GSTIN ${gstin}` : 'unregistered'}, ${GST_STATES[input.stateCode]}`,
      ip,
      userAgent,
    });

    // Signed in straight away. Asking someone to type the password they chose
    // four seconds ago is a step that exists only to make the flow look formal.
    const { token, expiresAt } = await createSession(adminId, created.orgId, {
      ip,
      userAgent,
      activeBranchId: branchId,
    });

    const res = NextResponse.json({
      user: {
        id: asId(adminId),
        name: input.name,
        email: input.email,
        role: 'admin' as const,
        branchId: branchId ? asId(branchId) : null,
      },
      org: { id: asId(created.orgId), name: input.businessName },
    });
    res.cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return res;
  },
  { public: true },
);
