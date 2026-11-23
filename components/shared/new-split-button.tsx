'use client';

// Zoho's "New" on a list: a blue split button, the left half making the
// list's own record and the ▾ offering its relatives (New Recurring Invoice,
// New Credit Note …).

import Link from 'next/link';
import { ChevronDown, Plus } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function NewSplitButton({ href, label = 'New', more }: {
  href: string;
  label?: string;
  more: { label: string; href: string }[];
}) {
  return (
    <span className="inline-flex" data-slot="new-split">
      <Link href={href} className="inline-flex h-8 items-center gap-1.5 rounded-l-[var(--radius-button)] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:brightness-95">
        <Plus className="size-4" /> {label}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More ways to start" data-slot="new-split-more"
          className="inline-flex h-8 items-center rounded-r-[var(--radius-button)] border-l border-white/30 bg-primary px-1.5 text-primary-foreground outline-none hover:brightness-95">
          <ChevronDown className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {more.map((m) => (
            <DropdownMenuItem key={m.href} asChild><Link href={m.href}>{m.label}</Link></DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
