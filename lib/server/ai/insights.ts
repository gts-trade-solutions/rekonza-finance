import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// What needs attention, found by rules rather than by the model.
//
// These cost nothing to run and are exactly right by construction: each one is
// a query over the same tables the reports read — duplicate supplier invoice
// numbers, invoices near the IRN deadline, MSME bills near 45 days — so a check
// that fires can always be traced to the documents that made it fire.
//
// They are the assistant's "suggestions with intelligence" that do not need
// intelligence: shown on the assistant's page for free, each with a question
// that hands it to the model when the person wants the detail explained.
//
// Filtered by role. A salesperson is not shown that a supplier's bill is
// overdue, for the same reason they cannot open the purchases module.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { hasPermission } from '../../rbac';
import type { RoleName } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { istDate } from './time';

export interface Flag {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  href: string;
  count: number;
  /** The module a person must be able to see for this to be shown to them. */
  module: string;
  /** A question that hands this to the assistant. */
  ask: string;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export async function detectFlags(ex: Executor, orgId: number, role: RoleName): Promise<Flag[]> {
  const today = istDate();
  const flags: Flag[] = [];

  const [duplicates, staleIrn, msme, missingHsn, unapplied, negativeStock, unmatched, drafts] =
    await Promise.all([
      // The same supplier invoice number twice is either a double entry or a
      // supplier reusing a number. Both need looking at before the ITC claim.
      sql<{ vendor_id: number; name: string; no: string; n: string }>`
        SELECT b.vendor_id, c.display_name AS name, b.vendor_invoice_no AS no, COUNT(*) AS n
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.org_id = ${orgId} AND b.status <> 'void'
         GROUP BY b.vendor_id, c.display_name, b.vendor_invoice_no
        HAVING n > 1
      `.execute(ex),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM einvoices e
          JOIN invoices i ON i.id = e.invoice_id
         WHERE e.org_id = ${orgId} AND e.status IN ('pending', 'failed')
           AND DATEDIFF(${today}, i.invoice_date) > 23
      `.execute(ex),
      sql<{ n: string; v: string }>`
        SELECT COUNT(*) AS n, COALESCE(SUM(b.total - b.amount_paid), 0) AS v
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.org_id = ${orgId} AND c.is_msme = 1
           AND b.status NOT IN ('draft','void') AND b.total > b.amount_paid
           AND DATEDIFF(${today}, b.bill_date) >= 38
      `.execute(ex),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM invoice_lines l
          JOIN invoices i ON i.id = l.invoice_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft','void')
           AND (l.hsn_sac IS NULL OR l.hsn_sac = '')
      `.execute(ex),
      sql<{ n: string; v: string }>`
        SELECT COUNT(*) AS n, COALESCE(SUM(unapplied_amount), 0) AS v
          FROM payments
         WHERE org_id = ${orgId} AND status <> 'void' AND unapplied_amount > 0
      `.execute(ex),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM (
          SELECT it.id,
                 it.opening_stock_qty
                 + COALESCE((SELECT SUM(bl.qty) FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
                              WHERE bl.item_id = it.id AND b.status NOT IN ('draft','void')), 0)
                 - COALESCE((SELECT SUM(il.qty) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
                              WHERE il.item_id = it.id AND i.status NOT IN ('draft','void')), 0)
                 + COALESCE((SELECT SUM(a.qty_delta) FROM stock_adjustments a
                              WHERE a.item_id = it.id), 0) AS qty
            FROM items it
           WHERE it.org_id = ${orgId} AND it.is_archived = 0 AND it.kind = 'goods'
        ) x WHERE x.qty < 0
      `.execute(ex),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM bank_transactions
         WHERE org_id = ${orgId} AND status = 'unmatched'
      `.execute(ex),
      sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM invoices WHERE org_id = ${orgId} AND status = 'draft'
      `.execute(ex),
    ]);

  const n = (r: { rows: { n: string }[] }) => Number(r.rows[0]?.n ?? 0);

  if (duplicates.rows.length) {
    flags.push({
      id: 'duplicate-bills',
      severity: 'high',
      title: 'The same supplier invoice number appears twice',
      detail:
        `${duplicates.rows.length} supplier invoice number(s) are used on more than one bill — ` +
        `${duplicates.rows.slice(0, 2).map((d) => `${d.name} ${d.no}`).join(', ')}. ` +
        'Either the bill was entered twice, or the supplier reused a number. Both matter: a duplicate claims the input credit twice.',
      href: '/purchases/bills',
      count: duplicates.rows.length,
      module: 'purchases',
      ask: 'Which supplier bills share an invoice number, and what should I do about each one?',
    });
  }

  if (n(staleIrn)) {
    flags.push({
      id: 'irn-window',
      severity: 'high',
      title: 'The IRN window is closing',
      detail:
        `${n(staleIrn)} invoice(s) are within a week of the 30-day registration deadline. ` +
        'After it the portal refuses them outright, and an invoice without an IRN is not legally valid.',
      href: '/gst/einvoices',
      count: n(staleIrn),
      module: 'gst',
      ask: 'Which invoices are close to the 30-day e-invoice deadline, and what happens if we miss it?',
    });
  }

  const msmeRow = msme.rows[0];
  if (Number(msmeRow?.n ?? 0)) {
    flags.push({
      id: 'msme-45',
      severity: 'high',
      title: 'MSME bills near the 45-day limit',
      detail:
        `${msmeRow.n} bill(s) worth ${rupees(toPaiseFromSql(msmeRow.v))} are close to or past 45 days. ` +
        'Under section 43B(h) the expense stops being deductible in this year if they are not paid.',
      href: '/purchases/msme-tracker',
      count: Number(msmeRow.n),
      module: 'purchases',
      ask: 'Which MSME supplier bills must we pay this week to stay within 45 days, and how much in total?',
    });
  }

  if (n(missingHsn)) {
    flags.push({
      id: 'missing-hsn',
      severity: 'high',
      title: 'Invoice lines with no HSN/SAC code',
      detail:
        `${n(missingHsn)} line(s) on issued invoices carry no code. GSTR-1 Table 12 is validated against the ` +
        'official master, and one missing code bounces the whole return.',
      href: '/gst/gstr1',
      count: n(missingHsn),
      module: 'gst',
      ask: 'Why do HSN codes matter on invoices, and what should I fix before filing GSTR-1?',
    });
  }

  const unappliedRow = unapplied.rows[0];
  if (Number(unappliedRow?.n ?? 0)) {
    flags.push({
      id: 'unapplied',
      severity: 'medium',
      title: 'Payments sitting on account',
      detail:
        `${unappliedRow.n} payment(s) hold ${rupees(toPaiseFromSql(unappliedRow.v))} that has not been matched ` +
        'to any invoice. The customer looks like they still owe it.',
      href: '/sales/payments',
      count: Number(unappliedRow.n),
      module: 'sales',
      ask: 'Which customers have paid money that is not yet applied to an invoice?',
    });
  }

  if (n(negativeStock)) {
    flags.push({
      id: 'negative-stock',
      severity: 'medium',
      title: 'Items showing negative stock',
      detail:
        `${n(negativeStock)} item(s) have been invoiced out in greater quantity than was ever recorded coming in. ` +
        'Usually a supplier bill that was never entered.',
      href: '/inventory/stock',
      count: n(negativeStock),
      module: 'inventory',
      ask: 'Why would an item show negative stock, and how do I correct it?',
    });
  }

  if (n(unmatched)) {
    flags.push({
      id: 'unreconciled',
      severity: 'medium',
      title: 'Bank lines not reconciled',
      detail:
        `${n(unmatched)} statement line(s) have not been matched to anything. Until they are, the bank balance ` +
        'in the books is not the balance in the bank.',
      href: '/banking/reconcile',
      count: n(unmatched),
      module: 'banking',
      ask: 'What is our cash position today, and how much of it is still unreconciled?',
    });
  }

  if (n(drafts)) {
    flags.push({
      id: 'drafts',
      severity: 'low',
      title: 'Invoices still in draft',
      detail:
        `${n(drafts)} invoice(s) have never been issued, so nothing has been posted for them and no customer ` +
        'has been asked to pay.',
      href: '/sales/invoices',
      count: n(drafts),
      module: 'sales',
      ask: 'Which invoices are still in draft, and how much would they add to our sales?',
    });
  }

  return flags.filter((f) => hasPermission(role, f.module, 'view'));
}

// ── Starting points ──────────────────────────────────────────────────────────

export interface SuggestedPrompt {
  title: string;
  prompt: string;
  kind: 'balance' | 'profit' | 'cash' | 'receivable' | 'payable' | 'gst' | 'sales' | 'expense';
}

const seesCosts = (role: RoleName) => role === 'admin' || role === 'accountant' || role === 'viewer';

/** Questions worth asking first, chosen by what the role can see. */
export function suggestedPrompts(role: RoleName): SuggestedPrompt[] {
  const out: SuggestedPrompt[] = [];
  if (seesCosts(role)) {
    out.push(
      { kind: 'balance', title: 'Closing balance', prompt: 'What is the closing balance of each of our bank accounts today?' },
      { kind: 'profit', title: 'Profit this year', prompt: 'How much profit have we made this financial year, and how does it compare with the same length of time before it?' },
      { kind: 'expense', title: 'Biggest expenses', prompt: 'What are our five biggest expense categories this financial year?' },
    );
  }
  if (hasPermission(role, 'sales', 'view')) {
    out.push(
      { kind: 'receivable', title: 'Who owes us', prompt: 'Which customers owe us the most, and how overdue are they?' },
      { kind: 'sales', title: 'Top customers', prompt: 'Who are our top five customers this financial year by sales?' },
    );
  }
  if (hasPermission(role, 'purchases', 'view')) {
    out.push({ kind: 'payable', title: 'What we owe', prompt: 'How much do we owe suppliers, and which MSME bills are close to 45 days?' });
  }
  if (hasPermission(role, 'gst', 'view')) {
    out.push({ kind: 'gst', title: 'GST due', prompt: 'How much GST do we have to pay in cash for last month after input tax credit?' });
  }
  if (seesCosts(role) || hasPermission(role, 'banking', 'view')) {
    out.push({ kind: 'cash', title: 'Cash position', prompt: 'What is our total cash position right now, and can it cover what we owe suppliers?' });
  }
  return out.slice(0, 6);
}
