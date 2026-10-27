// The Analytics engine: reading spreadsheets, grouping dates, aggregating,
// recommending charts and assigning colour.
//   npx tsx --test scripts/tests/analytics.test.ts
//
// No database and no browser. Every rule here is a way a dashboard can quietly
// show a wrong number — a totals row counted twice, an average of averages, a
// PIN code summed, a missing month drawn as a straight line — so each one is
// pinned down.

import test from 'node:test';
import assert from 'node:assert/strict';

import { importGrid, parseNumber, detectHeader } from '../../lib/analytics/infer';
import { bucketOf, detectDayOrder, parseDate, periodSequence, suggestGrain } from '../../lib/analytics/dates';
import { runQuery, stableOrder, distinctValues, measureLabel } from '../../lib/analytics/query';
import { colorsFor, OTHER_COLOR, SERIES_COLORS } from '../../lib/analytics/palette';
import { assessCharts, bestChart } from '../../lib/analytics/recommend';
import { starterTiles } from '../../lib/analytics/starter';
import { sampleDataset } from '../../lib/analytics/sample';
import { ChartSpecSchema, checkRows, LayoutSchema } from '../../lib/analytics/schema';
import { formatAxis, formatHeadline, formatValue, defaultAggregation } from '../../lib/analytics/format';
import type { ChartSpec, DatasetData } from '../../lib/analytics/types';

// ── Numbers, as finance writes them ──────────────────────────────────────────

test('Indian and Western grouping both read', () => {
  assert.equal(parseNumber('1,23,456.78')?.value, 123456.78);
  assert.equal(parseNumber('12,34,56,789')?.value, 123456789);
  assert.equal(parseNumber('123,456')?.value, 123456);
  assert.equal(parseNumber('1,234,567.5')?.value, 1234567.5);
  assert.equal(parseNumber('1,2,3'), null, 'commas in the wrong places are not a number');
});

test('accounting negatives, currency marks and Tally Dr/Cr', () => {
  assert.equal(parseNumber('(500)')?.value, -500);
  assert.equal(parseNumber('₹ 1,200')?.value, 1200);
  assert.equal(parseNumber('₹ 1,200')?.currency, true);
  assert.equal(parseNumber('Rs. 450.50')?.value, 450.5);
  assert.equal(parseNumber('₹(750)')?.value, -750);
  assert.equal(parseNumber('500-')?.value, -500, 'SAP-style trailing minus');
  const dr = parseNumber('1,200.00 Dr');
  assert.equal(dr?.value, 1200);
  assert.equal(dr?.drcr, true);
  assert.equal(parseNumber('450 Cr')?.value, -450);
  assert.equal(parseNumber('12.5%')?.value, 12.5);
  assert.equal(parseNumber('12.5%')?.percent, true);
});

test('things that look like numbers and are not stay text', () => {
  assert.equal(parseNumber('+91 98400 12345'), null, 'a phone number');
  assert.equal(parseNumber('+919840012345'), null, 'a phone number without spaces');
  assert.equal(parseNumber('0044'), null, 'a code with a leading zero');
  assert.equal(parseNumber('1234567890123456789'), null, 'too long to hold exactly');
  assert.equal(parseNumber('0.5')?.value, 0.5, 'but a decimal below one is fine');
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('day-first by default, month-first when the data proves it', () => {
  assert.equal(parseDate('11/09/2026', 'dmy'), '2026-09-11');
  assert.equal(parseDate('11/09/2026', 'mdy'), '2026-11-09');
  assert.deepEqual(detectDayOrder(['04/05/2026', '13/05/2026']), { order: 'dmy', ambiguous: false });
  assert.deepEqual(detectDayOrder(['04/05/2026', '05/13/2026']), { order: 'mdy', ambiguous: false });
  assert.deepEqual(detectDayOrder(['04/05/2026', '06/07/2026']), { order: 'dmy', ambiguous: true });
});

test('the date forms Indian spreadsheets actually use', () => {
  assert.equal(parseDate('11-Sep-2026'), '2026-09-11');
  assert.equal(parseDate('11 Sept 26'), '2026-09-11');
  assert.equal(parseDate('Sep 11, 2026'), '2026-09-11');
  assert.equal(parseDate('Sep-26'), '2026-09-01', 'a month on its own is its first day');
  assert.equal(parseDate('2026-09-11T10:30:00'), '2026-09-11');
  assert.equal(parseDate('11.09.2026'), '2026-09-11');
  assert.equal(parseDate('31/02/2026'), null, 'no 31st of February');
  assert.equal(parseDate('Region'), null);
});

test('the financial year runs April to March', () => {
  assert.deepEqual(bucketOf('2027-01-15', 'fy'), { key: '2026', label: 'FY 2026-27' });
  assert.deepEqual(bucketOf('2026-03-31', 'fy'), { key: '2025', label: 'FY 2025-26' });
  assert.deepEqual(bucketOf('2026-04-01', 'fy'), { key: '2026', label: 'FY 2026-27' });
  assert.equal(bucketOf('2027-01-15', 'fq').label, 'Q4 FY26-27');
  assert.equal(bucketOf('2026-07-01', 'fq').label, 'Q2 FY26-27');
  assert.equal(bucketOf('2027-01-15', 'quarter').label, 'Q1 2027', 'calendar quarters are also there');
  assert.equal(bucketOf('2027-01-15', 'month').label, 'Jan 2027');
});

test('a time axis has every period, with none skipped', () => {
  const seq = periodSequence('2026-01-20', '2026-05-02', 'month')!;
  assert.deepEqual(seq.map((b) => b.label), ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026']);
  const fq = periodSequence('2026-02-01', '2026-08-01', 'fq')!;
  assert.deepEqual(fq.map((b) => b.label), ['Q4 FY25-26', 'Q1 FY26-27', 'Q2 FY26-27']);
  assert.equal(periodSequence('2000-01-01', '2026-01-01', 'day'), null, 'too long to draw day by day');
  assert.equal(suggestGrain('2026-01-01', '2026-01-20'), 'day');
  assert.equal(suggestGrain('2024-04-01', '2026-08-01'), 'month');
});

// ── Importing a grid ─────────────────────────────────────────────────────────

const SALES = [
  ['Invoice No', 'Date', 'Customer', 'State', 'Amount', 'GST Rate', 'Qty'],
  ['1001', '01/04/2026', 'Sharma Traders', 'Tamil Nadu', '1,18,000', '18%', '1,950'],
  ['1002', '15/04/2026', 'Apex Motors', 'Karnataka', '(2,500)', '18%', '2,100'],
  [null, null, null, null, null, null, null],
  ['1003', '02/05/2026', 'Sharma Traders', 'Tamil Nadu', '₹ 54,000', '5%', '40'],
  ['', '', 'Grand Total', '', '1,69,500', '', '4,090'],
];

test('a real-looking export imports with the right types and roles', () => {
  const r = importGrid(SALES);
  assert.equal(r.hasHeader, true);
  assert.equal(r.rows.length, 3, 'blank row and totals row dropped');
  assert.equal(r.totalsRowDropped, true);

  const col = (label: string) => r.columns.find((c) => c.label === label)!;
  assert.equal(col('Invoice No').type, 'text', 'an invoice number is an identifier');
  assert.equal(col('Invoice No').role, 'dimension');
  assert.equal(col('Date').type, 'date');
  assert.equal(col('Amount').type, 'currency');
  assert.equal(col('Amount').role, 'measure');
  assert.equal(col('GST Rate').type, 'percent');
  assert.equal(col('Qty').type, 'number', 'quantities near 2000 are not years');
  assert.equal(col('Qty').role, 'measure');

  assert.deepEqual(r.rows[0], ['1001', '2026-04-01', 'Sharma Traders', 'Tamil Nadu', 118000, 18, 1950]);
  assert.equal(r.rows[1][4], -2500, 'the accounting negative');
});

test('the review screen is told about every guess', () => {
  const r = importGrid([
    ['Date', 'Balance', 'Year'],
    ['04/05/2026', '1,200 Dr', '2025'],
    ['06/07/2026', '300 Cr', '2026'],
  ]);
  const col = (label: string) => r.columns.find((c) => c.label === label)!;
  assert.match(col('Date').notes!.join(), /day\/month\/year/);
  assert.match(col('Balance').notes!.join(), /Dr\/Cr/);
  assert.equal(col('Year').type, 'text', 'a column called Year groups, it does not add');
  assert.match(col('Year').notes!.join(), /years/);
});

test('corrections re-read the column, and can skip or rename it', () => {
  const r = importGrid(SALES, { overrides: { 4: { type: 'text' }, 5: { skip: true }, 2: { label: 'Party' } } });
  assert.equal(r.columns.find((c) => c.label === 'Amount')!.type, 'text');
  assert.ok(!r.columns.some((c) => c.label === 'GST Rate'), 'skipped');
  assert.ok(r.columns.some((c) => c.label === 'Party'), 'renamed');
  assert.equal(r.rows[0].length, 6);
});

test('unreadable cells in a numeric column are blank, and counted', () => {
  const rows: (string | null)[][] = [['Item', 'Amount']];
  for (let i = 0; i < 40; i++) rows.push([`Item ${i}`, String(100 + i)]);
  rows.push(['Odd one', 'about 200']);
  const r = importGrid(rows);
  const amount = r.columns.find((c) => c.label === 'Amount')!;
  assert.equal(amount.type, 'currency');
  assert.equal(r.rows[40][1], null);
  assert.match(amount.notes!.join(), /1 value could not be read/);
});

test('duplicate and missing headers get usable names', () => {
  const r = importGrid([['Amount', 'Amount', null], ['a', 'b', 'c'], ['d', 'e', 'f']], { hasHeader: true });
  assert.deepEqual(r.columns.map((c) => c.label), ['Amount', 'Amount (2)', 'Column 3']);
});

test('headers are detected, and a headerless sheet is not given one', () => {
  assert.equal(detectHeader([['Region', 'Sales'], ['South', 100]]), true);
  assert.equal(detectHeader([[100, 200], [300, 400]]), false);
  assert.equal(detectHeader([['South', 100], ['North', 200]]), false);
});

test('long text is shortened, and said so', () => {
  const r = importGrid([['Note', 'Amount'], ['x'.repeat(600), 1], ['short', 2]]);
  assert.equal((r.rows[0][0] as string).length, 500);
  assert.match(r.columns[0].notes!.join(), /shortened/);
});

// ── The query engine ─────────────────────────────────────────────────────────

const PEOPLE: DatasetData = {
  columns: [
    { key: 'c0', index: 0, label: 'Region', type: 'text', role: 'dimension' },
    { key: 'c1', index: 1, label: 'Score', type: 'number', role: 'measure' },
    { key: 'c2', index: 2, label: 'Customer', type: 'text', role: 'dimension' },
    { key: 'c3', index: 3, label: 'Date', type: 'date', role: 'dimension' },
  ],
  rows: [
    ['A', 10, 'x', '2026-01-10'],
    ['A', 20, 'y', '2026-01-20'],
    ['B', 30, 'x', '2026-03-05'],
    ['C', 100, 'z', '2026-03-06'],
    ['D', 1, 'z', '2026-03-07'],
    ['D', 3, 'w', null],
    ['E', null, 'w', '2026-03-08'],
  ],
};

const spec = (s: Partial<ChartSpec>): ChartSpec => ({ type: 'bar', measures: [{ column: 'c1', agg: 'sum' }], ...s });

test('sums by category, largest first', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' } }));
  // A and B tie at 30; ties break alphabetically so the chart never depends on row order.
  assert.deepEqual(r.categories, ['C', 'A', 'B', 'D', 'E']);
  assert.deepEqual(r.values[0].map((c) => c[0]), [100, 30, 30, 4, null]);
  assert.equal(r.totals[0], 164);
});

test('no data is null, never zero', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' } }));
  assert.equal(r.values[0][r.categories.indexOf('E')][0], null, 'E has rows but no scores');
});

test('"Other" is re-aggregated from rows — the average is not an average of averages', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' }, measures: [{ column: 'c1', agg: 'avg' }], limit: 2 }));
  // Kept: the two highest averages, C (100) and B (30). Folded: A (10, 20),
  // D (1, 3) and E (none). The honest average of the folded rows is
  // (10 + 20 + 1 + 3) / 4 = 8.5. Averaging their averages would give 8.
  assert.deepEqual(r.categories, ['C', 'B', 'Other']);
  assert.equal(r.values[0][2][0], 8.5);
  assert.equal(r.folded.categories, 3);
});

test('distinct counts are not summed across "Other" either', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' }, measures: [{ column: 'c2', agg: 'countd' }], limit: 1 }));
  // A has customers x, y; the rest (B x, C z, D z w, E w) hold x, z, w — three,
  // not the 1 + 1 + 2 + 1 = 5 a sum of distinct counts would claim.
  const other = r.categories.indexOf('Other');
  assert.equal(r.values[0][other][0], 3);
});

test('averages over the whole slice come from the rows too', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' }, measures: [{ column: 'c1', agg: 'avg' }] }));
  assert.equal(r.totals[0], 164 / 6);
});

test('counting rows needs no column', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c0' }, measures: [{ column: null, agg: 'count' }] }));
  assert.equal(r.values[0][r.categories.indexOf('A')][0], 2);
  assert.equal(r.totals[0], 7);
  assert.equal(measureLabel({ column: null, agg: 'count' }, PEOPLE.columns), 'Rows');
});

test('a time axis keeps its empty months, and blanks sit at the end', () => {
  const r = runQuery(PEOPLE, spec({ category: { column: 'c3', grain: 'month' } }));
  assert.equal(r.temporal, true);
  assert.deepEqual(r.categories, ['Jan 2026', 'Feb 2026', 'Mar 2026', '(Blank)']);
  assert.deepEqual(r.values[0].map((c) => c[0]), [30, null, 131, 3], 'February is a gap, not a zero');
});

test('filters: lists including blanks, and date and number ranges', () => {
  const inList = runQuery(PEOPLE, spec({ category: { column: 'c0' } }), [{ column: 'c0', op: 'in', values: ['A', 'B'] }]);
  assert.deepEqual(inList.categories, ['A', 'B'], 'tied at 30, so alphabetical');

  const blanks = runQuery(PEOPLE, spec({}), [{ column: 'c3', op: 'in', values: [null] }]);
  assert.equal(blanks.rowCount, 1);

  const dates = runQuery(PEOPLE, spec({}), [{ column: 'c3', op: 'between', from: '2026-03-01', to: '2026-03-06' }]);
  assert.equal(dates.rowCount, 2);

  const nums = runQuery(PEOPLE, spec({}), [{ column: 'c1', op: 'between', from: 10, to: 30 }]);
  assert.equal(nums.totals[0], 60);
});

test('past eight series, the tail folds into "Other"', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`S${i}`, 12 - i, 'x', '2026-01-01']);
  const data: DatasetData = { ...PEOPLE, rows };
  const r = runQuery(data, spec({ category: { column: 'c2' }, series: { column: 'c0' } }));
  assert.equal(r.series.length, 9);
  assert.equal(r.series[8], 'Other');
  assert.equal(r.folded.series, 4);
  assert.equal(r.values[0][0][8], 4 + 3 + 2 + 1, 'S8–S11 folded');
});

test('stable order counts every row, before any filter', () => {
  assert.deepEqual(stableOrder(PEOPLE, { column: 'c0' }).slice(0, 2), ['A', 'D']);
  const dv = distinctValues(PEOPLE, 'c3');
  assert.equal(dv.find((d) => d.value === null)?.label, '(Blank)');
});

// ── Colour ───────────────────────────────────────────────────────────────────

test('colour follows the entity: a filter never repaints the survivors', () => {
  const stable = ['South', 'West', 'North', 'East'];
  const all = colorsFor(['South', 'West', 'North', 'East'], stable);
  const filtered = colorsFor(['West', 'East'], stable);
  assert.equal(filtered.get('West'), all.get('West'));
  assert.equal(filtered.get('East'), all.get('East'));
  assert.equal(all.get('South'), SERIES_COLORS[0]);
});

test('"Other" and blanks are grey; a deep-tail series takes a free slot', () => {
  const stable = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const m = colorsFor(['S0', 'S11', 'Other', '(Blank)'], stable);
  assert.equal(m.get('Other'), OTHER_COLOR);
  assert.equal(m.get('(Blank)'), OTHER_COLOR);
  assert.equal(m.get('S0'), SERIES_COLORS[0]);
  assert.equal(m.get('S11'), SERIES_COLORS[1], 'the first slot nobody on screen is using');
});

// ── Which chart ──────────────────────────────────────────────────────────────

const SAMPLE = sampleDataset();
const sampleCol = (label: string) => SAMPLE.columns.find((c) => c.label === label)!.key;

test('one number is a headline figure', () => {
  assert.equal(bestChart(spec({ measures: [{ column: sampleCol('Revenue'), agg: 'sum' }] }), SAMPLE), 'kpi');
});

test('a date axis is a line; a line over categories is refused, with the reason', () => {
  const byMonth = spec({ category: { column: sampleCol('Month'), grain: 'month' }, measures: [{ column: sampleCol('Revenue'), agg: 'sum' }] });
  assert.equal(bestChart(byMonth, SAMPLE), 'line');
  const byRegion = spec({ category: { column: sampleCol('Region') }, measures: [{ column: sampleCol('Revenue'), agg: 'sum' }] });
  const line = assessCharts(byRegion, SAMPLE).find((f) => f.type === 'line')!;
  assert.equal(line.fits, false);
  assert.match(line.reason, /in order/);
  assert.equal(bestChart(byRegion, SAMPLE), 'bar');
});

test('two measures in different units never share an axis', () => {
  const s = spec({
    category: { column: sampleCol('Region') },
    measures: [{ column: sampleCol('Revenue'), agg: 'sum' }, { column: sampleCol('Units'), agg: 'sum' }],
  });
  const fits = assessCharts(s, SAMPLE);
  assert.equal(fits.find((f) => f.type === 'bar')!.fits, false);
  assert.match(fits.find((f) => f.type === 'bar')!.reason, /different units/);
  assert.equal(bestChart(s, SAMPLE), 'scatter');
});

test('revenue against budget is a variance', () => {
  const s = spec({
    category: { column: sampleCol('Region') },
    measures: [{ column: sampleCol('Revenue'), agg: 'sum' }, { column: sampleCol('Budget'), agg: 'sum' }],
  });
  assert.equal(bestChart(s, SAMPLE), 'variance');
});

test('a donut refuses too many slices, negatives and averages', () => {
  const base = spec({ category: { column: 'c0' } });
  const many = runQuery({ ...PEOPLE, rows: Array.from({ length: 9 }, (_, i) => [`R${i}`, 1, 'x', null]) }, base);
  assert.match(assessCharts(base, PEOPLE, many).find((f) => f.type === 'donut')!.reason, /9 slices/);

  const neg = runQuery({ ...PEOPLE, rows: [['A', -5, 'x', null], ['B', 3, 'y', null]] }, base);
  assert.match(assessCharts(base, PEOPLE, neg).find((f) => f.type === 'donut')!.reason, /negative/);

  const avg = spec({ category: { column: 'c0' }, measures: [{ column: 'c1', agg: 'avg' }] });
  assert.equal(assessCharts(avg, PEOPLE).find((f) => f.type === 'donut')!.fits, false);
});

test('only totals can be stacked', () => {
  const s = spec({ category: { column: 'c0' }, series: { column: 'c2' }, measures: [{ column: 'c1', agg: 'avg' }] });
  const stacked = assessCharts(s, PEOPLE).find((f) => f.type === 'stacked')!;
  assert.equal(stacked.fits, false);
  assert.match(stacked.reason, /average/);
});

// ── The starter report ───────────────────────────────────────────────────────

test('the sample dataset reads as intended', () => {
  const col = (l: string) => SAMPLE.columns.find((c) => c.label === l)!;
  assert.equal(SAMPLE.rows.length, 29 * 4 * 4 * 3);
  assert.equal(col('Month').type, 'date');
  assert.equal(col('Revenue').type, 'currency');
  assert.equal(col('Units').type, 'number');
  assert.equal(col('Region').role, 'dimension');
  assert.equal(checkRows(SAMPLE.columns, SAMPLE.rows), null);
});

test('a new dataset lands on a working dashboard, not an empty page', () => {
  const tiles = starterTiles(SAMPLE);
  const types = tiles.map((t) => t.spec.type);
  assert.ok(types.filter((t) => t === 'kpi').length >= 2, 'headline figures');
  assert.ok(types.includes('line'), 'the trend');
  assert.ok(types.includes('donut') || types.includes('bar'), 'the mix');
  assert.ok(types.includes('variance'), 'revenue against budget, because there is a budget');
  assert.ok(types.includes('pivot'), 'the exact figures');

  // Every tile is a valid spec, and every one runs.
  assert.equal(LayoutSchema.safeParse({ tiles }).success, true);
  for (const t of tiles) {
    assert.equal(ChartSpecSchema.safeParse(t.spec).success, true, t.spec.title);
    const r = runQuery(SAMPLE, t.spec);
    assert.ok(r.rowCount > 0, t.spec.title);
    const fit = assessCharts(t.spec, SAMPLE, r).find((f) => f.type === t.spec.type)!;
    assert.equal(fit.fits, true, `${t.spec.type} — ${fit.reason}`);
  }
});

test('periods across the columns run in time order, and keep the most recent', () => {
  const month = sampleCol('Month');
  const pivot = runQuery(SAMPLE, {
    type: 'pivot',
    category: { column: sampleCol('Region') },
    series: { column: month, grain: 'fy' },
    measures: [{ column: sampleCol('Revenue'), agg: 'sum' }],
  });
  // Ordered by size, FY 2025-26 — the bigger year — would come before FY 2024-25.
  assert.deepEqual(pivot.series, ['FY 2024-25', 'FY 2025-26', 'FY 2026-27']);

  const months = runQuery(
    SAMPLE,
    { type: 'bar', category: { column: sampleCol('Region') }, series: { column: month, grain: 'month' }, measures: [{ column: null, agg: 'count' }] },
    [],
    { maxSeries: 3 },
  );
  assert.deepEqual(months.series, ['Jun 2026', 'Jul 2026', 'Aug 2026', 'Other'], 'older months fold, not smaller ones');
});

test('the starter picks a name to rank by, not an identifier', () => {
  const r = importGrid([
    ['Date', 'Customer', 'PIN', 'Amount'],
    ...Array.from({ length: 40 }, (_, i) => [`0${(i % 9) + 1}/04/2026`, ['Asha', 'Ravi', 'Mei', 'Arun', 'Divya'][i % 5], String(600001 + i), String(1000 + i * 37)]),
  ]);
  const data = { columns: r.columns, rows: r.rows };
  const bar = starterTiles(data).find((t) => t.spec.type === 'bar');
  const col = data.columns.find((c) => c.key === bar?.spec.category?.column);
  assert.equal(col?.label, 'Customer');
});

test('a rise in cost is not shown as good news', () => {
  const kpis = starterTiles(SAMPLE).filter((t) => t.spec.type === 'kpi');
  const cost = kpis.find((t) => t.spec.measures[0].column === sampleCol('Cost'));
  assert.equal(cost?.spec.favourable, 'lower');
  const revenue = kpis.find((t) => t.spec.measures.length === 1 && t.spec.measures[0].column === sampleCol('Revenue'));
  assert.notEqual(revenue?.spec.favourable, 'lower');
});

test('the starter report copes with data that has no numbers or dates', () => {
  const r = importGrid([['Name', 'City'], ['Asha', 'Chennai'], ['Ravi', 'Pune'], ['Mei', 'Chennai']]);
  const tiles = starterTiles({ columns: r.columns, rows: r.rows });
  assert.ok(tiles.length >= 1);
  for (const t of tiles) runQuery({ columns: r.columns, rows: r.rows }, t.spec);
});

test('stored rows are checked against their schema', () => {
  assert.match(checkRows(SAMPLE.columns, [[1, 2]]) ?? '', /expected 8/);
  const bad = SAMPLE.rows.slice(0, 1).map((r) => r.map((c, i) => (i === 4 ? 'lots' : c)));
  assert.match(checkRows(SAMPLE.columns, bad) ?? '', /not a number/);
});

// ── Formatting ───────────────────────────────────────────────────────────────

test('rupees in lakh and crore', () => {
  assert.equal(formatValue(1234567, 'inr'), '₹12,34,567');
  assert.equal(formatValue(-2500, 'inr'), '-₹2,500');
  assert.equal(formatValue(1234567, 'inr-compact'), '₹12.3L');
  assert.equal(formatValue(45000000, 'inr-compact'), '₹4.5Cr');
  assert.equal(formatAxis(250000, 'inr'), '₹2.5L');
  assert.equal(formatHeadline(98_76_543, 'inr'), '₹98.8L');
  assert.equal(formatValue(12.5, 'percent'), '12.5%');
  assert.equal(formatValue(null, 'inr'), '—', 'no data is a dash, not ₹0');
  assert.equal(defaultAggregation('percent', 'measure'), 'avg', 'percentages are averaged, never summed');
});
