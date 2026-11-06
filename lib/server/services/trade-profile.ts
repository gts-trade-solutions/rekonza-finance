import 'server-only';

// Where the business sells (within India, abroad, or both), what it supplies
// (goods, services, or both), and its Letter of Undertaking: the yes or no, the
// ARN and its year, and what an export takes when nobody chooses (IGST nil
// under the LUT, or IGST paid). Settings → Organisation.

import type { Executor } from '../db';
import type { ExportProfile } from '../../tax/gst';
import { badRequest } from '../http';

export type TradeScope = 'domestic' | 'both' | 'international';
export type Supplies = 'goods' | 'services' | 'both';

export interface TradeProfile extends ExportProfile {
  tradeScope: TradeScope;
  supplies: Supplies;
}

const ymd = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

/**
 * The LUT as a yes or no, for Settings → Organisation. A yes needs its ARN and
 * its dates, sent now or already on file; a no means exports pay IGST, so that
 * becomes their starting point. A no keeps the old ARN on file: the return
 * checks earlier exports against it. Nothing about the LUT sent, nothing changes.
 */
export async function lutPatch(
  ex: Executor, orgId: number,
  input: { lutDeclared?: boolean; exportIgst?: 'nil_lut' | 'paid'; lutArn?: string | null; lutValidFrom?: string | null; lutValidTo?: string | null },
): Promise<{ lut_declared?: number; export_igst?: 'nil_lut' | 'paid' }> {
  if (input.lutDeclared === undefined && input.exportIgst === undefined) return {};
  const kept = await ex.selectFrom('organizations').select(['lut_declared', 'lut_arn', 'lut_valid_from', 'lut_valid_to', 'export_igst'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  const declared = input.lutDeclared ?? !!kept.lut_declared;
  const arn = input.lutArn !== undefined ? input.lutArn : kept.lut_arn;
  const from = input.lutValidFrom !== undefined ? input.lutValidFrom : kept.lut_valid_from;
  const to = input.lutValidTo !== undefined ? input.lutValidTo : kept.lut_valid_to;
  if (declared && !arn) throw badRequest('A LUT declared needs its ARN: the acknowledgement the GST portal gave for Form RFD-11.', { lutArn: 'Type the LUT ARN.' });
  if (declared && (!from || !to)) throw badRequest('A LUT declared needs the dates it covers, usually the financial year.', { lutValidFrom: 'Give the from and to dates.' });
  return { lut_declared: declared ? 1 : 0, export_igst: declared ? input.exportIgst ?? kept.export_igst : 'paid' };
}

export async function tradeProfile(ex: Executor, orgId: number): Promise<TradeProfile> {
  const o = await ex.selectFrom('organizations')
    .select(['trade_scope', 'supplies', 'lut_declared', 'lut_arn', 'lut_valid_from', 'lut_valid_to', 'export_igst'])
    .where('id', '=', orgId).executeTakeFirst();
  return {
    tradeScope: (o?.trade_scope ?? 'domestic') as TradeScope,
    supplies: (o?.supplies ?? 'both') as Supplies,
    lutDeclared: !!o?.lut_declared,
    lutArn: o?.lut_arn ?? null,
    lutValidFrom: ymd(o?.lut_valid_from),
    lutValidTo: ymd(o?.lut_valid_to),
    exportIgst: (o?.export_igst ?? 'nil_lut') as ExportProfile['exportIgst'],
  };
}
