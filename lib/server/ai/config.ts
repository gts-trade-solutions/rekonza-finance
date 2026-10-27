import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// How the assistant is configured on this server.
//
// Everything comes from the environment, read on each call rather than at
// module load: a missing OpenAI key must not stop the app starting, because
// every other screen — and the demo book — works without one.
//
// Three states:
//
//   openai        OPENAI_API_KEY is set. Questions go to OpenAI.
//   standin       No key, outside production. A built-in stand-in answers from
//                 the same tools, so the whole flow — credits included — can
//                 be developed and tested without spending anything.
//   unconfigured  No key in production. The assistant says it is not set up,
//                 rather than letting a stand-in answer a real customer.
// ─────────────────────────────────────────────────────────────────────────────

import { TRIAL_CREDITS } from '../../billing/catalog';

export type AiMode = 'openai' | 'standin' | 'unconfigured';

/** A capable, inexpensive model with tool calling. Override with OPENAI_MODEL. */
export const DEFAULT_MODEL = 'gpt-5-mini';

const isProduction = () => process.env.APP_ENV === 'production';

export function aiMode(): AiMode {
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai';
  if (!isProduction() || process.env.AI_STANDIN === '1') return 'standin';
  return 'unconfigured';
}

export interface OpenAiSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  organization?: string;
  project?: string;
  /** Sent only to reasoning models; 'low' keeps answers quick and cheap. */
  reasoningEffort?: string;
}

export function openAiSettings(): OpenAiSettings | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    organization: process.env.OPENAI_ORG_ID?.trim() || undefined,
    project: process.env.OPENAI_PROJECT_ID?.trim() || undefined,
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT?.trim() || 'low',
  };
}

/** The model a question will be answered by, as shown to people. */
export function activeModel(): string {
  const mode = aiMode();
  if (mode === 'openai') return openAiSettings()!.model;
  return mode === 'standin' ? 'stand-in' : 'none';
}

const positive = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** What one credit is worth in model cost, in US dollars. */
export const creditCostUsd = () => positive(process.env.AI_CREDIT_COST_USD, 0.003);

/** Granted the first time an admin turns the assistant on. */
export const trialCredits = () => positive(process.env.AI_TRIAL_CREDITS, TRIAL_CREDITS);

/** The shared demo book's allowance, refreshed each Indian day. */
export const demoDailyCredits = () => positive(process.env.AI_DEMO_DAILY_CREDITS, 100);

/**
 * The most one question may reserve, in millicredits. A question is stopped
 * from calling more tools once it has spent most of this, and answers with
 * what it has.
 */
export const questionCapMc = () => Math.round(positive(process.env.AI_MAX_CREDITS_PER_QUESTION, 20) * 1000);
