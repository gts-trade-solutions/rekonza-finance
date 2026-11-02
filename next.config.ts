import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // A stray lockfile in the parent folder makes Next guess the wrong workspace
  // root, so pin it to this project.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // `next dev` keeps a lock on .next, so a production build run at the same time
  // fails with EPERM. Set NEXT_BUILD_DIR to build into a separate folder.
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  // The go-live check counts the migrations against the database, so they ship with it.
  outputFileTracingIncludes: {
    '/api/settings/golive': ['./db/migrations/*.sql'],
  },
  // Security headers on every response. Pages may be framed only by this site
  // (no clickjacking an approval); nothing is sniffed into another type; the
  // browser keeps to https; and a portal or share link, whose address is its
  // key, is never sent on to another site as a referrer. The API's own file
  // responses set their stricter policy themselves, so the page rules skip /api.
  async headers() {
    const everywhere = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ];
    const pages = [
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      { key: 'Permissions-Policy', value: 'geolocation=(), microphone=()' },
    ];
    const tokenInAddress = [{ key: 'Referrer-Policy', value: 'no-referrer' }];
    return [
      { source: '/:path*', headers: everywhere },
      { source: '/((?!api/).*)', headers: pages },
      { source: '/portal/:path*', headers: tokenInAddress },
      { source: '/share/:path*', headers: tokenInAddress },
      { source: '/api/portal/:path*', headers: tokenInAddress },
      { source: '/api/share/:path*', headers: tokenInAddress },
    ];
  },
};

export default nextConfig;
