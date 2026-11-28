import 'server-only';

// A payment is recorded on the day it was made, never ahead of it.
//
// A TDS challan dated next week, accepted today, would show in Form 24Q as tax
// deposited that has not been deposited (the CIN, BSR code and date on a
// challan are the bank's, issued when the bank takes the money), and the
// ledger would carry a bank payment that has not happened. The same goes for
// PF, ESI, PT and LWF paid through Dues & Payments, and salaries paid. So a
// date after today, in India, is refused; it can be recorded on the day.

import { badRequest } from '../http';

/** Today in India: the date the books keep, whatever the server's clock zone. */
export const indiaDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);

/**
 * Tests that run a whole financial year ahead of the calendar (April to March)
 * stand at a later "today"; nothing else sets this.
 */
let todayForTests: string | null = null;
export function setTodayForTests(day: string | null) { todayForTests = day; }

export function refuseFutureDate(date: string, what: string, today = todayForTests ?? indiaDay()) {
  if (date > today) {
    throw badRequest(`${what} is dated ${date}, after today (${today}). Record it on or after the day it is paid: the date is the one the bank gives it.`);
  }
}
