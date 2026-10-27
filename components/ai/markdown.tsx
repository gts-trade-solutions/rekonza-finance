'use client';

// ─────────────────────────────────────────────────────────────────────────────
// An answer, rendered.
//
// Markdown because that is what the model writes — short paragraphs, the odd
// list, and tables when comparing figures. Rendered without raw HTML (none is
// ever passed through), and links are kept only when they point inside the
// app: an answer is shaped partly by text from the books, and a customer's
// name must never be able to become a link to somewhere else.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const components: Components = {
  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-2.5">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="text-muted-foreground">{children}</em>,
  h1: ({ children }) => <p className="mt-3 font-semibold text-foreground">{children}</p>,
  h2: ({ children }) => <p className="mt-3 font-semibold text-foreground">{children}</p>,
  h3: ({ children }) => <p className="mt-3 font-semibold text-foreground">{children}</p>,
  h4: ({ children }) => <p className="mt-3 font-medium text-foreground">{children}</p>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border thin-scroll">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50 text-xs text-muted-foreground">{children}</thead>,
  th: ({ children, style }) => (
    <th className="whitespace-nowrap px-3 py-2 text-left font-medium" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border-t px-3 py-2 align-top tabular-nums" style={style}>
      {children}
    </td>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-[12px] thin-scroll">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-3" />,
  a: ({ href, children }) =>
    href && href.startsWith('/') && !href.startsWith('//') ? (
      <Link href={href} className="text-primary underline-offset-2 hover:underline">
        {children}
      </Link>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('text-sm text-foreground/90', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
