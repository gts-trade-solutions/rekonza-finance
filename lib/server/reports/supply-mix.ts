import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Sales by supply: domestic and international, goods and services, each on
// its own line, and exports split by their IGST: nil under the LUT, or paid.
//
// A line is goods or a service by its item, or failing that by its code (a
// SAC starts 99). One invoice with parts and labour counts in both. Credit
// notes come off, line by line, as they do in Sales Summary; the invoice count
// is of invoices only.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';

export interface SupplyMixRow {
  key: string;
  market: 'domestic' | 'export' | 'sez';
  /** How an export was taxed: nil under the LUT, or IGST paid. Null within India. */
  exportIgst: 'nil_lut' | 'paid' | null;
  kind: 'goods' | 'service';
  label: string;
  invoices: number;
  taxablePaise: number;
  igstPaise: number;
  cgstSgstPaise: number;
  taxPaise: number;
  totalPaise: number;
}

const SLOTS: Omit<SupplyMixRow, 'invoices' | 'taxablePaise' | 'igstPaise' | 'cgstSgstPaise' | 'taxPaise' | 'totalPaise'>[] = [
  { key: 'domestic-goods', market: 'domestic', exportIgst: null, kind: 'goods', label: 'Domestic — goods' },
  { key: 'domestic-service', market: 'domestic', exportIgst: null, kind: 'service', label: 'Domestic — services' },
  { key: 'export-lut-goods', market: 'export', exportIgst: 'nil_lut', kind: 'goods', label: 'Export under LUT, IGST nil — goods' },
  { key: 'export-lut-service', market: 'export', exportIgst: 'nil_lut', kind: 'service', label: 'Export under LUT, IGST nil — services' },
  { key: 'export-paid-goods', market: 'export', exportIgst: 'paid', kind: 'goods', label: 'Export with IGST paid — goods' },
  { key: 'export-paid-service', market: 'export', exportIgst: 'paid', kind: 'service', label: 'Export with IGST paid — services' },
  { key: 'sez-goods', market: 'sez', exportIgst: null, kind: 'goods', label: 'SEZ — goods' },
  { key: 'sez-service', market: 'sez', exportIgst: null, kind: 'service', label: 'SEZ — services' },
];

export async function supplyMix(ex: Executor, orgId: number, w: { from: string; to: string }): Promise<SupplyMixRow[]> {
  const slot = (doc: string) => sql`CONCAT(
             CASE ${sql.ref(`${doc}.supply_type`)} WHEN 'export_lut' THEN 'export-lut' WHEN 'export_with_tax' THEN 'export-paid' WHEN 'sez' THEN 'sez' ELSE 'domestic' END,
             '-',
             CASE WHEN it.kind IS NOT NULL THEN it.kind WHEN l.hsn_sac LIKE '99%' THEN 'service' ELSE 'goods' END
           )`;
  const { rows } = await sql<{ slot: string; invoices: string; taxable: string; igst: string; cgst_sgst: string; cess: string; total: string }>`
    SELECT slot, SUM(invoices) AS invoices, SUM(taxable) AS taxable, SUM(igst) AS igst, SUM(cgst_sgst) AS cgst_sgst,
           SUM(cess) AS cess, SUM(total) AS total FROM (
      SELECT ${slot('i')} AS slot, COUNT(DISTINCT i.id) AS invoices,
             SUM(l.taxable) AS taxable, SUM(l.igst) AS igst, SUM(l.cgst + l.sgst) AS cgst_sgst, SUM(l.cess) AS cess,
             SUM(l.line_total) AS total
        FROM invoices i
        JOIN invoice_lines l ON l.invoice_id = i.id
        LEFT JOIN items it ON it.id = l.item_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
       GROUP BY 1
      UNION ALL
      SELECT ${slot('n')}, 0,
             -SUM(l.taxable), -SUM(l.igst), -SUM(l.cgst + l.sgst), -SUM(l.cess), -SUM(l.line_total)
        FROM credit_notes n
        JOIN credit_note_lines l ON l.credit_note_id = n.id
        LEFT JOIN items it ON it.id = l.item_id
       WHERE n.org_id = ${orgId} AND n.status <> 'void'
         AND n.note_date BETWEEN ${w.from} AND ${w.to}
       GROUP BY 1
    ) x GROUP BY slot`.execute(ex);
  const got = new Map(rows.map((r) => [r.slot, r]));
  return SLOTS
    // Within India and exports always show, at nil if need be; SEZ only when there is some.
    .filter((s) => s.market !== 'sez' || got.has(s.key))
    .map((s) => {
      const r = got.get(s.key);
      const igst = toPaiseFromSql(r?.igst ?? '0');
      const cgstSgst = toPaiseFromSql(r?.cgst_sgst ?? '0');
      const cess = toPaiseFromSql(r?.cess ?? '0');
      return {
        ...s,
        invoices: Number(r?.invoices ?? 0),
        taxablePaise: toPaiseFromSql(r?.taxable ?? '0'),
        igstPaise: igst,
        cgstSgstPaise: cgstSgst,
        taxPaise: igst + cgstSgst + cess,
        totalPaise: toPaiseFromSql(r?.total ?? '0'),
      };
    });
}
