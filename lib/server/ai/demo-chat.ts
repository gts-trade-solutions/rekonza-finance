import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Asking the assistant on the online demo, which has no database.
//
// The same agent answers — OpenAI when the deployment has a key, the built-in
// stand-in when it does not — but its lookups are answered from the recording
// (demo-playback.ts), and nothing is charged or stored: there is nowhere to
// store it. A conversation is kept in this server's memory for a couple of
// hours so a follow-up ("and last month?") makes sense, and is simply gone
// after that, or when the server is recycled.
//
// A public link with a paid model behind it is a bill anyone can run up, so
// questions are limited per visitor and per day when a key is set.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AiMessage } from '../../api/ai';
import { runAgent, type AgentEvent } from './agent';
import { aiMode, creditCostUsd, openAiSettings, questionCapMc } from './config';
import { playLookup, type AiRecording } from './demo-playback';
import { OpenAiProvider } from './openai';
import { priceFor } from './pricing';
import { StandinProvider } from './standin';
import { hiddenAreas } from './tools';
import type { AiProvider } from './types';
import recordingJson from './demo-recording.json';
import { clientIp } from '../client-ip';

const recording = recordingJson as unknown as AiRecording;

const Input = z.object({
  conversationId: z.union([z.string(), z.number()]).nullish(),
  message: z.string().trim().min(1, 'Type a question first.').max(4_000, 'Questions can be up to 4,000 characters.'),
});

interface DemoConversation {
  title: string;
  messages: AiMessage[];
  touched: number;
}

const KEEP_MS = 2 * 60 * 60_000;
const MAX_CONVERSATIONS = 500;
/** Per visitor, when a paid model answers. */
const PER_VISITOR = { questions: 15, windowMs: 10 * 60_000 };
const dailyLimit = () => Number(process.env.DEMO_AI_DAILY_LIMIT) || 300;

declare global {
  var __rekonzaDemoChats: Map<string, DemoConversation> | undefined;
  var __rekonzaDemoAsks: { day: string; count: number; byVisitor: Map<string, number[]> } | undefined;
}
const conversations = (globalThis.__rekonzaDemoChats ??= new Map<string, DemoConversation>());
const asks = (globalThis.__rekonzaDemoAsks ??= { day: '', count: 0, byVisitor: new Map<string, number[]>() });

function sweep(now: number) {
  for (const [id, c] of conversations) if (now - c.touched > KEEP_MS) conversations.delete(id);
  while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
}

/** The model that answers on the demo: OpenAI with a key, otherwise the stand-in — never nothing. */
function demoProvider(): AiProvider {
  return aiMode() === 'openai' ? new OpenAiProvider(openAiSettings()!) : new StandinProvider();
}

/** Null when the question may go ahead; otherwise why not. */
function limited(visitor: string, now: number, paid: boolean): string | null {
  if (!paid) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  if (asks.day !== day) {
    asks.day = day;
    asks.count = 0;
    asks.byVisitor.clear();
  }
  if (asks.count >= dailyLimit()) return 'The online demo has answered all the questions it takes today. Please try again tomorrow.';
  const recent = (asks.byVisitor.get(visitor) ?? []).filter((t) => now - t < PER_VISITOR.windowMs);
  if (recent.length >= PER_VISITOR.questions) return 'That is a lot of questions in a few minutes. Please wait a little before asking more.';
  recent.push(now);
  asks.byVisitor.set(visitor, recent);
  asks.count++;
  return null;
}

const json = (status: number, error: string, code: string) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });

export async function demoChat(req: Request): Promise<Response> {
  let input: z.infer<typeof Input>;
  try {
    input = Input.parse(await req.json());
  } catch (err) {
    const issue = err instanceof z.ZodError ? err.issues[0]?.message : null;
    return json(400, issue ?? 'The request body was not valid JSON.', 'bad_request');
  }

  const now = Date.now();
  sweep(now);
  const provider = demoProvider();
  const visitor = clientIp(req) || 'local';
  const refusal = limited(visitor, now, provider.name === 'openai');
  if (refusal) return json(429, refusal, 'rate_limited');

  const question = input.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const askedId = input.conversationId ? String(input.conversationId) : null;
  const existing = askedId ? conversations.get(askedId) : undefined;
  const conversationId = existing ? askedId! : `demo-${randomUUID()}`;
  const convo: DemoConversation = existing ?? {
    title: question.replace(/\s+/g, ' ').slice(0, 80),
    messages: [],
    touched: now,
  };
  conversations.set(conversationId, convo);

  const history = convo.messages
    .filter((m) => m.status !== 'error')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const userMessage: AiMessage = {
    id: `u-${randomUUID()}`, role: 'user', content: question, followups: [], sources: [], reports: [], status: 'complete', chargedMc: 0,
    createdAt: new Date(now).toISOString(),
  };
  convo.messages.push(userMessage);

  const encoder = new TextEncoder();
  const upstream = new AbortController();
  req.signal?.addEventListener('abort', () => upstream.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
          upstream.abort();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);

      send('start', { conversationId, title: convo.title, isNew: !existing, userMessageId: userMessage.id, heldMc: 0 });
      try {
        const role = recording.role;
        const result = await runAgent({
          provider,
          // The lookups never reach these: runLookup answers from the recording.
          tools: { ex: undefined as never, orgId: 0, userId: 0, role, today: recording.today, fyStart: recording.fyStart },
          prompt: { orgName: recording.orgName, userName: recording.userName, role, today: recording.today, fyStart: recording.fyStart, hidden: hiddenAreas(role) },
          history,
          question,
          holdMc: questionCapMc(),
          price: priceFor(provider.model).price,
          creditCostUsd: creditCostUsd(),
          signal: upstream.signal,
          emit: (e: AgentEvent) => send(e.type, e),
          runLookup: async (call) => playLookup(recording, call),
        });
        const answer: AiMessage = {
          id: `a-${randomUUID()}`,
          role: 'assistant',
          content: result.content || (result.outcome === 'error' ? 'The assistant could not answer just now. Please try again.' : ''),
          followups: result.followups,
          sources: result.sources,
          reports: result.reports,
          status: result.outcome === 'answered' ? 'complete' : result.outcome,
          chargedMc: 0,
          createdAt: new Date().toISOString(),
        };
        convo.messages.push(answer);
        convo.touched = Date.now();
        if (result.outcome === 'error') console.error('[ai] demo answer failed', result.errorKind, result.errorMessage);
        send('done', {
          messageId: answer.id,
          content: answer.content,
          followups: answer.followups,
          sources: answer.sources,
          reports: answer.reports,
          status: answer.status,
          chargedMc: 0,
          availableMc: 100_000,
          notice: null,
        });
      } catch (err) {
        console.error('[ai] demo chat failed', err);
        send('error', { message: 'Something went wrong while answering. Please try again.' });
      } finally {
        clearInterval(heartbeat);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by the other side
          }
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** A demo conversation, while this server still holds it. */
export function demoConversation(id: string): Response {
  const c = conversations.get(id);
  if (!c) {
    return json(404, 'That conversation is no longer held by the online demo. Start a new one.', 'not_found');
  }
  return new Response(JSON.stringify({ id, title: c.title, messages: c.messages }), { headers: { 'Content-Type': 'application/json' } });
}

/** A report's price on the demo: nothing. */
export function demoReportQuote(): Response {
  return new Response(JSON.stringify({ owned: false, free: true, priceMc: 0, availableMc: 100_000 }), { headers: { 'Content-Type': 'application/json' } });
}

/** The report the file is made from, out of the answer this server holds. */
export async function demoReportDownload(req: Request): Promise<Response> {
  let input: { messageId?: unknown; key?: unknown };
  try {
    input = (await req.json()) as typeof input;
  } catch {
    return json(400, 'Say which report to download.', 'bad_request');
  }
  for (const c of conversations.values()) {
    const m = c.messages.find((x) => x.id === String(input.messageId));
    const report = m?.reports.find((r) => r.key === input.key);
    if (report) {
      return new Response(JSON.stringify({ report, chargedMc: 0, free: true, owned: false, availableMc: 100_000 }), { headers: { 'Content-Type': 'application/json' } });
    }
  }
  return json(404, 'That answer is no longer held by the online demo. Ask the question again to download its report.', 'not_found');
}
