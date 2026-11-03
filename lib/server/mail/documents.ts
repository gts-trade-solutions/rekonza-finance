import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The emails the app sends about documents: an invoice (with a link to view
// and pay it, lib/server/services/sharing.ts), any other document — a quote, a
// sales order, a receipt, a purchase order … (lib/print-doc.ts) — with a link
// to its printed copy, a statement of account (with the statement as a
// spreadsheet), and payment reminders.
//
// An invoice goes as a link rather than an attached PDF: the PDF would have to
// be drawn on the server, and the link opens the same printed invoice the
// customer can save, which also tells the business when it was opened.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Executor } from '../db';
import { badRequest, notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import { workbook } from '../../xlsx';
import { createDocumentLink, createShareLink } from '../services/sharing';
import { printableDocument } from '../services/document-print';
import { EMAILABLE, PRINT_NOUN, type PrintDoc, type PrintKind } from '../../print-doc';
import { markInvoiceSent } from '../services/sales';
import { partyStatement, type StatementSide } from '../reports/party-statement';
import { documentRecipients, mailStatus, sendMail, siteUrl } from './mailer';
import { renderEmail, type DocumentEmailKind } from './templates';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function sender(ex: Executor, orgId: number) {
  const org = await ex.selectFrom('organizations').select(['name', 'legal_name', 'email']).where('id', '=', orgId).executeTakeFirstOrThrow();
  return { name: org.legal_name || org.name, replyTo: org.email };
}

export interface EmailOptions { to?: string[]; cc?: string[]; message?: string | null; baseUrl?: string; proforma?: boolean }

export async function emailInvoice(orgId: number, userId: number | null, invoiceId: number, opts: EmailOptions = {}) {
  const inv = await db.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
    .select(['i.id', 'i.number', 'i.status', 'i.doc_kind', 'i.invoice_date', 'i.due_date', 'i.total', 'i.amount_paid', 'i.customer_id', 'c.display_name'])
    .where('i.id', '=', invoiceId).where('i.org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.status === 'draft') throw badRequest('A draft is not an invoice yet; issue it before sending it.');
  if (inv.status === 'void') throw badRequest('That invoice is void.');
  const to = opts.to?.length ? opts.to : await documentRecipients(db, orgId, inv.customer_id);
  if (!to.length) throw badRequest(`${inv.display_name} has no email address. Add one to the customer, or to a contact person.`);
  const from = await sender(db, orgId);
  const kind = inv.doc_kind === 'debit_note' ? 'Debit note' : 'Invoice';
  const due = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);

  return transaction(async (trx) => {
    const link = await createShareLink(trx, orgId, userId, { invoiceId: inv.id, days: 90 });
    const url = `${(opts.baseUrl ?? siteUrl()).replace(/\/$/, '')}${link.path}`;
    // The business's own wording (mail/templates.ts); a message typed when sending replaces it for this email.
    const vars = {
      customer: inv.display_name, document: kind.toLowerCase(), number: inv.number, date: dmy(String(inv.invoice_date)), total: inr(toPaiseFromSql(inv.total)),
      balance: inr(Math.max(due, 0)), due_date: dmy(String(inv.due_date)), link: url, business: from.name,
      balance_line: due > 0 ? `${inr(due)} is due by ${dmy(String(inv.due_date))}.` : 'It has been paid in full. Thank you.',
    };
    const mail = await renderEmail(trx, orgId, 'invoice', vars);
    const typed = opts.message?.trim();
    const text = typed ? (typed.includes(url) ? typed : `${typed}\n\nView, download or pay it here: ${url}\n\nRegards,\n${from.name}`) : mail.text;
    const sent = await sendMail(orgId, {
      to, cc: opts.cc, subject: mail.subject, text, replyTo: from.replyTo, fromName: from.name,
    }, { docType: 'invoice', docId: inv.id, userId, ex: trx });
    if (inv.status === 'approved') await markInvoiceSent(trx, orgId, userId, inv.id);
    return { to, messageId: sent.messageId, link: url };
  });
}

const EMAIL_KIND: Record<Exclude<PrintKind, 'bill'>, DocumentEmailKind> = {
  estimate: 'quote', 'sales-order': 'sales_order', challan: 'challan', 'credit-note': 'credit_note', retainer: 'retainer',
  'payment-received': 'payment_receipt', 'purchase-order': 'purchase_order', 'vendor-credit': 'vendor_credit', 'payment-made': 'payment_advice',
};

/** The {detail_line} of a document email: what this one is about, in a sentence. */
function detailLine(d: PrintDoc): string {
  const fact = (label: string) => d.facts.find((f) => f.label === label)?.value;
  const after = (label: string) => d.after.find((a) => a.label === label)?.paise ?? 0;
  const paidFor = d.allocations?.rows.map((r) => r.number).join(', ');
  switch (d.kind) {
    case 'estimate': return fact('Valid until') ? `It is valid until ${fact('Valid until')}.` : '';
    case 'sales-order': return fact('Expected shipment') ? `We expect to ship it by ${fact('Expected shipment')}.` : '';
    case 'challan': return d.endorsement ? `${d.endorsement}.` : 'The goods travel with this challan.';
    case 'credit-note': return d.endorsement ? `${d.endorsement}.` : '';
    case 'retainer': return after('Balance due') > 0 ? `${inr(after('Balance due'))} is due.` : 'It has been paid. Thank you.';
    case 'payment-received': return paidFor ? `It has been applied to ${paidFor}.` : 'It is held as an advance against your next invoice.';
    case 'purchase-order': return fact('Expected delivery') ? `Please deliver by ${fact('Expected delivery')}.` : '';
    case 'vendor-credit': return d.endorsement ? `${d.endorsement}.` : '';
    case 'payment-made': return [paidFor ? `It settles ${paidFor}.` : null, `Paid by ${fact('Mode') ?? 'bank'}${fact('Reference') ? `, reference ${fact('Reference')}` : ''}.`].filter(Boolean).join(' ');
    default: return '';
  }
}

/**
 * Email a quote, sales order, challan, credit note, retainer, receipt,
 * purchase order, vendor credit or payment advice: a link to its printed copy,
 * worded by the business's template for that kind. A draft quote or retainer
 * becomes sent and a draft purchase order is issued, as an invoice becomes sent.
 */
export async function emailDocument(orgId: number, userId: number | null, kind: PrintKind, id: number, opts: EmailOptions = {}) {
  if (kind === 'bill' || !EMAILABLE[kind]) throw badRequest('A bill is the vendor’s own document; there is nothing to send them.');
  // A sales order's proforma invoice goes as itself, in its own words.
  const proforma = kind === 'sales-order' && !!opts.proforma;
  const noun = proforma ? 'proforma invoice' : PRINT_NOUN[kind];
  const d = await printableDocument(db, orgId, kind, id, { proforma });
  if (d.tag === 'Cancelled') throw badRequest(`That ${noun} was cancelled.`);
  const to = opts.to?.length ? opts.to : await documentRecipients(db, orgId, Number(d.partyId));
  if (!to.length) throw badRequest(`${d.party.name} has no email address. Add one to the contact, or to a contact person.`);
  const from = await sender(db, orgId);

  return transaction(async (trx) => {
    if (d.status === 'draft') {
      if (kind === 'estimate') await trx.updateTable('estimates').set({ status: 'sent' }).where('id', '=', id).where('org_id', '=', orgId).execute();
      if (kind === 'retainer') await trx.updateTable('retainer_invoices').set({ status: 'sent' }).where('id', '=', id).where('org_id', '=', orgId).execute();
      if (kind === 'purchase-order') await trx.updateTable('purchase_orders').set({ status: 'open' }).where('id', '=', id).where('org_id', '=', orgId).execute();
    }
    const link = await createDocumentLink(trx, orgId, userId, { kind, id, days: 90, proforma });
    const url = `${(opts.baseUrl ?? siteUrl()).replace(/\/$/, '')}${link.path}`;
    const mail = await renderEmail(trx, orgId, proforma ? 'proforma' : EMAIL_KIND[kind], {
      party: d.party.name, document: noun, number: d.number, date: dmy(d.date), total: inr(d.totalPaise),
      detail_line: proforma ? '' : detailLine(d), link: url, business: from.name,
    });
    const typed = opts.message?.trim();
    const text = typed ? (typed.includes(url) ? typed : `${typed}\n\nView or download it here: ${url}\n\nRegards,\n${from.name}`) : mail.text;
    const sent = await sendMail(orgId, { to, cc: opts.cc, subject: mail.subject, text, replyTo: from.replyTo, fromName: from.name },
      { docType: kind, docId: id, userId, ex: trx });
    return { to, messageId: sent.messageId, link: url };
  });
}

export async function emailStatement(
  orgId: number, userId: number | null, contactId: number, side: StatementSide, from: string, to: string, opts: EmailOptions = {},
) {
  const s = await partyStatement(db, orgId, contactId, side, from, to);
  const recipients = opts.to?.length ? opts.to : await documentRecipients(db, orgId, contactId);
  if (!recipients.length) throw badRequest(`${s.party.name} has no email address. Add one to the contact, or to a contact person.`);
  const org = await sender(db, orgId);
  const words = side === 'customer' ? { charges: 'Invoiced', payments: 'Received', due: 'Balance due' } : { charges: 'Billed', payments: 'Paid', due: 'Balance payable' };
  const r = (p: number) => p / 100;
  const sheet = workbook([{
    name: 'Statement',
    rows: [
      [`Statement of account: ${s.party.name}`], [`${s.from} to ${s.to}`], [],
      ['Date', 'Transaction', 'Number', 'Details', words.charges, words.payments, 'Balance'],
      [s.from, 'Opening balance', '', '', '', '', r(s.openingPaise)],
      ...s.lines.map((l) => [l.date, l.kind, l.number, l.detail ?? '', l.chargePaise ? r(l.chargePaise) : '', l.paymentPaise ? r(l.paymentPaise) : '', r(l.balancePaise)]),
      [s.to, words.due, '', '', r(s.chargesPaise), r(s.paymentsPaise), r(s.closingPaise)],
    ],
  }]);
  const mail = await renderEmail(db, orgId, 'statement', {
    party: s.party.name, from: dmy(from), to: dmy(to), opening: inr(s.openingPaise), charges: inr(s.chargesPaise), payments: inr(s.paymentsPaise),
    closing: inr(s.closingPaise), business: org.name, charges_label: words.charges, payments_label: words.payments, closing_label: words.due,
    check_line: side === 'customer' ? 'Please check it against your books and let us know within 15 days if your balance differs.' : 'Please check it against your records.',
  });
  const text = opts.message?.trim() ? `${opts.message.trim()}\n\nRegards,\n${org.name}` : mail.text;
  const sent = await sendMail(orgId, {
    to: recipients, cc: opts.cc, subject: mail.subject, text,
    replyTo: org.replyTo, fromName: org.name,
    attachments: [{ filename: `statement-${s.party.name.replace(/[^A-Za-z0-9]+/g, '-')}-${from}-${to}.xlsx`, content: sheet, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  }, { docType: 'statement', docId: contactId, userId });
  return { to: recipients, messageId: sent.messageId };
}

/**
 * Payment reminders queued for email (services/reminders.ts), sent on their
 * own once mail is set up: the {link} in the message becomes a link to the
 * invoice. Those with no address, or whose invoice was paid meanwhile, are
 * left for a person or skipped.
 */
export async function sendQueuedEmailReminders(orgId: number, baseUrl?: string): Promise<number> {
  if (!mailStatus().configured) return 0;
  const queued = await db.selectFrom('payment_reminders as r').innerJoin('invoices as i', 'i.id', 'r.invoice_id')
    .select(['r.id', 'r.invoice_id', 'r.to_address', 'r.subject', 'r.message', 'i.total', 'i.amount_paid', 'i.status'])
    .where('r.org_id', '=', orgId).where('r.status', '=', 'queued').where('r.channel', '=', 'email').where('r.to_address', 'is not', null)
    .limit(200).execute();
  const from = await sender(db, orgId);
  let sent = 0;
  for (const r of queued) {
    const settled = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid) <= 0 || r.status === 'void';
    if (settled) {
      await db.updateTable('payment_reminders').set({ status: 'skipped', sent_at: new Date() }).where('id', '=', r.id).execute();
      continue;
    }
    try {
      await transaction(async (trx) => {
        const link = await createShareLink(trx, orgId, null, { invoiceId: r.invoice_id, days: 60 });
        const text = (r.message ?? '').replace('{link}', `${(baseUrl ?? siteUrl()).replace(/\/$/, '')}${link.path}`);
        await sendMail(orgId, { to: [r.to_address!], subject: r.subject ?? `Payment reminder from ${from.name}`, text, replyTo: from.replyTo, fromName: from.name },
          { docType: 'reminder', docId: r.invoice_id, ex: trx });
        await trx.updateTable('payment_reminders').set({ status: 'sent', sent_at: new Date() }).where('id', '=', r.id).execute();
      });
      sent++;
    } catch (err) {
      console.error('[reminders] email', r.id, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}
