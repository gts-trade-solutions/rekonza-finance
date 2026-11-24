// Zoho Books' "Repeat Every" on a recurring invoice (recorded 2026-11-23):
// Week, 2 Weeks, Month, 2/3/6 Months, Year, 2/3 Years, or Custom — a unit
// and a count (migration 123). Shared by the form and the server.

export type RepeatUnit = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const REPEAT_CHOICES: { value: string; label: string; frequency: RepeatUnit; every: number }[] = [
  { value: 'week', label: 'Week', frequency: 'weekly', every: 1 },
  { value: '2_weeks', label: '2 Weeks', frequency: 'weekly', every: 2 },
  { value: 'month', label: 'Month', frequency: 'monthly', every: 1 },
  { value: '2_months', label: '2 Months', frequency: 'monthly', every: 2 },
  { value: '3_months', label: '3 Months', frequency: 'monthly', every: 3 },
  { value: '6_months', label: '6 Months', frequency: 'monthly', every: 6 },
  { value: 'year', label: 'Year', frequency: 'yearly', every: 1 },
  { value: '2_years', label: '2 Years', frequency: 'yearly', every: 2 },
  { value: '3_years', label: '3 Years', frequency: 'yearly', every: 3 },
];

const UNIT_WORD: Record<RepeatUnit, [string, string]> = {
  daily: ['Day', 'Days'], weekly: ['Week', 'Weeks'], monthly: ['Month', 'Months'], quarterly: ['Quarter', 'Quarters'], yearly: ['Year', 'Years'],
};

/** "Week", "2 Weeks", "Every 10 Days": a profile's period as Zoho words it. */
export function repeatLabel(frequency: RepeatUnit, every: number): string {
  if (frequency === 'quarterly') return every === 1 ? '3 Months' : `Every ${every * 3} Months`;
  const known = REPEAT_CHOICES.find((c) => c.frequency === frequency && c.every === every);
  if (known) return known.label;
  const [one, many] = UNIT_WORD[frequency];
  return `Every ${every} ${every === 1 ? one : many}`;
}

/** The Repeat Every choice a profile is on, or 'custom'. */
export function repeatChoice(frequency: RepeatUnit, every: number): string {
  if (frequency === 'quarterly' && every === 1) return '3_months';
  return REPEAT_CHOICES.find((c) => c.frequency === frequency && c.every === every)?.value ?? 'custom';
}
