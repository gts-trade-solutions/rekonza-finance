// A UPI payment link, as every UPI app reads it from a QR code.
//
// The format is NPCI's deep link: upi://pay?pa=<VPA>&pn=<payee>&am=<amount>…
// The amount is fixed in the code, so the payer cannot pay the wrong figure by
// mistyping it, and the note carries the invoice number, which is what lets
// the receipt be matched to the invoice when the bank statement comes in.

/** name@bank — letters, digits, dot, hyphen and underscore before the @. */
export const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(vpa.trim());
}

export function upiPayUri(opts: {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  /** Shown to the payer and carried to the payee's statement. */
  note: string;
  /** The payee's own reference for the payment, such as the invoice number. */
  reference?: string;
}): string {
  const params: [string, string][] = [
    ['pa', opts.vpa.trim()],
    ['pn', opts.payeeName.trim().slice(0, 50)],
    ['am', (Math.round(opts.amountPaise) / 100).toFixed(2)],
    ['cu', 'INR'],
    ['tn', opts.note.slice(0, 80)],
  ];
  if (opts.reference) params.push(['tr', opts.reference.slice(0, 35)]);
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
