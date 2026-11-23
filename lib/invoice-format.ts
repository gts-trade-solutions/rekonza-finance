// What sets the three invoice formats apart on paper, kept free of React so the
// settings samples, the printed invoice and the tests share it.

import { rupeesInWords } from '@/lib/billing/words';
import type { InvoiceFormat } from '@/lib/print-template';

/** The code column's heading, from the codes on the lines: HSN for goods, SAC (99…) for services. */
export function hsnHeading(codes: (string | null)[], format: InvoiceFormat): string {
  const given = codes.filter((c): c is string => !!c);
  if (!given.length) return format === 'services' ? 'SAC' : 'HSN';
  const sac = given.filter((c) => c.startsWith('99')).length;
  return sac === given.length ? 'SAC' : sac === 0 ? 'HSN' : 'HSN/SAC';
}

/** "US Dollar Twelve Thousand … and Fifty Cents Only": the amount in words in the invoice's currency. */
export function foreignWords(minor: number, currency: string): string {
  let name = currency;
  try { name = new Intl.DisplayNames(['en'], { type: 'currency' }).of(currency) ?? currency; } catch { /* the code */ }
  return rupeesInWords(minor).replace(/^Rupees\s+/, `${name} `).replace(/ Paise Only$/, ' Cents Only');
}
