import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Every document besides the invoice, as it prints (lib/print-doc.ts): read
// back from what is stored, never recomputed, so a reprint next year is the
// same document. Shared by the print screen, a link sent by email and the
// portal; none of them shows the ledger behind it.
//
// The law has something to say about three of them. A delivery challan
// carries what Rule 55 lists and travels in triplicate; a credit note names
// the invoice it reduces (Rule 53(1A)); a receipt for an advance on which GST
// was paid is a receipt voucher with the tax shown (Rule 50).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { asId, notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import { readTemplate } from '../../print-template';
import { registrationOn } from './statutory';
import type { PrintDoc, PrintKind, PrintLine, PrintParty } from '../../print-doc';

const p = toPaiseFromSql;
const iso = (d: unknown) => (d == null ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: unknown) => {
  const s = iso(d);
  if (!s) return '—';
  const [y, m, dd] = s.split('-').map(Number);
  return `${String(dd).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
const MODE: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', card: 'Card', netbanking: 'Net banking', other: 'Other',
};
const CHALLAN_PURPOSE: Record<string, string> = {
  job_work: 'Sent for job work', supply_on_approval: 'Supply on approval', liquid_gas: 'Supply of liquid gas, quantity not known at removal', other: 'Other than by way of supply',
};

async function sellerOf(ex: Executor, orgId: number, branchId: number, date: string) {
  const o = await ex.selectFrom('organizations')
    .select(['name', 'legal_name', 'pan', 'email', 'phone', 'logo_file_id', 'signatory_name', 'print_language', 'print_template'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  const b = await ex.selectFrom('branches').select(['name', 'gstin', 'address', 'city', 'pincode', 'state_code'])
    .where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const registration = await registrationOn(ex, orgId, date);
  return {
    registration,
    seller: {
      label: 'From',
      name: o.legal_name || o.name,
      tradeName: o.legal_name && o.legal_name !== o.name ? o.name : null,
      address: b.address, city: b.city, pincode: b.pincode, stateCode: b.state_code,
      gstin: registration === 'unregistered' ? undefined : b.gstin,
      pan: o.pan, email: o.email, phone: o.phone,
      logoUrl: o.logo_file_id ? `/api/files/${o.logo_file_id}` : null,
      signatoryName: o.signatory_name,
      printLanguage: o.print_language,
      template: readTemplate(o.print_template),
    },
  };
}

async function partyOf(ex: Executor, orgId: number, contactId: number, label: string) {
  const c = await ex.selectFrom('contacts')
    .select(['id', 'display_name', 'legal_name', 'gstin', 'billing_address', 'billing_city', 'billing_pincode', 'state_code', 'email', 'phone',
      'shipping_address', 'shipping_city', 'shipping_pincode'])
    .where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const party: PrintParty = {
    label, name: c.legal_name || c.display_name, address: c.billing_address, city: c.billing_city, pincode: c.billing_pincode,
    stateCode: c.state_code, gstin: c.gstin, email: c.email, phone: c.phone,
  };
  const ship = c.shipping_address?.trim() ?? '';
  const shipTo: PrintParty | null = ship && ship.toLowerCase() !== (c.billing_address ?? '').trim().toLowerCase()
    ? { label: 'Ship to', name: c.display_name, address: ship, city: c.shipping_city, pincode: c.shipping_pincode, stateCode: null }
    : null;
  return { party, shipTo };
}

interface TaxedLineRow {
  description: string | null; item_name: string | null; hsn_sac: string | null; qty: string | number; uqc: string | null; rate: string;
  discount_pct: string | number; taxable: string; gst_rate_pct: string | number; cgst: string; sgst: string; igst: string; cess: string; line_total: string;
}
const taxedLine = (l: TaxedLineRow): PrintLine => ({
  description: l.description?.trim() || l.item_name || null, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc, ratePaise: p(l.rate),
  discountPct: Number(l.discount_pct), taxablePaise: p(l.taxable), gstRatePct: Number(l.gst_rate_pct),
  cgstPaise: p(l.cgst), sgstPaise: p(l.sgst), igstPaise: p(l.igst), cessPaise: p(l.cess), totalPaise: p(l.line_total),
});

/** One line for a document that has none: a retainer, a credit against a bill. */
const singleLine = (description: string | null, paise: number): PrintLine => ({
  description, hsnSac: null, qty: null, uqc: null, ratePaise: null, discountPct: 0, taxablePaise: paise, gstRatePct: 0,
  cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, totalPaise: paise,
});

function taxColumns(registration: string, supplyType: string | null, igst: number): PrintDoc['taxColumns'] {
  if (registration !== 'regular' || supplyType === 'nil_or_exempt') return 'none';
  if (supplyType === 'intra') return 'split';
  return igst > 0 || supplyType === 'inter' || supplyType === 'export_with_tax' || supplyType === 'sez' ? 'integrated' : 'none';
}

function taxTotals(cols: PrintDoc['taxColumns'], subtotal: number, t: { cgst: number; sgst: number; igst: number; cess: number }) {
  const out: { label: string; paise: number }[] = [{ label: 'Taxable value', paise: subtotal }];
  if (cols === 'split') out.push({ label: 'CGST', paise: t.cgst }, { label: 'SGST', paise: t.sgst });
  if (cols === 'integrated') out.push({ label: 'IGST', paise: t.igst });
  if (t.cess) out.push({ label: 'Cess', paise: t.cess });
  return out;
}

/** The round-off that took the lines' sum to the stored total. */
function withRoundOff(totals: { label: string; paise: number }[], total: number) {
  const diff = total - totals.reduce((s, t) => s + t.paise, 0);
  return diff ? [...totals, { label: 'Round off', paise: diff }] : totals;
}

const ORIGINAL = ['Original'];

/** A document as it prints. Throws not found for one outside the organisation. */
export async function printableDocument(
  ex: Executor, orgId: number, kind: PrintKind, id: number,
  /** A sales order printed as its proforma invoice (services/order-stages.ts). */
  opts: { proforma?: boolean } = {},
): Promise<PrintDoc> {
  const missing = () => notFound('That document does not exist.');
  switch (kind) {
    case 'estimate': {
      const d = await ex.selectFrom('estimates').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('estimate_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.estimate_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.estimate_date)!;
      const { seller, registration } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party, shipTo } = await partyOf(ex, orgId, d.customer_id, 'Quote to');
      const cols = taxColumns(registration, d.supply_type, p(d.igst));
      return {
        kind, id: asId(d.id), number: d.number, title: 'Quotation', endorsement: null, date, status: d.status,
        tag: d.status === 'draft' ? 'Draft' : null, copies: ORIGINAL, seller, party, partyId: asId(d.customer_id), shipTo,
        placeOfSupply: d.place_of_supply, taxColumns: cols,
        facts: [
          { label: 'Quote no.', value: d.number }, { label: 'Quote date', value: day(date) }, { label: 'Valid until', value: day(d.expiry_date) },
          // The same discount on every line is an offer on the whole quote: said so at the top.
          ...(lines.length && Number(lines[0].discount_pct) > 0 && lines.every((l) => Number(l.discount_pct) === Number(lines[0].discount_pct))
            ? [{ label: 'Special offer', value: `${Number(lines[0].discount_pct)}% off` }] : []),
        ],
        lines: lines.map(taxedLine),
        totals: withRoundOff(taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) }), p(d.total)),
        totalLabel: 'Total', totalPaise: p(d.total), after: [], allocations: null, notes: d.notes, terms: null,
      };
    }
    case 'sales-order': {
      const d = await ex.selectFrom('sales_orders').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('sales_order_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.sales_order_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.order_date)!;
      const { seller, registration } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party, shipTo } = await partyOf(ex, orgId, d.customer_id, 'Bill to');
      const cols = taxColumns(registration, d.supply_type, p(d.igst));
      // The proforma: the order priced for the customer to pay against or approve. Not a tax invoice.
      if (opts.proforma) {
        if (!d.proforma_number) throw notFound('This order has no proforma invoice yet: raise one first.');
        const piDate = iso(d.proforma_date) ?? date;
        return {
          kind, id: asId(d.id), number: d.proforma_number, title: 'Proforma Invoice',
          endorsement: 'Not a tax invoice. The tax invoice follows on delivery.', date: piDate, status: d.status,
          tag: d.status === 'cancelled' ? 'Cancelled' : null, copies: ORIGINAL, seller, party, partyId: asId(d.customer_id), shipTo,
          placeOfSupply: d.place_of_supply, taxColumns: cols,
          facts: [
            { label: 'Proforma no.', value: d.proforma_number }, { label: 'Proforma date', value: day(piDate) },
            { label: 'Against order', value: d.number },
            ...(d.expected_ship_date ? [{ label: 'Expected delivery', value: day(d.expected_ship_date) }] : []),
          ],
          lines: lines.map(taxedLine),
          totals: withRoundOff(taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) }), p(d.total)),
          totalLabel: 'Amount payable', totalPaise: p(d.total), after: [], allocations: null, notes: null, terms: null,
        };
      }
      return {
        kind, id: asId(d.id), number: d.number, title: 'Sales Order', endorsement: null, date, status: d.status,
        tag: d.status === 'cancelled' ? 'Cancelled' : null, copies: ORIGINAL, seller, party, partyId: asId(d.customer_id), shipTo,
        placeOfSupply: d.place_of_supply, taxColumns: cols,
        facts: [
          { label: 'Order no.', value: d.number }, { label: 'Order date', value: day(date) },
          ...(d.expected_ship_date ? [{ label: 'Expected shipment', value: day(d.expected_ship_date) }] : []),
        ],
        lines: lines.map(taxedLine),
        totals: withRoundOff(taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) }), p(d.total)),
        totalLabel: 'Total', totalPaise: p(d.total),
        after: p(d.invoiced_amount) ? [{ label: 'Invoiced', paise: p(d.invoiced_amount) }] : [],
        allocations: null, notes: null, terms: null,
      };
    }
    case 'challan': {
      const d = await ex.selectFrom('delivery_challans').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('challan_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.challan_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.challan_date)!;
      const { seller } = await sellerOf(ex, orgId, d.branch_id, date);
      seller.label = 'Consigner';
      const { party, shipTo } = await partyOf(ex, orgId, d.customer_id, 'Consignee');
      const ship: PrintParty | null = d.ship_to_address
        ? { label: 'Deliver to', name: d.ship_to_name || party.name, address: d.ship_to_address, city: d.ship_to_city, pincode: d.ship_to_pincode, stateCode: d.ship_to_state_code }
        : shipTo && { ...shipTo, label: 'Deliver to' };
      const total = p(d.total);
      // The order it was delivered against, and the invoice raised from it, printed with it.
      const order = d.source_so_id
        ? await ex.selectFrom('sales_orders').select('number').where('id', '=', d.source_so_id).where('org_id', '=', orgId).executeTakeFirst()
        : undefined;
      // Raised from it, or the one it was sent with (an order made ready for delivery).
      const invoiced = await ex.selectFrom('invoices').select('number')
        .where('org_id', '=', orgId)
        .where((eb) => eb.or([
          eb.and([eb('source_doc_type', '=', 'challan'), eb('source_doc_id', '=', d.id)]),
          ...(d.invoice_id ? [eb('id', '=', d.invoice_id)] : []),
        ]))
        .where('status', 'not in', ['void', 'draft']).orderBy('id').execute();
      return {
        kind, id: asId(d.id), number: d.number, title: 'Delivery Challan',
        endorsement: d.challan_type && CHALLAN_PURPOSE[d.challan_type] ? `Purpose: ${CHALLAN_PURPOSE[d.challan_type]}` : null,
        date, status: d.status, tag: d.status === 'cancelled' ? 'Cancelled' : null,
        // Rule 55(2): original for the consignee, duplicate for the transporter, triplicate for the consigner.
        copies: ['Original for consignee', 'Duplicate for transporter', 'Triplicate for consigner'],
        seller, party, partyId: asId(d.customer_id), shipTo: ship, placeOfSupply: d.place_of_supply, taxColumns: 'none',
        facts: [
          { label: 'Challan no.', value: d.number }, { label: 'Challan date', value: day(date) },
          ...(order ? [{ label: 'Sales order', value: order.number }] : []),
          ...(invoiced.length ? [{ label: invoiced.length > 1 ? 'Invoices' : 'Invoice no.', value: invoiced.map((i) => i.number).join(', ') }] : []),
        ],
        lines: lines.map((l) => singleLineWith(l.description?.trim() || l.item_name || null, l.hsn_sac, Number(l.qty), l.uqc, p(l.rate), p(l.line_total))),
        totals: [], totalLabel: 'Value of goods', totalPaise: total, after: [], allocations: null, notes: d.notes, terms: null,
      };
    }
    case 'credit-note': {
      const d = await ex.selectFrom('credit_notes').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('credit_note_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.credit_note_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.note_date)!;
      const { seller, registration } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party } = await partyOf(ex, orgId, d.customer_id, 'Issued to');
      const against = d.against_invoice_id
        ? await ex.selectFrom('invoices').select(['number', 'invoice_date']).where('id', '=', d.against_invoice_id).where('org_id', '=', orgId).executeTakeFirst()
        : undefined;
      const cols = taxColumns(registration, d.supply_type, p(d.igst));
      const applied = p(d.applied_amount);
      return {
        kind, id: asId(d.id), number: d.number, title: 'Credit Note',
        endorsement: [against ? `Against invoice ${against.number} dated ${day(against.invoice_date)}` : null, d.reason].filter(Boolean).join(' · ') || null,
        date, status: d.status, tag: d.status === 'void' ? 'Cancelled' : null, copies: ORIGINAL,
        seller, party, partyId: asId(d.customer_id), shipTo: null, placeOfSupply: d.place_of_supply, taxColumns: cols,
        facts: [
          { label: 'Credit note no.', value: d.number }, { label: 'Date', value: day(date) },
          ...(against ? [{ label: 'Original invoice', value: `${against.number}, ${day(against.invoice_date)}` }] : []),
        ],
        lines: lines.map(taxedLine),
        totals: withRoundOff(taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) }), p(d.total)),
        totalLabel: 'Credit total', totalPaise: p(d.total),
        after: applied ? [{ label: d.status === 'refunded' ? 'Refunded or applied' : 'Applied', paise: applied }, { label: 'Credit remaining', paise: p(d.total) - applied }] : [],
        allocations: null, notes: null, terms: null,
      };
    }
    case 'retainer': {
      const d = await ex.selectFrom('retainer_invoices').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const date = iso(d.retainer_date)!;
      const { seller } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party } = await partyOf(ex, orgId, d.customer_id, 'Bill to');
      const amount = p(d.amount);
      const paid = p(d.amount_paid);
      return {
        kind, id: asId(d.id), number: d.number, title: 'Service Invoice', endorsement: 'An advance, adjusted against the invoices that follow',
        date, status: d.status, tag: d.status === 'draft' ? 'Draft' : d.status === 'void' ? 'Cancelled' : null, copies: ORIGINAL,
        seller, party, partyId: asId(d.customer_id), shipTo: null, placeOfSupply: null, taxColumns: 'none',
        facts: [{ label: 'Service invoice no.', value: d.number }, { label: 'Date', value: day(date) }],
        lines: [singleLine(d.description || 'Service', amount)],
        totals: [], totalLabel: 'Total', totalPaise: amount,
        after: [{ label: 'Paid', paise: paid }, { label: 'Balance due', paise: Math.max(amount - paid, 0) }],
        allocations: null, notes: null, terms: null,
      };
    }
    case 'payment-received':
    case 'payment-made': {
      const side = kind === 'payment-received' ? 'received' : 'made';
      const d = await ex.selectFrom('payments').selectAll().where('id', '=', id).where('org_id', '=', orgId).where('kind', '=', side).executeTakeFirst();
      if (!d) throw missing();
      const date = iso(d.payment_date)!;
      const { seller } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party } = await partyOf(ex, orgId, d.contact_id, side === 'received' ? 'Received from' : 'Paid to');
      const allocs = await ex.selectFrom('payment_allocations').select(['target_type', 'target_id', 'amount'])
        .where('payment_id', '=', id).where('org_id', '=', orgId).orderBy('id').execute();
      const ids = (t: string) => allocs.filter((a) => a.target_type === t).map((a) => a.target_id);
      const [invs, bills] = await Promise.all([
        ids('invoice').length ? ex.selectFrom('invoices').select(['id', 'number', 'invoice_date']).where('id', 'in', ids('invoice')).execute() : [],
        ids('bill').length ? ex.selectFrom('bills').select(['id', 'vendor_invoice_no', 'internal_no', 'bill_date']).where('id', 'in', ids('bill')).execute() : [],
      ]);
      const label = (a: (typeof allocs)[number]) => {
        if (a.target_type === 'invoice') { const i = invs.find((x) => x.id === a.target_id); return { number: i?.number ?? `Invoice ${a.target_id}`, date: iso(i?.invoice_date) }; }
        if (a.target_type === 'bill') { const b = bills.find((x) => x.id === a.target_id); return { number: b?.vendor_invoice_no || b?.internal_no || `Bill ${a.target_id}`, date: iso(b?.bill_date) }; }
        if (a.target_type === 'opening') return { number: 'Opening balance', date: null };
        return { number: `${a.target_type.replace('_', ' ')} ${a.target_id}`, date: null };
      };
      const bank = d.bank_account_id
        ? await ex.selectFrom('bank_accounts').select(['bank_name', 'account_number']).where('id', '=', d.bank_account_id).where('org_id', '=', orgId).executeTakeFirst()
        : undefined;
      const amount = p(d.amount);
      const tds = p(d.tds_amount);
      const advanceGst = p(d.advance_gst);
      // Rule 50: GST paid on an advance for services is shown on a receipt voucher.
      const voucher = side === 'received' && advanceGst > 0;
      const advanceTaxable = p(d.advance_amount) - advanceGst;
      return {
        kind, id: asId(d.id), number: d.number,
        title: voucher ? 'Receipt Voucher' : side === 'received' ? 'Payment Receipt' : 'Payment Advice',
        endorsement: voucher ? 'Advance received for a supply of services; tax paid on the advance' : null,
        date, status: d.status, tag: d.status === 'void' ? 'Cancelled' : null, copies: ORIGINAL,
        seller, party, partyId: asId(d.contact_id), shipTo: null,
        placeOfSupply: voucher ? d.advance_pos : null,
        taxColumns: voucher ? (p(d.advance_igst) > 0 ? 'integrated' : 'split') : 'none',
        facts: [
          { label: side === 'received' ? 'Receipt no.' : 'Payment no.', value: d.number },
          { label: 'Payment date', value: day(date) },
          { label: 'Mode', value: MODE[d.mode] ?? d.mode },
          ...(d.reference ? [{ label: 'Reference', value: d.reference }] : []),
          ...(bank ? [{ label: side === 'received' ? 'Deposited to' : 'Paid from', value: `${bank.bank_name ?? 'Bank'}${bank.account_number ? ` ····${bank.account_number.slice(-4)}` : ''}` }] : []),
        ],
        lines: voucher
          ? [{ ...singleLine('Advance received', advanceTaxable), gstRatePct: Number(d.advance_rate_pct ?? 0),
              cgstPaise: p(d.advance_cgst), sgstPaise: p(d.advance_sgst), igstPaise: p(d.advance_igst), totalPaise: p(d.advance_amount) }]
          : [],
        totals: [
          ...(tds ? [{ label: 'TDS deducted', paise: tds }] : []),
          ...(p(d.bank_charges) ? [{ label: 'Bank charges', paise: p(d.bank_charges) }] : []),
        ],
        totalLabel: side === 'received' ? 'Amount received' : 'Amount paid', totalPaise: amount,
        after: p(d.unapplied_amount) ? [{ label: side === 'received' ? 'In excess, held as an advance' : 'Paid in advance', paise: p(d.unapplied_amount) }] : [],
        allocations: allocs.length
          ? { label: side === 'received' ? 'Payment for' : 'Bills paid', rows: allocs.map((a) => ({ ...label(a), paise: p(a.amount) })) }
          : null,
        notes: d.notes, terms: null,
      };
    }
    case 'purchase-order': {
      const d = await ex.selectFrom('purchase_orders').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('purchase_order_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.purchase_order_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.order_date)!;
      const { seller, registration } = await sellerOf(ex, orgId, d.branch_id, date);
      seller.label = 'Buyer';
      const { party } = await partyOf(ex, orgId, d.vendor_id, 'Vendor');
      const cols = taxColumns(registration, d.supply_type, p(d.igst));
      return {
        kind, id: asId(d.id), number: d.number, title: 'Purchase Order', endorsement: null, date, status: d.status,
        tag: d.status === 'draft' ? 'Draft' : d.status === 'cancelled' ? 'Cancelled' : null, copies: ORIGINAL,
        seller, party, partyId: asId(d.vendor_id),
        // Goods come to the branch that ordered them.
        shipTo: { label: 'Deliver to', name: seller.name, address: seller.address, city: seller.city, pincode: seller.pincode, stateCode: seller.stateCode },
        placeOfSupply: d.place_of_supply, taxColumns: cols,
        facts: [
          { label: 'PO no.', value: d.number }, { label: 'Order date', value: day(date) },
          ...(d.expected_date ? [{ label: 'Expected delivery', value: day(d.expected_date) }] : []),
        ],
        lines: lines.map(taxedLine),
        totals: withRoundOff(taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) }), p(d.total)),
        totalLabel: 'Total', totalPaise: p(d.total),
        after: p(d.billed_amount) ? [{ label: 'Billed', paise: p(d.billed_amount) }] : [],
        allocations: null, notes: d.notes, terms: null,
      };
    }
    case 'vendor-credit': {
      const d = await ex.selectFrom('vendor_credits').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const date = iso(d.credit_date)!;
      const { seller } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party } = await partyOf(ex, orgId, d.vendor_id, 'Vendor');
      const against = d.against_bill_id
        ? await ex.selectFrom('bills').select(['vendor_invoice_no', 'internal_no', 'bill_date']).where('id', '=', d.against_bill_id).where('org_id', '=', orgId).executeTakeFirst()
        : undefined;
      const total = p(d.total);
      const applied = p(d.applied_amount);
      const billNo = against ? against.vendor_invoice_no || against.internal_no || 'bill' : null;
      return {
        kind, id: asId(d.id), number: d.number, title: 'Vendor Credit',
        endorsement: [against ? `Against your bill ${billNo} dated ${day(against.bill_date)}` : null, d.reason].filter(Boolean).join(' · ') || null,
        date, status: d.status, tag: d.status === 'void' ? 'Cancelled' : null, copies: ORIGINAL,
        seller, party, partyId: asId(d.vendor_id), shipTo: null, placeOfSupply: null, taxColumns: 'none',
        facts: [{ label: 'Credit no.', value: d.number }, { label: 'Date', value: day(date) }, ...(billNo ? [{ label: 'Your bill', value: billNo }] : [])],
        lines: [singleLine(d.reason || 'Credit', total)],
        totals: [], totalLabel: 'Credit total', totalPaise: total,
        after: applied ? [{ label: 'Applied', paise: applied }, { label: 'Credit remaining', paise: total - applied }] : [],
        allocations: null, notes: null, terms: null,
      };
    }
    case 'bill': {
      const d = await ex.selectFrom('bills').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
      if (!d) throw missing();
      const lines = await ex.selectFrom('bill_lines as l').leftJoin('items as i', 'i.id', 'l.item_id').selectAll('l').select('i.name as item_name')
        .where('l.bill_id', '=', id).orderBy('l.line_no').execute();
      const date = iso(d.bill_date)!;
      const { seller, registration } = await sellerOf(ex, orgId, d.branch_id, date);
      const { party } = await partyOf(ex, orgId, d.vendor_id, 'Vendor');
      const cols = taxColumns(registration, d.supply_type, p(d.igst));
      const total = p(d.total);
      const paid = p(d.amount_paid);
      const tds = p(d.tds_amount);
      const totals = taxTotals(cols, p(d.subtotal), { cgst: p(d.cgst), sgst: p(d.sgst), igst: p(d.igst), cess: p(d.cess) });
      return {
        kind, id: asId(d.id), number: d.vendor_invoice_no || d.internal_no || `Bill ${d.id}`, title: 'Bill',
        endorsement: d.is_rcm ? 'Tax payable on reverse charge' : null, date, status: d.status,
        tag: d.status === 'draft' ? 'Draft' : d.status === 'void' ? 'Cancelled' : null, copies: ORIGINAL,
        // The vendor issued it: they head the sheet, and the business is who it was billed to.
        seller: { ...seller, label: 'Billed to' }, party, partyId: asId(d.vendor_id), shipTo: null,
        placeOfSupply: d.place_of_supply, taxColumns: cols,
        facts: [
          { label: 'Bill no.', value: d.vendor_invoice_no || '—' },
          ...(d.internal_no ? [{ label: 'Our reference', value: d.internal_no }] : []),
          { label: 'Bill date', value: day(date) }, { label: 'Due date', value: day(d.due_date) },
          { label: 'Reverse charge', value: d.is_rcm ? 'Yes' : 'No' },
        ],
        lines: lines.map(taxedLine),
        totals: d.round_off != null && p(d.round_off) ? [...totals, { label: 'Round off', paise: p(d.round_off) }] : withRoundOff(totals, total),
        totalLabel: 'Total', totalPaise: total,
        after: [
          ...(tds ? [{ label: 'TDS deducted', paise: tds }] : []),
          ...(paid ? [{ label: 'Paid', paise: paid }] : []),
          { label: 'Balance due', paise: Math.max(total - tds - paid, 0) },
        ],
        allocations: null, notes: d.notes, terms: null,
      };
    }
  }
}

function singleLineWith(description: string | null, hsnSac: string | null, qty: number, uqc: string | null, ratePaise: number, totalPaise: number): PrintLine {
  return { ...singleLine(description, totalPaise), hsnSac, qty, uqc, ratePaise };
}

/**
 * A document as someone outside the business may see it — through a link or
 * the portal. The notes on a bill or a payment are the business's own, for its
 * staff; a quote's or an order's notes are written for the customer and stay.
 */
export function forOutside(doc: PrintDoc): PrintDoc {
  return doc.kind === 'bill' || doc.kind === 'payment-made' || doc.kind === 'payment-received' ? { ...doc, notes: null } : doc;
}

/** The customer or vendor a document belongs to, for checking a portal's claim on it. */
const PARTY_OF: Record<PrintKind, [table: string, column: string, paymentKind?: 'received' | 'made']> = {
  estimate: ['estimates', 'customer_id'], 'sales-order': ['sales_orders', 'customer_id'], challan: ['delivery_challans', 'customer_id'],
  'credit-note': ['credit_notes', 'customer_id'], retainer: ['retainer_invoices', 'customer_id'], 'payment-received': ['payments', 'contact_id', 'received'],
  'purchase-order': ['purchase_orders', 'vendor_id'], 'vendor-credit': ['vendor_credits', 'vendor_id'], 'payment-made': ['payments', 'contact_id', 'made'],
  bill: ['bills', 'vendor_id'],
};

export async function documentParty(ex: Executor, orgId: number, kind: PrintKind, id: number): Promise<{ contactId: number; status: string } | null> {
  // Table and column come from the map above, never from the request.
  const [table, column, paymentKind] = PARTY_OF[kind];
  const { rows } = await sql<{ contact_id: number; status: string }>`
    SELECT ${sql.ref(column)} AS contact_id, status FROM ${sql.table(table)}
    WHERE id = ${id} AND org_id = ${orgId} ${paymentKind ? sql`AND kind = ${paymentKind}` : sql``}`.execute(ex);
  return rows[0] ? { contactId: Number(rows[0].contact_id), status: rows[0].status } : null;
}
