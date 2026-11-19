'use client';

// The ⋯ menu at the top of a list, as Zoho Books has it beside "+ New":
// Import ▸ "Import Invoices", Export ▸ "Export Invoices", Refresh List.
// The import opens Zoho's three steps (/import/[module]); the export opens
// Settings → Export set to the same records.

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Download, MoreHorizontal, RefreshCw, Upload } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { importHref, importModule } from '@/lib/imports/modules';
import { usePermission } from '@/lib/store/hooks';

export function ModuleMenu({ slug, onRefresh, children }: {
  /** The module's import (lib/imports/modules.ts). */
  slug: string;
  /** Refresh List; without it the page reloads. */
  onRefresh?: () => void;
  /** More items, after Export. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const m = importModule(slug);
  const canImport = usePermission(m?.module ?? 'sales', 'create');
  const canExport = usePermission(m?.module ?? 'sales', 'export');
  if (!m) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="More actions" data-slot="module-menu"
        className="grid size-8 place-items-center rounded-[3px] border bg-background transition-colors hover:bg-accent">
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {canImport && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Upload className="mr-2 size-4 text-primary" /> Import</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => router.push(importHref(m.slug))} data-slot="module-import">Import {m.title}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {canExport && m.exportModule && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Download className="mr-2 size-4 text-primary" /> Export</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => router.push(`/settings/export?module=${m.exportModule}`)} data-slot="module-export">Export {m.title}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {children}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => (onRefresh ? onRefresh() : router.refresh())}><RefreshCw className="mr-2 size-4 text-primary" /> Refresh List</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
