// ─────────────────────────────────────────────────────────────────────────────
// Sample data — for trying Analytics before you have any of your own.
//
// Regional sales against budget for an auto-parts distributor, month by month
// across two and a half financial years. Shaped like the real thing — seasonal,
// growing, with some regions ahead of plan and some behind — so every chart
// type has something honest to show, including variance.
//
// Deterministic: the same rows every time, so a screenshot, a test and a
// training session all see the same numbers. Always labelled as sample data.
// ─────────────────────────────────────────────────────────────────────────────

import { importGrid, type RawCell } from './infer';
import type { DatasetData } from './types';

/** A small seeded generator — the same seed gives the same rows forever. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS: [string, number][] = [['South', 1.35], ['West', 1.15], ['North', 0.95], ['East', 0.7]];
const LINES: [string, number, number, number][] = [
  // name, monthly base revenue (₹), cost ratio, average unit price (₹)
  ['Brake systems', 4_20_000, 0.64, 1_850],
  ['Filters', 2_60_000, 0.58, 420],
  ['Tyres', 6_10_000, 0.71, 4_600],
  ['Lubricants', 1_90_000, 0.55, 640],
];
const CHANNELS: [string, number][] = [['Dealer', 1.0], ['Workshop', 0.62], ['Online', 0.28]];

/** Indian auto-parts demand: a festive peak in Oct–Nov, a monsoon dip in Jul–Aug. */
const SEASON = [0.92, 0.88, 1.12, 0.98, 1.0, 1.02, 0.86, 0.84, 0.97, 1.18, 1.22, 1.01];

export const SAMPLE_NAME = 'Regional sales and budget (sample)';

export function sampleDataset(): DatasetData & { name: string; description: string } {
  const rand = mulberry32(20260911);
  const grid: RawCell[][] = [['Month', 'Region', 'Product line', 'Channel', 'Revenue', 'Budget', 'Cost', 'Units']];

  // April 2024 to August 2026: FY 2024-25, FY 2025-26 and FY 2026-27 to date.
  for (let i = 0; i < 29; i++) {
    const y = 2024 + Math.floor((3 + i) / 12);
    const m = ((3 + i) % 12) + 1;
    const month = `${y}-${String(m).padStart(2, '0')}-01`;
    const growth = 1 + i * 0.011;

    for (const [region, rf] of REGIONS) {
      // Each region runs its own distance from plan, so variance has a story.
      const planGap = region === 'South' ? 1.06 : region === 'East' ? 0.88 : region === 'North' ? 0.97 : 1.01;
      for (const [line, base, costRatio, price] of LINES) {
        for (const [channel, cf] of CHANNELS) {
          const expected = base * rf * cf * SEASON[m - 1] * growth;
          const noise = 0.9 + rand() * 0.2;
          const revenue = Math.round(expected * planGap * noise);
          const budget = Math.round((expected * 1.02) / 100) * 100;
          const cost = Math.round(revenue * costRatio * (0.97 + rand() * 0.06));
          const units = Math.max(1, Math.round(revenue / price));
          grid.push([month, region, line, channel, revenue, budget, cost, units]);
        }
      }
    }
  }

  const { columns, rows } = importGrid(grid, { hasHeader: true });
  return {
    name: SAMPLE_NAME,
    description:
      'Illustrative data for trying out Analytics: monthly revenue, budget, cost and units by region, product line ' +
      'and sales channel. None of it is real.',
    columns,
    rows,
  };
}
