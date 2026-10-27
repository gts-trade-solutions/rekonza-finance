// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary shared by the assistant's parts.
//
// A provider turns messages into an answer or a request to run tools; the
// agent runs the tools and loops; the route streams it to the browser and
// settles the bill. Each part knows only these types, which is what lets the
// built-in stand-in replace OpenAI in development and in tests without the
// agent or the route noticing.
//
// No server imports, so the tests can use it directly.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, exactly as the model produced it. Parsed — and validated — by the tool. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface CallUsage {
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache, billed at a discount. */
  cachedTokens: number;
  /** Includes reasoning tokens, which are billed as output. */
  outputTokens: number;
  reasoningTokens: number;
  /** True when the provider never reported usage and it was estimated from the text. */
  estimated: boolean;
}

export const NO_USAGE: CallUsage = {
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimated: false,
};

export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    estimated: a.estimated || b.estimated,
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 'none' offers the tools but has the model answer with what it already has. */
  toolChoice?: 'auto' | 'none';
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Each piece of answer text, as it arrives. */
  onText?: (delta: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: CallUsage;
  finishReason: string | null;
}

export interface AiProvider {
  readonly name: 'openai' | 'standin';
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export type ProviderErrorKind =
  | 'auth' // the key was refused
  | 'quota' // our account with the provider has run out of money
  | 'rate_limit'
  | 'context_length'
  | 'bad_request'
  | 'unavailable'
  | 'aborted'; // the person pressed Stop, or closed the tab

/**
 * A provider failure, carrying whatever had already happened.
 *
 * `partial` matters for billing: a stream cut off halfway has still consumed
 * tokens the provider will charge for, and those are charged to the question —
 * no more, since the rest was never generated.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly partial?: { text: string; usage: CallUsage };
  constructor(
    message: string,
    kind: ProviderErrorKind,
    opts: { status?: number; partial?: { text: string; usage: CallUsage } } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.partial = opts.partial;
  }
}
