import Image from 'next/image';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// The Rekonza brand.
//
// One module so the name, the tagline and the artwork can never drift apart
// between the sidebar, the sign-in screen, the landing page and the metadata.
//
// Four assets, all derived from the master lockup by scripts/brand-assets.mjs:
// `mark.png` is the glyph squared for chrome slots, `wordmark.png` the full
// lockup trimmed, and `*-dark.png` the same two with the navy repainted near
// white.
//
// A dark variant rather than a CSS filter. The lockup is navy text beside a
// teal-and-blue glyph; brightening or inverting the whole image would take the
// glyph with it, and the glyph is the half that already reads on a dark ground.
// So both files ship and the theme picks one — a few kilobytes to keep the
// brand looking like itself in either theme.
// ─────────────────────────────────────────────────────────────────────────────

export const BRAND = {
  name: 'Rekonza AI',
  /** Set in caps where the name is a title rather than running prose. */
  display: 'REKONZA AI',
  tagline: 'Books. Made Smarter.',
  short: 'Rekonza',
  description:
    'Double-entry accounting, GST compliance, e-invoicing and banking for Indian business — one ledger, every figure traceable to the document behind it.',
} as const;

/** The glyph alone, for a chrome slot where the name is set in text beside it. */
export function LogoMark({ className, size = 30 }: { className?: string; size?: number }) {
  // Decorative in every place it is used: the name is always set in text
  // beside it, or carried by an aria-label on the link around it.
  //
  // The style repeats the width and height attributes on purpose. Tailwind's
  // preflight puts `height: auto` on every img, so without it Next sees one
  // dimension changed by CSS and the other not, and warns on every page the
  // chrome renders on.
  const common = {
    'aria-hidden': true,
    width: size,
    height: size,
    priority: true,
    style: { width: size, height: size },
  } as const;
  return (
    <>
      <Image {...common} alt="" src="/mark.png" className={cn('shrink-0 dark:hidden', className)} />
      <Image {...common} alt="" src="/mark-dark.png" className={cn('hidden shrink-0 dark:block', className)} />
    </>
  );
}

/** The full lockup, for places where the brand itself is the subject. */
export function Logo({
  className,
  width = 190,
  priority = false,
}: {
  className?: string;
  width?: number;
  priority?: boolean;
}) {
  const common = {
    width,
    height: Math.round((width * 376) / 1940),
    priority,
    style: { width, height: 'auto' } as const,
  };
  return (
    <>
      {/* Only one of the two is ever visible, so only one carries the name —
          otherwise a screen reader announces the brand twice. */}
      <Image
        {...common}
        src="/wordmark.png"
        alt={BRAND.display}
        className={cn('h-auto w-auto dark:hidden', className)}
      />
      <Image
        {...common}
        src="/wordmark-dark.png"
        alt=""
        aria-hidden
        className={cn('hidden h-auto w-auto dark:block', className)}
      />
    </>
  );
}
