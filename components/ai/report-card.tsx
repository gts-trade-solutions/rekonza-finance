'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A report under an answer, and the same report opened out.
//
// In the corner panel the card is compact, and "View full report" carries the
// conversation to the assistant's page, where the report opens full size. On
// that page the card is larger, and Expand lays it over the page — the
// clearest view of the figures, with the download beside them.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { ArrowRight, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { AiReport } from '@/lib/ai/reports';
import { DownloadReportButton } from './report-download';
import { ReportView } from './report-view';

export function ReportCard({
  report,
  messageId,
  variant,
  onOpen,
}: {
  report: AiReport;
  messageId: string;
  variant: 'compact' | 'full';
  /** Compact: go to the full report. Full: expand it over the page. */
  onOpen?: () => void;
}) {
  const compact = variant === 'compact';
  return (
    <section className="rounded-lg border bg-card p-3 sm:p-4" data-slot="ai-report" data-report={report.key}>
      <ReportView
        report={report}
        variant={variant}
        actions={
          !compact && onOpen ? (
            <Button size="xs" variant="ghost" onClick={onOpen} aria-label={`Expand ${report.title}`} data-slot="ai-report-expand">
              <Maximize2 className="size-3" /> Expand
            </Button>
          ) : undefined
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
            {compact && onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                data-slot="ai-report-open"
              >
                View full report <ArrowRight className="size-3" />
              </button>
            ) : (
              <Link href={report.source.href} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                From {report.source.label}
              </Link>
            )}
            <DownloadReportButton report={report} messageId={messageId} />
          </div>
        }
      />
    </section>
  );
}

/** The report full size, over the page. */
export function ReportDialog({
  report,
  messageId,
  onClose,
}: {
  report: AiReport | null;
  messageId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!report} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl" data-slot="ai-report-dialog">
        {report && messageId && (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{report.title}</DialogTitle>
              <DialogDescription>{report.subtitle}</DialogDescription>
            </DialogHeader>
            <ReportView
              report={report}
              variant="sheet"
              footer={
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <Link href={report.source.href} onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                    Open {report.source.label} in the app
                  </Link>
                  <DownloadReportButton report={report} messageId={messageId} />
                </div>
              }
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
