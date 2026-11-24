import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' per-module Preferences — Quote Preferences, Sales Order, Invoice,
// Delivery Challan and Credit Note Preferences (migration 124, document_preferences).
//
// Only what Rekonza honours is offered:
//   - the Customer Notes and Terms & Conditions a new document starts with
//     (an invoice's are the organisation's own defaults, kept where the invoice
//     form and its PDF have always read them);
//   - whether a document may still be edited once it has gone to the customer
//     (sent and accepted quotes, confirmed orders, sent invoices, open credit
//     notes) — refused by the services' edit when switched off;
//   - what happens when a quote is accepted: nothing, or turned into a draft
//     invoice or a sales order there and then.
// Numbering lives in Settings → Transaction Number Series; the page links there.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest } from '../http';

export type DocPrefType = 'estimate' | 'sales_order' | 'invoice' | 'challan' | 'credit_note';
export const DOC_PREF_TYPES: DocPrefType[] = ['estimate', 'sales_order', 'invoice', 'challan', 'credit_note'];

export interface DocSettings {
  /** Quotes: sent and accepted ones may be edited. Orders: confirmed ones. Invoices: sent ones. Credit notes: open ones. */
  allowEditAfterSending?: boolean;
  /** Quotes only: what accepting one does. */
  onQuoteAccepted?: 'nothing' | 'invoice' | 'sales_order';
}

export interface DocPreferences { type: DocPrefType; notes: string | null; terms: string | null; settings: Required<Pick<DocSettings, 'allowEditAfterSending'>> & DocSettings }

const DEFAULTS: Record<DocPrefType, DocPreferences['settings']> = {
  estimate: { allowEditAfterSending: true, onQuoteAccepted: 'nothing' },
  sales_order: { allowEditAfterSending: true },
  invoice: { allowEditAfterSending: true },
  challan: { allowEditAfterSending: true },
  credit_note: { allowEditAfterSending: true },
};

const parse = (v: unknown): DocSettings => {
  if (!v) return {};
  try { return (typeof v === 'string' ? JSON.parse(v) : v) as DocSettings; } catch { return {}; }
};

export async function getDocPreferences(ex: Executor, orgId: number, type: DocPrefType): Promise<DocPreferences> {
  if (!DOC_PREF_TYPES.includes(type)) throw badRequest('There are no preferences for that.');
  const row = await ex.selectFrom('document_preferences').select(['notes', 'terms', 'settings'])
    .where('org_id', '=', orgId).where('doc_type', '=', type).executeTakeFirst();
  let notes = row?.notes ?? null;
  let terms = row?.terms ?? null;
  if (type === 'invoice') {
    // The invoice's defaults are the organisation's, which the invoice form and PDF read.
    const org = await ex.selectFrom('organizations').select(['default_invoice_notes', 'default_invoice_terms']).where('id', '=', orgId).executeTakeFirst();
    notes = org?.default_invoice_notes ?? null;
    terms = org?.default_invoice_terms ?? null;
  }
  return { type, notes, terms, settings: { ...DEFAULTS[type], ...parse(row?.settings) } };
}

export async function saveDocPreferences(
  trx: Trx, orgId: number, userId: number | null, type: DocPrefType,
  input: { notes?: string | null; terms?: string | null; settings?: DocSettings },
): Promise<DocPreferences> {
  if (!DOC_PREF_TYPES.includes(type)) throw badRequest('There are no preferences for that.');
  const current = await getDocPreferences(trx, orgId, type);
  const settings: DocSettings = { ...current.settings, ...(input.settings ?? {}) };
  if (type !== 'estimate') delete settings.onQuoteAccepted;
  else if (settings.onQuoteAccepted && !['nothing', 'invoice', 'sales_order'].includes(settings.onQuoteAccepted)) throw badRequest('Choose what accepting a quote does.');
  const notes = input.notes === undefined ? current.notes : input.notes?.trim() || null;
  const terms = input.terms === undefined ? current.terms : input.terms?.trim() || null;
  if (type === 'invoice') {
    await trx.updateTable('organizations').set({ default_invoice_notes: notes, default_invoice_terms: terms }).where('id', '=', orgId).execute();
  }
  const values = { notes: type === 'invoice' ? null : notes, terms: type === 'invoice' ? null : terms, settings: JSON.stringify(settings), updated_by_user_id: userId };
  const exists = await trx.selectFrom('document_preferences').select('org_id').where('org_id', '=', orgId).where('doc_type', '=', type).executeTakeFirst();
  if (exists) await trx.updateTable('document_preferences').set(values).where('org_id', '=', orgId).where('doc_type', '=', type).execute();
  else await trx.insertInto('document_preferences').values({ org_id: orgId, doc_type: type, ...values }).execute();
  return getDocPreferences(trx, orgId, type);
}

/** Whether a document that has gone to the customer may still be edited, per its module's preference. */
export async function editAfterSendingAllowed(ex: Executor, orgId: number, type: DocPrefType): Promise<boolean> {
  return (await getDocPreferences(ex, orgId, type)).settings.allowEditAfterSending !== false;
}
