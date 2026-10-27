import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { form16, form16Employees } from '@/lib/server/payroll/form16';

// Form 16 Part B (Form 130 from April 2026): one employee's year, or the list of everyone paid in it.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ fy: z.coerce.number().int().min(2020).max(2100), employeeId: z.coerce.number().int().positive().optional() }));
    if (q.employeeId) return form16(db, orgId, q.employeeId, q.fy);
    return { fy: q.fy, employees: await form16Employees(db, orgId, q.fy) };
  },
  { permission: { module: 'payroll', action: 'view' } },
);
