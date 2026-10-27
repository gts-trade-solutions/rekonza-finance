'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The browser's side of the assistant.
//
// Everything is an ordinary JSON call except asking a question, which streams:
// the answer arrives as server-sent events over a POST, read here with a
// fetch reader because EventSource can only make GET requests. Aborting the
// signal — the Stop button, or leaving the page — closes the connection, and
// the server stops the model and charges only for what it had produced.
// ─────────────────────────────────────────────────────────────────────────────

import { api, ApiError } from './client';
import type { AiReport } from '../ai/reports';

export type { AiReport } from '../ai/reports';

export interface AiSource {
  label: string;
  href: string;
}

export interface AiFlag {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  href: string;
  count: number;
  ask: string;
}

export interface AiSuggestion {
  title: string;
  prompt: string;
  kind: 'balance' | 'profit' | 'cash' | 'receivable' | 'payable' | 'gst' | 'sales' | 'expense';
}

export interface AiStatus {
  enabled: boolean;
  consentGiven: boolean;
  isDemo: boolean;
  canManage: boolean;
  mode: 'openai' | 'standin' | 'unconfigured';
  model: string;
  wallet: {
    availableMc: number;
    totalMc: number;
    heldMc: number;
    trialExpiresAt: string | null;
    nextExpiry: { mc: number; at: string | null } | null;
  };
  plan: { code: string; name: string; status: string; renewsAt: string | null; cancelAtPeriodEnd: boolean } | null;
  userCap: { capMc: number; spentMc: number } | null;
  questionCapMc: number;
  suggestions: AiSuggestion[];
  hidden: string[];
  flags: AiFlag[];
}

/** The balance and little else: what the top bar and the corner assistant need. */
export interface AiWallet {
  enabled: boolean;
  mode: 'openai' | 'standin' | 'unconfigured';
  isDemo: boolean;
  /** Can buy credits and change the plan. */
  canManage: boolean;
  availableMc: number;
  trialExpiresAt: string | null;
  plan: { name: string; status: string } | null;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  followups: string[];
  sources: AiSource[];
  /** The detailed reports under an answer: key figures, a chart and a table each. */
  reports: AiReport[];
  status: 'complete' | 'stopped' | 'error';
  chargedMc: number;
  createdAt: string;
}

/** What downloading one report would cost this person, before they confirm. */
export interface DownloadQuote {
  /** Downloaded before: free again, in either format. */
  owned: boolean;
  /** This person's first download: free. */
  free: boolean;
  priceMc: number;
  availableMc: number;
}

export interface DownloadResult {
  /** The report as stored with the answer — what the file is made from. */
  report: AiReport;
  chargedMc: number;
  free: boolean;
  owned: boolean;
  availableMc: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

export const ai = {
  status: () => api.get<AiStatus>('/api/ai/status'),
  wallet: () => api.get<AiWallet>('/api/ai/wallet'),
  conversations: () => api.get<{ conversations: ConversationSummary[] }>('/api/ai/conversations'),
  conversation: (id: string) => api.get<{ id: string; title: string; messages: AiMessage[] }>(`/api/ai/conversations/${id}`),
  rename: (id: string, title: string) => api.patch<{ ok: true }>(`/api/ai/conversations/${id}`, { title }),
  remove: (id: string) => api.delete<{ ok: true }>(`/api/ai/conversations/${id}`),
  settings: (input: { enabled?: boolean; acceptDataTerms?: boolean; monthlyCapCredits?: number | null }) =>
    api.patch<{ enabled: boolean; consentGiven: boolean; userMonthlyCapMc: number | null; trialGrantedMc: number }>(
      '/api/ai/settings',
      input,
    ),
  downloadQuote: (messageId: string, key: string) =>
    api.get<DownloadQuote>(
      `/api/ai/reports/download?messageId=${encodeURIComponent(messageId)}&key=${encodeURIComponent(key)}`,
    ),
  download: (input: { messageId: string; key: string; format: 'png' | 'csv' }) =>
    api.post<DownloadResult>('/api/ai/reports/download', input),
};

// ── Streaming a question ─────────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'start'; conversationId: string; title: string; isNew: boolean; userMessageId: string; heldMc: number }
  | { type: 'delta'; text: string }
  | { type: 'discard' }
  | { type: 'tool'; name: string; label: string }
  | {
      type: 'done';
      messageId: string;
      content: string;
      followups: string[];
      sources: AiSource[];
      reports: AiReport[];
      status: 'complete' | 'stopped' | 'error';
      chargedMc: number;
      availableMc: number;
      notice: string | null;
    }
  | { type: 'error'; message: string };

/**
 * Ask, and hand each event to `onEvent` as it arrives. Resolves when the
 * stream ends. Throws an ApiError if the question is refused before it
 * starts — out of credits, turned off, too fast — with the server's words.
 */
export async function askStream(
  input: { conversationId: string | null; message: string },
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/ai/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(input),
      signal,
    });
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.', 'offline');
  }

  if (!res.ok || !res.body) {
    let b: { error?: string; code?: string } = {};
    try {
      b = await res.json();
    } catch {
      // not JSON — keep the generic message
    }
    throw new ApiError(res.status, b.error || `The question could not be asked (${res.status}).`, b.code || 'error');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length) {
      try {
        onEvent({ ...(JSON.parse(data.join('\n')) as object), type: event } as StreamEvent);
      } catch {
        // one malformed event is not worth losing the answer over
      }
    }
    event = 'message';
    data = [];
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') dispatch();
        else if (line.startsWith(':')) continue;
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
    }
    dispatch();
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'The connection dropped before the answer finished.', 'stream_cut');
  }
}
