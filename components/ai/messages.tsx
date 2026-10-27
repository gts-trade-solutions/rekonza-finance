'use client';

// The three things a conversation shows: what was asked, what was answered,
// and an answer still arriving.

import Link from 'next/link';
import { useState } from 'react';
import { Check, Copy, FileText, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import type { AiMessage } from '@/lib/api/ai';
import { formatCharge } from '@/lib/billing/catalog';
import { visibleWhileStreaming } from '@/lib/ai/followups';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';
import { ReportCard } from './report-card';

function Avatar({ busy }: { busy?: boolean }) {
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary',
        busy && 'animate-pulse',
      )}
      aria-hidden
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

export function UserMessage({ m }: { m: AiMessage }) {
  return (
    <div className="flex justify-end" data-slot="ai-user-message">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-primary/10 px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {m.content}
      </div>
    </div>
  );
}

export function AssistantMessage({
  m,
  isLast,
  onFollowup,
  variant = 'full',
  onOpenReport,
}: {
  m: AiMessage;
  isLast: boolean;
  onFollowup: (q: string) => void;
  /** Compact in the corner panel, full on the assistant's page. */
  variant?: 'compact' | 'full';
  onOpenReport?: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused by the browser; nothing to do.
    }
  };

  return (
    <div className="flex gap-3" data-slot="ai-answer" data-status={m.status} data-message-id={m.id}>
      <Avatar />
      <div className="min-w-0 flex-1">
        {m.status === 'error' ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {m.content}
          </p>
        ) : (
          <Markdown>{m.content}</Markdown>
        )}

        {/* The summary above; the detail — figures, chart, table — below it. */}
        {m.reports.length > 0 && (
          <div className="mt-3 space-y-3">
            {m.reports.map((r, i) => (
              <ReportCard
                key={r.key}
                report={r}
                messageId={m.id}
                variant={variant}
                onOpen={onOpenReport ? () => onOpenReport(i) : undefined}
              />
            ))}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
          {m.status === 'stopped' && <span className="rounded border px-1.5 py-0.5">Stopped</span>}
          {m.sources.map((s) => (
            <Link
              key={`${s.href}|${s.label}`}
              href={s.href}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors hover:border-primary/40 hover:text-foreground"
              data-slot="ai-source"
            >
              <FileText className="size-3" /> {s.label}
            </Link>
          ))}
          {m.chargedMc > 0 && (
            <span data-slot="ai-charge">
              {formatCharge(m.chargedMc)} credits{m.reports.length ? ' · includes the report' : ''}
            </span>
          )}
          {m.status !== 'error' && m.content && (
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground"
              aria-label="Copy the answer"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>

        {isLast && m.followups.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5" data-slot="ai-followups">
            {m.followups.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onFollowup(q)}
                className="rounded-full border bg-background px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function StreamingMessage({ text, tool }: { text: string; tool: string | null }) {
  const visible = visibleWhileStreaming(text);
  return (
    <div className="flex gap-3" data-slot="ai-streaming" aria-live="polite">
      <Avatar busy />
      <div className="min-w-0 flex-1">
        {visible && <Markdown>{visible}</Markdown>}
        {tool ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {tool}…
          </p>
        ) : (
          !visible && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Thinking…
            </p>
          )
        )}
      </div>
    </div>
  );
}
