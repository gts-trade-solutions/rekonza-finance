// What deleting a month's payroll does, by how far it has gone: said in the
// confirm on the list of months and on the month itself (payroll/changes.ts).

export const RUN_DELETE: Record<'draft' | 'posted' | 'paid', string> = {
  draft: 'A draft has posted nothing: it goes, and the month can be prepared again.',
  posted: 'Its entry is reversed in the ledger, never erased, and the payroll is kept as deleted. Claims it repaid and advance instalments it recovered are owed again. Refused once PF, ESI, PT or LWF has been paid for the month.',
  paid: 'Its salary payment and its entry are both reversed in the ledger, never erased, and the payroll is kept as deleted. Refused while the payment is matched to the bank statement, or once PF, ESI, PT or LWF has been paid for the month.',
};
