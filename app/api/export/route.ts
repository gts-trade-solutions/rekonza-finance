import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { EXPORT_MODULES, exportModule } from '@/lib/server/services/data-export';

// Export data (services/data-export.ts): one module as rows, which the screen
// saves as CSV, Excel or JSON; or, for someone who may change settings, the
// whole book as one JSON backup. Each module needs its own view right, so a
// sales user's backup holds only what a sales user may see. Taking the copy
// is recorded by the screen's output guard (lib/output-guard.ts), as every
// download is; a read writes nothing here.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Q = z.object({
  module: z.string().max(40).optional(),
  from: DATE.optional(),
  to: DATE.optional(),
});

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, Q);
  const allowed = EXPORT_MODULES.filter((m) => hasPermission(role, m.permission, 'view'));

  if (!q.module) {
    return { modules: allowed.map((m) => ({ key: m.key, label: m.label, dated: m.dated, importKind: m.importKind ?? null })) };
  }

  if (q.module === 'all') {
    if (!hasPermission(role, 'settings', 'view')) throw forbidden('A full backup needs access to Settings.');
    const everything = { from: '1900-01-01', to: '2999-12-31' };
    const org = await db.selectFrom('organizations').select(['name', 'legal_name']).where('id', '=', orgId).executeTakeFirst();
    const modules: Record<string, unknown[]> = {};
    for (const m of allowed) modules[m.key] = await m.rows(db, orgId, everything);
    return {
      format: 'rekonza-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      organization: org?.legal_name ?? org?.name ?? null,
      modules,
    };
  }

  const m = exportModule(q.module);
  if (!m) throw badRequest('There is no such module to export.');
  if (!hasPermission(role, m.permission, 'view')) throw forbidden(`Your role cannot export ${m.label.toLowerCase()}.`);
  const range = m.dated ? { from: q.from ?? '1900-01-01', to: q.to ?? '2999-12-31' } : { from: '1900-01-01', to: '2999-12-31' };
  const rows = await m.rows(db, orgId, range);
  return {
    format: 'rekonza-export',
    module: m.key,
    label: m.label,
    importKind: m.importKind ?? null,
    exportedAt: new Date().toISOString(),
    ...(m.dated ? { from: range.from, to: range.to } : {}),
    rows,
  };
});
