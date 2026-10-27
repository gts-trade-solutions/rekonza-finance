// ─────────────────────────────────────────────────────────────────────────────
// E-invoice time rules, as plain arithmetic.
//
// Shared by the server, which enforces them, and the screens, which explain
// them — so the two can never disagree about how long is left.
// ─────────────────────────────────────────────────────────────────────────────

/** The IRP accepts a cancellation for this long after an IRN is issued, and never after. */
export const IRN_CANCEL_WINDOW_HOURS = 24;

/** When an IRN stops being cancellable. Null when the issue time is unknown. */
export function irnCancelDeadline(issuedAt: Date | string | null | undefined): Date | null {
  if (!issuedAt) return null;
  const t = new Date(issuedAt).getTime();
  return Number.isNaN(t) ? null : new Date(t + IRN_CANCEL_WINDOW_HOURS * 3_600_000);
}

/** Whether an IRN issued at `issuedAt` can still be cancelled at `now`. */
export function irnCancellable(issuedAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  const deadline = irnCancelDeadline(issuedAt);
  return deadline !== null && now.getTime() <= deadline.getTime();
}

/** The deadline as ISO while it is still ahead, so a screen can offer the action; otherwise null. */
export function irnCancelOpenUntil(issuedAt: Date | string | null | undefined, now: Date = new Date()): string | null {
  const deadline = irnCancelDeadline(issuedAt);
  return deadline && deadline.getTime() > now.getTime() ? deadline.toISOString() : null;
}

/** "5 hours", "40 minutes": what is left before a deadline, rounded down. */
export function timeLeft(until: Date | string, now: Date = new Date()): string {
  const minutes = Math.floor((new Date(until).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'no time';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
