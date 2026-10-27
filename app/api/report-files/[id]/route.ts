import { NextResponse } from 'next/server';
import { db } from '@/lib/server/db';
import { route, idParam, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { reportModule } from '@/lib/report-groups';
import { readReportFile } from '@/lib/server/services/report-schedules';

// A scheduled report's workbook, to whoever may see that report.

export const GET = route(
  async ({ orgId, role, params }) => {
    const file = await readReportFile(db, orgId, idParam(params));
    if (!hasPermission(role, reportModule(file.report), 'view')) throw forbidden('Your role does not include that report.');
    const name = `${file.name.replace(/[^\w ,.-]+/g, '-')}.xlsx`;
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
  { permission: { module: 'reports', action: 'view' } },
);
