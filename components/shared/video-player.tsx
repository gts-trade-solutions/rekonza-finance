'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The video player used for in-app tutorials.
//
// Built rather than borrowed, so it carries the app's own colours, focus rings
// and type instead of a browser's grey chrome — and so the parts that matter on
// a help video work properly: scrubbing that follows the pointer off the track,
// a buffered bar that shows what has actually arrived, speed for people who
// want it faster, and the keys anyone who has used a video player expects.
//
// Nothing autoplays with sound: browsers refuse it and viewers resent it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Maximize, Minimize, Pause, Play, RotateCcw, Volume2, VolumeX,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const HIDE_AFTER_MS = 2600;

/** Seconds as m:ss, which is how a short video reads. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoPlayer({
  src,
  title,
  className,
  onEnded,
}: {
  src: string;
  /** Read out to screen readers, and shown while the video is still loading. */
  title: string;
  className?: string;
  onEnded?: () => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [full, setFull] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);

  const progress = duration > 0 ? Math.min(time / duration, 1) : 0;

  // Controls stay up while paused, while scrubbing, while the pointer rests on
  // them, and for a moment after any pointer or key activity. Hiding a bar
  // somebody is reaching for turns the click into a play/pause on the video.
  const overControls = useRef(false);
  const wake = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!overControls.current) setShowControls(false);
    }, HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    if (!playing || scrubbing) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setShowControls(true);
      return;
    }
    wake();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [playing, scrubbing, wake]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.ended) {
      v.currentTime = 0;
      void v.play();
      return;
    }
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(v.currentTime + delta, 0), v.duration);
    setTime(v.currentTime);
  }, []);

  const seekToRatio = useCallback((ratio: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const at = Math.min(Math.max(ratio, 0), 1) * v.duration;
    v.currentTime = at;
    setTime(at);
  }, []);

  const ratioFromEvent = (el: HTMLElement, clientX: number) => {
    const box = el.getBoundingClientRect();
    return box.width ? (clientX - box.left) / box.width : 0;
  };

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // The keys people already know. They work while anything inside the player
  // has focus, so they never steal typing from the rest of the page.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      ArrowRight: () => seekBy(5),
      ArrowLeft: () => seekBy(-5),
      l: () => seekBy(10),
      j: () => seekBy(-10),
      m: () => {
        const v = videoRef.current;
        if (v) {
          v.muted = !v.muted;
          setMuted(v.muted);
        }
      },
      f: toggleFullscreen,
      Home: () => seekToRatio(0),
      End: () => seekToRatio(0.999),
    };
    const run = keys[e.key] ?? keys[e.key.toLowerCase()];
    if (!run) return;
    e.preventDefault();
    wake();
    run();
  };

  return (
    <div
      ref={shellRef}
      className={cn(
        'group/player relative isolate overflow-hidden rounded-lg bg-[oklch(0.17_0.015_250)] select-none',
        'focus-within:ring-2 focus-within:ring-ring/60 focus-within:ring-offset-0',
        className,
      )}
      onPointerMove={wake}
      onPointerLeave={() => playing && !scrubbing && setShowControls(false)}
      onKeyDown={onKeyDown}
      data-slot="video-player"
    >
      <video
        ref={videoRef}
        // #t=0.1 makes the browser paint the first frame instead of a black box.
        src={`${src}#t=0.1`}
        title={title}
        className="block aspect-video w-full cursor-pointer bg-black"
        playsInline
        preload="metadata"
        onClick={toggle}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => !scrubbing && setTime(e.currentTarget.currentTime)}
        onProgress={(e) => {
          const v = e.currentTarget;
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onEnded={() => {
          setPlaying(false);
          setEnded(true);
          setShowControls(true);
          onEnded?.();
        }}
      />

      {/* Before the first play, and again at the end: one obvious target. */}
      {(!playing || ended) && (
        <button
          type="button"
          onClick={toggle}
          aria-label={ended ? 'Play again' : 'Play'}
          className="absolute inset-0 grid place-items-center bg-black/25 transition-colors hover:bg-black/35 focus-visible:outline-none"
          data-slot="video-play"
        >
          <span className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground shadow-xl ring-4 ring-white/15 transition-transform group-hover/player:scale-105 motion-reduce:transition-none">
            {ended ? <RotateCcw className="size-7" /> : <Play className="ml-0.5 size-7 fill-current" />}
          </span>
        </button>
      )}

      {waiting && playing && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <Loader2 className="size-9 animate-spin text-white/90" />
        </span>
      )}

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pt-8 pb-2.5 transition-opacity duration-200 motion-reduce:transition-none',
          showControls || !playing ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onPointerEnter={() => {
          overControls.current = true;
          wake();
        }}
        onPointerLeave={() => {
          overControls.current = false;
          wake();
        }}
      >
        {/* Scrub bar. Dragging keeps following the pointer past the track's edges. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          // Keys are handled once, by the shell: this bubbles to it, and a
          // second handler here would toggle play twice and look like nothing.
          className="group/track relative h-5 cursor-pointer touch-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubbing(true);
            seekToRatio(ratioFromEvent(e.currentTarget, e.clientX));
          }}
          onPointerMove={(e) => {
            if (scrubbing) seekToRatio(ratioFromEvent(e.currentTarget, e.clientX));
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setScrubbing(false);
          }}
          data-slot="video-seek"
        >
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25" />
          <span
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/30"
            style={{ width: `${duration ? Math.min(buffered / duration, 1) * 100 : 0}%` }}
          />
          <span
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
            style={{ width: `${progress * 100}%` }}
          />
          <span
            className={cn(
              'absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-transform motion-reduce:transition-none',
              scrubbing ? 'scale-110' : 'scale-0 group-hover/track:scale-100',
            )}
            style={{ left: `${progress * 100}%` }}
          />
        </div>

        <div className="flex items-center gap-1 text-white">
          <Control onClick={toggle} label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
          </Control>
          <Control
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.muted = !v.muted;
              setMuted(v.muted);
            }}
            label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </Control>

          <span className="ml-1 text-xs tabular-nums text-white/85" data-slot="video-time">
            {clock(time)} <span className="text-white/45">/ {clock(duration)}</span>
          </span>

          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
                setSpeed(next);
                if (videoRef.current) videoRef.current.playbackRate = next;
              }}
              aria-label={`Playback speed, now ${speed} times`}
              className="rounded px-2 py-1 text-xs font-medium tabular-nums text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            >
              {speed}×
            </button>
            <Control onClick={toggleFullscreen} label={full ? 'Leave full screen' : 'Full screen'}>
              {full ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </Control>
          </span>
        </div>
      </div>
    </div>
  );
}

function Control({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded text-white/90 transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
