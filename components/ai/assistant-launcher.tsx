'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The assistant in the corner of every screen.
//
// "AI Assistant" in the sidebar is found by the people who go looking for it.
// A chat button in the bottom-right corner is found by everyone, because that
// is where help sits on every website they use. It opens a small panel over
// the screen they are on, so a question about the invoice in front of them
// does not mean leaving it.
//
// The conversation is held here, in the app shell, not in the panel: closing
// the panel or moving to another page does not lose it, and an answer being
// written keeps arriving — the button shows a dot when it lands. The full page
// takes over a conversation, with the history beside it.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Loader2, Maximize2, MessageCircle, MessageSquarePlus, Sparkles, Square, TriangleAlert, Wallet, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ai, type AiSuggestion } from '@/lib/api/ai';
import { MC_PER_CREDIT, TRIAL_CREDITS, formatCredits } from '@/lib/billing/catalog';
import { cn } from '@/lib/utils';
import { AssistantMessage, StreamingMessage, UserMessage } from './messages';
import { useCredits } from './credits-provider';
import { MAX_QUESTION_CHARS, useAiChat } from './use-ai-chat';

/** Set once the panel has been opened, so the button stops asking to be noticed. */
const SEEN_KEY = 'rekonza-ai-launcher-seen';

const isPhone = () => window.matchMedia('(max-width: 639.98px)').matches;

export function AssistantLauncher() {
  const { wallet, setAvailable, topUp, assistantOpen: open, setAssistantOpen: setOpen } = useCredits();
  const pathname = usePathname();
  const router = useRouter();
  const onAiPage = pathname === '/ai' || !!pathname?.startsWith('/ai/');

  const [input, setInput] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<AiSuggestion[] | null>(null);
  const [unread, setUnread] = useState(false);
  const [seen, setSeen] = useState(true);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);

  const chat = useAiChat(wallet?.availableMc ?? 0, {
    onWallet: (mc) => {
      setAvailable(mc);
      if (!openRef.current) setUnread(true);
    },
    onStarted: (c) => setTitle(c.title),
  });
  const { messages, streaming, available } = chat;

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(SEEN_KEY) === '1');
    } catch {
      // Storage blocked: no pulse, which is the quiet default anyway.
    }
  }, []);

  useEffect(() => {
    openRef.current = open;
    if (!open) return;
    setUnread(false);
    setSeen(true);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // As above.
    }
    // A phone's keyboard would cover half the answer the moment it opened.
    if (!isPhone()) textRef.current?.focus();
  }, [open]);

  // The assistant's own page has the whole conversation on it already.
  useEffect(() => {
    if (onAiPage) setOpen(false);
  }, [onAiPage, setOpen]);

  // On a phone the panel covers the screen, so a link followed from an answer
  // would change the page out of sight. Step aside to show it.
  useEffect(() => {
    if (isPhone()) setOpen(false);
  }, [pathname, setOpen]);

  // What to ask about this book: the same suggestions as the full page, fetched
  // the first time the panel opens rather than on every screen load.
  const enabled = !!wallet?.enabled;
  useEffect(() => {
    if (!open || !enabled || suggestions) return;
    let live = true;
    ai.status()
      .then((s) => {
        if (live) setSuggestions(s.suggestions.slice(0, 4));
      })
      .catch(() => {
        if (live) setSuggestions([]);
      });
    return () => {
      live = false;
    };
  }, [open, enabled, suggestions]);

  // Follow the answer down while it is being written, unless the reader has
  // scrolled up to look at something.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (messages.length === 0 && !streaming)) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || !streaming) el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming, open]);

  if (!wallet || wallet.mode === 'unconfigured' || onAiPage) return null;
  // Someone who can neither ask nor turn it on has nothing to open.
  if (!wallet.enabled && !wallet.canManage) return null;

  const close = () => {
    setOpen(false);
    // The button is hidden under the panel on a phone; focus it once it is back.
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  const send = (raw: string) => {
    const question = raw.trim();
    if (!question || streaming) return;
    if (question.length > MAX_QUESTION_CHARS) {
      toast.error(`Questions can be up to ${MAX_QUESTION_CHARS.toLocaleString('en-IN')} characters.`);
      return;
    }
    setInput('');
    if (textRef.current) textRef.current.style.height = 'auto';
    void chat.ask(question);
  };

  const startNew = () => {
    if (streaming) return;
    chat.startNew();
    setTitle(null);
    setInput('');
    textRef.current?.focus();
  };

  // "View full report": the conversation moves to the assistant's page, which
  // opens this report full size. The panel starts afresh next time.
  const openReport = (messageId: string, index: number) => {
    if (streaming || !chat.activeId) return;
    router.push(`/ai?c=${chat.activeId}&m=${encodeURIComponent(messageId)}&r=${index}`);
    setOpen(false);
    chat.startNew();
    setTitle(null);
  };

  const outOfCredits = available < MC_PER_CREDIT;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const fullPageHref = chat.activeId ? `/ai?c=${chat.activeId}` : '/ai';

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="AI assistant"
          className="fixed inset-0 z-40 flex flex-col bg-card no-print sm:inset-auto sm:bottom-[5.25rem] sm:right-5 sm:h-[min(40rem,calc(100dvh-7.5rem))] sm:w-[25rem] sm:rounded-lg sm:border sm:shadow-2xl"
          data-slot="ai-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header className="flex items-center gap-2 border-b px-3 py-2.5 sm:px-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-semibold">{title ?? 'AI Assistant'}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {wallet.enabled ? (
                  <span className={cn('tabular-nums', outOfCredits && 'text-destructive')} data-slot="ai-panel-balance">
                    {formatCredits(available)} credits left
                  </span>
                ) : (
                  'Answers from your books'
                )}
                {wallet.mode === 'standin' && ' · stand-in answers'}
              </p>
            </div>
            {wallet.enabled && wallet.canManage && (
              <Button size="xs" variant="outline" onClick={topUp} data-slot="ai-panel-topup">
                <Wallet className="size-3" /> Top up
              </Button>
            )}
            {wallet.enabled && (
              <HeaderButton label="New conversation" onClick={startNew} disabled={!!streaming || messages.length === 0}>
                <MessageSquarePlus />
              </HeaderButton>
            )}
            <Link
              href={fullPageHref}
              aria-label="Open the full assistant"
              title="Open the full assistant"
              aria-disabled={!!streaming}
              onClick={(e) => {
                if (streaming) {
                  e.preventDefault();
                  return;
                }
                // The page carries on with this conversation; the panel starts
                // afresh next time rather than showing a copy that falls behind.
                setOpen(false);
                chat.startNew();
                setTitle(null);
              }}
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                streaming && 'pointer-events-none opacity-40',
              )}
            >
              <Maximize2 className="size-4" />
            </Link>
            <HeaderButton label="Close" onClick={close}>
              <X />
            </HeaderButton>
          </header>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 thin-scroll">
            {!wallet.enabled ? (
              <TurnOn onGo={() => setOpen(false)} />
            ) : messages.length === 0 && !streaming ? (
              <div className="space-y-4" data-slot="ai-panel-welcome">
                <div>
                  <p className="text-sm font-semibold">What would you like to know?</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    Ask the way you would ask your accountant. Every figure comes from your books, with a link to the
                    report behind it.
                  </p>
                </div>
                {suggestions === null ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Finding questions for your book…
                  </p>
                ) : (
                  suggestions.length > 0 && (
                    <div className="space-y-2" data-slot="ai-panel-suggestions">
                      <p className="micro-label">Try asking</p>
                      {suggestions.map((s) => (
                        <button
                          key={s.prompt}
                          type="button"
                          disabled={outOfCredits}
                          onClick={() => send(s.prompt)}
                          className="block w-full rounded-md border bg-background px-3 py-2 text-left text-[13px] leading-snug transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:opacity-60"
                        >
                          {s.prompt}
                        </button>
                      ))}
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <UserMessage key={m.id} m={m} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      m={m}
                      isLast={m === lastAssistant && !streaming}
                      onFollowup={send}
                      variant="compact"
                      onOpenReport={(i) => openReport(m.id, i)}
                    />
                  ),
                )}
                {streaming && <StreamingMessage text={streaming.text} tool={streaming.tool} />}
              </div>
            )}
          </div>

          {wallet.enabled && (
            <footer className="border-t p-3">
              {outOfCredits ? (
                <div
                  className="space-y-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[13px]"
                  data-slot="ai-panel-out-of-credits"
                >
                  <p className="flex gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <span>
                      {wallet.isDemo
                        ? "The demo book's AI allowance for today is used up. Create your own book to keep asking."
                        : wallet.canManage
                          ? 'Your organisation has run out of AI credits. Top up to keep asking.'
                          : 'Your organisation has run out of AI credits. Ask an administrator to top up.'}
                    </span>
                  </p>
                  {wallet.canManage && (
                    <Button size="sm" className="w-full" onClick={topUp}>
                      <Wallet className="size-3.5" /> Top up credits
                    </Button>
                  )}
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    send(input);
                  }}
                >
                  <div className="flex items-end gap-2 rounded-md border bg-background px-3 py-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                    <textarea
                      ref={textRef}
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          send(input);
                        }
                      }}
                      rows={1}
                      maxLength={MAX_QUESTION_CHARS + 200}
                      placeholder="Ask about balances, profit, GST…"
                      className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
                      aria-label="Your question"
                      data-slot="ai-panel-input"
                    />
                    {streaming ? (
                      <Button type="button" size="icon-sm" variant="outline" onClick={chat.stop} aria-label="Stop the answer" data-slot="ai-panel-stop">
                        <Square className="size-3.5 fill-current" />
                      </Button>
                    ) : (
                      <Button type="submit" size="icon-sm" disabled={!input.trim()} aria-label="Ask" data-slot="ai-panel-send">
                        <ArrowUp className="size-4" />
                      </Button>
                    )}
                  </div>
                  <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
                    Built from your books. Check a figure in its report before you file on it.
                  </p>
                </form>
              )}
            </footer>
          )}
        </div>
      )}

      <button
        ref={launcherRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={
          open ? 'Close the AI assistant' : unread ? 'Ask the AI assistant — a new answer is ready' : 'Ask the AI assistant'
        }
        aria-expanded={open}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex size-12 items-center justify-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 no-print sm:w-auto sm:px-5',
          open && 'max-sm:hidden',
        )}
        data-slot="ai-launcher"
      >
        {!seen && !open && (
          <span aria-hidden className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary/40 motion-reduce:hidden" />
        )}
        {open ? <X className="size-5" /> : <MessageCircle className="size-5" />}
        <span className="hidden text-sm font-medium sm:inline" data-slot="ai-launcher-label">
          {open ? 'Close' : 'Ask AI'}
        </span>
        {!open && (streaming || unread) && (
          <span
            aria-hidden
            className={cn(
              'absolute -right-0.5 -top-0.5 size-3.5 rounded-full border-2 border-background',
              streaming ? 'animate-pulse bg-warning' : 'bg-destructive',
            )}
            data-slot="ai-launcher-dot"
          />
        )}
      </button>
    </>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

/** An administrator, before the assistant is on: what it is, and where to turn it on. */
function TurnOn({ onGo }: { onGo: () => void }) {
  return (
    <div className="space-y-4" data-slot="ai-panel-enable">
      <div>
        <p className="text-sm font-semibold">Ask about your books in plain words</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Closing balances, profit, cash, who owes you, GST — answered from the same reports the app shows, each linked
          back to its source.
        </p>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        It is off until an administrator turns it on, after reading what is sent to the AI service. You start with{' '}
        {TRIAL_CREDITS} free credits.
      </p>
      <Button className="w-full" asChild>
        <Link href="/ai" onClick={onGo}>
          Review and turn on
        </Link>
      </Button>
    </div>
  );
}
