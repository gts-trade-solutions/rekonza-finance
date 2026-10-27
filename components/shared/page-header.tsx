'use client';

import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="accent-bar min-w-0">
        <h1 className="display-xl">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 no-print">{actions}</div>}
    </div>
  );
}
