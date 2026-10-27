import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI, over its Chat Completions API, streamed.
//
// Plain fetch and a small server-sent-events reader rather than the SDK: the
// surface used is four fields wide, and owning the parser means owning the one
// behaviour that matters for billing — reading the usage the API reports at
// the end of the stream (`stream_options.include_usage`), and estimating it
// when the stream is cut short and that report never comes.
//
// The key never leaves the server. Nothing here is imported by client code,
// and `server-only` makes that a build error rather than a convention.
// ─────────────────────────────────────────────────────────────────────────────

import { estimateTokens } from './pricing';
import {
  NO_USAGE, ProviderError,
  type AiProvider, type CallUsage, type ChatMessage, type ChatRequest, type ChatResult, type ToolCall,
} from './types';

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  organization?: string;
  project?: string;
  reasoningEffort?: string;
  /** Abandon a call that sends nothing for this long. */
  idleTimeoutMs?: number;
  /** Abandon a call that has not finished in this long. */
  totalTimeoutMs?: number;
}

/**
 * o-series and GPT-5 models reason before answering. They take
 * `reasoning_effort` and refuse `temperature`; the chat variants do neither.
 */
export const isReasoningModel = (model: string): boolean => /^(o\d|gpt-5)/i.test(model) && !/chat/i.test(model);

/** Our message shape to the API's. */
export function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      case 'assistant':
        return m.toolCalls?.length
          ? {
              role: 'assistant',
              content: m.content ?? null,
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : { role: 'assistant', content: m.content ?? '' };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

// ── The stream ───────────────────────────────────────────────────────────────

export interface StreamOutcome {
  text: string;
  toolCalls: ToolCall[];
  /** Null when the stream ended without a usage report. */
  usage: CallUsage | null;
  finishReason: string | null;
}

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { message?: string; code?: string };
}

/**
 * Read a Chat Completions event stream to the end.
 *
 * Text goes to `onText` as it arrives. Tool calls arrive in fragments — the id
 * and name first, the arguments a few characters at a time — keyed by index,
 * and are reassembled here. The usage report is the last event before [DONE].
 *
 * Exported for the tests, which feed it recorded streams.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onActivity?: () => void,
): Promise<StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let text = '';
  let usage: CallUsage | null = null;
  let finishReason: string | null = null;
  let done = false;
  const calls: { id: string; name: string; arguments: string }[] = [];

  const handle = (payload: string) => {
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let chunk: Chunk;
    try {
      chunk = JSON.parse(payload) as Chunk;
    } catch {
      return; // a malformed keep-alive is not worth failing a paid answer over
    }
    if (chunk.error) {
      throw new ProviderError(chunk.error.message || 'The model reported an error mid-answer.', 'unavailable', {
        partial: { text, usage: usage ?? NO_USAGE },
      });
    }
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      const piece = (delta.content ?? '') + (delta.refusal ?? '');
      if (piece) {
        text += piece;
        onText?.(piece);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = (calls[i] ??= { id: '', name: '', arguments: '' });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        estimated: false,
      };
    }
  };

  const flush = () => {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    handle(payload);
  };

  try {
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while (!done && (nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') flush();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        // Comments (":"), "event:", "id:" and "retry:" lines carry nothing we use.
      }
    }
    if (!done) {
      buffer += decoder.decode();
      for (const raw of buffer.split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      flush();
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    // The connection dropped, or the caller aborted. What had arrived is
    // returned with the error so it can be billed and shown.
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ProviderError(aborted ? 'Stopped.' : 'The connection to the model dropped mid-answer.', aborted ? 'aborted' : 'unavailable', {
      partial: { text, usage: usage ?? NO_USAGE },
    });
  } finally {
    reader.cancel().catch(() => undefined);
  }

  return {
    text,
    toolCalls: calls
      .filter((c) => c && c.name)
      .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' })),
    usage,
    finishReason,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

async function toProviderError(res: Response): Promise<ProviderError> {
  let code = '';
  let message = '';
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string; type?: string } };
    code = body.error?.code ?? body.error?.type ?? '';
    message = body.error?.message ?? '';
  } catch {
    // An HTML error page from a proxy has nothing useful to parse.
  }
  const status = res.status;
  if (status === 401 || status === 403) {
    return new ProviderError(`The model provider refused the API key (${status}). ${message}`.trim(), 'auth', { status });
  }
  if (status === 429) {
    return code === 'insufficient_quota'
      ? new ProviderError('The model provider account has no credit left.', 'quota', { status })
      : new ProviderError('The model provider is rate-limiting requests.', 'rate_limit', { status });
  }
  if (status === 400 && code === 'context_length_exceeded') {
    return new ProviderError('The conversation is too long for the model.', 'context_length', { status });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError(`The model provider rejected the request: ${message || code || status}`, 'bad_request', { status });
  }
  return new ProviderError(`The model provider is unavailable (${status}).`, 'unavailable', { status });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('Stopped.', 'aborted'));
    }, { once: true });
  });

// ── The provider ─────────────────────────────────────────────────────────────

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly cfg: OpenAiConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: OpenAiConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get model(): string {
    return this.cfg.model;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toOpenAiMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: req.maxOutputTokens,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = req.toolChoice ?? 'auto';
    }
    if (isReasoningModel(this.cfg.model) && this.cfg.reasoningEffort) {
      body.reasoning_effort = this.cfg.reasoningEffort;
    }
    const serialised = JSON.stringify(body);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.cfg.organization) headers['OpenAI-Organization'] = this.cfg.organization;
    if (this.cfg.project) headers['OpenAI-Project'] = this.cfg.project;

    // One retry, and only before anything has streamed: a rate limit or a 5xx
    // at the door is usually gone a second later, while retrying half an
    // answer would charge for it twice.
    for (let attempt = 1; ; attempt++) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) ctrl.abort();

      const idleMs = this.cfg.idleTimeoutMs ?? 45_000;
      let idle = setTimeout(() => ctrl.abort(), idleMs);
      const total = setTimeout(() => ctrl.abort(), this.cfg.totalTimeoutMs ?? 120_000);
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ctrl.abort(), idleMs);
      };
      const cleanup = () => {
        clearTimeout(idle);
        clearTimeout(total);
        req.signal?.removeEventListener('abort', onAbort);
      };

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: serialised,
          signal: ctrl.signal,
        });
      } catch (err) {
        cleanup();
        if (req.signal?.aborted) throw new ProviderError('Stopped.', 'aborted');
        if (attempt < 2) {
          await sleep(800, req.signal);
          continue;
        }
        throw new ProviderError(`Could not reach the model provider: ${(err as Error).message}`, 'unavailable');
      }

      if (!res.ok || !res.body) {
        cleanup();
        const error = res.ok ? new ProviderError('The model provider sent an empty response.', 'unavailable') : await toProviderError(res);
        const retryable = error.kind === 'rate_limit' || (error.kind === 'unavailable' && (error.status ?? 500) >= 500);
        if (retryable && attempt < 2) {
          const after = Number(res.headers.get('retry-after'));
          await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 800, 4000), req.signal);
          continue;
        }
        throw error;
      }

      try {
        const out = await readChatStream(res.body, req.onText, touch);
        return {
          text: out.text,
          toolCalls: out.toolCalls,
          usage: out.usage ?? this.estimate(serialised, out.text, out.toolCalls),
          finishReason: out.finishReason,
        };
      } catch (err) {
        if (err instanceof ProviderError && err.partial) {
          // Cut short: bill what the provider will bill — the whole prompt, and
          // the part of the answer that was generated before it stopped.
          const stopped = req.signal?.aborted ? 'aborted' : err.kind;
          throw new ProviderError(err.message, stopped, {
            status: err.status,
            partial: {
              text: err.partial.text,
              usage: err.partial.usage.inputTokens
                ? err.partial.usage
                : this.estimate(serialised, err.partial.text, []),
            },
          });
        }
        throw err;
      } finally {
        cleanup();
      }
    }
  }

  private estimate(request: string, text: string, calls: ToolCall[]): CallUsage {
    return {
      inputTokens: estimateTokens(request),
      cachedTokens: 0,
      outputTokens: estimateTokens(text + calls.map((c) => c.name + c.arguments).join('')),
      reasoningTokens: 0,
      estimated: true,
    };
  }
}
