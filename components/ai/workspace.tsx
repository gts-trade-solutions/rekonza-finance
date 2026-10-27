'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The conversation: history on the left, the exchange in the middle, the box
// to ask in at the bottom.
//
// An answer streams in as it is written. The lookups the assistant makes show
// as they happen ("Reading the ledger…"), so a few seconds of silence while a
// report runs does not read as a hang. Stop cuts the model off; the question is
// charged only for what was produced, and the partial answer is kept. The
// asking itself lives in useAiChat, shared with the corner panel.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp, ChartColumnBig, CreditCard, Ellipsis, FileText, HandCoins, History, Landmark, Loader2,
  MessageSquarePlus, Pencil, Receipt, Square, Trash2, TrendingUp, TriangleAlert, Wallet, type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ai, type AiStatus, type AiSuggestion, type ConversationSummary } from '@/lib/api/ai';
import { MC_PER_CREDIT, formatCredits } from '@/lib/billing/catalog';
import { cn } from '@/lib/utils';
import type { AiReport } from '@/lib/ai/reports';
import { AssistantMessage, StreamingMessage, UserMessage } from './messages';
import { ReportDialog } from './report-card';
import { MAX_QUESTION_CHARS, useAiChat } from './use-ai-chat';
import { useCredits } from './credits-provider';

const KIND_ICON: Record<AiSuggestion['kind'], LucideIcon> = {
  balance: Landmark,
  profit: TrendingUp,
  cash: Wallet,
  receivable: HandCoins,
  payable: Receipt,
  gst: FileText,
  sales: ChartColumnBig,
  expense: CreditCard,
};

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function Workspace({
  status,
  availableMc,
  onWallet,
}: {
  status: AiStatus;
  /** The live balance, kept by the app shell so every display agrees. */
  availableMc: number;
  onWallet: (availableMc: number) => void;
}) {
  const credits = useCredits();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  /** A report opened out over the page. */
  const [expanded, setExpanded] = useState<{ report: AiReport; messageId: string } | null>(null);
  /** A report asked for from the corner panel, to open once its conversation has loaded. */
  const [focus, setFocus] = useState<{ messageId: string; index: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const chat = useAiChat(availableMc, {
    onWallet,
    onStarted: (c) => setConversations((list) => [c, ...list]),
    onTouched: (id) =>
      setConversations((list) => {
        const hit = list.find((x) => x.id === id);
        if (!hit) return list;
        return [
          { ...hit, updatedAt: new Date().toISOString(), messageCount: hit.messageCount + 2 },
          ...list.filter((x) => x.id !== id),
        ];
      }),
  });
  const { activeId, messages, loadingConversation, streaming, available, open: openChat, startNew: startChat } = chat;

  const loadList = useCallback(async () => {
    try {
      const res = await ai.conversations();
      setConversations(res.conversations);
    } catch {
      // The list is a convenience; a failure here should not block asking.
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Opened from the corner assistant's "full page" button: carry on with that
  // conversation here. Read once, from the address, when the page opens.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('c');
    const messageId = params.get('m');
    const index = Number(params.get('r') ?? 0);
    if (messageId) setFocus({ messageId, index: Number.isInteger(index) && index >= 0 ? index : 0 });
    if (id) void openChat(id);
    // Taken in: a reload should not open it again over whatever comes next.
    if (id || messageId) window.history.replaceState(null, '', window.location.pathname);
  }, [openChat]);

  // "View full report" from the corner panel: once the conversation is here,
  // bring that answer into view and open its report full size.
  useEffect(() => {
    if (!focus) return;
    const m = messages.find((x) => x.id === focus.messageId);
    const report = m?.reports[focus.index];
    if (!m || !report) return;
    setFocus(null);
    setExpanded({ report, messageId: m.id });
    requestAnimationFrame(() =>
      document.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ block: 'center' }),
    );
  }, [focus, messages]);

  // Follow the answer down while it is being written, unless the reader has
  // scrolled up to look at something.
  useEffect(() => {
    const el = scrollRef.current;
    // An empty conversation reads from the top: the greeting, then suggestions.
    if (!el || (messages.length === 0 && !streaming)) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || !streaming) el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  const openConversation = (id: string) => {
    if (streaming) return;
    setHistoryOpen(false);
    void openChat(id);
  };

  const startNew = () => {
    if (streaming) return;
    setHistoryOpen(false);
    startChat();
    setInput('');
    textRef.current?.focus();
  };

  const ask = (raw: string) => {
    const question = raw.trim();
    if (!question || streaming) return;
    if (question.length > MAX_QUESTION_CHARS) {
      toast.error(`Questions can be up to ${MAX_QUESTION_CHARS.toLocaleString('en-IN')} characters.`);
      return;
    }
    setInput('');
    void chat.ask(question);
  };

  const outOfCredits = available < MC_PER_CREDIT;
  const lowCredits = !outOfCredits && available < 10 * MC_PER_CREDIT;
  const capLeft = status.userCap ? status.userCap.capMc - status.userCap.spentMc : null;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  const historyList = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Button variant="outline" className="w-full justify-start gap-2" onClick={startNew} disabled={!!streaming} data-slot="ai-new-chat">
          <MessageSquarePlus className="size-4" /> New conversation
        </Button>
      </div>
      <p className="micro-label px-4 pb-1.5">History</p>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 thin-scroll" data-slot="ai-history">
        {loadingList ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            Your conversations appear here. Only you can see them.
          </p>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                'group flex items-center gap-1 rounded-md pr-1 transition-colors',
                c.id === activeId ? 'bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <button
                type="button"
                onClick={() => openConversation(c.id)}
                className="min-w-0 flex-1 px-2.5 py-2 text-left"
                disabled={!!streaming}
              >
                <p className="truncate text-[13px]">{c.title}</p>
                <p className="text-[11px] text-muted-foreground">{when(c.updatedAt)}</p>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`Options for ${c.title}`}
                  className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 data-[popup-open]:opacity-100"
                >
                  <Ellipsis className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => setRenaming(c)}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(c)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="grid h-[calc(100dvh-13rem)] min-h-[34rem] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 rounded-[3px] border bg-card lg:block">{historyList}</aside>

      <section className="flex min-h-0 flex-col rounded-[3px] border bg-card" data-slot="ai-chat">
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:hidden"
            aria-label="Conversation history"
          >
            <History className="size-4" />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeId ? conversations.find((c) => c.id === activeId)?.title ?? 'Conversation' : 'New conversation'}
          </p>
          {status.mode === 'standin' && (
            <span className="hidden rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning sm:inline" title="Set OPENAI_API_KEY on the server for real answers">
              Stand-in answers · no AI key set
            </span>
          )}
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 thin-scroll">
          {loadingConversation ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Opening the conversation…
            </p>
          ) : messages.length === 0 && !streaming ? (
            <Welcome status={status} onAsk={ask} disabled={outOfCredits} />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.map((m) =>
                m.role === 'user' ? (
                  <UserMessage key={m.id} m={m} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    m={m}
                    isLast={m === lastAssistant && !streaming}
                    onFollowup={ask}
                    variant="full"
                    onOpenReport={(i) => setExpanded({ report: m.reports[i], messageId: m.id })}
                  />
                ),
              )}
              {streaming && <StreamingMessage text={streaming.text} tool={streaming.tool} />}
            </div>
          )}
        </div>

        <footer className="border-t p-3 sm:p-4">
          {outOfCredits ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-slot="ai-out-of-credits">
              <TriangleAlert className="size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">
                {status.isDemo
                  ? "The demo book's AI allowance for today is used up. Create your own book to keep asking."
                  : status.canManage
                    ? 'Your organisation has run out of AI credits. Top up to keep asking.'
                    : 'Your organisation has run out of AI credits. Ask an administrator to top up.'}
              </p>
              {status.canManage && (
                <Button size="sm" onClick={credits.topUp} data-slot="ai-out-of-credits-topup">
                  <Wallet className="size-3.5" /> Top up credits
                </Button>
              )}
            </div>
          ) : (
            <form
              className="mx-auto max-w-3xl"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <div className="flex items-end gap-2 rounded-md border bg-background px-3 py-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                <textarea
                  ref={textRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      ask(input);
                    }
                  }}
                  rows={1}
                  maxLength={MAX_QUESTION_CHARS + 200}
                  placeholder="Ask about balances, profit, cash, what customers owe, GST…"
                  className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
                  aria-label="Your question"
                  data-slot="ai-input"
                />
                {streaming ? (
                  <Button type="button" size="icon-sm" variant="outline" onClick={chat.stop} aria-label="Stop the answer" data-slot="ai-stop">
                    <Square className="size-3.5 fill-current" />
                  </Button>
                ) : (
                  <Button type="submit" size="icon-sm" disabled={!input.trim()} aria-label="Ask" data-slot="ai-send">
                    <ArrowUp className="size-4" />
                  </Button>
                )}
              </div>
              <p className="mt-1.5 flex flex-wrap justify-between gap-2 px-1 text-[11px] text-muted-foreground">
                <span>
                  Answers are built from your books and link to their reports. Check a figure there before you file on it.
                </span>
                <span className="tabular-nums">
                  {input.length > MAX_QUESTION_CHARS - 500
                    ? `${input.length.toLocaleString('en-IN')} / ${MAX_QUESTION_CHARS.toLocaleString('en-IN')}`
                    : capLeft !== null
                      ? `${formatCredits(Math.max(0, capLeft))} of your monthly credits left`
                      : `${formatCredits(available)} credits left`}
                  {lowCredits && status.canManage && (
                    <>
                      {' · '}
                      <button type="button" onClick={credits.topUp} className="font-medium text-primary hover:underline">
                        Top up
                      </button>
                    </>
                  )}
                </span>
              </p>
            </form>
          )}
        </footer>
      </section>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Conversation history</SheetTitle>
          {historyList}
        </SheetContent>
      </Sheet>

      <ReportDialog report={expanded?.report ?? null} messageId={expanded?.messageId ?? null} onClose={() => setExpanded(null)} />

      <RenameDialog
        conversation={renaming}
        onClose={() => setRenaming(null)}
        onSaved={(id, title) => setConversations((c) => c.map((x) => (x.id === id ? { ...x, title } : x)))}
      />
      <DeleteDialog
        conversation={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setConversations((c) => c.filter((x) => x.id !== id));
          if (id === activeId) startNew();
        }}
      />
    </div>
  );
}

// ── An empty conversation ────────────────────────────────────────────────────

function Welcome({ status, onAsk, disabled }: { status: AiStatus; onAsk: (q: string) => void; disabled: boolean }) {
  const high = status.flags.filter((f) => f.severity !== 'low').slice(0, 4);
  return (
    <div className="mx-auto max-w-3xl space-y-7" data-slot="ai-welcome">
      <div>
        <h2 className="text-lg font-semibold">What would you like to know?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the way you would ask your accountant. Every figure comes from your books, dated, with a link to the report
          behind it.
        </p>
        {status.hidden.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Your role does not include {status.hidden.join('; ')} — the assistant will not answer about those.
          </p>
        )}
      </div>

      {status.suggestions.length > 0 && (
        <div className="grid gap-2.5 sm:grid-cols-2" data-slot="ai-suggestions">
          {status.suggestions.map((s) => {
            const Icon = KIND_ICON[s.kind];
            return (
              <button
                key={s.prompt}
                type="button"
                disabled={disabled}
                onClick={() => onAsk(s.prompt)}
                className="flex items-start gap-3 rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/30 disabled:opacity-60"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{s.prompt}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {high.length > 0 && (
        <div data-slot="ai-attention">
          <p className="micro-label mb-2">Needs attention in your books</p>
          <div className="divide-y rounded-md border">
            {high.map((f) => (
              <div key={f.id} className="flex flex-wrap items-start gap-3 p-3">
                <span
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', f.severity === 'high' ? 'bg-destructive' : 'bg-warning')}
                  aria-label={f.severity === 'high' ? 'Important' : 'Worth a look'}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{f.detail}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="xs" variant="outline" asChild>
                    <Link href={f.href}>Open</Link>
                  </Button>
                  <Button size="xs" disabled={disabled} onClick={() => onAsk(f.ask)}>
                    Ask AI
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Found by rules over your books — free, and always exactly right. Asking about one uses credits.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Rename and delete ────────────────────────────────────────────────────────

function RenameDialog({
  conversation,
  onClose,
  onSaved,
}: {
  conversation: ConversationSummary | null;
  onClose: () => void;
  onSaved: (id: string, title: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTitle(conversation?.title ?? ''), [conversation]);

  const save = async () => {
    if (!conversation || !title.trim()) return;
    setBusy(true);
    try {
      await ai.rename(conversation.id, title.trim());
      onSaved(conversation.id, title.trim());
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!conversation} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
        </DialogHeader>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} autoFocus onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  conversation,
  onClose,
  onDeleted,
}: {
  conversation: ConversationSummary | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!conversation) return;
    setBusy(true);
    try {
      await ai.remove(conversation.id);
      onDeleted(conversation.id);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!conversation} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{conversation?.title}”?</DialogTitle>
          <DialogDescription>
            The questions and answers are removed for good. The credits it used stay on the usage record — that record holds no
            text.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
