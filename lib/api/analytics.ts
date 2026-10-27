'use client';

// The browser's side of the Analytics API.

import { api } from './client';
import type { Cell, ColumnSchema, Filter, ReportLayout } from '../analytics/types';

export type DatasetSource = 'upload' | 'paste' | 'books' | 'sample';

export const SOURCE_LABELS: Record<DatasetSource, string> = {
  upload: 'Uploaded file',
  paste: 'Pasted',
  books: 'From your books',
  sample: 'Sample data',
};

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

export interface DatasetFull extends DatasetSummary {
  columns: ColumnSchema[];
  rows: Cell[][];
}

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

export const analytics = {
  datasets: () => api.get<{ datasets: DatasetSummary[] }>('/api/analytics/datasets'),
  dataset: (id: string) => api.get<DatasetFull>(`/api/analytics/datasets/${id}`),
  createDataset: (input:
    | { source: 'upload' | 'paste'; name: string; description?: string | null; sourceName?: string | null; columns: ColumnSchema[]; rows: Cell[][]; createReport?: boolean }
    | { source: 'books' | 'sample'; name?: string; createReport?: boolean }) =>
    api.post<{ id: string; reportId: string | null }>('/api/analytics/datasets', input),
  updateDataset: (id: string, patch: { name?: string; description?: string | null; columns?: { key: string; label?: string; role?: 'dimension' | 'measure' }[] }) =>
    api.patch<DatasetSummary>(`/api/analytics/datasets/${id}`, patch),
  refreshDataset: (id: string) => api.patch<DatasetSummary>(`/api/analytics/datasets/${id}`, { action: 'refresh' }),
  deleteDataset: (id: string) => api.delete<{ ok: true }>(`/api/analytics/datasets/${id}`),

  reports: () => api.get<{ reports: ReportSummary[] }>('/api/analytics/reports'),
  report: (id: string) => api.get<ReportDetail>(`/api/analytics/reports/${id}`),
  createReport: (input: { datasetId: string; name: string; description?: string | null; starter?: boolean; visibility?: Visibility }) =>
    api.post<{ id: string }>('/api/analytics/reports', input),
  copyReport: (id: string) => api.post<{ id: string }>('/api/analytics/reports', { copyOf: id }),
  updateReport: (id: string, patch: { name?: string; description?: string | null; visibility?: Visibility; layout?: ReportLayout; filters?: Filter[] }) =>
    api.patch<ReportDetail>(`/api/analytics/reports/${id}`, patch),
  deleteReport: (id: string) => api.delete<{ ok: true }>(`/api/analytics/reports/${id}`),
};
