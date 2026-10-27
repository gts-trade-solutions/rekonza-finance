'use client';

// Shared Recharts config so every chart in the app reads as one system:
// same grid, same axis treatment, same tooltip chrome, same palette order.

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

export const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--popover-foreground)',
  boxShadow: '0 4px 12px rgb(0 0 0 / 0.08)',
};

/** Rupee tooltip formatter (Recharts' formatter type is loose by design). */
export const rupeeFormatter = (v: unknown): string =>
  `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/** Axis tick: ₹1.2L / ₹3.4Cr / ₹12K — Indian units keep axes readable. */
export const axisRupee = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1_00_00_000) return `₹${(v / 1_00_00_000).toFixed(1)}Cr`;
  if (a >= 1_00_000) return `₹${(v / 1_00_000).toFixed(1)}L`;
  if (a >= 1_000) return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v}`;
};

export const axisProps = {
  tickLine: false,
  axisLine: false,
  fontSize: 11,
  stroke: 'var(--muted-foreground)',
} as const;
