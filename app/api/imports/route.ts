import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { IMPORT_KINDS, MAX_IMPORT_ROWS, TEMPLATES, type ImportKind } from '@/lib/imports/templates';
import { clean, runImport, type ImportOutcome } from '@/lib/server/imports/run';
import { connectedCompanyMasters, importTally, importTallyFileVouchers, importTallyVouchers, QUICKBOOKS_COMPANY_ID } from '@/lib/server/imports/tally';
import { parseQuickBooks, toImportShapes } from '@/lib/quickbooks/parse';
import { parseTallyFiles } from '@/lib/tally/xml';

// Imports. A check runs the whole import and throws it away; a real run keeps
// it only if every row went in. Either way the answer is the same shape: what
// would be (or was) created, what was skipped, and every row that failed.

/** What each import touches, and so who may run it. */
const MODULE: Record<ImportKind, string> = {
  contacts: 'sales', items: 'inventory', accounts: 'accountant', 'opening-ledger': 'accountant',
  'opening-bills': 'accountant', journals: 'accountant', invoices: 'sales', bills: 'purchases',
  estimates: 'sales', 'sales-orders': 'sales', 'credit-notes': 'sales', 'payments-received': 'sales',
  'purchase-orders': 'purchases', expenses: 'purchases', 'payments-made': 'purchases',
};

const Input = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('rows'),
    kind: z.enum(IMPORT_KINDS as [ImportKind, ...ImportKind[]]),
    rows: z.array(z.record(z.string(), z.unknown())).max(MAX_IMPORT_ROWS, `Up to ${MAX_IMPORT_ROWS} rows at a time.`),
    dryRun: z.boolean().default(true),
    onDuplicate: z.enum(['skip', 'error']).default('skip'),
  }),
  // Files exported from Tally: masters, vouchers, or both, one file or several.
  z.object({
    source: z.literal('tally-xml'),
    xml: z.string().min(1).max(50 * 1024 * 1024).optional(),
    files: z.array(z.string().min(1).max(50 * 1024 * 1024)).max(12, 'Up to 12 files at a time.').optional(),
    dryRun: z.boolean().default(true),
  }),
  z.object({
    source: z.literal('tally-company'),
    companyId: z.union([z.string(), z.number()]),
    dryRun: z.boolean().default(true),
  }),
  // QuickBooks: Desktop's IIF files and Online's lists and Journal report, each read by the browser into rows.
  z.object({
    source: z.literal('quickbooks'),
    files: z.array(z.object({
      name: z.string().max(255),
      rows: z.array(z.array(z.string().max(4000)).max(300)).max(200_000, 'Up to 200,000 rows a file.'),
    })).min(1, 'Choose the files QuickBooks exported.').max(12, 'Up to 12 files at a time.'),
    dateOrder: z.enum(['auto', 'dmy', 'mdy']).default('auto'),
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
      } else if (input.source === 'quickbooks') {
        const data = parseQuickBooks(input.files, input.dateOrder);
        const { masters, vouchers } = toImportShapes(data);
        const hasMasters = masters.ledgers.length > 0 || masters.stockItems.length > 0;
        if (!hasMasters && !vouchers.length) {
          throw badRequest('Nothing QuickBooks wrote was found: export an IIF file, or the Account List, Customers, Vendors, Products and Services or the Journal report.');
        }
        out = hasMasters ? await importTally(trx, ctx, masters, 'QuickBooks') : [];
        if (vouchers.length) {
          out.push(await importTallyFileVouchers(trx, ctx, vouchers, masters, { companyId: QUICKBOOKS_COMPANY_ID, source: 'QuickBooks' }));
        }
        if (data.warnings.length) (out[0] ?? out[out.length - 1])?.notes.push(...data.warnings);
      } else if (input.source === 'tally-xml') {
        const files = [...(input.files ?? []), ...(input.xml ? [input.xml] : [])];
        if (!files.length) throw badRequest('Choose the XML file Tally exported.');
        const file = parseTallyFiles(files);
        const hasMasters = file.masters.ledgers.length > 0 || file.masters.stockItems.length > 0;
        if (!hasMasters && !file.vouchers.length) {
          throw badRequest('No ledgers, stock items or vouchers were found. In TallyPrime use Export → Masters, or Export → Transactions, format XML.');
        }
        // Masters first, so the vouchers find the customers, vendors and accounts they name.
        out = hasMasters ? await importTally(trx, ctx, file.masters) : [];
        if (file.vouchers.length) out.push(await importTallyFileVouchers(trx, ctx, file.vouchers, hasMasters ? file.masters : undefined));
      } else {
        const masters = await connectedCompanyMasters(trx, orgId, Number(input.companyId));
        if (!masters.ledgers.length && !masters.stockItems.length) {
          throw badRequest('No ledgers or stock items were found in that company.');
        }
        out = await importTally(trx, ctx, masters);
      }
      if (input.dryRun || !clean(out)) throw new Discard(out);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'import',
        targetType: input.source === 'rows' ? input.kind : input.source === 'quickbooks' ? 'quickbooks' : 'tally',
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
