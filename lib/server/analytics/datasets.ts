import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Datasets: storing what people bring, and handing it back.
//
// Rows are stored as they were confirmed on the review screen, already typed.
// Nothing re-parses them on the way out, so a chart built today and the same
// chart opened next month read identical numbers. A type cannot be changed
// after import for the same reason — the original text is gone, and guessing it
// back would be the one way to make stored numbers drift. Labels and roles can
// change freely; they are presentation.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import { badRequest, conflict, notFound } from '../http';
import { ColumnSchemaSchema, MAX_DATASET_BYTES, checkRows } from '../../analytics/schema';
import type { Cell, ColumnSchema, DatasetData } from '../../analytics/types';
import { salesSnapshot } from './books';

export type DatasetSource = 'upload' | 'paste' | 'books' | 'sample';

export interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  source: DatasetSource;
  sourceName: string | null;
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  refreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  reportCount: number;
}

const iso = (d: Date | string | null) => (d ? (d instanceof Date ? d : new Date(d)).toISOString() : null);

export async function listDatasets(ex: Executor, orgId: number): Promise<DatasetSummary[]> {
  const rows = await ex
    .selectFrom('analytics_datasets as d')
    .leftJoin('users as u', 'u.id', 'd.created_by_user_id')
    .select([
      'd.id', 'd.name', 'd.description', 'd.source', 'd.source_name', 'd.row_count', 'd.column_count',
      'd.size_bytes', 'd.refreshed_at', 'd.created_at', 'd.updated_at', 'u.name as created_by',
    ])
    .select((eb) =>
      eb.selectFrom('analytics_reports as r').whereRef('r.dataset_id', '=', 'd.id').select(eb.fn.countAll<number>().as('n')).as('report_count'),
    )
    .where('d.org_id', '=', orgId)
    .orderBy('d.updated_at', 'desc')
    .execute();

  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    description: r.description,
    source: r.source,
    sourceName: r.source_name,
    rowCount: r.row_count,
    columnCount: r.column_count,
    sizeBytes: r.size_bytes,
    refreshedAt: iso(r.refreshed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    createdBy: r.created_by,
    reportCount: Number(r.report_count ?? 0),
  }));
}

export async function getDataset(
  ex: Executor,
  orgId: number,
  id: number,
): Promise<DatasetSummary & DatasetData> {
  const row = await ex
    .selectFrom('analytics_datasets as d')
    .leftJoin('users as u', 'u.id', 'd.created_by_user_id')
    .select([
      'd.id', 'd.name', 'd.description', 'd.source', 'd.source_name', 'd.row_count', 'd.column_count',
      'd.size_bytes', 'd.refreshed_at', 'd.created_at', 'd.updated_at', 'd.columns_json', 'd.data_json',
      'u.name as created_by',
    ])
    .where('d.id', '=', id)
    .where('d.org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound('That dataset does not exist.');

  const reports = await ex
    .selectFrom('analytics_reports')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('dataset_id', '=', id)
    .executeTakeFirst();

  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    source: row.source,
    sourceName: row.source_name,
    rowCount: row.row_count,
    columnCount: row.column_count,
    sizeBytes: row.size_bytes,
    refreshedAt: iso(row.refreshed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    createdBy: row.created_by,
    reportCount: Number(reports?.n ?? 0),
    columns: (typeof row.columns_json === 'string' ? JSON.parse(row.columns_json) : row.columns_json) as unknown as ColumnSchema[],
    rows: JSON.parse(row.data_json) as Cell[][],
  };
}

export interface NewDataset {
  name: string;
  description?: string | null;
  source: DatasetSource;
  sourceName?: string | null;
  columns: unknown;
  rows: unknown;
}

/** Validate and store. Everything a browser sent is checked, not trusted. */
export async function createDataset(ex: Executor, orgId: number, userId: number, input: NewDataset): Promise<number> {
  const parsed = ColumnSchemaSchema.array().min(1).max(60).safeParse(input.columns);
  if (!parsed.success) throw badRequest('The column list is not valid.', parsed.error.issues.slice(0, 3));
  const columns = parsed.data as ColumnSchema[];

  // Keys and positions must be internally consistent, or every spec that
  // refers to a column by key would read the wrong one.
  const keys = new Set(columns.map((c) => c.key));
  if (keys.size !== columns.length) throw badRequest('Two columns share a key.');
  columns.forEach((c, i) => {
    if (c.index !== i) throw badRequest(`Column "${c.label}" is out of position.`);
  });

  const problem = checkRows(columns, input.rows);
  if (problem) throw badRequest(problem);
  const rows = input.rows as Cell[][];
  if (!rows.length) throw badRequest('There are no rows to store.');

  const data = JSON.stringify(rows);
  const size = Buffer.byteLength(data, 'utf8');
  if (size > MAX_DATASET_BYTES) {
    throw badRequest(
      `This dataset is ${(size / 1024 / 1024).toFixed(1)} MB and the limit is ${MAX_DATASET_BYTES / 1024 / 1024} MB. ` +
        'Remove columns you do not need, or split it by year.',
    );
  }

  const res = await ex
    .insertInto('analytics_datasets')
    .values({
      org_id: orgId,
      name: input.name.trim().slice(0, 150),
      description: input.description?.trim().slice(0, 500) || null,
      source: input.source,
      source_name: input.sourceName?.slice(0, 255) ?? null,
      row_count: rows.length,
      column_count: columns.length,
      columns_json: JSON.stringify(columns),
      data_json: data,
      size_bytes: size,
      refreshed_at: input.source === 'books' ? new Date() : null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
}

export async function updateDataset(
  ex: Executor,
  orgId: number,
  id: number,
  patch: { name?: string; description?: string | null; columns?: { key: string; label?: string; role?: 'dimension' | 'measure' }[] },
): Promise<void> {
  const current = await ex
    .selectFrom('analytics_datasets')
    .select(['columns_json'])
    .where('id', '=', id)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!current) throw notFound('That dataset does not exist.');

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 150);
  if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 500) || null;

  if (patch.columns) {
    const cols = (typeof current.columns_json === 'string'
      ? JSON.parse(current.columns_json)
      : current.columns_json) as unknown as ColumnSchema[];
    for (const p of patch.columns) {
      const c = cols.find((x) => x.key === p.key);
      if (!c) throw badRequest(`There is no column ${p.key}.`);
      if (p.label !== undefined) {
        const label = p.label.trim();
        if (!label) throw badRequest('A column needs a name.');
        c.label = label.slice(0, 80);
      }
      if (p.role) {
        // A text column cannot be summed; letting it be a "measure" would give
        // every chart a column of nulls and no explanation.
        if (p.role === 'measure' && !['number', 'currency', 'percent'].includes(c.type)) {
          throw badRequest(`"${c.label}" holds ${c.type === 'date' ? 'dates' : 'text'}, so it can be counted but not added up.`);
        }
        c.role = p.role;
      }
    }
    set.columns_json = JSON.stringify(cols);
  }

  if (Object.keys(set).length) {
    await ex.updateTable('analytics_datasets').set(set).where('id', '=', id).where('org_id', '=', orgId).execute();
  }
}

/**
 * Take a fresh snapshot of a books dataset.
 *
 * Column keys come from the extract's fixed column order, so they are the same
 * on every refresh and every report keeps working. Names and roles the user
 * changed are carried across.
 */
export async function refreshDataset(ex: Executor, orgId: number, id: number): Promise<void> {
  const current = await ex
    .selectFrom('analytics_datasets')
    .select(['source', 'columns_json'])
    .where('id', '=', id)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!current) throw notFound('That dataset does not exist.');
  if (current.source !== 'books') {
    throw badRequest('Only a snapshot of the books can be refreshed. For a file, import the new version.');
  }

  const fresh = await salesSnapshot(ex, orgId);
  const old = (typeof current.columns_json === 'string'
    ? JSON.parse(current.columns_json)
    : current.columns_json) as unknown as ColumnSchema[];
  for (const c of fresh.columns) {
    const prior = old.find((o) => o.key === c.key);
    if (prior) {
      c.label = prior.label;
      c.role = prior.role;
    }
  }
  const data = JSON.stringify(fresh.rows);
  await ex
    .updateTable('analytics_datasets')
    .set({
      columns_json: JSON.stringify(fresh.columns),
      data_json: data,
      row_count: fresh.rows.length,
      column_count: fresh.columns.length,
      size_bytes: Buffer.byteLength(data, 'utf8'),
      refreshed_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
}

/** Refused while reports use it — naming them — rather than taking them with it. */
export async function deleteDataset(ex: Executor, orgId: number, id: number): Promise<void> {
  const users = await ex
    .selectFrom('analytics_reports')
    .select(['name'])
    .where('dataset_id', '=', id)
    .where('org_id', '=', orgId)
    .limit(4)
    .execute();
  if (users.length) {
    const names = users.slice(0, 3).map((r) => `"${r.name}"`).join(', ');
    throw conflict(
      `This dataset feeds ${users.length > 3 ? 'several reports, including ' : ''}${names}. Delete ` +
        `${users.length === 1 ? 'that report' : 'those reports'} first.`,
    );
  }
  const res = await ex
    .deleteFrom('analytics_datasets')
    .where('id', '=', id)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!res.numDeletedRows) throw notFound('That dataset does not exist.');
}
