// ─────────────────────────────────────────────────────────────────────────────
// The first report, built for you.
//
// A new dataset should never land on an empty canvas. The moment data is
// imported, this reads its columns the way an analyst would on first look —
// what is the main number, what is the date, what are the useful ways to split
// it — and lays out a dashboard: headline figures across the top, the trend,
// the biggest contributors, the mix, and an exact table underneath.
//
// It is a starting point, and it says so. Every tile is an ordinary chart the
// user can change or delete; nothing here is special.
// ─────────────────────────────────────────────────────────────────────────────

import { suggestGrain } from './dates';
import { defaultAggregation } from './format';
import type { ChartSpec, ColumnSchema, DatasetData, MeasureRef, Tile, TileWidth } from './types';

const PRIMARY = /revenue|sales|turnover|amount|total|value|income|net/i;
const COMPARISON = /budget|target|plan|forecast|goal|quota|last\s*year|prior|previous/i;
/** Spending, where coming in under the comparison is the good outcome. */
const COSTLIKE = /cost|expense|spend|purchase|payable|overhead|salary|rent/i;
/** Labels that name a reference, not a thing — worth filtering by, never ranking by. */
const IDLIKE = /\b(id|code|no|num|number|pin|pincode|zip|postal|gstin|pan|hsn|sac|phone|mobile|ref|reference|invoice|bill|voucher|serial)\b|#/i;

export const newTileId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const tile = (width: TileWidth, spec: ChartSpec): Tile => ({ id: newTileId(), width, spec });

const measure = (c: ColumnSchema): MeasureRef => ({ column: c.key, agg: defaultAggregation(c.type, 'measure') });

export function starterTiles(data: DatasetData): Tile[] {
  const rows = data.rows.length;
  const measures = data.columns.filter((c) => c.role === 'measure');
  const money = measures.filter((c) => c.type === 'currency');
  const additive = measures.filter((c) => c.type !== 'percent');

  // The main number: a money column named like revenue, else the first money
  // column, else the first thing that can be added up.
  const primary =
    money.find((c) => PRIMARY.test(c.label) && !COMPARISON.test(c.label)) ??
    money.find((c) => !COMPARISON.test(c.label)) ??
    additive[0] ??
    null;
  const comparison = primary ? money.find((c) => c !== primary && COMPARISON.test(c.label)) ?? null : null;
  const second = additive.find((c) => c !== primary && c !== comparison) ?? null;

  const dateCol = data.columns.find((c) => c.type === 'date' && (c.profile?.distinct ?? 0) >= 2) ?? null;
  const span =
    dateCol && typeof dateCol.profile?.min === 'string' && typeof dateCol.profile?.max === 'string'
      ? { min: dateCol.profile.min, max: dateCol.profile.max }
      : null;
  const grain = span ? suggestGrain(span.min, span.max) : 'month';
  // Grouping fields worth splitting by: more than one value, and not so many
  // that every row is its own group (an invoice number, a name per row).
  const dims = data.columns
    .filter((c) => c.role === 'dimension' && c.type !== 'date')
    .filter((c) => {
      const d = c.profile?.distinct ?? 0;
      return d >= 2 && d <= Math.max(60, Math.min(500, rows * 0.5)) && d < rows * 0.9;
    })
    .sort((a, b) => (a.profile?.distinct ?? 0) - (b.profile?.distinct ?? 0));
  // Ranking by an identifier — "top PIN codes", "top invoice numbers" — is
  // never the question. Names are: customers, items, regions.
  const named = dims.filter((c) => c.type === 'text' && !IDLIKE.test(c.label));
  const small = (named.length ? named : dims).find((c) => (c.profile?.distinct ?? 0) <= 6) ?? null;
  const pickWide = (list: ColumnSchema[]) => [...list].reverse().find((c) => (c.profile?.distinct ?? 0) > 3) ?? list[0] ?? null;
  const wide = pickWide(named) ?? pickWide(dims);

  const main: MeasureRef = primary ? measure(primary) : { column: null, agg: 'count' };
  const trend = dateCol ? { column: dateCol.key, grain } : null;
  const tiles: Tile[] = [];

  // ── Headline figures ──
  // A rise in cost is not good news, so its arrow must not be green.
  const direction = (c: ColumnSchema | null): Pick<ChartSpec, 'favourable'> =>
    c && COSTLIKE.test(c.label) ? { favourable: 'lower' } : {};
  const kpis: ChartSpec[] = [{ type: 'kpi', measures: [main], category: trend, ...direction(primary) }];
  if (comparison) {
    kpis.push({ type: 'kpi', title: `${primary!.label} against ${comparison.label}`, measures: [main, measure(comparison)], ...direction(primary) });
  }
  if (second) kpis.push({ type: 'kpi', measures: [measure(second)], category: trend, ...direction(second) });
  kpis.push({ type: 'kpi', title: 'Records', measures: [{ column: null, agg: 'count', label: 'Records' }], category: trend });
  const kpiWidth: TileWidth = kpis.length >= 4 ? 3 : kpis.length === 3 ? 4 : 6;
  for (const k of kpis.slice(0, 4)) tiles.push(tile(kpiWidth, k));

  // ── The trend, beside the mix ──
  if (trend) {
    tiles.push(tile(small ? 8 : 12, {
      type: 'line',
      title: `${primary?.label ?? 'Records'} over time`,
      category: trend,
      measures: comparison ? [main, measure(comparison)] : [main],
    }));
  }
  if (small) {
    tiles.push(tile(trend ? 4 : 6, {
      type: 'donut',
      title: `${primary?.label ?? 'Records'} by ${small.label}`,
      category: { column: small.key },
      measures: [main],
    }));
  }

  // ── Who or what contributes most ──
  if (wide) {
    tiles.push(tile(6, {
      type: 'bar',
      title: `Top ${wide.label} by ${primary?.label ?? 'records'}`,
      category: { column: wide.key },
      measures: [main],
      limit: 10,
      sort: 'value-desc',
      orientation: 'horizontal',
    }));
  }

  // ── Against plan, or the mix over time ──
  if (comparison && wide) {
    tiles.push(tile(6, {
      type: 'variance',
      title: `${primary!.label} against ${comparison.label} by ${(small ?? wide).label}`,
      category: { column: (small ?? wide).key },
      measures: [main, measure(comparison)],
      limit: 10,
      favourable: direction(primary).favourable ?? 'higher',
    }));
  } else if (trend && small && wide && small !== wide) {
    tiles.push(tile(6, {
      type: 'stacked',
      title: `${primary?.label ?? 'Records'} by ${small.label}, over time`,
      category: { column: trend.column, grain: grain === 'day' || grain === 'week' ? 'month' : grain === 'month' ? 'fq' : grain },
      series: { column: small.key },
      measures: [main],
    }));
  }

  // ── The exact figures ──
  if (wide) {
    tiles.push(tile(12, {
      type: 'pivot',
      title: `${primary?.label ?? 'Records'} by ${wide.label}${trend ? ' and financial year' : small && small !== wide ? ` and ${small.label}` : ''}`,
      category: { column: wide.key },
      series: trend ? { column: trend.column, grain: 'fy' } : small && small !== wide ? { column: small.key } : null,
      measures: [main],
      limit: 15,
    }));
  }

  return tiles;
}
