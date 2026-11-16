'use client';

// Zoho Books' list header: a 65px band across the page with the title on the
// left (18px semibold) and the actions on the right, a hairline under it, and
// it stays in place while the list scrolls under it. When the page's list has
// status views, the title becomes Zoho's view menu ("All Invoices ▾"): the list
// draws it into the slot here (DataTable, page-context.ts).
//
// Zoho has no subtitle under a list's title. The explanation a Rekonza page
// carries is kept, behind the (i) beside the title, and stays in the page for
// screen readers.

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setViewSlot, usePublishPageTitle } from '@/components/layout/page-context';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  usePublishPageTitle(title);
  return (
    <div
      data-slot="page-header"
      className="sticky top-0 z-10 flex min-h-[65px] flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background py-3 print:static"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5" data-slot="page-title">
        <h1 className="display-xl min-w-0 truncate">{title}</h1>
        <span ref={setViewSlot} className="contents" data-slot="view-slot" />
        {description && (
          <>
            <Tooltip>
              <TooltipTrigger
                aria-label="About this screen"
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground no-print"
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-[12px] leading-relaxed">{description}</TooltipContent>
            </Tooltip>
            <span className="sr-only" data-slot="page-description">{description}</span>
          </>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 no-print" data-slot="page-actions">{actions}</div>}
    </div>
  );
}
