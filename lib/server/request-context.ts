import 'server-only';

// The reason a person gave for the change their request makes, and where the
// request came from, for the length of that request. route() sets both: the
// reason from the X-Change-Reason header, the address and browser from the
// request itself. The audit trail reads them, so every audit row a change
// writes carries the "why" and the "from where" beside the who and the when —
// without each service being handed them, and without a route that forgets
// to pass auditMeta(req) leaving the IP column blank.
//
// A module of its own because both http.ts and audit.ts need it, and audit.ts
// is imported by things http.ts imports.

import { AsyncLocalStorage } from 'node:async_hooks';

const reasons = new AsyncLocalStorage<string | null>();

export interface RequestOrigin { ip: string | null; userAgent: string | null }
const origins = new AsyncLocalStorage<RequestOrigin>();

export function withChangeReason<T>(reason: string | null, fn: () => Promise<T>): Promise<T> {
  return reasons.run(reason, fn);
}

/** Why the current request changes what it changes, if the person said. */
export function changeReason(): string | null {
  return reasons.getStore() ?? null;
}

/** Run with the request's address and browser known to the audit trail. */
export function withRequestOrigin<T>(origin: RequestOrigin, fn: () => Promise<T>): Promise<T> {
  return origins.run(origin, fn);
}

/** Where the current request came from; nothing outside a request (scripts, the scheduler). */
export function requestOrigin(): RequestOrigin | null {
  return origins.getStore() ?? null;
}
