import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Email templates (migration 096): the wording of the emails the books send,
// which a business may change as Zoho Books lets it — the invoice email, the
// statement, payment reminders, the portal invitation, and one for each other
// document that goes by email (a quote, a sales order, a payment receipt, a
// purchase order …). Placeholders in
// braces are filled in when each email goes; one that does not apply is left
// empty. A kind nobody has edited uses the wording below.
//
// The sign-in code email is not here: its wording is part of keeping it safe.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest } from '../http';

/** The emails that send one document's printed copy as a link (lib/print-doc.ts). */
export type DocumentEmailKind =
  | 'quote' | 'sales_order' | 'proforma' | 'challan' | 'credit_note' | 'retainer' | 'payment_receipt'
  | 'purchase_order' | 'vendor_credit' | 'payment_advice';
export type EmailKind = 'invoice' | 'statement' | 'reminder' | 'portal_invite' | DocumentEmailKind;
export const EMAIL_KINDS: EmailKind[] = [
  'invoice', 'quote', 'sales_order', 'proforma', 'challan', 'credit_note', 'retainer', 'payment_receipt',
  'purchase_order', 'vendor_credit', 'payment_advice', 'statement', 'reminder', 'portal_invite',
];

/** What every document email can say. */
const DOC_PLACEHOLDERS = {
  party: 'The customer’s or vendor’s name', document: 'What it is: quote, sales order …', number: 'Its number', date: 'Its date',
  total: 'Its total, or the amount paid', detail_line: 'A line about this document: valid until, what it was against, what was paid',
  link: 'The link to view and download it', business: 'Your business name',
};
const doc = (label: string, when: string, subject: string, opening: string): KindSpec => ({
  label, when, placeholders: DOC_PLACEHOLDERS, required: ['link'], subject,
  body: `Dear {party},\n\n${opening}\n{detail_line}\n\nView or download it here: {link}\n\nRegards,\n{business}`,
});

interface KindSpec { label: string; when: string; placeholders: Record<string, string>; required: string[]; subject: string; body: string }

export const EMAIL_SPECS: Record<EmailKind, KindSpec> = {
  invoice: {
    label: 'Invoice', when: 'An invoice or debit note is emailed to the customer.',
    placeholders: {
      customer: 'The customer’s name', document: 'invoice or debit note', number: 'Its number', date: 'Its date', total: 'Its total',
      balance: 'What is still owed', due_date: 'When it falls due', balance_line: 'A line saying what is due and when, or that it is paid',
      link: 'The link to view, download and pay it', business: 'Your business name',
    },
    required: ['link'],
    subject: '{Document} {number} from {business}',
    body: 'Dear {customer},\n\nPlease find {document} {number} dated {date} for {total}.\n{balance_line}\n\nView, download or pay it here: {link}\n\nRegards,\n{business}',
  },
  quote: doc('Quote', 'A quote is emailed to the customer.', 'Quote {number} from {business}',
    'Thank you for your enquiry. Please find our quote {number} dated {date} for {total}.'),
  sales_order: doc('Sales order', 'A sales order is emailed to the customer.', 'Sales order {number} from {business}',
    'Thank you for your order. Please find sales order {number} dated {date} for {total}.'),
  proforma: doc('Proforma invoice', 'A sales order’s proforma invoice is emailed to the customer.', 'Proforma invoice {number} from {business}',
    'Please find proforma invoice {number} dated {date} for {total}, for your approval or advance payment.'),
  challan: doc('Delivery challan', 'A delivery challan is emailed to the customer.', 'Delivery challan {number} from {business}',
    'Please find delivery challan {number} dated {date} for the goods we are sending you.'),
  credit_note: doc('Credit note', 'A credit note is emailed to the customer.', 'Credit note {number} from {business}',
    'Please find credit note {number} dated {date} for {total}.'),
  retainer: doc('Service invoice', 'A service invoice (an advance) is emailed to the customer.', 'Service invoice {number} from {business}',
    'Please find service invoice {number} dated {date} for {total}, an advance adjusted against the invoices that follow.'),
  payment_receipt: doc('Payment receipt (thank you)', 'A receipt for a payment received is emailed to the customer.', 'Payment received: thank you',
    'Thank you for your payment. We have received {total} on {date}, receipt {number}.'),
  purchase_order: doc('Purchase order', 'A purchase order is emailed to the vendor.', 'Purchase order {number} from {business}',
    'Please find our purchase order {number} dated {date} for {total}. Kindly confirm it and let us know when to expect the goods.'),
  vendor_credit: doc('Vendor credit', 'A vendor credit is emailed to the vendor.', 'Vendor credit {number} from {business}',
    'Please find vendor credit {number} dated {date} for {total}.'),
  payment_advice: doc('Payment advice', 'A payment made is emailed to the vendor.', 'Payment of {total} from {business}',
    'We have made a payment of {total} on {date}, our reference {number}.'),
  statement: {
    label: 'Statement of account', when: 'A customer’s or vendor’s statement is emailed, with the spreadsheet attached.',
    placeholders: {
      party: 'The customer’s or vendor’s name', from: 'The first day', to: 'The last day', opening: 'Opening balance', charges: 'Invoiced or billed in the period',
      payments: 'Received or paid in the period', closing: 'Balance at the end', business: 'Your business name',
      charges_label: '“Invoiced” or “Billed”', payments_label: '“Received” or “Paid”', closing_label: '“Balance due” or “Balance payable”',
      check_line: 'Asks a customer to confirm within 15 days, or a vendor to check it',
    },
    required: [],
    subject: 'Statement of account {from} – {to} from {business}',
    body: 'Dear {party},\n\nHere is your statement of account with us from {from} to {to}.\n\nOpening balance: {opening}\n{charges_label}: {charges}\n{payments_label}: {payments}\n{closing_label} on {to}: {closing}\n\n{check_line}\n\nRegards,\n{business}',
  },
  reminder: {
    label: 'Payment reminder', when: 'A payment reminder is queued for an unpaid invoice (email, WhatsApp or SMS).',
    placeholders: {
      customer: 'The customer’s name', number: 'The invoice number', balance: 'What is still owed', due_date: 'When it falls due',
      due_words: '“falls due on …”, “falls due today” or “fell due on …”', link: 'The link to view and pay it', business: 'Your business name',
    },
    required: ['link'],
    subject: 'Invoice {number}: payment reminder',
    body: 'Dear {customer}, a reminder that invoice {number} for {balance} {due_words}. You can see it and pay here: {link}\n— {business}',
  },
  portal_invite: {
    label: 'Portal invitation', when: 'A customer or vendor is given access to their portal by email.',
    placeholders: {
      contact: 'The customer’s or vendor’s name', what: 'What they can do there, as a customer or as a supplier', link: 'Their portal link',
      expires: 'The last day the link works', business: 'Your business name',
    },
    required: ['link'],
    subject: 'Your account with {business}',
    body: 'Hello {contact},\n\n{what}\n{link}\n\nThe link is yours alone and works until {expires}. You can also sign in at any time with your email address.\n\nRegards,\n{business}',
  },
};

/** Fill the braces. `{Document}` is `{document}` with a capital; unknown placeholders are left as typed. */
export function fill(text: string, vars: Record<string, string>) {
  return text.replace(/\{([A-Za-z_]+)\}/g, (whole, key: string) => {
    const lower = key.toLowerCase();
    if (!(lower in vars)) return whole;
    const v = vars[lower] ?? '';
    return key[0] === key[0].toUpperCase() && key[0] !== key[0].toLowerCase() ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  });
}

export async function getTemplate(ex: Executor, orgId: number, kind: EmailKind) {
  const row = await ex.selectFrom('email_templates').select(['subject', 'body', 'updated_at']).where('org_id', '=', orgId).where('kind', '=', kind).executeTakeFirst();
  const spec = EMAIL_SPECS[kind];
  return { kind, subject: row?.subject ?? spec.subject, body: row?.body ?? spec.body, custom: !!row, updatedAt: row ? new Date(row.updated_at).toISOString() : null };
}

/** The email for a kind, filled in. */
export async function renderEmail(ex: Executor, orgId: number, kind: EmailKind, vars: Record<string, string>) {
  const t = await getTemplate(ex, orgId, kind);
  return { subject: fill(t.subject, vars).replace(/\s+/g, ' ').trim().slice(0, 300), text: fill(t.body, vars) };
}

export async function listTemplates(ex: Executor, orgId: number) {
  const out = [];
  for (const kind of EMAIL_KINDS) {
    const t = await getTemplate(ex, orgId, kind);
    const spec = EMAIL_SPECS[kind];
    out.push({ ...t, label: spec.label, when: spec.when, placeholders: spec.placeholders, required: spec.required, defaultSubject: spec.subject, defaultBody: spec.body });
  }
  return out;
}

export async function saveTemplate(trx: Trx, orgId: number, userId: number | null, kind: EmailKind, input: { subject: string; body: string }) {
  const spec = EMAIL_SPECS[kind];
  const subject = input.subject.trim();
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!subject) throw badRequest('The email needs a subject.');
  if (subject.length > 300) throw badRequest('Keep the subject under 300 characters.');
  if (!body) throw badRequest('The email needs some words.');
  if (body.length > 5000) throw badRequest('Keep the email under 5,000 characters.');
  for (const p of spec.required) {
    if (!new RegExp(`\\{${p}\\}`, 'i').test(body)) throw badRequest(`Keep {${p}} in the email: without it the ${kind === 'portal_invite' ? 'contact cannot open their portal' : kind === 'invoice' || kind === 'reminder' ? 'customer cannot open the invoice' : 'recipient cannot open the document'}.`);
  }
  const unknown = [...`${subject}\n${body}`.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1].toLowerCase()).filter((k) => !(k in spec.placeholders));
  if (unknown.length) throw badRequest(`{${unknown[0]}} is not a placeholder this email knows. It can use: ${Object.keys(spec.placeholders).map((k) => `{${k}}`).join(', ')}.`);
  const existing = await trx.selectFrom('email_templates').select('id').where('org_id', '=', orgId).where('kind', '=', kind).executeTakeFirst();
  if (existing) await trx.updateTable('email_templates').set({ subject, body, updated_by_user_id: userId }).where('id', '=', existing.id).execute();
  else await trx.insertInto('email_templates').values({ org_id: orgId, kind, subject, body, updated_by_user_id: userId }).execute();
}

/** Back to the built-in wording. */
export async function resetTemplate(trx: Trx, orgId: number, kind: EmailKind) {
  await trx.deleteFrom('email_templates').where('org_id', '=', orgId).where('kind', '=', kind).execute();
}
