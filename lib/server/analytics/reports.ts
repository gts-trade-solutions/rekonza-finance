import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reports: saved layouts of charts over one dataset.
//
// Who sees what is simple and strict:
//   · a private report is its author's alone — to anyone else it does not
//     exist, which is why it answers "not found" rather than "forbidden";
//   · a shared report is visible to everyone who can open Analytics;
//   · only the author, or an admin, can change or delete one. Anyone else who
//     wants it different saves a copy — a board pack must not change under the
//     person presenting it because a colleague was tidying.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleName } from '../../types';
import type { Executor } from '../db';
import { forbidden, notFound } from '../http';
import { LayoutSchema, ReportFiltersSchema } from '../../analytics/schema';
import { starterTiles } from '../../analytics/starter';
import type { Filter, ReportLayout } from '../../analytics/types';
import { getDataset } from './datasets';

export type Visibility = 'private' | 'org';

export interface ReportSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  datasetId: string;
  datasetName: string;
  tileCount: number;
  createdBy: string | null;
  isOwner: boolean;
  updatedAt: string;
}

export interface ReportDetail extends ReportSummary {
  layout: ReportLayout;
  filters: Filter[];
  canEdit: boolean;
}

const parseJson = <T>(v: unknown, fallback: T): T =>
  v === null || v === undefined ? fallback : ((typeof v === 'string' ? JSON.parse(v) : v) as T);

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

export async function listReports(ex: Executor, orgId: number, userId: number): Promise<ReportSummary[]> {
  const rows = await ex
    .selectFrom('analytics_reports as r')
    .innerJoin('analytics_datasets as d', 'd.id', 'r.dataset_id')
    .leftJoin('users as u', 'u.id', 'r.created_by_user_id')
    .select([
      'r.id', 'r.name', 'r.description', 'r.visibility', 'r.dataset_id', 'r.layout_json', 'r.updated_at',
      'r.created_by_user_id', 'd.name as dataset_name', 'u.name as created_by',
    ])
    .where('r.org_id', '=', orgId)
    .where((eb) => eb.or([eb('r.visibility', '=', 'org'), eb('r.created_by_user_id', '=', userId)]))
    .orderBy('r.updated_at', 'desc')
    .execute();

  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    datasetId: String(r.dataset_id),
    datasetName: r.dataset_name,
    tileCount: parseJson<ReportLayout>(r.layout_json, { tiles: [] }).tiles.length,
    createdBy: r.created_by,
    isOwner: r.created_by_user_id === userId,
    updatedAt: iso(r.updated_at),
  }));
}

async function load(ex: Executor, orgId: number, id: number) {
  return ex
    .selectFrom('analytics_reports as r')
    .innerJoin('analytics_datasets as d', 'd.id', 'r.dataset_id')
    .leftJoin('users as u', 'u.id', 'r.created_by_user_id')
    .select([
      'r.id', 'r.name', 'r.description', 'r.visibility', 'r.dataset_id', 'r.layout_json', 'r.filters_json',
      'r.updated_at', 'r.created_by_user_id', 'd.name as dataset_name', 'u.name as created_by',
    ])
    .where('r.id', '=', id)
    .where('r.org_id', '=', orgId)
    .executeTakeFirst();
}

export async function getReport(
  ex: Executor,
  orgId: number,
  userId: number,
  role: RoleName,
  id: number,
): Promise<ReportDetail> {
  const r = await load(ex, orgId, id);
  const isOwner = r?.created_by_user_id === userId;
  if (!r || (r.visibility === 'private' && !isOwner)) throw notFound('That report does not exist.');
  const layout = parseJson<ReportLayout>(r.layout_json, { tiles: [] });
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    datasetId: String(r.dataset_id),
    datasetName: r.dataset_name,
    tileCount: layout.tiles.length,
    createdBy: r.created_by,
    isOwner,
    updatedAt: iso(r.updated_at),
    layout,
    filters: parseJson<Filter[]>(r.filters_json, []),
    canEdit: isOwner || role === 'admin',
  };
}

export async function createReport(
  ex: Executor,
  orgId: number,
  userId: number,
  input: { datasetId: number; name: string; description?: string | null; starter?: boolean; visibility?: Visibility },
): Promise<number> {
  // Loading the dataset proves it exists in this organisation, and gives the
  // starter layout its columns to work from.
  const dataset = await getDataset(ex, orgId, input.datasetId);
  const layout: ReportLayout = { tiles: input.starter === false ? [] : starterTiles(dataset) };

  const res = await ex
    .insertInto('analytics_reports')
    .values({
      org_id: orgId,
      dataset_id: input.datasetId,
      name: input.name.trim().slice(0, 150),
      description: input.description?.trim().slice(0, 500) || null,
      visibility: input.visibility ?? 'private',
      layout_json: JSON.stringify(layout),
      filters_json: JSON.stringify([]),
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
}

async function assertEditable(ex: Executor, orgId: number, userId: number, role: RoleName, id: number) {
  const r = await load(ex, orgId, id);
  const isOwner = r?.created_by_user_id === userId;
  if (!r || (r.visibility === 'private' && !isOwner)) throw notFound('That report does not exist.');
  if (!isOwner && role !== 'admin') {
    throw forbidden(
      `Only ${r.created_by ?? 'its author'} or an admin can change this report. Save a copy to make your own version.`,
    );
  }
  return r;
}

export async function updateReport(
  ex: Executor,
  orgId: number,
  userId: number,
  role: RoleName,
  id: number,
  patch: { name?: string; description?: string | null; visibility?: Visibility; layout?: unknown; filters?: unknown },
): Promise<void> {
  await assertEditable(ex, orgId, userId, role, id);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 150);
  if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 500) || null;
  if (patch.visibility) set.visibility = patch.visibility;
  if (patch.layout !== undefined) set.layout_json = JSON.stringify(LayoutSchema.parse(patch.layout));
  if (patch.filters !== undefined) set.filters_json = JSON.stringify(ReportFiltersSchema.parse(patch.filters));
  if (Object.keys(set).length) {
    await ex.updateTable('analytics_reports').set(set).where('id', '=', id).where('org_id', '=', orgId).execute();
  }
}

export async function deleteReport(ex: Executor, orgId: number, userId: number, role: RoleName, id: number): Promise<string> {
  const r = await assertEditable(ex, orgId, userId, role, id);
  await ex.deleteFrom('analytics_reports').where('id', '=', id).where('org_id', '=', orgId).execute();
  return r.name;
}

/** Anyone who can see a report can take a copy of it, which is theirs and private. */
export async function copyReport(
  ex: Executor,
  orgId: number,
  userId: number,
  role: RoleName,
  id: number,
): Promise<number> {
  const src = await getReport(ex, orgId, userId, role, id);
  const res = await ex
    .insertInto('analytics_reports')
    .values({
      org_id: orgId,
      dataset_id: Number(src.datasetId),
      name: `${src.name} (copy)`.slice(0, 150),
      description: src.description,
      visibility: 'private',
      layout_json: JSON.stringify(src.layout),
      filters_json: JSON.stringify(src.filters),
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
}
