import { NextResponse } from 'next/server';
import { db } from '@/lib/server/db';
import { route, idParam, notFound } from '@/lib/server/http';
import { openPortal, portalFile } from '@/lib/server/services/portal';
import { readAttachment } from '@/lib/server/files/attachments';

// A file on the portal: one the business shared with the contact, or one the
// contact sent in. Nothing else on the contact's record is reachable here.

const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

export const GET = route(
  async ({ params, req }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p) throw notFound('This link has expired or been withdrawn.');
    const id = idParam(params);
    if (!(await portalFile(db, p.orgId, p.contactId, id))) throw notFound('That file was not found.');
    const { row, bytes } = await readAttachment(db, p.orgId, id);
    const download = new URL(req.url).searchParams.has('download') || !INLINE.has(row.content_type);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': row.content_type,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=300',
        'Referrer-Policy': 'no-referrer',
      },
    });
  },
  { public: true },
);
