import { db } from '@/lib/server/db';
import { route, forbidden, notFound, idParam } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { printableDocument } from '@/lib/server/services/document-print';
import { isPrintKind, PRINT_SIDE } from '@/lib/print-doc';

// One document as it prints (lib/print-doc.ts): a quote, sales order, challan,
// credit note, retainer, receipt, purchase order, vendor credit, payment
// advice or bill. Seeing it needs the right to view sales or purchases.

export const GET = route(async ({ orgId, role, user, params }) => {
  const kind = params.kind;
  if (!isPrintKind(kind)) throw notFound('There is no such document to print.');
  const area = PRINT_SIDE[kind] === 'customer' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, 'view', user.permissions ?? null)) {
    throw forbidden(`Your role (${role}) cannot view ${area}. Ask an admin if you need this.`);
  }
  return printableDocument(db, orgId, kind, idParam(params));
});
