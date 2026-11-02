// The GSTR-3B form, table by table, as the GST portal lays it out.
//
// Shared by the server, which fills each row from the documents, and by the
// screen, which draws the form with the portal's own wording, so that what a
// person checks here reads line for line against what they will file.

import { GST_STATES } from '../tax/gst';

export type Gstr3bRowKey =
  | '3.1a' | '3.1b' | '3.1c' | '3.1d' | '3.1e'
  | '3.1.1i' | '3.1.1ii'
  | '4A1' | '4A2' | '4A3' | '4A4' | '4A5' | '4B1' | '4B2' | '4D1' | '4D2'
  | '5gst' | '5nongst';

/** Which columns a row fills on the portal. */
export type Gstr3bColumns = 'all' | 'igst' | 'value' | 'tax';

export const GSTR3B_ROWS: Record<Gstr3bRowKey, { table: string; label: string; columns: Gstr3bColumns }> = {
  '3.1a': { table: '3.1', columns: 'all', label: '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)' },
  '3.1b': { table: '3.1', columns: 'igst', label: '(b) Outward taxable supplies (zero rated)' },
  '3.1c': { table: '3.1', columns: 'value', label: '(c) Other outward supplies (nil rated, exempted)' },
  '3.1d': { table: '3.1', columns: 'all', label: '(d) Inward supplies (liable to reverse charge)' },
  '3.1e': { table: '3.1', columns: 'value', label: '(e) Non-GST outward supplies' },
  '3.1.1i': { table: '3.1.1', columns: 'all', label: '(i) Taxable supplies on which electronic commerce operator pays tax u/s 9(5)' },
  '3.1.1ii': { table: '3.1.1', columns: 'value', label: '(ii) Taxable supplies made by the registered person through electronic commerce operator, on which electronic commerce operator is required to pay tax u/s 9(5)' },
  '4A1': { table: '4A', columns: 'tax', label: '(1) Import of goods' },
  '4A2': { table: '4A', columns: 'tax', label: '(2) Import of services' },
  '4A3': { table: '4A', columns: 'tax', label: '(3) Inward supplies liable to reverse charge (other than 1 & 2 above)' },
  '4A4': { table: '4A', columns: 'tax', label: '(4) Inward supplies from ISD' },
  '4A5': { table: '4A', columns: 'tax', label: '(5) All other ITC' },
  '4B1': { table: '4B', columns: 'tax', label: '(1) As per rules 38, 42 & 43 of CGST Rules and section 17(5)' },
  '4B2': { table: '4B', columns: 'tax', label: '(2) Others' },
  '4D1': { table: '4D', columns: 'tax', label: '(1) ITC reclaimed which was reversed under Table 4(B)(2) in earlier tax period' },
  '4D2': { table: '4D', columns: 'tax', label: '(2) Ineligible ITC under section 16(4) & ITC restricted due to PoS rules' },
  '5gst': { table: '5', columns: 'value', label: 'From a supplier under composition scheme, Exempt and Nil rated supply' },
  '5nongst': { table: '5', columns: 'value', label: 'Non GST supply' },
};

export const GSTR3B_TABLES = [
  { key: '3.1', title: '3.1 Details of Outward Supplies and inward supplies liable to reverse charge' },
  { key: '3.1.1', title: '3.1.1 Details of Supplies notified under section 9(5) of the CGST Act, 2017' },
  { key: '3.2', title: '3.2 Of the supplies shown in 3.1 (a) and 3.1.1 (i) above, details of inter-State supplies made to unregistered persons, composition taxable persons and UIN holders' },
  { key: '4', title: '4. Eligible ITC' },
  { key: '5', title: '5. Values of exempt, nil-rated and non-GST inward supplies' },
  { key: '5.1', title: '5.1 Interest & late fee payable' },
  { key: '6.1', title: '6.1 Payment of tax' },
] as const;

/** Figures in paise. A row that fills only some columns leaves the rest at 0. */
export interface Gstr3bHeads {
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
}

export const ZERO_HEADS: Gstr3bHeads = { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };

/** Table 3.2 names each place of supply by its code and state. */
export const stateLabel = (code: string | null | undefined) =>
  code ? `${code}-${GST_STATES[code] ?? 'Other'}` : '—';
