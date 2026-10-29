import 'server-only';

// The reason a person gave for the change their request makes, for the length
// of that request. route() sets it from the X-Change-Reason header and the
// audit trail reads it, so every audit row a change writes carries the "why"
// beside the who and the when — without each service being handed it.
//
// A module of its own because both http.ts and audit.ts need it, and audit.ts
// is imported by things http.ts imports.

import { AsyncLocalStorage } from 'node:async_hooks';

const reasons = new AsyncLocalStorage<string | null>();

export function withChangeReason<T>(reason: string | null, fn: () => Promise<T>): Promise<T> {
  return reasons.run(reason, fn);
}

/** Why the current request changes what it changes, if the person said. */
export function changeReason(): string | null {
  return reasons.getStore() ?? null;
}
