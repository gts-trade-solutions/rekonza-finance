import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, asId, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createDataset, listDatasets, type DatasetSource } from '@/lib/server/analytics/datasets';
import { createReport } from '@/lib/server/analytics/reports';
import { salesSnapshot } from '@/lib/server/analytics/books';
import { MAX_DATASET_BYTES } from '@/lib/analytics/schema';
import { sampleDataset } from '@/lib/analytics/sample';

// ─────────────────────────────────────────────────────────────────────────────
// Datasets: the list, and bringing a new one in.
//
// Three ways in. An upload or a paste arrives already parsed — the browser
// reads the spreadsheet and the person confirms every column on the review
// screen before anything is sent. A snapshot of the books and the sample data
// are built here on the server, from sources the server already trusts, so the
// browser never has to send rows it did not write.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async ({ orgId }) => ({ datasets: await listDatasets(db, orgId) }),
  { permission: { module: 'analytics', action: 'view' } },
);

const Uploaded = z.object({
  source: z.enum(['upload', 'paste']),
  name: z.string().trim().min(1, 'Give the dataset a name.').max(150),
  description: z.string().trim().max(500).nullish(),
  sourceName: z.string().trim().max(255).nullish(),
  columns: z.unknown(),
  rows: z.unknown(),
  createReport: z.boolean().optional(),
});

const Built = z.object({
  source: z.enum(['books', 'sample']),
  name: z.string().trim().max(150).optional(),
  createReport: z.boolean().optional(),
});

const Input = z.union([Uploaded, Built]);

/**
 * The body is read as text and measured before it is parsed. A multi-megabyte
 * paste is refused with a sentence, instead of being parsed in full only to be
 * refused afterwards.
 */
async function readCapped(req: Request): Promise<unknown> {
  const limit = MAX_DATASET_BYTES + 256 * 1024; // the rows, plus the column list and name
  const declared = Number(req.headers.get('content-length') ?? 0);
  const tooBig = () =>
    badRequest(
      `That data is larger than ${MAX_DATASET_BYTES / 1024 / 1024} MB. Remove columns you do not need, or split it by year.`,
    );
  if (declared > limit) throw tooBig();
  const text = await req.text();
  if (text.length > limit) throw tooBig();
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('The request body was not valid JSON.');
  }
}

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = Input.parse(await readCapped(req));

    let payload: { name: string; description?: string | null; source: DatasetSource; sourceName?: string | null; columns: unknown; rows: unknown };
    if (input.source === 'books') {
      const snap = await salesSnapshot(db, orgId);
      if (!snap.rows.length) {
        throw badRequest('There are no issued sales invoices yet, so there is nothing to take a snapshot of.');
      }
      payload = { ...snap, name: input.name || snap.name, source: 'books', sourceName: snap.name };
    } else if (input.source === 'sample') {
      const s = sampleDataset();
      payload = { ...s, name: input.name || s.name, source: 'sample', sourceName: 'Sample data' };
    } else {
      // Only an upload or a paste reaches here; the two checks above took the rest.
      payload = input as z.infer<typeof Uploaded>;
    }

    const result = await transaction(async (trx) => {
      const id = await createDataset(trx, orgId, user.userId, payload);
      // The starter report is created in the same transaction: a dataset that
      // saved but whose first report failed would drop the user onto nothing.
      const reportId = input.createReport
        ? await createReport(trx, orgId, user.userId, {
            datasetId: id,
            name: `${payload.name} — overview`,
            starter: true,
          })
        : null;
      return { id, reportId };
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'analytics_dataset', targetId: result.id, targetLabel: payload.name,
      detail: `Created dataset from ${payload.source}${payload.sourceName ? ` (${payload.sourceName})` : ''}`,
      ...auditMeta(req),
    });

    return { id: asId(result.id), reportId: result.reportId ? asId(result.reportId) : null };
  },
  { permission: { module: 'analytics', action: 'create' } },
);
