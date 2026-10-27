import 'server-only';

// Cancelling a posted document takes a reason. It is kept on the document,
// where anyone looking at it will see it, and in the memo of the entry that
// reverses it. "Why was this cancelled?" is the first question an auditor asks
// of a void, and Rule 3(1) of the Companies (Accounts) Rules expects the books
// to answer it.

import { badRequest } from '../http';

export function voidReason(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (r.length < 4) throw badRequest('Give a reason for cancelling. It stays with the document and in the audit trail.');
  return r.slice(0, 300);
}

/** The columns every voidable document carries (migration 048). */
export const voidStamp = (reason: string, userId: number | null) =>
  ({ voided_at: new Date(), void_reason: reason, voided_by_user_id: userId });
