'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Downloading a report: as an image to share, or a spreadsheet to check.
//
// The price is said before anything is charged — free the first time, free
// again for a report already downloaded, a credit otherwise — and the file is
// made from the copy of the report the server hands back, not from the page.
// The image is the report laid out on a sheet of its own, with the
// organisation's name and the date on it, so it still makes sense once it has
// been forwarded.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Download, FileImage, FileSpreadsheet, Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useSession } from '@/components/layout/session-provider';
import { ai, type AiReport, type DownloadQuote, type DownloadResult } from '@/lib/api/ai';
import { ApiError } from '@/lib/api/client';
import { reportToCsv } from '@/lib/ai/report-csv';
import { reportFileName } from '@/lib/ai/reports';
import { REPORT_DOWNLOAD_CREDITS, formatCharge, formatCredits } from '@/lib/billing/catalog';
import { cn } from '@/lib/utils';
import { useCredits } from './credits-provider';
import { ReportView } from './report-view';

type Format = 'png' | 'csv';

const creditWord = (n: number) => `${n} credit${n === 1 ? '' : 's'}`;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function save(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function DownloadReportButton({ report, messageId, className }: { report: AiReport; messageId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" className={className} onClick={() => setOpen(true)} data-slot="ai-report-download">
        <Download className="size-3" /> Download
      </Button>
      <DownloadDialog report={report} messageId={messageId} open={open} onOpenChange={setOpen} />
    </>
  );
}

function DownloadDialog({
  report,
  messageId,
  open,
  onOpenChange,
}: {
  report: AiReport;
  messageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const credits = useCredits();
  const session = useSession();
  const orgName = session.org?.name ?? 'Your organisation';
  const [quote, setQuote] = useState<DownloadQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outOfCredits, setOutOfCredits] = useState(false);
  const [format, setFormat] = useState<Format>('png');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<AiReport | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuote(null);
    setError(null);
    setOutOfCredits(false);
    ai.downloadQuote(messageId, report.key)
      .then((q) => {
        if (live) setQuote(q);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [open, messageId, report.key]);

  const price = quote ? (quote.owned || quote.free ? 0 : quote.priceMc) : null;
  const short = !!quote && price !== null && price > quote.availableMc;

  /** The report drawn on its own sheet, off screen, and photographed. */
  const makeImage = async (r: AiReport): Promise<string> => {
    flushSync(() => setSheet(r));
    try {
      await document.fonts?.ready;
      // The chart measures itself on its first frames.
      await frame();
      await frame();
      await pause(150);
      const node = sheetRef.current;
      if (!node) throw new Error('The report sheet did not render.');
      const { toPng } = await import('html-to-image');
      return await toPng(node, { pixelRatio: 2, backgroundColor: getComputedStyle(node).backgroundColor, cacheBust: true });
    } finally {
      setSheet(null);
    }
  };

  const told = (res: DownloadResult) => {
    if (res.owned) toast.success('Downloaded again — no charge for a report you already have.');
    else if (res.free) {
      toast.success(
        `Downloaded — your first download is free. Each new report after this costs ${creditWord(REPORT_DOWNLOAD_CREDITS)}; this one stays free to download again.`,
      );
    } else toast.success(`Downloaded · ${formatCharge(res.chargedMc)} credit${res.chargedMc === 1000 ? '' : 's'}`);
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    let res: DownloadResult;
    try {
      res = await ai.download({ messageId, key: report.key, format });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'out_of_credits') setOutOfCredits(true);
      setError((err as Error).message);
      return;
    }
    credits.setAvailable(res.availableMc);

    try {
      if (format === 'csv') {
        const csv = reportToCsv(res.report, { orgName, generatedAt: new Date(), origin: window.location.origin });
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        save(url, reportFileName(res.report, 'csv'));
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else {
        save(await makeImage(res.report), reportFileName(res.report, 'png'));
      }
      told(res);
      onOpenChange(false);
    } catch (err) {
      console.error('[ai] report file failed', err);
      // Paid for either way: the receipt means trying again costs nothing.
      setError('The file could not be made in this browser. Try again, or choose the other format — there is no second charge.');
    } finally {
      setBusy(false);
    }
  };

  const options: { value: Format; icon: typeof FileImage; title: string; detail: string }[] = [
    { value: 'png', icon: FileImage, title: 'Image (PNG)', detail: 'The report as a picture — figures, chart and table — to share or print.' },
    { value: 'csv', icon: FileSpreadsheet, title: 'Spreadsheet (CSV)', detail: 'Every figure in full, to the paisa, to open in Excel.' },
  ];

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
        <DialogContent className="sm:max-w-md" data-slot="ai-download-dialog">
          <DialogHeader>
            <DialogTitle>Download this report</DialogTitle>
            <DialogDescription>
              {report.title} · {report.subtitle}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2" role="radiogroup" aria-label="Format">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={format === o.value}
                onClick={() => setFormat(o.value)}
                className={cn(
                  'flex items-start gap-3 rounded-md border p-3 text-left transition-colors',
                  format === o.value ? 'border-primary bg-primary/[0.04] ring-1 ring-primary' : 'hover:bg-accent/40',
                )}
                data-slot="ai-download-format"
                data-format={o.value}
              >
                <o.icon className={cn('mt-0.5 size-4 shrink-0', format === o.value ? 'text-primary' : 'text-muted-foreground')} />
                <span>
                  <span className="block text-sm font-medium">{o.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{o.detail}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed" data-slot="ai-download-price" aria-live="polite">
            {!quote && !error ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Checking the price…
              </span>
            ) : quote?.owned ? (
              <span>
                <span className="font-medium">Free</span> — you have downloaded this report before, so it costs nothing again, in either format.
              </span>
            ) : quote?.free ? (
              <span>
                <span className="font-medium">Free</span> — your first download is on us. After this, each new report costs{' '}
                {creditWord(REPORT_DOWNLOAD_CREDITS)}.
              </span>
            ) : quote ? (
              <span>
                <span className="font-medium">{formatCharge(quote.priceMc)} credit{quote.priceMc === 1000 ? '' : 's'}</span> · you have{' '}
                {formatCredits(quote.availableMc)}. Downloading this report again later is free.
              </span>
            ) : null}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {(outOfCredits || short) && credits.wallet?.canManage && (
            <Button variant="outline" size="sm" onClick={credits.topUp}>
              <Wallet className="size-3.5" /> Top up credits
            </Button>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void download()} disabled={busy || !quote || short} data-slot="ai-download-confirm">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {price ? `Download for ${formatCharge(price)} credit${price === 1000 ? '' : 's'}` : 'Download'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sheet &&
        createPortal(
          <div aria-hidden style={{ position: 'fixed', left: -12_000, top: 0, width: 960, pointerEvents: 'none' }}>
            <div ref={sheetRef} className="bg-card p-8 text-card-foreground" style={{ width: 960 }}>
              <div className="mb-6 flex items-end justify-between gap-6 border-b pb-4">
                <div>
                  <p className="text-xs font-semibold tracking-[0.14em] text-primary">REKONZA AI</p>
                  <p className="mt-1 text-sm font-medium">{orgName}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Generated {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </div>
              <ReportView report={sheet} variant="sheet" still />
              <p className="mt-6 border-t pt-3 text-[11px] text-muted-foreground">
                From {orgName}&apos;s books in REKONZA AI · {sheet.source.label}. Check a figure in its report before you file on it.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
