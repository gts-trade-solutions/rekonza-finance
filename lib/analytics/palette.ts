// ─────────────────────────────────────────────────────────────────────────────
// Colour, assigned by what it means.
//
// Four jobs, four rules:
//
//   identity   — eight categorical hues, in a fixed order, never cycled. A
//                ninth series is not a ninth colour; it folds into "Other".
//   magnitude  — one hue, light to dark, for heatmaps.
//   polarity   — two opposite hues with a grey middle, for variance.
//   nothing    — "Other" and de-emphasis are grey, so they never compete.
//
// The eight hues are validated — lightness band, chroma floor, colour-blind
// separation between neighbours, normal-vision floor — against this app's own
// card surfaces in both themes (`#ffffff` light, `#12181f` dark). They live as
// CSS variables in globals.css so the dark theme is its own selected set, not
// an automatic inversion. Three light-mode hues sit under 3:1 against white,
// which is why every chart here also has a table view.
// ─────────────────────────────────────────────────────────────────────────────

import { BLANK, OTHER } from './types';

/** The categorical slots, in their validated order. */
export const SERIES_COLORS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
  'var(--viz-7)',
  'var(--viz-8)',
] as const;

/** The ceiling. Past it, the tail folds — see the series-count ladder. */
export const MAX_SERIES = SERIES_COLORS.length;

/**
 * Scatter compares every point with every other, so every pair of colours
 * must separate, not just neighbours. Only the first three do.
 */
export const MAX_SCATTER_SERIES = 3;

export const OTHER_COLOR = 'var(--viz-other)';

/** The sequential ramp for magnitude, lightest to darkest. */
export const SEQUENTIAL = [
  'var(--viz-seq-1)',
  'var(--viz-seq-2)',
  'var(--viz-seq-3)',
  'var(--viz-seq-4)',
  'var(--viz-seq-5)',
  'var(--viz-seq-6)',
  'var(--viz-seq-7)',
] as const;

export const DIVERGING = {
  positive: 'var(--viz-div-pos)',
  negative: 'var(--viz-div-neg)',
  neutral: 'var(--viz-div-mid)',
} as const;

/**
 * Colour per series, following the entity rather than its position.
 *
 * `stable` is the order of the dimension's values across the whole dataset,
 * unfiltered — so when a filter removes one series, the survivors keep their
 * colours. A reader who learned "South is orange" is never quietly repainted.
 *
 * The dataset's own top eight always get the same slot. A series from deeper
 * in the tail that only reaches the chart under a filter takes the first slot
 * nobody on screen is using.
 */
export function colorsFor(visible: string[], stable: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  const rank = new Map(stable.map((v, i) => [v, i]));
  const pending: string[] = [];

  for (const v of visible) {
    if (v === OTHER || v === BLANK) {
      out.set(v, OTHER_COLOR);
      continue;
    }
    const r = rank.get(v);
    if (r !== undefined && r < MAX_SERIES && !used.has(r)) {
      out.set(v, SERIES_COLORS[r]);
      used.add(r);
    } else pending.push(v);
  }
  for (const v of pending) {
    const free = SERIES_COLORS.findIndex((_, i) => !used.has(i));
    if (free === -1) {
      out.set(v, OTHER_COLOR);
      continue;
    }
    used.add(free);
    out.set(v, SERIES_COLORS[free]);
  }
  return out;
}

/** Which step of the sequential ramp a value falls on, between the grid's min and max. */
export function sequentialStep(v: number, min: number, max: number): number {
  if (max === min) return SEQUENTIAL.length - 1;
  const t = (v - min) / (max - min);
  return Math.min(SEQUENTIAL.length - 1, Math.max(0, Math.floor(t * SEQUENTIAL.length)));
}
