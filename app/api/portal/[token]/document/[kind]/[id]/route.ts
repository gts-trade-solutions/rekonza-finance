import { db } from '@/lib/server/db';
import { route, notFound } from '@/lib/server/http';
import { openPortal } from '@/lib/server/services/portal';
import { documentParty, forOutside, printableDocument } from '@/lib/server/services/document-print';
import { isPrintKind, PRINT_SIDE } from '@/lib/print-doc';

// One of the contact's own documents, as printed, from the portal: a
// customer's quotes, orders, challans, credit notes, retainers and receipts; a
// vendor's purchase orders, vendor credits, payments and bills. Drafts and
// cancelled documents are the business's own business.
export const GET = route(
  async ({ params }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p) throw notFound('This link has expired or been withdrawn.');
    const kind = params.kind;
    const id = Number(params.id);
    if (!isPrintKind(kind) || PRINT_SIDE[kind] !== p.side || !Number.isInteger(id)) throw notFound('That document is not yours.');
    const owner = await documentParty(db, p.orgId, kind, id);
    if (!owner || owner.contactId !== p.contactId || ['draft', 'void', 'cancelled'].includes(owner.status)) throw notFound('That document is not yours.');
    return forOutside(await printableDocument(db, p.orgId, kind, id));
  },
  { public: true },
);
