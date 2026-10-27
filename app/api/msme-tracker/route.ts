import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { msme1, msmeDisallowance, msmeInterestReport, msmeOpenBills } from '@/lib/server/services/msme';
import { getPolicies } from '@/lib/server/services/org-settings';

// ─────────────────────────────────────────────────────────────────────────────
// Paying micro and small suppliers on time — see lib/server/services/msme.ts.
//
//   open          bills still owed, each against its own deadline: the period
//                 agreed in writing (at most 45 days) or 15 days without one.
//   disallowance  the year-end figure section 43B(h) (37(2)(g) of the 2025
//                 Act) takes out of the year's deductions, and what last
//                 year's disallowance gives back now it is paid.
//   msme1         the half-yearly return to the MCA.
//   interest      interest owed under s.16 for late payment, and the
//                 disclosure the accounts carry.
// ─────────────────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['open', 'disallowance', 'msme1', 'interest']).default('open'),
      fy: z.coerce.number().int().min(2017).max(2100).optional(),
      halfEnd: DATE.optional(),
      asOf: DATE.optional(),
    }));
    const asOf = q.asOf ?? new Date().toISOString().slice(0, 10);

    if (q.view === 'disallowance') {
      const fy = q.fy ?? Number(asOf.slice(0, 4)) - (Number(asOf.slice(5, 7)) < 4 ? 1 : 0) - 1;
      return msmeDisallowance(db, orgId, fy, asOf);
    }
    if (q.view === 'interest') {
      const fy = q.fy ?? Number(asOf.slice(0, 4)) - (Number(asOf.slice(5, 7)) < 4 ? 1 : 0);
      const end = `${fy + 1}-03-31`;
      const rate = (await getPolicies(db, orgId)).msmeBankRatePct;
      return msmeInterestReport(db, orgId, fy, end < asOf ? end : asOf, rate);
    }
    if (q.view === 'msme1') {
      // The half-year just ended: 30 September or 31 March.
      const y = Number(asOf.slice(0, 4));
      const m = Number(asOf.slice(5, 7));
      const halfEnd = q.halfEnd ?? (m >= 10 ? `${y}-09-30` : m >= 4 ? `${y}-03-31` : `${y - 1}-09-30`);
      return msme1(db, orgId, halfEnd);
    }

    const items = await msmeOpenBills(db, orgId, asOf);
    const breached = items.filter((i) => i.risk === 'breached');
    const critical = items.filter((i) => i.risk === 'critical');
    return {
      asOf,
      items,
      summary: {
        breached: breached.length,
        critical: critical.length,
        safe: items.length - breached.length - critical.length,
        atRiskPaise: [...breached, ...critical].reduce((t, i) => t + i.balancePaise, 0),
        totalOwedPaise: items.reduce((t, i) => t + i.balancePaise, 0),
        noAgreement: items.filter((i) => !i.writtenAgreement).length,
        categoryUnknown: new Set(items.filter((i) => !i.categoryKnown).map((i) => i.vendorId)).size,
      },
    };
  },
  { permission: { module: 'purchases', action: 'view' } },
);
