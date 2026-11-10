import { z } from 'zod';
import { NextResponse } from 'next/server';
import { route, query, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { DATASETS, datasetRows, isDataset } from '@/lib/server/bi/datasets';
import { toDelimited } from '@/lib/delimited';

// Flat tables for Power BI, Excel Power Query, Google Sheets, a OneStream
// connector rule — and Tableau, which reads the same tables at /api/odata.
//
// Each dataset is one table of rows, amounts in rupees, dates as yyyy-mm-dd —
// the shape a BI tool reads without transforming. Read with an API key
// (Settings → Developer): in Power BI, Get data → Web → Advanced, this URL,
// and a header "Authorization: Bearer rk_live_…". ?format=csv returns CSV,
// ?format=txt tab-separated text. The key's role decides what it may read, as
// for every API call. The "onestream" table takes ?view=ytd (default) or
// ?view=periodic.

export const GET = route(async ({ orgId, role, params, req }) => {
  const ds = params.dataset;
  if (!isDataset(ds)) throw notFound(`There is no dataset called ${ds}. Try one of: ${Object.keys(DATASETS).join(', ')}.`);
  if (!hasPermission(role, DATASETS[ds].permission, 'view')) throw forbidden('This key or user cannot read that dataset.');
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const q = query(req, z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('1900-01-01'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today),
    format: z.enum(['json', 'csv', 'txt']).default('json'),
    view: z.enum(['ytd', 'periodic']).default('ytd'),
  }));
  const data = await datasetRows(orgId, ds, { from: q.from, to: q.to, view: q.view });
  if (q.format !== 'json') {
    const cols = DATASETS[ds].columns.map(([c]) => c);
    const body = toDelimited([cols, ...data.map((row) => cols.map((c) => row[c] as string | number | null))], q.format === 'csv' ? ',' : '\t');
    return new NextResponse(body, {
      headers: {
        'Content-Type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${ds}.${q.format}"`,
      },
    });
  }
  return data;
});
