// ─────────────────────────────────────────────────────────────────────────────
// Which chart, and why not the others.
//
// Tableau calls this "Show Me". Here every chart type is judged against the
// fields chosen, and the ones that do not fit are not hidden — they are shown
// disabled with the reason, because "why can't I make a pie of this?" deserves
// an answer, and the answer usually teaches something about the data.
//
// The rules are the charting guidance's, made executable:
//   · one axis only — two measures in different units never share a plot
//   · lines imply order, so they are for time
//   · a donut is for part-to-whole at a glance: six slices, none negative
//   · stacking only adds up what can be added — never averages
//   · scatter compares every point with every other, so three colours at most
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_SCATTER_SERIES } from './palette';
import { columnOf, measureMeta } from './query';
import type { ChartSpec, ChartType, DatasetData, QueryResult } from './types';

export interface ChartFit {
  type: ChartType;
  fits: boolean;
  recommended: boolean;
  /** Why it fits, or why it does not — a sentence the user can act on. */
  reason: string;
}

export const CHART_LABELS: Record<ChartType, string> = {
  kpi: 'Headline figure',
  bar: 'Bar',
  stacked: 'Stacked bar',
  line: 'Line',
  area: 'Area',
  donut: 'Donut',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  variance: 'Variance',
  table: 'Table',
  pivot: 'Pivot table',
};

export const CHART_ORDER: ChartType[] = [
  'kpi', 'bar', 'stacked', 'line', 'area', 'donut', 'variance', 'scatter', 'heatmap', 'pivot', 'table',
];

const COMPARISON = /budget|target|plan|forecast|goal|quota|last\s*year|prior|previous|\bly\b|estimate/i;

export function assessCharts(spec: ChartSpec, data: DatasetData, result?: QueryResult | null): ChartFit[] {
  const cat = columnOf(data, spec.category?.column);
  const ser = columnOf(data, spec.series?.column);
  const temporal = cat?.type === 'date';
  const measures = spec.measures;
  const metas = measures.map((m) => measureMeta(m, spec, data.columns));
  const twoMeasures = measures.length === 2;
  const sameUnits = !twoMeasures || metas[0].format === metas[1].format;
  const additive = measures.every((m) => m.column === null || m.agg === 'sum' || m.agg === 'count');
  const catCount = result?.categories.length ?? 0;
  const serCount = result?.series.length ?? 0;
  const anyNegative = !!result?.values[0]?.some((row) => row.some((v) => v !== null && v < 0));
  const secondIsComparison =
    twoMeasures && sameUnits && COMPARISON.test(metas[1].label) && !COMPARISON.test(metas[0].label);

  const unitsReason =
    `${metas[0]?.label} and ${metas[1]?.label} are in different units, and two scales on one axis invent a ` +
    'relationship that is not in the data. Use two charts, or Scatter to show how they relate.';

  const fits: Record<ChartType, [boolean, string]> = {
    kpi: ser
      ? [false, 'A headline figure has no breakdown. Remove the colour field.']
      : cat && !temporal
        ? [false, 'A headline figure is one number. Its trend can only run over dates.']
        : [true, twoMeasures ? `${metas[0].label} against ${metas[1].label}, with the difference.` : 'One number, stated plainly.'],

    bar: !cat
      ? [false, 'Choose a field to put along the axis.']
      : !sameUnits
        ? [false, unitsReason]
        : [true, twoMeasures ? 'Side-by-side bars on one shared axis.' : 'Compares sizes across categories.'],

    stacked: !cat || !ser
      ? [false, 'Stacking needs a category and a colour field to split each bar by.']
      : twoMeasures
        ? [false, 'A stack splits one measure. Remove the second value.']
        : !additive
          ? [false, 'Only totals can be stacked — the pieces of an average do not add up to the average.']
          : [true, 'Each bar is the whole; its segments are the parts.'],

    line: !cat
      ? [false, 'Choose a date to draw the line over.']
      : !temporal
        ? [false, 'A line joins its points, which says they come in order. Use a date field, or Bar.']
        : !sameUnits
          ? [false, unitsReason]
          : [true, 'Shows how it moves over time.'],

    area: !temporal
      ? [false, 'An area shows one total over time — choose a date field.']
      : ser || twoMeasures
        ? [false, 'An area is for a single series. Use Line to compare several.']
        : [true, 'One total over time, with its volume filled in.'],

    donut: !cat || temporal
      ? [false, 'A donut splits a whole into categories — choose a category, not a date.']
      : ser || twoMeasures
        ? [false, 'A donut shows one measure split one way.']
        : !additive
          ? [false, 'Slices must add up to a whole, so only totals and counts work.']
          : anyNegative
            ? [false, 'Some values are negative, and a slice cannot be smaller than nothing.']
            : catCount > 6
              ? [false, `${catCount} slices is too many to compare by angle. Use Bar, or set Top 5.`]
              : [true, 'Part-to-whole at a glance.'],

    variance: !twoMeasures
      ? [false, 'Variance compares two values — add a second, such as a budget or last year.']
      : !sameUnits
        ? [false, unitsReason]
        : ser
          ? [false, 'Variance is drawn per category. Remove the colour field.']
          : [true, `How far ${metas[0].label} sits above or below ${metas[1].label}.`],

    scatter: !twoMeasures
      ? [false, 'Scatter plots one value against another — choose two.']
      : !cat
        ? [false, 'Each point needs something to be a point for. Choose a category.']
        : ser && serCount > MAX_SCATTER_SERIES
          ? [false, `Scatter can colour at most ${MAX_SCATTER_SERIES} groups apart. Remove the colour field or filter it.`]
          : [true, 'Shows whether the two move together.'],

    heatmap: !cat || !ser
      ? [false, 'A heatmap needs two fields to form its grid.']
      : twoMeasures
        ? [false, 'A heatmap shades one measure.']
        : [true, 'Magnitude across a grid of two fields.'],

    pivot: !cat && !ser
      ? [false, 'A pivot needs at least one field for its rows.']
      : [true, 'Exact figures, with totals, in rows and columns.'],

    table: [true, 'Every figure, exactly.'],
  };

  // The one to reach for first.
  let best: ChartType;
  if (!cat && !ser) best = 'kpi';
  else if (twoMeasures && !sameUnits) best = cat ? 'scatter' : 'table';
  else if (secondIsComparison && cat && !ser) best = 'variance';
  else if (temporal) best = 'line';
  else if (ser) best = additive && !twoMeasures ? 'stacked' : 'heatmap';
  else best = 'bar';
  if (!fits[best][0]) best = CHART_ORDER.find((t) => fits[t][0]) ?? 'table';

  return CHART_ORDER.map((type) => ({
    type,
    fits: fits[type][0],
    recommended: type === best,
    reason: fits[type][1],
  }));
}

export function bestChart(spec: ChartSpec, data: DatasetData, result?: QueryResult | null): ChartType {
  return assessCharts(spec, data, result).find((f) => f.recommended)?.type ?? 'table';
}
