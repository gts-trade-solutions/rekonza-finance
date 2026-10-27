import { z } from 'zod';
import { currentUser } from '@/lib/server/auth/session';
import { hasPermission } from '@/lib/rbac';
import { badRequest, forbidden, toResponse, unauthorized } from '@/lib/server/http';
import { beginQuestion, runQuestion, MAX_QUESTION_CHARS, type BegunQuestion } from '@/lib/server/ai/assistant';
import { currentSessionKey } from '@/lib/server/ai/session-key';

// ─────────────────────────────────────────────────────────────────────────────
// Ask the assistant. The answer comes back as a stream of server-sent events:
//
//   start    the conversation it belongs to, and what was reserved for it
//   delta    a piece of the answer
//   discard  withdraw what streamed so far — it led into a lookup
//   tool     a lookup has started ("Reading the ledger")
//   done     the finished answer, its sources, and what it cost
//   error    it failed; nothing further will arrive
//
// Everything that can refuse — no permission, assistant off, out of credits,
// asking too fast — is checked before the stream opens, so those arrive as an
// ordinary JSON error with the right status code rather than as an event.
//
// Closing the tab or pressing Stop aborts the model call. The question is
// charged for what the model had already produced, and no more.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Input = z.object({
  conversationId: z.union([z.string(), z.number()]).nullish(),
  message: z.string().min(1, 'Type a question first.').max(MAX_QUESTION_CHARS + 500),
});

export async function POST(req: Request): Promise<Response> {
  let question: BegunQuestion;
  try {
    const user = await currentUser();
    if (!user) throw unauthorized();
    if (!hasPermission(user.role, 'ai', 'view')) {
      throw forbidden(`Your role (${user.role}) does not include the AI assistant. Ask an admin if you need it.`);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw badRequest('The request body was not valid JSON.');
    }
    const input = Input.parse(raw);
    const conversationId = input.conversationId ? Number(input.conversationId) : null;
    if (conversationId !== null && (!Number.isInteger(conversationId) || conversationId <= 0)) {
      throw badRequest('That conversation id is not valid.');
    }

    question = await beginQuestion({
      user,
      role: user.role,
      sessionKey: await currentSessionKey(),
      conversationId,
      message: input.message,
    });
  } catch (err) {
    return toResponse(err);
  }

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
          // The browser has gone. Stop the model too — nobody is reading.
          open = false;
          upstream.abort();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Proxies close a connection that has been silent for a while, and a
      // slow report can take a few seconds before the next word arrives.
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);

      send('start', {
        conversationId: String(question.conversationId),
        title: question.title,
        isNew: question.isNewConversation,
        userMessageId: String(question.userMessageId),
        heldMc: question.holdMc,
      });

      try {
        const done = await runQuestion(question, (e) => send(e.type, e), upstream.signal);
        send('done', {
          messageId: String(done.assistantMessageId),
          content: done.content,
          followups: done.followups,
          sources: done.sources,
          reports: done.reports,
          status: done.status,
          chargedMc: done.chargedMc,
          availableMc: done.availableMc,
          notice: done.notice,
        });
      } catch (err) {
        console.error('[ai] chat stream failed', err);
        send('error', { message: 'Something went wrong while answering. Nothing was charged for it.' });
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
      // nginx buffers responses by default, which would hold the whole answer
      // back until it was finished.
      'X-Accel-Buffering': 'no',
    },
  });
}
