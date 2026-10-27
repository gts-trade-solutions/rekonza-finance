// Plays the recorded demo book on a deployment with no database
// (lib/demo-snapshot.ts). Anywhere else it steps aside.

import { NextResponse, type NextRequest } from 'next/server';
import manifest from './public/demo-snapshot/manifest.json';
import { DEMO_READ_ONLY, pickRecording, snapshotMode, snapshotQuery, SNAPSHOT_DIR, type SnapshotManifest } from './lib/demo-snapshot';

const recording = manifest as unknown as SnapshotManifest;

export function middleware(req: NextRequest) {
  if (!snapshotMode()) return NextResponse.next();
  const { pathname, searchParams } = req.nextUrl;

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = pickRecording(recording.routes[pathname], snapshotQuery(searchParams));
    if (file) return NextResponse.rewrite(new URL(`/${SNAPSHOT_DIR}/${file}`, req.url));
    return NextResponse.json({ error: 'This part is not in the online demo.', code: 'not_in_demo' }, { status: 404 });
  }

  // The demo door and signing out have nothing to save, so they simply work.
  if (pathname === '/api/auth/demo' || pathname === '/api/auth/logout') return NextResponse.json({ ok: true });
  if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
    return NextResponse.json(
      { error: 'The online demo has no accounts of its own. Open the demo book instead.', code: 'demo_read_only' },
      { status: 403 },
    );
  }
  return NextResponse.json({ error: DEMO_READ_ONLY, code: 'demo_read_only' }, { status: 403 });
}

export const config = { matcher: '/api/:path*' };
