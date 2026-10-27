import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Document number series, as Settings shows and changes them.
//
// Documents a GST registration issues — invoices, credit notes, challans, and
// the orders and quotes around them — are numbered per branch and financial
// year in number_series. Documents that are internal to the books — receipts,
// payments, bills, expenses, retainers — are numbered once per organisation in
// sequences. Both are listed here.
//
// What may change is the look of a series: its prefix and how many digits it
// pads to. What may not is the counter. Setting the next number by hand is how
// a book ends up with two invoices sharing a number, which is a question at
// assessment rather than a display problem. A new prefix takes effect from the
// next document and the count carries on, so every number stays unique for the
// year, as rule 46(b) requires; and it carries into the next year too.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { GST_SERIES, format } from '../ledger/posting';
import { badRequest, notFound } from '../http';
import { fyLabelFor } from './sales';

export const SERIES_LABEL: Record<string, string> = {
  INV: 'Tax invoices', CN: 'Credit notes', DC: 'Delivery challans', EST: 'Estimates', SO: 'Sales orders',
  PO: 'Purchase orders', GRN: 'Goods receipts', VC: 'Vendor credits',
  RCPT: 'Receipts', PAY: 'Payments made', BILL: 'Bills', EXP: 'Expenses', RET: 'Retainer invoices',
};

/** Numbered per branch, and so each with its own prefix. */
export const BRANCH_SERIES = ['INV', 'CN', 'DC', 'EST', 'SO', 'PO', 'GRN', 'VC'] as const;
export type BranchSeries = (typeof BRANCH_SERIES)[number];

export interface SeriesRow {
  /** 'branch' series can be restyled; 'org' series are listed for reference. */
  scope: 'branch' | 'org';
  docType: string;
  label: string;
  branchId: string | null;
  branchName: string | null;
  fyLabel: string;
  prefix: string;
  padding: number;
  nextNumber: number;
  issued: number;
  /** The number the next document will get. */
  sample: string;
  /** Under the GST rules for invoices, credit notes and challans. */
  gst: boolean;
  /** The longest number this series could issue at its current padding. */
  maxLength: number;
}

const digits = (n: number) => String(n).length;

/** Every series for the current year, whether or not it has issued anything yet. */
export async function listSeries(ex: Executor, orgId: number, today = new Date().toISOString().slice(0, 10)): Promise<SeriesRow[]> {
  const fy = fyLabelFor(today);
  const [branches, rows, seqs] = await Promise.all([
    ex.selectFrom('branches').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1)
      .orderBy('is_primary', 'desc').orderBy('name').execute(),
    ex.selectFrom('number_series').select(['branch_id', 'doc_type', 'fy_label', 'prefix', 'next_number', 'padding'])
      .where('org_id', '=', orgId).orderBy('fy_label', 'desc').execute(),
    ex.selectFrom('sequences').select(['name', 'next_value']).where('org_id', '=', orgId).execute(),
  ]);

  const out: SeriesRow[] = [];
  for (const b of branches) {
    for (const docType of BRANCH_SERIES) {
      const mine = rows.filter((r) => r.branch_id === b.id && r.doc_type === docType);
      const current = mine.find((r) => r.fy_label === fy);
      const style = current ?? mine[0];
      const prefix = style?.prefix ?? docType;
      const padding = style?.padding ?? 4;
      const next = current?.next_number ?? 1;
      out.push({
        scope: 'branch', docType, label: SERIES_LABEL[docType], branchId: String(b.id), branchName: b.name,
        fyLabel: fy, prefix, padding, nextNumber: next, issued: next - 1,
        sample: format(prefix, fy, next, padding), gst: GST_SERIES.has(docType),
        maxLength: prefix.length + fy.length + 2 + Math.max(padding, digits(next)),
      });
    }
  }

  // Org-wide counters are named 'RCPT:26-27'. Others in the table (the journal
  // entry counter, for one) are not document series.
  for (const s of seqs) {
    const m = /^([A-Z]+):(\d{2}-\d{2})$/.exec(s.name);
    if (!m || m[2] !== fy) continue;
    const next = Number(s.next_value);
    out.push({
      scope: 'org', docType: m[1], label: SERIES_LABEL[m[1]] ?? m[1], branchId: null, branchName: null,
      fyLabel: fy, prefix: m[1], padding: 4, nextNumber: next, issued: next - 1,
      sample: format(m[1], fy, next, 4), gst: false, maxLength: m[1].length + fy.length + 2 + Math.max(4, digits(next)),
    });
  }
  return out;
}

/**
 * Restyle a branch's series from its next document onwards. The counter is
 * never touched.
 */
export async function setSeriesStyle(
  trx: Trx, orgId: number,
  input: { branchId: number; docType: string; prefix: string; padding: number; today?: string },
): Promise<SeriesRow> {
  if (!(BRANCH_SERIES as readonly string[]).includes(input.docType)) {
    throw badRequest(`${input.docType} is not a series a branch numbers for itself.`);
  }
  const prefix = input.prefix.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,10}$/.test(prefix)) {
    throw badRequest('A prefix is 1 to 10 letters, digits or hyphens. The slashes around the year are added for you.');
  }
  if (!(Number.isInteger(input.padding) && input.padding >= 1 && input.padding <= 6)) {
    throw badRequest('Pad the number to between 1 and 6 digits.');
  }
  const branch = await trx.selectFrom('branches').select('id')
    .where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch is not in this organisation.');

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const fy = fyLabelFor(today);
  const row = await trx.selectFrom('number_series').select(['id', 'next_number'])
    .where('org_id', '=', orgId).where('branch_id', '=', input.branchId)
    .where('doc_type', '=', input.docType).where('fy_label', '=', fy)
    .forUpdate().executeTakeFirst();
  const next = row?.next_number ?? 1;

  // Long enough for every number the year could reasonably reach at this
  // padding, and for the one about to be issued.
  if (GST_SERIES.has(input.docType)) {
    const longest = prefix.length + fy.length + 2 + Math.max(input.padding, digits(next));
    if (longest > 16) {
      const room = 16 - (fy.length + 2 + Math.max(input.padding, digits(next)));
      throw badRequest(
        `${prefix}/${fy}/${'9'.repeat(Math.max(input.padding, digits(next)))} would be ${longest} characters; GST allows 16. ` +
          (room > 0 ? `Keep the prefix to ${room} character${room === 1 ? '' : 's'}, or pad to fewer digits.` : 'Pad to fewer digits.'),
      );
    }
  }

  if (row) {
    await trx.updateTable('number_series').set({ prefix, padding: input.padding }).where('id', '=', row.id).execute();
  } else {
    await trx.insertInto('number_series').values({
      org_id: orgId, branch_id: input.branchId, doc_type: input.docType, fy_label: fy,
      prefix, next_number: 1, padding: input.padding,
    }).execute();
  }

  const all = await listSeries(trx, orgId, today);
  return all.find((s) => s.scope === 'branch' && s.branchId === String(input.branchId) && s.docType === input.docType)!;
}
