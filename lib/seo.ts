// ─────────────────────────────────────────────────────────────────────────────
// One place for the canonical origin.
//
// Metadata, sitemap, robots and the JSON-LD all need the same absolute URL, and
// a mismatch between them is the kind of thing that only shows up as a quietly
// unindexed site weeks later. NEXT_PUBLIC_SITE_URL overrides it per deploy;
// the fallback is the production host.
// ─────────────────────────────────────────────────────────────────────────────

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rekonza.ai'
).replace(/\/$/, '');

/** Pages a crawler should see. Everything behind sign-in is excluded. */
export const PUBLIC_ROUTES = ['/', '/login', '/register'] as const;
