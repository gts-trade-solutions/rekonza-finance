import { route, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { captureBill } from '@/lib/server/ai/bill-capture';

// Read a supplier's bill from a PDF or a photo into a draft for the New Bill
// form. Nothing is saved here: the person checks the draft and saves the bill.

export const POST = route(
  async ({ orgId, user, req }) => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('Send the bill as a file.');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Send the bill as a file.');
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await captureBill(orgId, user.userId, { bytes, contentType: file.type, filename: file.name });
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'import', targetType: 'bill_capture',
      detail: `Read ${file.name}: ${result.bill.vendorName ?? 'supplier not found'}, ${result.bill.invoiceNumber ?? 'no number'}, ${result.bill.lines.length} line(s)`,
      ...auditMeta(req),
    });
    return result;
  },
  { permission: { module: 'purchases', action: 'create' } },
);
