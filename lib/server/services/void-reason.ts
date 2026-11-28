import 'server-only';

// Cancelling a posted document takes a reason. It is kept on the document,
// where anyone looking at it will see it, and in the memo of the entry that
// reverses it. "Why was this cancelled?" is the first question an auditor asks
// of a void, and Rule 3(1) of the Companies (Accounts) Rules expects the books
// to answer it.

import { ApiError, badRequest } from '../http';
import { changeReason, inRequest } from '../request-context';

/**
 * The reason for cancelling: the one passed, or the one the person gave for
 * the request (a reason box, or the browser's own question answered after a
 * 428). A request that gave none is answered 428 reason_required, so the
 * browser asks for it instead of the void failing with an error.
 */
export function voidReason(reason: string | null | undefined): string {
  const r = (reason?.trim() || changeReason()?.trim() || '');
  if (!r && inRequest()) {
    throw new ApiError(428, 'Give a reason for cancelling. It stays with the document, on the reversing entry and in the audit trail.', 'reason_required');
  }
  if (r.length < 4) throw badRequest('Give a reason for cancelling. It stays with the document and in the audit trail.');
  return r.slice(0, 300);
}

/** The columns every voidable document carries (migration 048). */
export const voidStamp = (reason: string, userId: number | null) =>
  ({ voided_at: new Date(), void_reason: reason, voided_by_user_id: userId });
