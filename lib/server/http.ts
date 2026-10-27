import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Route-handler plumbing: authentication, permissions, validation, and one
// place that turns a thrown error into a response.
//
// Permissions are checked here, on the server, using the same matrix the UI
// uses. The client-side check hides buttons; this one is what actually stops
// the request. A hidden button is a courtesy, not a control — anyone can call
// the endpoint directly.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';
import { claimKey, releaseKey, settleKey } from './idempotency';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import type { RoleName } from '../types';
import { hasPermission, setCustomPermissionSource, type CustomPermissions } from '../rbac';
import { currentUser, type SessionUser } from './auth/session';
import { allowedBranchIds, requestedBranchId } from './auth/branches';
import { UnbalancedEntryError, PeriodLockedError, NumberingError } from './ledger/posting';

export type { Action } from '../rbac';
import type { Action } from '../rbac';

/** Thrown by handlers; caught by `route()` and turned into a response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new ApiError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Sign in to continue.') => new ApiError(401, m, 'unauthorized');
export const forbidden = (m: string) => new ApiError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new ApiError(404, m, 'not_found');
export const conflict = (m: string) => new ApiError(409, m, 'conflict');

export interface Ctx {
  user: SessionUser;
  orgId: number;
  /** The branch this request acts in; falls back to the user's home branch. */
  branchId: number;
  role: RoleName;
  req: Request;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

interface RouteOptions {
  /** Permission required. Omit only for endpoints that are genuinely public. */
  permission?: { module: string; action: Action };
  /** Skip authentication entirely — login, health, and nothing else. */
  public?: boolean;
  /** Open to a user who must set up two-step sign-in and has not: the setup itself, who-am-I, sign-out. */
  duringMfaSetup?: boolean;
}

/**
 * Wrap a handler with auth, permissions and error translation.
 *
 * Returning a plain value serialises it as JSON; throwing an ApiError produces
 * the matching status. Anything else thrown is logged and reported as a 500
 * with a generic message, because an unexpected error's text may name a table,
 * a column, or a constraint, and none of that belongs in a client response.
 */
/**
 * The signed-in user's custom role for the length of a request, so every
 * hasPermission() in the handler and the services it calls honours it without
 * being handed it.
 */
const requestPermissions = new AsyncLocalStorage<CustomPermissions | null>();
setCustomPermissionSource(() => requestPermissions.getStore());

/** The signed-in user's role for the length of a request; none outside one (scripts, the scheduler). */
const requestRole = new AsyncLocalStorage<RoleName>();
export const currentRole = (): RoleName | undefined => requestRole.getStore();

/** Run as a role, with a custom role's grants if it has one: what route() does for a request. For scripts and tests. */
export function runAs<T>(role: RoleName, permissions: CustomPermissions | null, fn: () => Promise<T>): Promise<T> {
  return requestRole.run(role, () => requestPermissions.run(permissions, fn));
}

export function route(handler: Handler, options: RouteOptions = {}) {
  // Next 15 types a route handler's second argument as a required context whose
  // params is a promise, for dynamic and static segments alike. It is still read
  // defensively, because a direct call from a test passes nothing.
  return async (
    req: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    try {
      const params = context?.params ? await context.params : {};

      let user: SessionUser | null = null;
      if (!options.public) {
        user = await currentUser();
        // Other software signs in with an API key instead of a session cookie.
        if (!user && req.headers.get('authorization')?.startsWith('Bearer rk_')) {
          const keys = await import('./auth/api-keys');
          const byKey = await keys.apiKeyUser(req);
          if (byKey) {
            const path = new URL(req.url).pathname;
            if (keys.KEY_FORBIDDEN.some((p) => path.startsWith(p))) throw forbidden('An API key cannot use this endpoint; sign in to the app instead.');
            if (keys.overLimit(byKey.apiKeyId)) throw new ApiError(429, 'Too many requests for this key. Wait a minute and try again.', 'rate_limited');
            user = byKey;
          }
        }
        if (!user) throw unauthorized();
        if (user.mfaSetupRequired && !options.duringMfaSetup) {
          throw new ApiError(403, 'This book requires two-step sign-in. Set it up to carry on.', 'mfa_setup_required');
        }

        if (options.permission) {
          const { module, action } = options.permission;
          if (!hasPermission(user.role, module, action, user.permissions ?? null)) {
            throw forbidden(
              `Your role (${user.role}) cannot ${action} in ${module}. ` +
                'Ask an admin if you need this.',
            );
          }
        }

        // A branch named in the request has to be one this user may act in —
        // otherwise anyone could raise documents under any GST registration
        // by putting its id in the body.
        const asked = await requestedBranchId(req);
        if (asked !== null && !(await allowedBranchIds(user)).has(asked)) {
          throw forbidden('You do not have access to that branch. Ask an admin to grant it.');
        }
      }

      // The same request sent again under its key gets the first one's reply (idempotency.ts).
      const idem = user && req.method !== 'GET' ? req.headers.get('idempotency-key')?.trim().slice(0, 80) || null : null;
      if (user && idem) {
        const prior = await claimKey(user.orgId, user.userId, idem, new URL(req.url).pathname);
        if (prior === 'running') throw new ApiError(409, 'This entry is still being saved. Try again in a moment.', 'in_progress');
        if (prior) return new NextResponse(prior.body, { status: prior.status, headers: { 'Content-Type': 'application/json', 'Idempotent-Replay': 'true' } });
      }

      let result: unknown;
      try {
        result = await requestRole.run((user?.role ?? 'viewer') as RoleName, () => requestPermissions.run(user?.permissions ?? null, () => handler({
          user: user as SessionUser,
          orgId: user?.orgId ?? 0,
          branchId: user?.activeBranchId ?? user?.homeBranchId ?? 0,
          role: (user?.role ?? 'viewer') as RoleName,
          req,
          params,
        })));
      } catch (err) {
        if (user && idem) await releaseKey(user.orgId, user.userId, idem);
        throw err;
      }

      if (result instanceof NextResponse) {
        if (user && idem) await releaseKey(user.orgId, user.userId, idem);
        return result;
      }
      const json = JSON.stringify(result ?? { ok: true });
      if (user && idem) await settleKey(user.orgId, user.userId, idem, 200, json);
      return new NextResponse(json, { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return toResponse(err);
    }
  };
}

/** An error as the JSON response a route returns. Exported for streaming routes. */
export function toResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status: err.status },
    );
  }

  // Domain errors carry messages written for the person reading them, so they
  // pass through intact rather than becoming a generic 500.
  if (err instanceof UnbalancedEntryError) {
    return NextResponse.json({ error: err.message, code: 'unbalanced' }, { status: 422 });
  }
  if (err instanceof PeriodLockedError) {
    return NextResponse.json({ error: err.message, code: 'period_locked' }, { status: 423 });
  }
  if (err instanceof NumberingError) {
    return NextResponse.json({ error: err.message, code: 'numbering' }, { status: 422 });
  }

  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'Some fields need attention.', code: 'validation', details: fieldErrors(err) },
      { status: 400 },
    );
  }

  // MySQL surfaces these as codes; the raw message names tables and columns.
  const code = (err as { code?: string })?.code;
  if (code === 'ER_DUP_ENTRY') {
    return NextResponse.json(
      { error: 'That already exists. Check for a duplicate number or code.', code: 'conflict' },
      { status: 409 },
    );
  }
  if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2') {
    return NextResponse.json(
      { error: 'That record is linked to something else and cannot be changed this way.', code: 'conflict' },
      { status: 409 },
    );
  }

  console.error('[api] unhandled', err);
  return NextResponse.json(
    { error: 'Something went wrong on our side. Nothing was saved.', code: 'internal' },
    { status: 500 },
  );
}

/** Flatten a Zod error into { field: message } for form display. */
function fieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Parse and validate a JSON body. */
export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest('The request body was not valid JSON.');
  }
  return schema.parse(raw);
}

/** Parse and validate the query string. */
export function query<T>(req: Request, schema: ZodType<T>): T {
  const url = new URL(req.url);
  return schema.parse(Object.fromEntries(url.searchParams));
}

/**
 * Row ids are BIGINT in the database and opaque strings over the wire, which
 * is what the frontend already expects. This is the one place they convert.
 */
export function idParam(params: Record<string, string>, key = 'id'): number {
  const n = Number(params[key]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${key}.`);
  return n;
}

export const asId = (n: number | string | bigint): string => String(n);
