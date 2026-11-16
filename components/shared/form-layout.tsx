'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books form chrome: a fixed left label column, a sticky action bar, and
// section rules. Labels sit beside their field rather than above it, which is
// what makes a 15-field invoice header readable in one glance instead of
// scrolling — the pattern the client asked us to match.
//
// Sizes are Zoho's own (measured from its "New Invoice"): labels 13px in a
// 180px column, left-aligned, required ones in Zoho's red (#d6141d) with a
// star; fields 34px tall; the title band 65px with a hairline under it; the
// action bar fixed at the foot with Save as Draft, Save and Send, Cancel.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** One labelled field. `width` controls the control column, not the label. */
export function FormRow({
  label,
  required,
  hint,
  error,
  children,
  width = 'md',
  className,
  htmlFor,
}: {
  label?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
  htmlFor?: string;
}) {
  const widths = {
    sm: 'max-w-[180px]',
    md: 'max-w-[340px]',
    lg: 'max-w-[520px]',
    full: 'w-full',
  } as const;

  return (
    <div className={cn('flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-0', className)}>
      {label !== undefined && (
        <label
          htmlFor={htmlFor}
          className={cn(
            'shrink-0 pt-[7px] text-[13px] leading-snug sm:w-[180px] sm:pr-4',
            required ? 'text-required' : 'text-field-label',
          )}
        >
          {label}
          {required && <span className="ml-0.5">*</span>}
        </label>
      )}
      <div className={cn('min-w-0 flex-1', widths[width])}>
        {children}
        {error ? (
          <p className="mt-1 text-[11px] text-destructive">{error}</p>
        ) : hint ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Two FormRows side by side on wide screens (e.g. Invoice Date + Terms). */
export function FormRowPair({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4 lg:grid-cols-2', className)}>{children}</div>;
}

export function FormSectionRule({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      {label && (
        <span className="text-[14px] font-semibold text-foreground">
          {label}
        </span>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Full-bleed document editor: title band, scrolling body, sticky action bar.
 * Mirrors Zoho's "New Invoice" screen, which is a focused page rather than a
 * card floating inside the normal app layout.
 */
export function DocumentForm({
  title,
  icon,
  backHref,
  children,
  footer,
  footerSummary,
  headerExtra,
}: {
  title: string;
  icon?: ReactNode;
  backHref: string;
  children: ReactNode;
  footer: ReactNode;
  footerSummary?: ReactNode;
  headerExtra?: ReactNode;
}) {
  return (
    <div className="-mx-6 -mb-6 -mt-5 flex min-h-[calc(100vh-3rem)] flex-col" data-slot="document-form">
      {/* Title band: Zoho's 65px band, its document icon and a 22px title. */}
      <div className="sticky top-0 z-20 flex h-[65px] shrink-0 items-center gap-3 border-b bg-surface px-5">
        <span className="text-foreground [&_svg]:size-6">{icon}</span>
        <h1 className="flex-1 truncate text-[22px] font-normal leading-tight">{title}</h1>
        {headerExtra}
        <Link
          href={backHref}
          aria-label="Close"
          className="grid size-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-5" strokeWidth={1.6} />
        </Link>
      </div>

      {/* Body */}
      <div className="flex-1 bg-surface px-5 py-7">
        <div className="max-w-[1050px] space-y-7">{children}</div>
      </div>

      {/* Sticky actions */}
      <div className="footer-bar sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t bg-surface px-4 py-2.5 shadow-[0_-2px_6px_rgba(33,38,60,0.05)]">
        <div className="flex flex-wrap items-center gap-2">{footer}</div>
        {footerSummary && <div className="ml-auto text-right">{footerSummary}</div>}
      </div>
    </div>
  );
}
