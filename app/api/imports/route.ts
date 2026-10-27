import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { IMPORT_KINDS, MAX_IMPORT_ROWS, TEMPLATES, type ImportKind } from '@/lib/imports/templates';
import { clean, runImport, type ImportOutcome } from '@/lib/server/imports/run';
import { connectedCompanyMasters, importTally, importTallyVouchers, parseTallyMastersXml } from '@/lib/server/imports/tally';

// Imports. A check runs the whole import and throws it away; a real run keeps
// it only if every row went in. Either way the answer is the same shape: what
// would be (or was) created, what was skipped, and every row that failed.

/** What each import touches, and so who may run it. */
const MODULE: Record<ImportKind, string> = {
  contacts: 'sales', items: 'inventory', accounts: 'accountant', 'opening-ledger': 'accountant',
  'opening-bills': 'accountant', journals: 'accountant', invoices: 'sales', bills: 'purchases',
};

const Input = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('rows'),
    kind: z.enum(IMPORT_KINDS as [ImportKind, ...ImportKind[]]),
    rows: z.array(z.record(z.string(), z.unknown())).max(MAX_IMPORT_ROWS, `Up to ${MAX_IMPORT_ROWS} rows at a time.`),
    dryRun: z.boolean().default(true),
    onDuplicate: z.enum(['skip', 'error']).default('skip'),
  }),
  z.object({
    source: z.literal('tally-xml'),
    xml: z.string().min(1).max(50 * 1024 * 1024),
    dryRun: z.boolean().default(true),
  }),
  z.object({
    source: z.literal('tally-company'),
    companyId: z.union([z.string(), z.number()]),
    dryRun: z.boolean().default(true),
  }),
  // The company's vouchers, after its masters: posted as journal entries.
  z.object({
    source: z.literal('tally-vouchers'),
    companyId: z.union([z.string(), z.number()]),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    dryRun: z.boolean().default(true),
  }),
]);

class Discard extends Error {
  constructor(readonly outcomes: ImportOutcome[]) { super('discard'); }
}

export const POST = route(async ({ orgId, user, role, branchId, req }) => {
  const input = await body(req, Input);
  const ctx = { orgId, userId: user.userId, branchId, onDuplicate: input.source === 'rows' ? input.onDuplicate : 'skip' as const };

  if (input.source === 'rows') {
    if (!hasPermission(role, MODULE[input.kind], 'create')) throw forbidden(`Your role cannot import ${TEMPLATES[input.kind].title.toLowerCase()}.`);
    if (!input.rows.length) throw badRequest('The file has no rows under its headings.');
  } else if (!hasPermission(role, 'accountant', 'create') || !hasPermission(role, 'sales', 'create')) {
    throw forbidden('Bringing a company across from Tally needs an accountant or an admin.');
  }

  let outcomes: ImportOutcome[];
  try {
    outcomes = await db.transaction().execute(async (trx) => {
      let out: ImportOutcome[];
      if (input.source === 'rows') {
        out = [await runImport(trx, ctx, input.kind, input.rows)];
      } else if (input.source === 'tally-vouchers') {
        out = [await importTallyVouchers(trx, ctx, Number(input.companyId), { from: input.from, to: input.to })];
      } else {
        const masters = input.source === 'tally-xml'
          ? parseTallyMastersXml(input.xml)
          : await connectedCompanyMasters(trx, orgId, Number(input.companyId));
        if (!masters.ledgers.length && !masters.stockItems.length) {
          throw badRequest('No ledgers or stock items were found. In TallyPrime use Export → Masters, format XML.');
        }
        out = await importTally(trx, ctx, masters);
      }
      if (input.dryRun || !clean(out)) throw new Discard(out);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'import',
        targetType: input.source === 'rows' ? input.kind : 'tally',
        detail: out.map((o) => `${o.kind}: ${o.created} created, ${o.skipped} skipped`).join('; '),
        ...auditMeta(req),
      });
      return out;
    });
  } catch (err) {
    if (!(err instanceof Discard)) throw err;
    outcomes = err.outcomes;
  }
  return { committed: !input.dryRun && clean(outcomes), outcomes };
});
