import { NextResponse } from 'next/server';
import { ApiError, badRequest, route } from '@/lib/server/http';
import { auditMeta, logAudit } from '@/lib/server/audit';
import { captureInvoice, captureSampleOffline } from '@/lib/server/ai/invoice-capture';
import { snapshotMode } from '@/lib/demo-snapshot';

// Read one invoice from a PDF or a photo, for the PDF import to list and check.
// Nothing is saved here: the checked list goes in through POST /api/imports.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fileOf(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('Send the invoice as a file.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('Send the invoice as a file.');
  return { bytes: Buffer.from(await file.arrayBuffer()), contentType: file.type, filename: file.name };
}

const read = route(
  async ({ orgId, user, req }) => {
    const file = await fileOf(req);
    const r = await captureInvoice(orgId, user.userId, file);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'import', targetType: 'invoice_capture',
      detail: `Read ${file.filename}: ${r.direction === 'sale' ? 'our invoice to' : 'a bill from'} ${r.party.name ?? 'an unnamed company'}, ${r.number ?? 'no number'}, ${r.lines.length} line(s)`,
      ...auditMeta(req),
    });
    return r;
  },
  { permission: { module: 'sales', action: 'create' } },
);

export async function POST(req: Request, ctx: { params: Promise<Record<string, string>> }) {
  // The online demo has no database and no AI: the sample PDFs alone, read from their own contents.
  if (snapshotMode()) {
    try {
      return NextResponse.json(captureSampleOffline(await fileOf(req)));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(400, 'That file could not be read.');
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
  }
  return read(req, ctx);
}
