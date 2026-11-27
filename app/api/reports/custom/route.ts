import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { reportModule } from '@/lib/report-groups';
import { customReport } from '@/lib/server/reports/custom-report';

// ─────────────────────────────────────────────────────────────────────────────
// A customised report (Zoho's "Customize Report"): the profit and loss,
// balance sheet, trial balance, general ledger, account transactions or cash
// flow with the period, basis, comparison, "report by" columns and the
// filters chosen (lib/server/reports/custom-report.ts). The spec travels as
// one JSON parameter on a GET, so a saved custom report reopens from its URL.
// ─────────────────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IDS = z.array(z.coerce.number().int().positive()).max(500).optional();
const Spec = z.object({
  report: z.enum(['profit-and-loss', 'balance-sheet', 'trial-balance', 'general-ledger', 'account-transactions', 'cash-flow']),
  from: DATE, to: DATE,
  basis: z.enum(['accrual', 'cash']).optional(),
  reportBy: z.enum(['total', 'month', 'quarter', 'year']).optional(),
  compareMode: z.enum(['none', 'previous_period', 'previous_year']).optional(),
  compareCount: z.coerce.number().int().min(0).max(12).optional(),
  accounts: z.enum(['all', 'non_zero', 'with_txns']).optional(),
  accountId: z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || v === '' ? null : String(v))),
  filter: z.object({
    branchId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
    costCentreIds: IDS, projectIds: IDS, tagOptionIds: IDS, contactIds: IDS, accountIds: IDS,
    accountTypes: z.array(z.enum(['asset', 'liability', 'equity', 'income', 'expense'])).optional(),
  }).optional(),
});

export const GET = route(
  async ({ orgId, role, req }) => {
    const { spec: raw } = query(req, z.object({ spec: z.string().max(8000) }));
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw badRequest('That report could not be read.'); }
    const spec = Spec.parse(parsed);
    if (spec.from > spec.to) throw badRequest('The period starts after it ends.');
    if (!hasPermission(role, reportModule(spec.report), 'view')) throw forbidden('Your role does not include financial statements.');
    return customReport(db, orgId, spec);
  },
  { permission: { module: 'reports', action: 'view' } },
);
