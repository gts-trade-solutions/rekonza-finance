// ─────────────────────────────────────────────────────────────────────────────
// Using input tax credit against output tax, in the order the law fixes.
//
// Section 49 and Rule 88A: IGST credit goes first, against IGST, and whatever
// is left against CGST and SGST in any order; CGST and SGST credit may be used
// only once the IGST credit is used up, each against its own head and then
// IGST, never against each other. Cess credit only meets cess.
//
// "In any order" is where cash is won or lost. IGST credit spilling onto CGST
// first can leave SGST short while CGST credit sits unused — and that credit
// cannot cross over to help. So the spill goes first where a head's own credit
// cannot reach, and only then anywhere, which is what the portal's own
// utilisation does and what pays the least cash the law allows.
// ─────────────────────────────────────────────────────────────────────────────

export type TaxHead = 'IGST' | 'CGST' | 'SGST' | 'CESS';
export const TAX_HEADS: readonly TaxHead[] = ['IGST', 'CGST', 'SGST', 'CESS'];

type ByHead = Record<TaxHead, number>;
const zero = (): ByHead => ({ IGST: 0, CGST: 0, SGST: 0, CESS: 0 });

export interface SetOff {
  /** used[liability head][credit head]: the credit of one head that met the other's liability. */
  used: Record<TaxHead, ByHead>;
  /** Liability left for cash, head by head. */
  cash: ByHead;
  /** Credit carried forward to the next period. */
  creditLeft: ByHead;
}

export function setOffCredit(owed: ByHead, credit: ByHead): SetOff {
  const used: Record<TaxHead, ByHead> = { IGST: zero(), CGST: zero(), SGST: zero(), CESS: zero() };
  const left = zero();
  const cred = zero();
  for (const h of TAX_HEADS) {
    left[h] = Math.max(0, owed[h]);
    cred[h] = Math.max(0, credit[h]);
  }
  const take = (from: TaxHead, against: TaxHead, cap = Number.POSITIVE_INFINITY) => {
    const n = Math.min(cred[from], left[against], Math.max(0, cap));
    if (n <= 0) return;
    used[against][from] += n;
    cred[from] -= n;
    left[against] -= n;
  };

  take('IGST', 'IGST');
  take('IGST', 'CGST', left.CGST - cred.CGST);
  take('IGST', 'SGST', left.SGST - cred.SGST);
  take('IGST', 'CGST');
  take('IGST', 'SGST');
  take('CGST', 'CGST');
  take('CGST', 'IGST');
  take('SGST', 'SGST');
  take('SGST', 'IGST');
  take('CESS', 'CESS');

  return { used, cash: left, creditLeft: cred };
}

/** All the credit that met one liability head. */
export const creditUsedFor = (s: SetOff, head: TaxHead) =>
  TAX_HEADS.reduce((t, c) => t + s.used[head][c], 0);
