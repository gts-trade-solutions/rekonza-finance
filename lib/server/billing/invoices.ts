import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The tax invoice for a purchase.
//
// Issued by the platform — under its own GSTIN, from one unbroken series — to
// the organisation that paid, once per payment. The parties are copied onto the
// invoice when it is issued: a tax invoice states what was true on its date,
// and an address changed next year must not rewrite it.
//
// The GST on it is exactly the GST that was charged. It is split, not
// recomputed: intra-state (the buyer's registration is in the platform's
// state) as CGST and SGST, halves, with any odd paisa on SGST; otherwise IGST.
// Place of supply for a service to a registered business is the buyer's
// location, which is their registration's state.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { sellerDetails } from './config';
import { istDate } from '../ai/time';

export interface InvoiceParty {
  name: string;
  gstin: string | null;
  address: string | null;
  stateCode: string | null;
  email: string | null;
}

export interface InvoiceLine {
  description: string;
  sac: string;
  qty: number;
  taxablePaise: number;
}

/** '26-27' for any date in the financial year beginning April 2026. */
export function fyShort(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Charged GST, split by where the supply is made. */
export function splitGst(
  gstPaise: number,
  sellerState: string | null,
  placeOfSupply: string | null,
): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (sellerState && placeOfSupply && sellerState === placeOfSupply) {
    const cgst = Math.floor(gstPaise / 2);
    return { cgstPaise: cgst, sgstPaise: gstPaise - cgst, igstPaise: 0 };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise };
}

/**
 * The next number in the platform's series for a date's financial year.
 * Update first, insert only if missing — the same pattern as `nextSequence`,
 * for the same reason: no gap locks, no deadlocks between two payments.
 */
async function nextInvoiceNumber(trx: Trx, prefix: string, date: string): Promise<string> {
  const fy = fyShort(date);
  const name = `INV:${fy}`;
  const updated = await trx
    .updateTable('billing_counters')
    .set((eb) => ({ next_value: eb('next_value', '+', 1) }))
    .where('name', '=', name)
    .executeTakeFirst();

  let n: number;
  if (Number(updated.numUpdatedRows ?? 0) > 0) {
    const row = await trx.selectFrom('billing_counters').select('next_value').where('name', '=', name).executeTakeFirstOrThrow();
    n = Number(row.next_value) - 1;
  } else {
    try {
      await trx.insertInto('billing_counters').values({ name, next_value: 2 }).execute();
      n = 1;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
      return nextInvoiceNumber(trx, prefix, date);
    }
  }
  return `${prefix}/${fy}/${String(n).padStart(5, '0')}`;
}

export interface IssueInput {
  orgId: number;
  paymentId: number;
  description: string;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  date: Date;
  /** The gateway's payment id, printed as the payment reference. */
  reference: string | null;
}

/** Issue the invoice for a payment, or return the one already issued. */
export async function issueInvoice(trx: Trx, input: IssueInput): Promise<{ id: number; number: string }> {
  const existing = await trx
    .selectFrom('billing_invoices')
    .select(['id', 'number'])
    .where('payment_id', '=', input.paymentId)
    .executeTakeFirst();
  if (existing) return existing;

  const seller = sellerDetails();
  const org = await trx
    .selectFrom('organizations')
    .select(['name', 'legal_name', 'address', 'email'])
    .where('id', '=', input.orgId)
    .executeTakeFirstOrThrow();
  const branch = await trx
    .selectFrom('branches')
    .select(['gstin', 'state_code', 'address', 'city', 'pincode'])
    .where('org_id', '=', input.orgId)
    .where('is_active', '=', 1)
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .executeTakeFirst();

  const buyer: InvoiceParty = {
    name: org.legal_name || org.name,
    gstin: branch?.gstin ?? null,
    address: [branch?.address ?? org.address, branch?.city, branch?.pincode].filter(Boolean).join(', ') || null,
    stateCode: branch?.state_code ?? null,
    email: org.email,
  };
  const placeOfSupply = buyer.stateCode ?? seller.stateCode;
  const split = splitGst(input.gstPaise, seller.stateCode, placeOfSupply);
  const date = istDate(input.date);
  const number = await nextInvoiceNumber(trx, seller.invoicePrefix, date);

  const lines: InvoiceLine[] = [{ description: input.description, sac: seller.sac, qty: 1, taxablePaise: input.taxablePaise }];

  const res = await trx
    .insertInto('billing_invoices')
    .values({
      org_id: input.orgId,
      payment_id: input.paymentId,
      number,
      invoice_date: date,
      // Without a GSTIN it is a receipt, and says so; charging GST without
      // being registered is not something a document can fix.
      is_tax_invoice: seller.gstin && input.gstPaise > 0 ? 1 : 0,
      seller_json: JSON.stringify({
        name: seller.legalName,
        gstin: seller.gstin,
        address: seller.address,
        stateCode: seller.stateCode,
        email: seller.email,
      }),
      buyer_json: JSON.stringify(buyer),
      place_of_supply: placeOfSupply,
      lines_json: JSON.stringify({ lines, reference: input.reference }),
      taxable_paise: input.taxablePaise,
      cgst_paise: split.cgstPaise,
      sgst_paise: split.sgstPaise,
      igst_paise: split.igstPaise,
      total_paise: input.totalPaise,
    })
    .executeTakeFirstOrThrow();

  return { id: Number(res.insertId), number };
}
