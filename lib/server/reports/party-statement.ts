import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A statement of account: what a customer owed at the start of a period, every
// invoice, receipt and credit since, and what they owe at the end — the sheet a
// business sends when a customer asks "what do we owe you?", or a vendor's
// statement is checked against.
//
// It is read from the party's lines on the receivable or payable control
// account, not assembled from documents, so it agrees with the ageing and the
// balance sheet at every date: an opening balance from before the books
// started, a write-off, a cheque that bounced or a journal someone posted by
// hand all appear, because they all moved the balance. A list built from
// invoices and receipts would leave those out and disagree with the ledger by
// exactly the amount the customer is disputing.
//
// A document voided inside the period shows neither its entry nor the reversal:
// together they did nothing, and a customer reading a statement does not need
// an invoice that never happened. Voided after the period opened, both stay —
// the opening balance counted the original.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { notFound } from '../http';

export type StatementSide = 'customer' | 'vendor';

export interface StatementLine {
  date: string;
  /** "Invoice", "Payment received", … */
  kind: string;
  number: string;
  /** A due date, the vendor's own bill number, a journal's narration. */
  detail: string | null;
  sourceType: string;
  sourceId: string | null;
  /** What raised the balance: an invoice to a customer, a bill from a vendor. */
  chargePaise: Paise;
  /** What brought it down: a receipt, a credit note, a payment made. */
  paymentPaise: Paise;
  balancePaise: Paise;
}

export interface PartyStatement {
  side: StatementSide;
  from: string;
  to: string;
  party: {
    id: string; name: string; legalName: string | null; gstin: string | null; stateCode: string | null;
    address: string | null; email: string | null; phone: string | null;
  };
  org: {
    name: string; legalName: string | null; gstin: string | null; address: string | null;
    email: string | null; phone: string | null;
  };
  openingPaise: Paise;
  chargesPaise: Paise;
  paymentsPaise: Paise;
  closingPaise: Paise;
  lines: StatementLine[];
}

const KIND: Record<string, string> = {
  invoice: 'Invoice',
  payment_received: 'Payment received',
  credit_note: 'Credit note',
  credit_note_refund: 'Refund',
  retainer: 'Service invoice',
  retainer_application: 'Service invoice applied',
  bill: 'Bill',
  payment_made: 'Payment made',
  vendor_credit: 'Vendor credit',
  vendor_credit_refund: 'Refund received',
  expense: 'Expense',
  opening: 'Opening balance',
  opening_balance: 'Opening balance',
  opening_document: 'Opening balance',
  write_off: 'Write-off',
  cheque_return: 'Cheque returned',
  advance_adjustment: 'Advance adjusted',
  fx_settlement: 'Exchange difference',
  fx_revaluation: 'Exchange revaluation',
  manual: 'Journal',
  bank_txn: 'Bank entry',
};

/** Document numbers by source type: the table, and the column the party knows it by. */
const NUMBERS: { types: string[]; table: string; column: string }[] = [
  { types: ['invoice'], table: 'invoices', column: 'number' },
  { types: ['bill'], table: 'bills', column: 'internal_no' },
  { types: ['payment_received', 'payment_made'], table: 'payments', column: 'number' },
  { types: ['credit_note'], table: 'credit_notes', column: 'number' },
  { types: ['vendor_credit'], table: 'vendor_credits', column: 'number' },
  { types: ['retainer'], table: 'retainer_invoices', column: 'number' },
  { types: ['opening_document'], table: 'opening_documents', column: 'ref_no' },
];

export async function partyStatement(
  ex: Executor,
  orgId: number,
  contactId: number,
  side: StatementSide,
  from: string,
  to: string,
  /** Zoho's "Filter By": every transaction, or only the documents still unpaid. */
  filter: 'all' | 'outstanding' = 'all',
): Promise<PartyStatement> {
  if (filter === 'outstanding') return outstandingStatement(ex, orgId, contactId, side, from, to);
  const c = await ex.selectFrom('contacts')
    .select(['id', 'display_name', 'legal_name', 'gstin', 'state_code', 'billing_address', 'email', 'phone'])
    .where('org_id', '=', orgId).where('id', '=', contactId).executeTakeFirst();
  if (!c) throw notFound('That contact does not exist.');
  const org = await ex.selectFrom('organizations')
    .select(['name', 'legal_name', 'address', 'email', 'phone'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  const branch = await ex.selectFrom('branches').select(['gstin', 'address'])
    .where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('id').executeTakeFirst();

  const control = side === 'customer' ? CODE.AR : CODE.AP;
  // Positive is what the party owes us (a customer) or we owe them (a vendor).
  const sign = side === 'customer' ? 1 : -1;

  const { rows: open } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND a.code = ${control} AND jl.contact_id = ${contactId}
       AND jl.entry_date < ${from}
  `.execute(ex);
  const openingPaise = sign * toPaiseFromSql(open[0]?.v ?? '0');

  const { rows } = await sql<{
    entry_id: number; entry_no: number; entry_date: string; memo: string | null; description: string | null;
    source_type: string; source_id: number | null; reversal_of_entry_id: number | null; debit: string; credit: string;
  }>`
    SELECT jl.entry_id, je.entry_no, jl.entry_date, je.memo, jl.description, je.source_type, je.source_id,
           je.reversal_of_entry_id, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.org_id = ${orgId} AND a.code = ${control} AND jl.contact_id = ${contactId}
       AND jl.entry_date >= ${from} AND jl.entry_date <= ${to}
     ORDER BY jl.entry_date, je.entry_no, jl.id
  `.execute(ex);

  // An entry and its reversal both inside the period cancel out of the sheet.
  const inPeriod = new Set(rows.map((r) => r.entry_id));
  const cancelled = new Set<number>();
  for (const r of rows) {
    if (r.reversal_of_entry_id && inPeriod.has(r.reversal_of_entry_id)) {
      cancelled.add(r.entry_id);
      cancelled.add(r.reversal_of_entry_id);
    }
  }
  const kept = rows.filter((r) => !cancelled.has(r.entry_id));

  // Each document's own number, fetched once per kind.
  const numbers = new Map<string, { number: string; detail: string | null; kind?: string }>();
  for (const n of NUMBERS) {
    const ids = [...new Set(kept.filter((r) => n.types.includes(r.source_type) && r.source_id).map((r) => Number(r.source_id)))];
    if (!ids.length) continue;
    const extra = n.table === 'invoices' ? sql`, due_date AS detail, doc_kind AS kind`
      : n.table === 'bills' ? sql`, vendor_invoice_no AS detail`
      : sql`, NULL AS detail`;
    const { rows: found } = await sql<{ id: number; number: string; detail: string | null; kind?: string }>`
      SELECT id, ${sql.ref(n.column)} AS number ${extra} FROM ${sql.table(n.table)}
       WHERE org_id = ${orgId} AND id IN (${sql.join(ids)})
    `.execute(ex);
    for (const f of found) {
      const detail = n.table === 'invoices' && f.detail ? `Due ${String(f.detail).slice(0, 10)}`
        : n.table === 'bills' && f.detail ? `Their no. ${f.detail}` : null;
      const kind = f.kind === 'debit_note' ? 'Debit note' : undefined;
      for (const t of n.types) numbers.set(`${t}:${f.id}`, { number: f.number, detail, kind });
    }
  }

  let running = openingPaise;
  let chargesPaise = 0;
  let paymentsPaise = 0;
  const lines: StatementLine[] = kept.map((r) => {
    const net = sign * (toPaiseFromSql(r.debit) - toPaiseFromSql(r.credit));
    const charge = net > 0 ? net : 0;
    const payment = net < 0 ? -net : 0;
    running += net;
    chargesPaise += charge;
    paymentsPaise += payment;
    const doc = r.source_id ? numbers.get(`${r.source_type}:${r.source_id}`) : undefined;
    const reversal = r.reversal_of_entry_id ? ' (cancelled)' : '';
    return {
      date: String(r.entry_date).slice(0, 10),
      kind: (doc?.kind ?? KIND[r.source_type] ?? r.source_type.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase())) + reversal,
      number: doc?.number ?? `JE-${r.entry_no}`,
      detail: doc?.detail ?? (r.source_type === 'manual' || !doc ? (r.description || r.memo) : null),
      sourceType: r.source_type,
      sourceId: r.source_id ? String(r.source_id) : null,
      chargePaise: charge,
      paymentPaise: payment,
      balancePaise: running,
    };
  });

  return {
    side,
    from,
    to,
    party: {
      id: String(c.id), name: c.display_name, legalName: c.legal_name, gstin: c.gstin, stateCode: c.state_code,
      address: c.billing_address, email: c.email, phone: c.phone,
    },
    org: {
      name: org.name, legalName: org.legal_name, gstin: branch?.gstin ?? null,
      address: org.address ?? branch?.address ?? null, email: org.email, phone: org.phone,
    },
    openingPaise,
    chargesPaise,
    paymentsPaise,
    closingPaise: running,
    lines,
  };
}

/**
 * Zoho's statement filtered to "Outstanding": only the invoices (or, for a
 * vendor, the bills) raised in the period that are still unpaid, and any
 * opening balance still owed, each with what is left on it.
 */
async function outstandingStatement(ex: Executor, orgId: number, contactId: number, side: StatementSide, from: string, to: string): Promise<PartyStatement> {
  const all = await partyStatement(ex, orgId, contactId, side, from, to, 'all');
  const docs = side === 'customer'
    ? await ex.selectFrom('invoices').select(['id', 'number', 'invoice_date as date', 'due_date', 'total', 'amount_paid', 'doc_kind'])
      .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', 'not in', ['draft', 'void'])
      .where('invoice_date', '>=', from).where('invoice_date', '<=', to).orderBy('invoice_date').orderBy('id').execute()
    : await ex.selectFrom('bills').select(['id', 'internal_no as number', 'bill_date as date', 'due_date', 'total', 'amount_paid'])
      .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('status', 'not in', ['draft', 'void'])
      .where('bill_date', '>=', from).where('bill_date', '<=', to).orderBy('bill_date').orderBy('id').execute();
  let running = 0;
  const lines: StatementLine[] = [];
  // What was owed before the books started and is still unpaid comes first, whatever the period.
  const openings = await ex.selectFrom('opening_documents').select(['id', 'ref_no', 'doc_date', 'due_date', 'amount', 'amount_paid'])
    .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('kind', '=', side === 'customer' ? 'receivable' : 'payable')
    .where('status', '<>', 'void').where('doc_date', '<=', to).orderBy('doc_date').orderBy('id').execute();
  for (const o of openings) {
    const due = toPaiseFromSql(o.amount) - toPaiseFromSql(o.amount_paid);
    if (due <= 0) continue;
    running += due;
    lines.push({
      date: String(o.doc_date).slice(0, 10), kind: 'Opening balance', number: o.ref_no,
      detail: o.due_date ? `Due ${String(o.due_date).slice(0, 10)}` : null, sourceType: 'opening_document', sourceId: String(o.id),
      chargePaise: due, paymentPaise: 0, balancePaise: running,
    });
  }
  for (const d of docs) {
    const due = toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid);
    if (due <= 0) continue;
    running += due;
    lines.push({
      date: String(d.date).slice(0, 10),
      kind: side === 'customer' ? ('doc_kind' in d && d.doc_kind === 'debit_note' ? 'Debit note' : 'Invoice') : 'Bill',
      number: d.number,
      detail: d.due_date ? `Due ${String(d.due_date).slice(0, 10)}` : null,
      sourceType: side === 'customer' ? 'invoice' : 'bill',
      sourceId: String(d.id),
      chargePaise: due,
      paymentPaise: 0,
      balancePaise: running,
    });
  }
  return { ...all, openingPaise: 0, chargesPaise: running, paymentsPaise: 0, closingPaise: running, lines };
}
