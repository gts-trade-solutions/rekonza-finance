// ─────────────────────────────────────────────────────────────────────────────
// An amount in words, the Indian way: lakh and crore, not million.
//
// Printed on every tax invoice, where it is customary and where a wrong word
// is a document the customer's accountant will send back. Pure, and tested.
// ─────────────────────────────────────────────────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** 12,34,56,789 → "Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine". */
export function indianWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1_00_00_000);
  n %= 1_00_00_000;
  const lakh = Math.floor(n / 1_00_000);
  n %= 1_00_000;
  const thousand = Math.floor(n / 1_000);
  n %= 1_000;
  return [
    crore ? `${indianWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    n ? belowThousand(n) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 17582 paise → "Rupees One Hundred Seventy-Five and Eighty-Two Paise Only". */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const rest = Math.abs(paise) % 100;
  return `Rupees ${indianWords(rupees)}${rest ? ` and ${belowHundred(rest)} Paise` : ''} Only`;
}
