// ─────────────────────────────────────────────────────────────────────────────
// From tokens to credits.
//
// A question is charged what it actually cost: the provider's price for the
// tokens it used, converted to credits at a fixed rate (AI_CREDIT_COST_USD).
// That is how API token billing works, and it is fair in both directions — a
// one-line balance check costs a fraction of a quarter-by-quarter analysis.
//
// Prices are per million tokens, in US dollars, as the provider publishes
// them. They change; check them against https://openai.com/api/pricing before
// going live, and override with OPENAI_PRICE_INPUT / _CACHED / _OUTPUT if the
// table below is out of date. A model missing from the table is priced at the
// conservative fallback, so an unknown model can cost us margin but can never
// be given away.
//
// Pure functions, no server imports: the tests pin every rule here.
// ─────────────────────────────────────────────────────────────────────────────

import { REPORT_MARKUP_PCT, REPORT_MIN_SURCHARGE_MC } from '../../billing/catalog';
import type { CallUsage } from './types';

export interface ModelPrice {
  /** US$ per million uncached input tokens. */
  input: number;
  /** US$ per million input tokens served from the prompt cache. */
  cached: number;
  /** US$ per million output tokens, reasoning included. */
  output: number;
}

/** Published list prices at the time of writing. Longest matching prefix wins. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  o3: { input: 2, cached: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  // The built-in stand-in costs nothing to run, but is priced like a small
  // model so the whole credit flow can be exercised without a key.
  'stand-in': { input: 0.25, cached: 0.025, output: 2 },
};

/** For a model not in the table: priced high enough that it can never be undercharged. */
export const FALLBACK_PRICE: ModelPrice = { input: 2.5, cached: 1.25, output: 10 };

/** Credits charged even for the smallest question: 0.1 of a credit. */
export const MIN_CHARGE_MC = 100;

/**
 * The price for a model. An environment override wins, then the longest
 * matching entry — so a dated snapshot like `gpt-5-mini-2025-08-07` is priced
 * as `gpt-5-mini`, not as `gpt-5`.
 */
export function priceFor(
  model: string,
  env: Record<string, string | undefined> = process.env,
): { price: ModelPrice; known: boolean } {
  const input = Number(env.OPENAI_PRICE_INPUT);
  const output = Number(env.OPENAI_PRICE_OUTPUT);
  if (input > 0 && output > 0) {
    const cached = Number(env.OPENAI_PRICE_CACHED);
    return { price: { input, cached: cached > 0 ? cached : input, output }, known: true };
  }

  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`));
  return key ? { price: MODEL_PRICES[key], known: true } : { price: FALLBACK_PRICE, known: false };
}

/**
 * What the provider will bill, in millionths of a US dollar.
 *
 * Cached input is a subset of input, not an addition to it, so it is priced at
 * the cached rate and the rest at the full rate. Rounded up: a fraction of a
 * micro-dollar is still owed.
 */
export function costMicroUsd(usage: Pick<CallUsage, 'inputTokens' | 'cachedTokens' | 'outputTokens'>, price: ModelPrice): number {
  const cached = Math.min(Math.max(usage.cachedTokens, 0), Math.max(usage.inputTokens, 0));
  const fresh = Math.max(usage.inputTokens, 0) - cached;
  return Math.ceil(fresh * price.input + cached * price.cached + Math.max(usage.outputTokens, 0) * price.output);
}

/** Millicredits for a cost, rounded up to the next millicredit. */
export function millicreditsFor(costMicro: number, creditCostUsd: number): number {
  if (costMicro <= 0) return 0;
  return Math.ceil((costMicro * 1000) / (creditCostUsd * 1_000_000));
}

/**
 * What a question is charged, in millicredits.
 *
 * Nothing when nothing was consumed — a question refused before the model saw
 * it costs nothing. Otherwise at least the minimum, and never more than was
 * reserved for it: the reservation is the ceiling the person agreed to by
 * asking, and any overshoot on the last call is ours to absorb.
 */
export function chargeFor(costMicro: number, creditCostUsd: number, holdMc: number): number {
  if (costMicro <= 0) return 0;
  return Math.min(holdMc, Math.max(MIN_CHARGE_MC, millicreditsFor(costMicro, creditCostUsd)));
}

/**
 * A question's charge when its answer comes with a detailed report: the
 * tokens' charge plus REPORT_MARKUP_PCT of it, at least REPORT_MIN_SURCHARGE_MC
 * more — and, like every charge, never more than was reserved. Nothing
 * consumed is still nothing charged.
 */
export function withReportMarkup(chargeMc: number, holdMc: number): number {
  if (chargeMc <= 0) return 0;
  const surcharge = Math.max(REPORT_MIN_SURCHARGE_MC, Math.ceil((chargeMc * REPORT_MARKUP_PCT) / 100));
  return Math.min(holdMc, chargeMc + surcharge);
}

/** The credit cost of a spend in micro-dollars, for budgeting inside a question. */
export const costMicroForMc = (mc: number, creditCostUsd: number): number =>
  Math.floor((mc / 1000) * creditCostUsd * 1_000_000);

/**
 * Tokens in a piece of text, roughly. Only used when a provider did not say —
 * a stream cut short — and deliberately a little generous, since what it
 * estimates is what the provider will bill.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
