// A customer's or vendor's registration as the contact card shows it: the kind
// of business, the GST registration and since when, the CIN and the date the
// company was incorporated; for an international party its country and
// currency; and what a customer buys. Filled from the GSTIN and the CIN, or typed.

import { countryName } from '@/lib/countries';

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const BUYS: Record<string, string> = { goods: 'Goods only', service: 'Services only', both: 'Goods and services' };

export function RegistrationDetails({ c }: {
  c: {
    constitution?: string | null; gstStatus?: string | null; gstRegisteredOn?: string | null; cin?: string | null; incorporatedOn?: string | null;
    country?: string | null; currency?: string | null; supplies?: string | null; kind?: string;
  };
}) {
  const rows: [string, string][] = [];
  if (c.country) rows.push(['Country', `${countryName(c.country)}${c.currency && c.currency !== 'INR' ? ` · invoiced in ${c.currency}` : ''}`]);
  if (c.constitution) rows.push(['Kind of business', c.constitution]);
  if (c.gstRegisteredOn || c.gstStatus) rows.push(['GST registration', [c.gstStatus, c.gstRegisteredOn ? `since ${day(c.gstRegisteredOn)}` : null].filter(Boolean).join(', ')]);
  if (c.cin) rows.push(['CIN', c.cin]);
  if (c.incorporatedOn) rows.push(['Incorporated on', day(c.incorporatedOn)]);
  if (c.kind !== 'vendor' && c.supplies && c.supplies !== 'both') rows.push(['Buys', BUYS[c.supplies] ?? c.supplies]);
  if (!rows.length) return null;
  return (
    <div className="space-y-2 border-t pt-3 text-sm" data-slot="registration-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={label === 'CIN' ? 'mt-0.5 font-mono text-xs' : 'mt-0.5 text-xs'}>{value}</p>
        </div>
      ))}
    </div>
  );
}
