import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';

/**
 * Everything behind sign-in is disallowed.
 *
 * Not for secrecy — the API refuses an unauthenticated request anyway — but
 * because a crawler following those paths only ever reaches a redirect, and a
 * site whose crawl budget is spent on redirects indexes badly.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/sales/',
          '/purchases/',
          '/banking/',
          '/accountant/',
          '/gst/',
          '/inventory/',
          '/reports/',
          '/settings/',
          '/ai',
          '/portal',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
