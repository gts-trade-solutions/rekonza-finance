import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The demo book's records for the fixes from the independent auditor check
// (2026-11-28, builder fx-c). The reviewers judge from the online demo's
// screens, so each fix has something real to open:
//
//   1  every stock adjustment carries the value that actually left stock (the
//      FIFO or average cost on its date), worked out again for the adjustments
//      the earlier seed files inserted directly;
//   2  a vendor payment and a bank transfer deleted with a reason, shown with
//      it in Accountant → Reversed Vouchers;
//   5  a journal held for approval and then discarded, in Approvals → Approval
//      history as "Discarded".
//
// Run last in scripts/seed.ts, after the other demo files.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { IdMap } from './bootstrap';
import { DEMO_TODAY } from './demo-book';
import { CODE } from '../ledger/chart-of-accounts';
import { withChangeReason } from '../request-context';
import { refreshAdjustmentValue } from '../services/stock-changes';
import { makePayment, deletePayment } from '../services/payments';
import { createTransfer } from '../services/banking';
import { deleteTransfer } from '../services/banking-changes';
import { saveJournal, discardHeldJournal } from '../services/held-journals';
import { ruleFor, saveRule } from '../services/approvals';

const day = (n: number) => {
  const d = new Date(`${DEMO_TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const R = (rupees: number) => rupees * 100;

export async function seedDemoFxC(trx: Trx, ids: IdMap) {
  const org = ids.orgId;
  const admin = ids.users.u_arun;
  const accountant = ids.users.u_priya;
  const branch = ids.branches.br_chennai;
  const acc = ids.accounts;

  // ── 1. Adjustment values ──────────────────────────────────────────────────
  const unvalued = await trx.selectFrom('stock_adjustments').select('id').where('org_id', '=', org).where('value', 'is', null).orderBy('adjust_date').orderBy('id').execute();
  for (const a of unvalued) await refreshAdjustmentValue(trx, org, a.id);

  // ── 2. Deleted with a reason, shown in Reversed Vouchers ──────────────────
  const vendor = ids.contacts.v_bosch ?? Object.values(ids.contacts)[0];
  const pay = await makePayment(trx, org, accountant, {
    branchId: branch, contactId: vendor, date: day(6), mode: 'neft', amountPaise: R(7_080), bankAccountId: ids.bankAccounts.ba_hdfc,
    reference: 'UTR-DUP-0611',
  });
  await withChangeReason('Paid twice: the bank statement shows one payment of ₹7,080', () =>
    deletePayment(trx, org, admin, pay.id, 'Paid twice: the bank statement shows one payment of ₹7,080'));
  const tr = await createTransfer(trx, org, accountant, {
    fromBankAccountId: ids.bankAccounts.ba_icici, toBankAccountId: ids.bankAccounts.ba_hdfc, date: day(5), amountPaise: R(25_000), reference: 'Sweep',
  });
  await withChangeReason('Entered against the wrong account: the sweep went to ICICI, not HDFC', () =>
    deleteTransfer(trx, org, admin, tr.id, 'Entered against the wrong account: the sweep went to ICICI, not HDFC'));

  // ── 5. A journal discarded while it waited for approval ───────────────────
  if (!(await ruleFor(trx, org, 'journal', R(90_000)))) {
    await saveRule(trx, org, { documentType: 'journal', thresholdPaise: R(50_000), approverRole: 'admin', isActive: true });
  }
  const saved = await saveJournal(trx, org, accountant, {
    branchId: branch, date: day(4), memo: 'Year-end bonus provision (entered twice)',
    lines: [{ accountId: acc[CODE.SALARIES] ?? acc[CODE.RENT], debitPaise: R(90_000) }, { accountId: acc[CODE.PROVISIONS], creditPaise: R(90_000) }],
  });
  if (saved.held) await discardHeldJournal(trx, org, admin, saved.id, 'Entered twice: the provision is already booked for the month');
}
