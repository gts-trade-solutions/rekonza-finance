'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The Tally tutorial, shown once.
//
// Connecting Tally is the one part of this app that happens on another machine,
// in software we do not control, so people arrive at this screen least sure of
// what to do. The video opens by itself the first time someone comes to Tally,
// and never again on that browser — a tutorial that reappears is an annoyance,
// and one that can never be found again is a support call. "Watch the tutorial"
// in the page header reopens it whenever it is wanted.
//
// What was watched is remembered in this browser only: it decides whether a
// video plays, which is not worth a round trip or a row in anybody's database.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { MonitorDown, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { VideoPlayer } from '@/components/shared/video-player';

const SEEN_KEY = 'rekonza.tally.tutorial.seen';
export const TALLY_TUTORIAL_SRC = '/rekonza-tutorial.mp4';

/** True once this browser has been shown the tutorial. Safe where storage is blocked. */
function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // Private window, or storage switched off: treat it as seen, so the video
    // cannot reappear on every single visit.
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // As above — nothing to do, and nothing worth telling anyone.
  }
}

/**
 * Opens by itself on a first visit, and whenever `open` is set from the page.
 * The page owns `open` so its header button can reopen the same dialog.
 */
export function TallyTutorialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounts the player on each open, so a second viewing starts at the
  // beginning and a closed dialog is never left playing in the background.
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (open) setRun((n) => n + 1);
  }, [open]);

  const close = () => {
    markSeen();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-3xl" data-slot="tally-tutorial">
        <DialogHeader>
          <DialogTitle>Connecting Tally — a short tour</DialogTitle>
          <DialogDescription>
            A short tour of what connects to what, before you start. You can reopen it any time from
            Watch the tutorial at the top of this page.
          </DialogDescription>
        </DialogHeader>

        <VideoPlayer key={run} src={TALLY_TUTORIAL_SRC} title="Connecting Tally to REKONZA" />

        <div className="grid gap-2 sm:grid-cols-2">
          <span className="flex items-start gap-2.5 rounded-md border bg-muted/30 p-3 text-sm">
            <MonitorDown className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              <b className="font-medium">Your Tally books, here.</b> A small connector on the PC running
              TallyPrime reads your companies. Nothing in Tally is changed.
            </span>
          </span>
          <span className="flex items-start gap-2.5 rounded-md border bg-muted/30 p-3 text-sm">
            <Upload className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              <b className="font-medium">Your invoices, into Tally.</b> Export to Tally makes the two files
              your accountant imports.
            </span>
          </span>
        </div>

        <DialogFooter>
          <Button onClick={close} data-slot="tally-tutorial-done">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether the tutorial should open by itself, decided after mount so the server
 * and the first client render agree.
 */
export function useFirstVisitTutorial(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasSeen()) setOpen(true);
  }, []);

  const set = useCallback((next: boolean) => setOpen(next), []);
  return [open, set];
}
