'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Asking, as both the assistant's page and the corner panel do it.
//
// One place for the streaming, the Stop button, and what a half-finished answer
// leaves behind, so the two surfaces cannot drift apart: an answer the page
// keeps when stopped, the panel keeps too, and both show the same charge.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ai, askStream, type AiMessage, type ConversationSummary } from '@/lib/api/ai';
import { ApiError } from '@/lib/api/client';
import { visibleWhileStreaming } from '@/lib/ai/followups';

export const MAX_QUESTION_CHARS = 4000;

const localMessage = (role: 'user' | 'assistant', content: string, over: Partial<AiMessage> = {}): AiMessage => ({
  id: `local-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  role,
  content,
  followups: [],
  sources: [],
  reports: [],
  status: 'complete',
  chargedMc: 0,
  createdAt: new Date().toISOString(),
  ...over,
});

export interface ChatCallbacks {
  /** The balance after an answer settled; zero when a question was refused for want of credits. */
  onWallet?: (availableMc: number) => void;
  /** This question started a new conversation. */
  onStarted?: (c: ConversationSummary) => void;
  /** A question was asked in this conversation, so it moves to the top. */
  onTouched?: (id: string) => void;
}

export type Streaming = { text: string; tool: string | null } | null;

export function useAiChat(availableMc: number, callbacks: ChatCallbacks = {}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [streaming, setStreaming] = useState<Streaming>(null);
  const [available, setAvailable] = useState(availableMc);

  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<Streaming>(null);
  const activeRef = useRef<string | null>(null);
  const callbacksRef = useRef(callbacks);

  useEffect(() => {
    callbacksRef.current = callbacks;
  });
  useEffect(() => setAvailable(availableMc), [availableMc]);
  // Leaving mid-answer stops the model rather than leaving it running, and
  // charging, for nobody.
  useEffect(() => () => abortRef.current?.abort(), []);

  const setStream = useCallback((next: Streaming) => {
    streamRef.current = next;
    setStreaming(next);
  }, []);

  const setActive = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveId(id);
  }, []);

  const open = useCallback(
    async (id: string) => {
      if (streamRef.current) return;
      setActive(id);
      setLoadingConversation(true);
      try {
        const res = await ai.conversation(id);
        setMessages(res.messages);
      } catch (err) {
        toast.error((err as Error).message);
        setActive(null);
        setMessages([]);
      } finally {
        setLoadingConversation(false);
      }
    },
    [setActive],
  );

  const startNew = useCallback(() => {
    if (streamRef.current) return;
    setActive(null);
    setMessages([]);
  }, [setActive]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Ask one question. The caller has checked it is not empty and not too long. */
  const ask = useCallback(
    async (question: string) => {
      if (!question || streamRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setMessages((m) => [...m, localMessage('user', question)]);
      setStream({ text: '', tool: null });
      let finished = false;
      let conversationId = activeRef.current;

      try {
        await askStream(
          { conversationId: activeRef.current, message: question },
          (e) => {
            switch (e.type) {
              case 'start':
                conversationId = e.conversationId;
                if (e.isNew) {
                  setActive(e.conversationId);
                  callbacksRef.current.onStarted?.({
                    id: e.conversationId,
                    title: e.title,
                    messageCount: 1,
                    updatedAt: new Date().toISOString(),
                  });
                }
                break;
              case 'delta': {
                const s = streamRef.current ?? { text: '', tool: null };
                setStream({ text: s.text + e.text, tool: null });
                break;
              }
              case 'discard':
                setStream({ text: '', tool: streamRef.current?.tool ?? null });
                break;
              case 'tool':
                setStream({ text: streamRef.current?.text ?? '', tool: e.label });
                break;
              case 'done':
                finished = true;
                setMessages((m) => [
                  ...m,
                  {
                    id: e.messageId,
                    role: 'assistant',
                    content: e.content,
                    followups: e.followups,
                    sources: e.sources,
                    reports: e.reports ?? [],
                    status: e.status,
                    chargedMc: e.chargedMc,
                    createdAt: new Date().toISOString(),
                  },
                ]);
                setAvailable(e.availableMc);
                callbacksRef.current.onWallet?.(e.availableMc);
                if (e.notice) toast.error(e.notice);
                break;
              case 'error':
                finished = true;
                setMessages((m) => [...m, localMessage('assistant', e.message, { status: 'error' })]);
                break;
            }
          },
          ctrl.signal,
        );

        if (!finished) {
          // Stopped, or the connection dropped: keep what had arrived. The
          // server has stored it too, with what it cost.
          // Read through the declared type: the check at the top narrowed this
          // to null, but the stream has written to it since.
          const last = streamRef.current as Streaming;
          const partial = visibleWhileStreaming(last?.text ?? '');
          setMessages((m) => [
            ...m,
            localMessage('assistant', partial || 'Stopped before an answer was written.', { status: 'stopped' }),
          ]);
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'The question could not be sent.';
        setMessages((m) => [...m, localMessage('assistant', message, { status: 'error' })]);
        if (err instanceof ApiError && err.code === 'out_of_credits') {
          setAvailable(0);
          callbacksRef.current.onWallet?.(0);
        }
      } finally {
        abortRef.current = null;
        setStream(null);
        if (conversationId) callbacksRef.current.onTouched?.(conversationId);
      }
    },
    [setActive, setStream],
  );

  return { activeId, messages, loadingConversation, streaming, available, open, startNew, ask, stop };
}
