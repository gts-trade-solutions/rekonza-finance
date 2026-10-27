import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Asking the assistant a question, from the refusal checks to the bill.
//
// Two halves, so the route can refuse with a proper status code before it
// opens a stream:
//
//   beginQuestion   everything that can say no — the organisation has not
//                   turned the assistant on, the server has no model, the
//                   person is asking too fast, the wallet is empty — and, if
//                   none does, the reservation, the conversation and the
//                   question, written in one transaction.
//
//   runQuestion     the answer, streamed through `emit`, then the charge and
//                   the stored answer, again in one transaction. It does not
//                   throw: whatever happens, the reservation is settled.
//
// If the server dies between the two, the reservation is released unspent the
// next time the wallet is touched (see STALE_HOLD in wallet.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Executor } from '../db';
import { ApiError, notFound } from '../http';
import { hasPermission } from '../../rbac';
import type { RoleName } from '../../types';
import type { SessionUser } from '../auth/session';
import { holdCredits, settleUsage, walletView } from '../billing/wallet';
import { runAgent, type AgentEvent } from './agent';
import { aiMode, creditCostUsd, openAiSettings, questionCapMc } from './config';
import { OpenAiProvider } from './openai';
import type { AiReport } from '../../ai/reports';
import { chargeFor, priceFor, withReportMarkup, type ModelPrice } from './pricing';
import { aiSettingsFor } from './settings';
import { StandinProvider } from './standin';
import { hiddenAreas, type ToolSource } from './tools';
import { fyStartOf, istDate } from './time';
import type { AiProvider } from './types';

/** Longest question accepted. A question, not a document. */
export const MAX_QUESTION_CHARS = 4_000;
/** Beyond this a conversation costs more per question than it is worth. */
const MAX_CONVERSATION_MESSAGES = 200;
const QUESTIONS_PER_MINUTE = 10;
const IN_FLIGHT_PER_USER = 2;

export function createProvider(): AiProvider | null {
  switch (aiMode()) {
    case 'openai':
      return new OpenAiProvider(openAiSettings()!);
    case 'standin':
      return new StandinProvider();
    default:
      return null;
  }
}

export interface QuestionInput {
  user: SessionUser;
  role: RoleName;
  /**
   * The sign-in session, hashed. Used on the shared demo book only, where
   * every visitor is the same user and conversations must be kept apart by
   * session instead.
   */
  sessionKey: string | null;
  conversationId: number | null;
  message: string;
}

export interface BegunQuestion {
  orgId: number;
  userId: number;
  userName: string;
  role: RoleName;
  orgName: string;
  isDemo: boolean;
  conversationId: number;
  isNewConversation: boolean;
  title: string;
  userMessageId: number;
  usageId: number;
  holdMc: number;
  provider: AiProvider;
  price: ModelPrice;
  history: { role: 'user' | 'assistant'; content: string }[];
  question: string;
  startedAt: number;
}

/** First line of the question, tidied, as the conversation's name. */
export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || 'New conversation';
}

/** Control characters out, whitespace kept sensible — nothing else is changed. */
export function cleanQuestion(raw: string): string {
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
}

/** A conversation this person may see — their own, and on the demo, their session's own. */
function ownConversations(ex: Executor, orgId: number, userId: number, isDemo: boolean, sessionKey: string | null) {
  let q = ex.selectFrom('ai_conversations').where('org_id', '=', orgId).where('user_id', '=', userId);
  if (isDemo) q = q.where('session_key', '=', sessionKey ?? '__none__');
  return q;
}

export async function beginQuestion(input: QuestionInput): Promise<BegunQuestion> {
  const { user, role } = input;
  const orgId = user.orgId;
  const message = cleanQuestion(input.message);
  if (!message) throw new ApiError(400, 'Type a question first.', 'empty');
  if (message.length > MAX_QUESTION_CHARS) {
    throw new ApiError(400, `Questions can be up to ${MAX_QUESTION_CHARS.toLocaleString('en-IN')} characters.`, 'too_long');
  }

  const settings = await aiSettingsFor(db, orgId);
  if (!settings.enabled) {
    throw new ApiError(
      403,
      hasPermission(role, 'billing', 'edit')
        ? 'The AI assistant is turned off for this organisation. Turn it on under Settings → Billing & AI.'
        : 'The AI assistant is not turned on for your organisation. Ask an administrator to turn it on.',
      'ai_disabled',
    );
  }

  const provider = createProvider();
  if (!provider) throw new ApiError(503, 'The AI assistant is not set up on this server yet.', 'ai_unconfigured');

  // Asking faster than anyone reads is a script, or a stuck key.
  const minuteAgo = new Date(Date.now() - 60_000);
  const [recent, inFlight] = await Promise.all([
    db
      .selectFrom('ai_usage')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('org_id', '=', orgId)
      .where('user_id', '=', user.userId)
      .where('created_at', '>', minuteAgo)
      // Report downloads are usage too, but not questions.
      .where('provider', '<>', 'download')
      .executeTakeFirst(),
    db
      .selectFrom('ai_usage')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('org_id', '=', orgId)
      .where('user_id', '=', user.userId)
      .where('status', '=', 'held')
      .where('created_at', '>', new Date(Date.now() - 5 * 60_000))
      .executeTakeFirst(),
  ]);
  if (Number(recent?.n ?? 0) >= QUESTIONS_PER_MINUTE) {
    throw new ApiError(429, 'That is a lot of questions in a minute. Give it a few seconds and ask again.', 'rate_limited');
  }
  if (Number(inFlight?.n ?? 0) >= IN_FLIGHT_PER_USER) {
    throw new ApiError(429, 'Let your current question finish before asking another.', 'busy');
  }

  let conversation: { id: number; title: string; message_count: number } | null = null;
  if (input.conversationId) {
    conversation =
      (await ownConversations(db, orgId, user.userId, settings.isDemo, input.sessionKey)
        .select(['id', 'title', 'message_count'])
        .where('id', '=', input.conversationId)
        .executeTakeFirst()) ?? null;
    if (!conversation) throw notFound('That conversation does not exist.');
    if (conversation.message_count >= MAX_CONVERSATION_MESSAGES) {
      throw new ApiError(409, 'This conversation has grown long. Start a new one to keep answers quick and inexpensive.', 'conversation_full');
    }
  }

  const history = conversation
    ? (
        await db
          .selectFrom('ai_messages')
          .select(['role', 'content', 'status'])
          .where('conversation_id', '=', conversation.id)
          .orderBy('id', 'desc')
          .limit(12)
          .execute()
      )
        .reverse()
        .filter((m) => m.status !== 'error')
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  const { price } = priceFor(provider.model);
  const title = conversation?.title ?? titleFrom(message);

  const begun = await transaction(async (trx) => {
    let conversationId = conversation?.id;
    if (!conversationId) {
      const row = await trx
        .insertInto('ai_conversations')
        .values({
          org_id: orgId,
          user_id: user.userId,
          session_key: settings.isDemo ? input.sessionKey : null,
          title,
        })
        .executeTakeFirstOrThrow();
      conversationId = Number(row.insertId);
    }

    // Reserve before anything is sent anywhere. If the wallet says no, the
    // transaction rolls back and not even the conversation is left behind.
    const hold = await holdCredits(trx, orgId, user.userId, {
      capMc: questionCapMc(),
      isDemo: settings.isDemo,
      monthlyCapMc: settings.userMonthlyCapMc,
      conversationId,
      provider: provider.name,
      model: provider.model,
    });

    const msg = await trx
      .insertInto('ai_messages')
      .values({ conversation_id: conversationId, org_id: orgId, role: 'user', content: message })
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('ai_conversations')
      .set((eb) => ({ message_count: eb('message_count', '+', 1) }))
      .where('id', '=', conversationId)
      .execute();

    return { conversationId, userMessageId: Number(msg.insertId), usageId: hold.usageId, holdMc: hold.holdMc };
  });

  return {
    orgId,
    userId: user.userId,
    userName: user.name,
    role,
    orgName: settings.orgName,
    isDemo: settings.isDemo,
    conversationId: begun.conversationId,
    isNewConversation: !conversation,
    title,
    userMessageId: begun.userMessageId,
    usageId: begun.usageId,
    holdMc: begun.holdMc,
    provider,
    price,
    history,
    question: message,
    startedAt: Date.now(),
  };
}

export interface FinishedQuestion {
  assistantMessageId: number;
  content: string;
  followups: string[];
  sources: ToolSource[];
  reports: AiReport[];
  status: 'complete' | 'stopped' | 'error';
  chargedMc: number;
  availableMc: number;
  /** For the person, when something went wrong. Never a provider's raw text. */
  notice: string | null;
}

/** What to tell the person when the provider failed, in words they can act on. */
function noticeFor(kind: string | undefined, charged: boolean): string {
  const bill = charged ? '' : ' You were not charged for it.';
  switch (kind) {
    case 'rate_limit':
    case 'unavailable':
      return `The AI service is busy right now. Try again in a moment.${bill}`;
    case 'context_length':
      return `This conversation has grown too long for the model. Start a new conversation.${bill}`;
    case 'auth':
    case 'quota':
    case 'bad_request':
      return `The AI service is unavailable right now, and the team has been alerted.${bill}`;
    default:
      return `Something went wrong while answering.${bill}`;
  }
}

export async function runQuestion(
  q: BegunQuestion,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<FinishedQuestion> {
  const today = istDate();
  const result = await runAgent({
    provider: q.provider,
    tools: { ex: db, orgId: q.orgId, userId: q.userId, role: q.role, today, fyStart: fyStartOf(today) },
    prompt: {
      orgName: q.orgName,
      userName: q.userName,
      role: q.role,
      today,
      fyStart: fyStartOf(today),
      hidden: hiddenAreas(q.role),
    },
    history: q.history,
    question: q.question,
    holdMc: q.holdMc,
    price: q.price,
    creditCostUsd: creditCostUsd(),
    signal,
    emit,
  });

  if (result.outcome === 'error' && result.errorKind !== 'rate_limit') {
    // The raw text stays in the server log, where the operator can act on it.
    // The customer is told what it means for them instead.
    console.error('[ai] question failed', { org: q.orgId, kind: result.errorKind, message: result.errorMessage });
  }

  // An answer that comes with a detailed report is charged a little more, for
  // building it. One without — a greeting, a refusal — is charged its tokens.
  const reports = result.reports;
  const tokenChargeMc = chargeFor(result.costMicroUsd, creditCostUsd(), q.holdMc);
  const chargeMc = reports.length ? withReportMarkup(tokenChargeMc, q.holdMc) : tokenChargeMc;
  const status = result.outcome === 'answered' ? 'complete' : result.outcome;
  const notice = result.outcome === 'error' ? noticeFor(result.errorKind, chargeMc > 0) : null;
  const content =
    result.content ||
    (result.outcome === 'stopped' ? 'Stopped before an answer was written.' : notice ?? 'No answer was produced.');

  const finished = await transaction(async (trx) => {
    const { chargedMc } = await settleUsage(trx, q.orgId, q.usageId, {
      chargeMc,
      usage: result.usage,
      costMicroUsd: result.costMicroUsd,
      modelCalls: result.modelCalls,
      toolCalls: result.toolCalls,
      outcome: result.outcome,
      errorCode: result.errorKind ?? null,
      durationMs: Date.now() - q.startedAt,
      conversationId: q.conversationId,
    });

    const row = await trx
      .insertInto('ai_messages')
      .values({
        conversation_id: q.conversationId,
        org_id: q.orgId,
        role: 'assistant',
        content,
        followups_json: result.followups.length ? JSON.stringify(result.followups) : null,
        sources_json: result.sources.length ? JSON.stringify(result.sources) : null,
        reports_json: reports.length ? JSON.stringify(reports) : null,
        status,
        usage_id: q.usageId,
        charged_mc: chargedMc,
      })
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('ai_conversations')
      .set((eb) => ({ message_count: eb('message_count', '+', 1), updated_at: sql<Date>`CURRENT_TIMESTAMP(3)` }))
      .where('id', '=', q.conversationId)
      .execute();

    return { assistantMessageId: Number(row.insertId), chargedMc };
  });

  const wallet = await walletView(db, q.orgId);
  return {
    assistantMessageId: finished.assistantMessageId,
    content,
    followups: result.followups,
    sources: result.sources,
    reports,
    status,
    chargedMc: finished.chargedMc,
    availableMc: wallet.availableMc,
    notice,
  };
}

// ── Conversations ────────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

export async function listConversations(
  orgId: number,
  userId: number,
  isDemo: boolean,
  sessionKey: string | null,
): Promise<ConversationSummary[]> {
  const rows = await ownConversations(db, orgId, userId, isDemo, sessionKey)
    .select(['id', 'title', 'message_count', 'updated_at'])
    .orderBy('updated_at', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    messageCount: r.message_count,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  followups: string[];
  sources: ToolSource[];
  reports: AiReport[];
  status: 'complete' | 'stopped' | 'error';
  chargedMc: number;
  createdAt: string;
}

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

export async function getConversation(
  orgId: number,
  userId: number,
  isDemo: boolean,
  sessionKey: string | null,
  id: number,
): Promise<{ id: string; title: string; messages: StoredMessage[] }> {
  const conv = await ownConversations(db, orgId, userId, isDemo, sessionKey)
    .select(['id', 'title'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!conv) throw notFound('That conversation does not exist.');

  const rows = await db
    .selectFrom('ai_messages')
    .select(['id', 'role', 'content', 'followups_json', 'sources_json', 'reports_json', 'status', 'charged_mc', 'created_at'])
    .where('conversation_id', '=', id)
    .orderBy('id')
    .execute();

  return {
    id: String(conv.id),
    title: conv.title,
    messages: rows.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: m.content,
      followups: parseJson<string[]>(m.followups_json, []),
      sources: parseJson<ToolSource[]>(m.sources_json, []),
      reports: parseJson<AiReport[]>(m.reports_json, []),
      status: m.status,
      chargedMc: Number(m.charged_mc),
      createdAt: new Date(m.created_at).toISOString(),
    })),
  };
}

export async function renameConversation(
  orgId: number,
  userId: number,
  isDemo: boolean,
  sessionKey: string | null,
  id: number,
  title: string,
): Promise<void> {
  const conv = await ownConversations(db, orgId, userId, isDemo, sessionKey).select('id').where('id', '=', id).executeTakeFirst();
  if (!conv) throw notFound('That conversation does not exist.');
  await db.updateTable('ai_conversations').set({ title: title.trim().slice(0, 150) || 'Untitled' }).where('id', '=', id).execute();
}

/**
 * Deleted, not hidden: the questions were the person's to keep or discard.
 * The usage rows stay — they are the record of what was charged, and they
 * hold no text.
 */
export async function deleteConversation(
  orgId: number,
  userId: number,
  isDemo: boolean,
  sessionKey: string | null,
  id: number,
): Promise<void> {
  const conv = await ownConversations(db, orgId, userId, isDemo, sessionKey).select('id').where('id', '=', id).executeTakeFirst();
  if (!conv) throw notFound('That conversation does not exist.');
  await db.deleteFrom('ai_conversations').where('id', '=', id).execute();
}
