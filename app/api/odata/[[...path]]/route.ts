import { NextResponse } from 'next/server';
import { route, forbidden, notFound, badRequest } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { siteUrl } from '@/lib/server/mail/mailer';
import { DATASETS, datasetRows, type ColType, type Dataset } from '@/lib/server/bi/datasets';

// ─────────────────────────────────────────────────────────────────────────────
// An OData v4 feed of the BI tables, for Tableau (Connect → To a Server →
// OData), Excel and Power BI's OData connectors, and anything else that
// speaks OData.
//
//   /api/odata                  the service document: every table
//   /api/odata/$metadata        what each table's columns are, and their types
//   /api/odata/Invoices         a table's rows, a page at a time
//
// Signing in: Tableau asks for a username and password. The username can be
// anything; the password is an API key made under Settings → Developer, and
// the key's role decides which tables it may read. A Bearer header works too.
// ?from=yyyy-mm-dd&to=yyyy-mm-dd narrow a table to a period; the OneStream
// table also takes ?view=periodic.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 5000;
const EDM: Record<ColType, string> = { string: 'Edm.String', decimal: 'Edm.Decimal', date: 'Edm.Date', int: 'Edm.Int64', boolean: 'Edm.Boolean' };
const BY_SET = new Map(Object.entries(DATASETS).map(([key, def]) => [def.entitySet, key as Dataset]));
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function metadata(): string {
  const types = Object.values(DATASETS).map((def) =>
    `<EntityType Name="${def.entitySet}"><Key><PropertyRef Name="row_id"/></Key>` +
    '<Property Name="row_id" Type="Edm.Int64" Nullable="false"/>' +
    def.columns.map(([c, t]) => `<Property Name="${xml(c)}" Type="${EDM[t]}"${t === 'decimal' ? ' Scale="variable"' : ''}/>`).join('') +
    '</EntityType>').join('');
  const sets = Object.values(DATASETS).map((def) => `<EntitySet Name="${def.entitySet}" EntityType="Rekonza.${def.entitySet}"/>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>' +
    `<Schema Namespace="Rekonza" xmlns="http://docs.oasis-open.org/odata/ns/edm">${types}` +
    `<EntityContainer Name="Books">${sets}</EntityContainer></Schema>` +
    '</edmx:DataServices></edmx:Edmx>';
}

const json = (body: unknown) => NextResponse.json(body, { headers: { 'OData-Version': '4.0', 'Content-Type': 'application/json;odata.metadata=minimal;charset=utf-8' } });
const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

const read = route(async ({ orgId, role, params, req }) => {
  const segs = ((params as unknown as { path?: string[] }).path ?? []).map(decodeURIComponent);
  const base = `${siteUrl(req)}/api/odata`;
  if (!segs.length) {
    return json({
      '@odata.context': `${base}/$metadata`,
      value: Object.values(DATASETS).filter((def) => hasPermission(role, def.permission, 'view'))
        .map((def) => ({ name: def.entitySet, kind: 'EntitySet', url: def.entitySet, title: def.title })),
    });
  }
  if (segs[0] === '$metadata') {
    return new NextResponse(metadata(), { headers: { 'OData-Version': '4.0', 'Content-Type': 'application/xml;charset=utf-8' } });
  }
  const ds = BY_SET.get(segs[0].replace(/\(\)$/, ''));
  if (!ds || segs.length > 1) throw notFound(`There is no table called ${segs.join('/')}. The tables are: ${[...BY_SET.keys()].join(', ')}.`);
  const def = DATASETS[ds];
  if (!hasPermission(role, def.permission, 'view')) throw forbidden('This key or user cannot read that table.');

  const url = new URL(req.url);
  const p = url.searchParams;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const from = day(p.get('from')) ?? '1900-01-01';
  const to = day(p.get('to')) ?? today;
  const view = p.get('view') === 'periodic' ? 'periodic' : 'ytd';
  const top = p.has('$top') ? Number(p.get('$top')) : null;
  const skip = Number(p.get('$skip') ?? 0);
  if ((top !== null && (!Number.isInteger(top) || top < 0)) || !Number.isInteger(skip) || skip < 0) throw badRequest('$top and $skip take whole numbers.');
  const select = p.get('$select')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

  const all = (await datasetRows(orgId, ds, { from, to, view })).map((r, i) => ({ row_id: i + 1, ...r }));
  const take = Math.min(top ?? PAGE, PAGE);
  const page = all.slice(skip, skip + take).map((r) => (select ? Object.fromEntries(Object.entries(r).filter(([k]) => select.includes(k))) : r));
  const more = skip + take < all.length && (top === null || top > take);
  const next = new URLSearchParams(p);
  next.set('$skip', String(skip + take));
  if (top !== null) next.set('$top', String(top - take));
  return json({
    '@odata.context': `${base}/$metadata#${def.entitySet}`,
    ...(p.get('$count') === 'true' ? { '@odata.count': all.length } : {}),
    value: page,
    ...(more ? { '@odata.nextLink': `${base}/${def.entitySet}?${next.toString()}` } : {}),
  });
});

/** A sign-in refused asks for a username and password, as Tableau's and Excel's OData connectors expect. */
export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const res = await read(req, ctx as unknown as { params: Promise<Record<string, string>> });
  if (res.status === 401) res.headers.set('WWW-Authenticate', 'Basic realm="Rekonza OData", charset="UTF-8"');
  return res;
}
