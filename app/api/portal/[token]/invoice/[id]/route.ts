import { db } from '@/lib/server/db';
import { route, notFound } from '@/lib/server/http';
import { openPortal, ownsInvoice } from '@/lib/server/services/portal';
import { invoiceDetail } from '@/lib/server/services/invoice-detail';
import { livePaymentLink } from '@/lib/server/services/payment-links';

// One of the customer's own invoices, as printed, from the portal.
export const GET = route(
  async ({ params }) => {
    const p = await openPortal(db, params.token ?? '');
    if (!p || p.side !== 'customer') throw notFound('This link has expired or been withdrawn.');
    const id = Number(params.id);
    if (!(await ownsInvoice(db, p.orgId, p.contactId, id))) throw notFound('That invoice is not yours.');
    const inv = await invoiceDetail(p.orgId, id);
    const shown: Partial<typeof inv> = { ...inv };
    for (const inside of ['journalLines', 'journalEntryId', 'payments', 'approval'] as const) delete shown[inside];
    const payLink = inv.balancePaise > 0 ? await livePaymentLink(db, p.orgId, id) : null;
    return { ...shown, payLink };
  },
  { public: true },
);
