// Plays the recorded demo book on a deployment with no database
// (lib/demo-snapshot.ts). Anywhere else it steps aside.

import { NextResponse, type NextRequest } from 'next/server';
import manifest from './public/demo-snapshot/manifest.json';
import { DEMO_READ_ONLY, pickRecording, snapshotMode, snapshotQuery, SNAPSHOT_DIR, type SnapshotManifest } from './lib/demo-snapshot';

const recording = manifest as unknown as SnapshotManifest;

export async function middleware(req: NextRequest) {
  if (!snapshotMode()) return NextResponse.next();
  const { pathname, searchParams } = req.nextUrl;

  // The assistant answers on the demo too, from its own recording of the
  // demo book (lib/server/ai/demo-chat.ts): asking, and reopening an answer.
  if (req.method === 'POST' && pathname === '/api/ai/chat') return NextResponse.next();
  if (req.method === 'GET' && /^\/api\/ai\/conversations\/demo-[\w-]+$/.test(pathname)) return NextResponse.next();
  if (pathname === '/api/ai/reports/download' && (req.method === 'GET' || req.method === 'POST')) return NextResponse.next();

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = pickRecording(recording.routes[pathname], snapshotQuery(searchParams));
    if (file) {
      // What the assistant runs on is this deployment's, not the recording's:
      // a key set here means real answers, and the screens should say so.
      if (pathname === '/api/ai/status' || pathname === '/api/ai/wallet') {
        const recorded = await fetch(new URL(`/${SNAPSHOT_DIR}/${file}`, req.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (recorded) {
          const key = !!process.env.OPENAI_API_KEY?.trim();
          recorded.mode = key ? 'openai' : 'standin';
          // DEFAULT_MODEL in lib/server/ai/config.ts.
          if (pathname === '/api/ai/status') recorded.model = key ? process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini' : 'stand-in';
          return NextResponse.json(recorded);
        }
      }
      return NextResponse.rewrite(new URL(`/${SNAPSHOT_DIR}/${file}`, req.url));
    }
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
