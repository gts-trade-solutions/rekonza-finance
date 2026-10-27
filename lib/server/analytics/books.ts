import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Data from the books, as a dataset.
//
// Analytics never reads the ledger live. It takes a snapshot — one row per
// invoice line, with the customer, state, branch and item flattened onto it —
// and stamps it with the time it was taken. That is on purpose: a board pack
// has to show the same numbers tomorrow that it showed today, and a report that
// silently changed under an open meeting would be worse than one that says
// "as of 10:42 this morning" and offers to refresh.
//
// Drafts and void invoices are left out. They are not sales, and a chart that
// counted them would disagree with every report in the Reports section.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import { toNumberFromSql, toPaiseFromSql } from '../money-sql';
import { stateName } from '../../tax/gst';
import { importGrid, type RawCell } from '../../analytics/infer';
import type { DatasetData } from '../../analytics/types';

export const BOOKS_SALES = 'Sales invoice lines';

const SUPPLY: Record<string, string> = {
  intra: 'Within state',
  inter: 'Between states',
  export_lut: 'Export (LUT)',
  export_with_tax: 'Export (with tax)',
  sez: 'SEZ',
  nil_or_exempt: 'Nil-rated / exempt',
};

const rupees = (v: string | number | null) => toPaiseFromSql(v) / 100;

export async function salesSnapshot(ex: Executor, orgId: number): Promise<DatasetData & { name: string; description: string }> {
  const lines = await ex
    .selectFrom('invoice_lines as l')
    .innerJoin('invoices as i', 'i.id', 'l.invoice_id')
    .innerJoin('contacts as c', 'c.id', 'i.customer_id')
    .innerJoin('branches as b', 'b.id', 'i.branch_id')
    .leftJoin('items as it', 'it.id', 'l.item_id')
    .select([
      'i.invoice_date', 'i.number', 'i.status', 'i.supply_type',
      'c.display_name as customer', 'c.state_code as customer_state',
      'b.name as branch',
      'it.name as item_name', 'l.description', 'l.hsn_sac', 'l.qty',
      'l.taxable', 'l.cgst', 'l.sgst', 'l.igst', 'l.cess', 'l.line_total',
    ])
    .where('i.org_id', '=', orgId)
    .where('i.status', 'not in', ['draft', 'void'])
    .orderBy('i.invoice_date')
    .orderBy('i.id')
    .orderBy('l.line_no')
    .execute();

  const header = [
    'Invoice date', 'Invoice no', 'Customer', 'Customer state', 'Branch', 'Item', 'HSN/SAC',
    'Quantity', 'Taxable value', 'GST', 'Line total', 'Invoice status', 'Supply type',
  ];
  const grid: RawCell[][] = [header];
  for (const l of lines) {
    const gst = rupees(l.cgst) + rupees(l.sgst) + rupees(l.igst) + rupees(l.cess);
    grid.push([
      String(l.invoice_date).slice(0, 10),
      l.number,
      l.customer,
      stateName(l.customer_state),
      l.branch,
      l.description?.trim() || l.item_name || 'Unnamed item',
      l.hsn_sac,
      toNumberFromSql(l.qty),
      rupees(l.taxable),
      Math.round(gst * 100) / 100,
      rupees(l.line_total),
      l.status.replace(/_/g, ' '),
      SUPPLY[l.supply_type] ?? l.supply_type,
    ]);
  }

  // Types are stated, not guessed: this data's shape is known, and a snapshot
  // of five invoices must not come out typed differently from one of five
  // thousand because the guesser saw fewer values.
  const { columns, rows } = importGrid(grid, {
    hasHeader: true,
    overrides: {
      0: { type: 'date' },
      1: { type: 'text', role: 'dimension' },
      6: { type: 'text', role: 'dimension' },
      7: { type: 'number', role: 'measure' },
      8: { type: 'currency', role: 'measure' },
      9: { type: 'currency', role: 'measure' },
      10: { type: 'currency', role: 'measure' },
    },
  });

  return {
    name: BOOKS_SALES,
    description:
      'A snapshot of issued sales invoices, one row per line, with customer, state, branch and item. Drafts and ' +
      'void invoices are left out.',
    columns,
    rows,
  };
}
