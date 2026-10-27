// ─────────────────────────────────────────────────────────────────────────────
// The statutory side of a salary: provident fund, ESI, professional tax,
// labour welfare fund and income tax. Pure functions over paise, so a payroll
// run, a payslip preview and the tests all agree to the rupee.
//
// Client-safe on purpose: the employee form shows what a structure will cost
// and take home while it is being typed.
//
// ── The state tables (professional tax, LWF) need a CA's sign-off. ──
// States notify these individually and revise them without much notice. What
// is here are the commonly published figures; a state not listed deducts
// nothing until it is added, and an employee can carry an override.
// ─────────────────────────────────────────────────────────────────────────────

export type Paise = number;
const rupee = (p: Paise) => Math.round(p / 100) * 100;
/** ESI is rounded up to the next rupee (ESI (Central) Rules, rule 51). */
const rupeeUp = (p: Paise) => Math.ceil(p / 100) * 100;

// ── Provident fund (EPF & MP Act, 1952) ──────────────────────────────────────

/** The statutory wage ceiling for contributions and the pension scheme. */
export const PF_WAGE_CEILING: Paise = 15_000_00;

export interface PfResult {
  /** Basic and DA earned in the month: what PF is worked on. */
  pfWage: Paise;
  /** The wage contributions are taken on: the ceiling unless contributing on actual. */
  contributionWage: Paise;
  epsWage: Paise;
  employee: Paise;
  /** The employer's 12%, less what goes to the pension scheme. */
  employerEpf: Paise;
  employerEps: Paise;
  /** 0.5% of the PF wage, payable to EPFO with the challan. */
  admin: Paise;
  /** EDLI insurance, 0.5% of wages up to the ceiling. */
  edli: Paise;
}

export function pf(o: { pfWage: Paise; member: boolean; epsMember: boolean; onActual: boolean }): PfResult {
  const zero = { pfWage: o.pfWage, contributionWage: 0, epsWage: 0, employee: 0, employerEpf: 0, employerEps: 0, admin: 0, edli: 0 };
  if (!o.member || o.pfWage <= 0) return zero;
  const wage = o.onActual ? o.pfWage : Math.min(o.pfWage, PF_WAGE_CEILING);
  const capped = Math.min(o.pfWage, PF_WAGE_CEILING);
  const employee = rupee(wage * 0.12);
  const employerTotal = rupee(wage * 0.12);
  // Pension is 8.33% of wages up to the ceiling, never more, and only for members.
  const employerEps = o.epsMember ? Math.min(rupee(capped * 0.0833), employerTotal) : 0;
  return {
    pfWage: o.pfWage,
    contributionWage: wage,
    epsWage: o.epsMember ? capped : 0,
    employee,
    employerEpf: employerTotal - employerEps,
    employerEps,
    admin: rupee(wage * 0.005),
    edli: rupee(capped * 0.005),
  };
}

// ── ESI (ESI Act, 1948) ──────────────────────────────────────────────────────

export const ESI_WAGE_CEILING: Paise = 21_000_00;
/** For a person with a disability. */
export const ESI_WAGE_CEILING_DISABLED: Paise = 25_000_00;
/** Below this average daily wage the employee's share is waived; the employer still pays. */
export const ESI_EXEMPT_DAILY_WAGE: Paise = 176_00;

/** Contribution periods run April–September and October–March. */
export const esiPeriodOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  if (m >= 4 && m <= 9) return { from: `${y}-04`, to: `${y}-09` };
  return m >= 10 ? { from: `${y}-10`, to: `${y + 1}-03` } : { from: `${y - 1}-10`, to: `${y}-03` };
};

/**
 * ESI for a month. Coverage is decided at the start of the contribution
 * period: someone covered then stays covered to its end, whatever they earn
 * meanwhile (`coveredThisPeriod`). Coverage goes by the monthly rate of
 * wages (`rateWage`); contributions by what was earned (`esiWage`), so a month
 * of unpaid leave neither brings someone in nor takes them out.
 */
export function esi(o: { esiWage: Paise; rateWage: Paise; paidDays: number; disabled: boolean; coveredThisPeriod: boolean }): { covered: boolean; employee: Paise; employer: Paise } {
  const ceiling = o.disabled ? ESI_WAGE_CEILING_DISABLED : ESI_WAGE_CEILING;
  const covered = o.coveredThisPeriod || o.rateWage <= ceiling;
  if (!covered || o.esiWage <= 0) return { covered, employee: 0, employer: 0 };
  const daily = o.paidDays > 0 ? o.esiWage / o.paidDays : 0;
  return {
    covered,
    employee: daily > 0 && daily <= ESI_EXEMPT_DAILY_WAGE ? 0 : rupeeUp(o.esiWage * 0.0075),
    employer: rupeeUp(o.esiWage * 0.0325),
  };
}

// ── Professional tax (state Acts) ────────────────────────────────────────────

interface Slab { upTo: Paise | null; amount: Paise }
/** First slab whose ceiling covers the wage. */
const slab = (slabs: Slab[], wage: Paise) => slabs.find((s) => s.upTo === null || wage <= s.upTo)?.amount ?? 0;

interface PtRule {
  state: string;
  /** Monthly slabs on the month's gross, or half-yearly slabs deducted a sixth a month. */
  basis: 'monthly' | 'half_yearly';
  slabs: (gender: 'male' | 'female' | 'other' | null) => Slab[];
  /** February's deduction where the state makes it up to the annual maximum. */
  february?: Paise;
}

export const PT_RULES: Record<string, PtRule> = {
  '27': {
    state: 'Maharashtra', basis: 'monthly', february: 300_00,
    slabs: (g) => (g === 'female'
      ? [{ upTo: 25_000_00, amount: 0 }, { upTo: null, amount: 200_00 }]
      : [{ upTo: 7_500_00, amount: 0 }, { upTo: 10_000_00, amount: 175_00 }, { upTo: null, amount: 200_00 }]),
  },
  '29': { state: 'Karnataka', basis: 'monthly', february: 300_00, slabs: () => [{ upTo: 24_999_00, amount: 0 }, { upTo: null, amount: 200_00 }] },
  '19': {
    state: 'West Bengal', basis: 'monthly',
    slabs: () => [{ upTo: 10_000_00, amount: 0 }, { upTo: 15_000_00, amount: 110_00 }, { upTo: 25_000_00, amount: 130_00 }, { upTo: 40_000_00, amount: 150_00 }, { upTo: null, amount: 200_00 }],
  },
  '36': { state: 'Telangana', basis: 'monthly', slabs: () => [{ upTo: 15_000_00, amount: 0 }, { upTo: 20_000_00, amount: 150_00 }, { upTo: null, amount: 200_00 }] },
  '37': { state: 'Andhra Pradesh', basis: 'monthly', slabs: () => [{ upTo: 15_000_00, amount: 0 }, { upTo: 20_000_00, amount: 150_00 }, { upTo: null, amount: 200_00 }] },
  '24': { state: 'Gujarat', basis: 'monthly', slabs: () => [{ upTo: 11_999_00, amount: 0 }, { upTo: null, amount: 200_00 }] },
  '18': { state: 'Assam', basis: 'monthly', slabs: () => [{ upTo: 10_000_00, amount: 0 }, { upTo: 15_000_00, amount: 150_00 }, { upTo: 25_000_00, amount: 180_00 }, { upTo: null, amount: 208_00 }] },
  '33': {
    state: 'Tamil Nadu', basis: 'half_yearly',
    slabs: () => [{ upTo: 21_000_00, amount: 0 }, { upTo: 30_000_00, amount: 180_00 }, { upTo: 45_000_00, amount: 425_00 }, { upTo: 60_000_00, amount: 930_00 }, { upTo: 75_000_00, amount: 1_025_00 }, { upTo: null, amount: 1_250_00 }],
  },
  '32': {
    state: 'Kerala', basis: 'half_yearly',
    slabs: () => [{ upTo: 11_999_00, amount: 0 }, { upTo: 17_999_00, amount: 120_00 }, { upTo: 29_999_00, amount: 180_00 }, { upTo: 44_999_00, amount: 300_00 }, { upTo: 59_999_00, amount: 450_00 }, { upTo: 74_999_00, amount: 600_00 }, { upTo: 99_999_00, amount: 750_00 }, { upTo: 1_24_999_00, amount: 1_000_00 }, { upTo: null, amount: 1_250_00 }],
  },
};

/** Professional tax for a month's gross, in the state the employee works in. */
export function professionalTax(o: { stateCode: string; month: string; gross: Paise; gender: 'male' | 'female' | 'other' | null }): Paise {
  const rule = PT_RULES[o.stateCode];
  if (!rule || o.gross <= 0) return 0;
  if (rule.basis === 'half_yearly') return rupee(slab(rule.slabs(o.gender), o.gross * 6) / 6);
  const amount = slab(rule.slabs(o.gender), o.gross);
  return amount > 0 && rule.february && o.month.endsWith('-02') ? rule.february : amount;
}

// ── Labour welfare fund (state Acts) ─────────────────────────────────────────

/** Contributions and the months they fall due in. */
export const LWF_RULES: Record<string, { state: string; employee: Paise; employer: Paise; months: string[] }> = {
  '27': { state: 'Maharashtra', employee: 25_00, employer: 75_00, months: ['06', '12'] },
  '29': { state: 'Karnataka', employee: 50_00, employer: 100_00, months: ['12'] },
  '33': { state: 'Tamil Nadu', employee: 20_00, employer: 40_00, months: ['12'] },
  '24': { state: 'Gujarat', employee: 6_00, employer: 12_00, months: ['06', '12'] },
  '19': { state: 'West Bengal', employee: 3_00, employer: 15_00, months: ['06', '12'] },
  '36': { state: 'Telangana', employee: 2_00, employer: 5_00, months: ['12'] },
};

export function labourWelfare(stateCode: string, month: string): { employee: Paise; employer: Paise } {
  const r = LWF_RULES[stateCode];
  return r && r.months.includes(month.slice(5)) ? { employee: r.employee, employer: r.employer } : { employee: 0, employer: 0 };
}

// ── Income tax on salary ─────────────────────────────────────────────────────

interface Regime { standardDeduction: Paise; slabs: { upTo: Paise | null; ratePct: number }[]; rebateUpTo: Paise; rebateMax: Paise }

/**
 * Rates for individuals below 60, from the financial year starting 2025
 * (Finance Act 2025; carried into the Income-tax Act, 2025).
 */
export const REGIMES: Record<'new' | 'old', Regime> = {
  new: {
    standardDeduction: 75_000_00,
    slabs: [
      { upTo: 4_00_000_00, ratePct: 0 }, { upTo: 8_00_000_00, ratePct: 5 }, { upTo: 12_00_000_00, ratePct: 10 },
      { upTo: 16_00_000_00, ratePct: 15 }, { upTo: 20_00_000_00, ratePct: 20 }, { upTo: 24_00_000_00, ratePct: 25 },
      { upTo: null, ratePct: 30 },
    ],
    rebateUpTo: 12_00_000_00,
    rebateMax: 60_000_00,
  },
  old: {
    standardDeduction: 50_000_00,
    slabs: [{ upTo: 2_50_000_00, ratePct: 0 }, { upTo: 5_00_000_00, ratePct: 5 }, { upTo: 10_00_000_00, ratePct: 20 }, { upTo: null, ratePct: 30 }],
    rebateUpTo: 5_00_000_00,
    rebateMax: 12_500_00,
  },
};

/**
 * The year's tax on a year's salary. Surcharge applies above ₹50 lakh at the
 * flat rates, without marginal relief; a salary that high should be checked
 * by hand.
 */
export function annualTax(o: { regime: 'new' | 'old'; grossSalary: Paise; deductions?: Paise; professionalTax?: Paise }): { taxable: Paise; tax: Paise } {
  const t = taxComputation(o);
  return { taxable: t.taxable, tax: t.tax };
}

export interface TaxComputation {
  standardDeduction: Paise; deductions: Paise; professionalTax: Paise; taxable: Paise;
  slabTax: Paise; rebate: Paise; surcharge: Paise; cess: Paise; tax: Paise;
}

/** The year's tax step by step, as Form 16 sets it out. */
export function taxComputation(o: { regime: 'new' | 'old'; grossSalary: Paise; deductions?: Paise; professionalTax?: Paise }): TaxComputation {
  const r = REGIMES[o.regime];
  // Professional tax and the chapter VI-A deductions count under the old regime only.
  const deductions = o.regime === 'old' ? (o.deductions ?? 0) : 0;
  const professionalTax = o.regime === 'old' ? (o.professionalTax ?? 0) : 0;
  const taxable = Math.max(0, rupee(o.grossSalary - r.standardDeduction - deductions - professionalTax));
  let slabTax = 0;
  let floor = 0;
  for (const s of r.slabs) {
    const top = s.upTo ?? Infinity;
    if (taxable > floor) slabTax += ((Math.min(taxable, top) - floor) * s.ratePct) / 100;
    floor = top;
    if (taxable <= top) break;
  }
  // Rebate under s.87A, with marginal relief just above the limit in the new regime.
  let tax = slabTax;
  if (taxable <= r.rebateUpTo) tax = Math.max(0, tax - r.rebateMax);
  else if (o.regime === 'new') tax = Math.min(tax, taxable - r.rebateUpTo);
  const rebate = slabTax - tax;
  const rate = taxable > 5_00_00_000_00 ? (o.regime === 'new' ? 25 : 37)
    : taxable > 2_00_00_000_00 ? 25 : taxable > 1_00_00_000_00 ? 15 : taxable > 50_00_000_00 ? 10 : 0;
  const surcharge = (tax * rate) / 100;
  const cess = ((tax + surcharge) * 4) / 100; // health and education cess
  return {
    standardDeduction: r.standardDeduction, deductions, professionalTax, taxable,
    slabTax: Math.round(slabTax), rebate: Math.round(rebate), surcharge: Math.round(surcharge), cess: Math.round(cess),
    tax: rupee(tax + surcharge + cess),
  };
}

// ── Old-regime deductions, from the employee's declarations ─────────────────

export type DeductionSection = '80C' | '80CCD1B' | '80D' | '80E' | '80G' | '80TTA' | '24B' | 'HRA' | 'other';

/** The most each section allows a year. 80D is the most for self and senior-citizen parents together. */
export const SECTION_CAPS: Partial<Record<DeductionSection, Paise>> = {
  '80C': 1_50_000_00, '80CCD1B': 50_000_00, '80D': 1_00_000_00, '80TTA': 10_000_00, '24B': 2_00_000_00,
};

/**
 * HRA exempt for the year: the least of the HRA received, rent paid less a
 * tenth of basic and DA, and half (metro) or two-fifths of basic and DA.
 */
export function hraExemption(o: { hraReceived: Paise; basicDa: Paise; rentPaid: Paise; metro: boolean }): Paise {
  if (o.hraReceived <= 0 || o.rentPaid <= 0) return 0;
  return Math.max(0, Math.min(o.hraReceived, o.rentPaid - Math.round(o.basicDa / 10), Math.round((o.basicDa * (o.metro ? 50 : 40)) / 100)));
}

/** Each section's claim, capped, with the HRA exemption worked out from the rent declared. */
export function oldRegimeDeductions(
  items: { section: DeductionSection; amount: Paise }[], ctx: { hraReceived: Paise; basicDa: Paise; metro: boolean },
): { bySection: Partial<Record<DeductionSection, Paise>>; hra: Paise; total: Paise } {
  const claimed: Partial<Record<DeductionSection, Paise>> = {};
  for (const i of items) claimed[i.section] = (claimed[i.section] ?? 0) + Math.max(0, i.amount);
  const bySection: Partial<Record<DeductionSection, Paise>> = {};
  for (const [section, amount] of Object.entries(claimed) as [DeductionSection, Paise][]) {
    if (section === 'HRA') continue;
    const cap = SECTION_CAPS[section];
    bySection[section] = cap === undefined ? amount : Math.min(amount, cap);
  }
  const hra = hraExemption({ ...ctx, rentPaid: claimed.HRA ?? 0 });
  return { bySection, hra, total: hra + Object.values(bySection).reduce((t, v) => t + (v ?? 0), 0) };
}

/**
 * This month's TDS: the year's projected tax, less what was deducted in the
 * year's earlier months, spread over the months left including this one.
 */
export function monthlyTds(o: { annualTax: Paise; deductedSoFar: Paise; monthsLeft: number }): Paise {
  if (o.monthsLeft <= 0) return 0;
  return Math.max(0, rupee((o.annualTax - o.deductedSoFar) / o.monthsLeft));
}

/** Months left in the financial year, counting `month` itself: April is 12, March is 1. */
export const monthsLeftInFy = (month: string) => {
  const m = Number(month.slice(5));
  return m >= 4 ? 16 - m : 4 - m;
};
