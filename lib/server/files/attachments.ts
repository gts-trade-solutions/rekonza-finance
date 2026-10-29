import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Attachments on documents: the supplier's bill scan, a signed challan, the
// contract behind a retainer, the company logo.
//
// Each attachment belongs to one record and is seen by whoever may see that
// record. The checks sit here and not in the route, so a later caller cannot
// skip them.
//
// What is accepted is a short list checked against the file's own first bytes,
// not the name or the type the browser claims. A file is served back with the
// type recorded here and never as HTML, so an upload cannot run script in
// someone else's session.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto';
import type { Executor, Trx } from '../db';
import { badRequest, notFound } from '../http';
import type { Action } from '../../rbac';
import { fileStore } from './store';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What can carry attachments, the table it lives in and who may see it. */
export const ATTACHABLE = {
  invoice: { table: 'invoices', module: 'sales', label: 'invoice' },
  credit_note: { table: 'credit_notes', module: 'sales', label: 'credit note' },
  estimate: { table: 'estimates', module: 'sales', label: 'estimate' },
  sales_order: { table: 'sales_orders', module: 'sales', label: 'sales order' },
  challan: { table: 'delivery_challans', module: 'sales', label: 'delivery challan' },
  bill: { table: 'bills', module: 'purchases', label: 'bill' },
  expense: { table: 'expenses', module: 'purchases', label: 'expense' },
  vendor_credit: { table: 'vendor_credits', module: 'purchases', label: 'vendor credit' },
  purchase_order: { table: 'purchase_orders', module: 'purchases', label: 'purchase order' },
  payment: { table: 'payments', module: 'banking', label: 'payment' },
  journal: { table: 'journal_entries', module: 'accountant', label: 'journal entry' },
  contact: { table: 'contacts', module: 'sales', label: 'contact' },
  // The certificate as downloaded from TRACES, or as a customer sent it.
  tds_certificate: { table: 'tds_certificates', module: 'gst', label: 'TDS certificate' },
  organization: { table: 'organizations', module: 'settings', label: 'company' },
  goods_receipt: { table: 'goods_receipts', module: 'purchases', label: 'goods receipt' },
  payment_batch: { table: 'payment_batches', module: 'purchases', label: 'payment batch' },
  fixed_asset: { table: 'fixed_assets', module: 'accountant', label: 'fixed asset' },
  // An employee's papers are as private as their salary.
  employee: { table: 'employees', module: 'payroll', label: 'employee' },
  payroll_run: { table: 'payroll_runs', module: 'payroll', label: 'payroll month' },
  // The bills behind an expense claim, and the proofs behind a tax declaration.
  reimbursement_claim: { table: 'reimbursement_claims', module: 'payroll', label: 'expense claim' },
  tax_declaration: { table: 'tax_declarations', module: 'payroll', label: 'investment declaration' },
  // The document library: contracts, agreements, certificates, licences.
  document: { table: 'documents', module: 'accountant', label: 'document' },
} as const;

export type AttachableType = keyof typeof ATTACHABLE;
export const ATTACHABLE_TYPES = Object.keys(ATTACHABLE) as [AttachableType, ...AttachableType[]];

/** Who may do what with a record's attachments: see them, or add and remove them. */
export function attachmentPermission(type: AttachableType, intent: 'read' | 'write'): { module: string; action: Action } {
  return { module: ATTACHABLE[type].module, action: intent === 'read' ? 'view' : 'edit' };
}

interface Kind { contentType: string; ext: string; test: (b: Buffer) => boolean }

const starts = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);
const KINDS: Kind[] = [
  { contentType: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { contentType: 'image/png', ext: '.png', test: (b) => starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { contentType: 'image/jpeg', ext: '.jpg', test: (b) => starts(b, 0xff, 0xd8, 0xff) },
  {
    contentType: 'image/webp', ext: '.webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];
// Office files are zip archives; the name says which one.
const ZIP_KINDS: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** What a file really is, from its first bytes. Null when it is not accepted. */
export function sniff(bytes: Buffer, filename: string): { contentType: string; ext: string } | null {
  const k = KINDS.find((x) => x.test(bytes));
  if (k) return { contentType: k.contentType, ext: k.ext };
  const ext = (/\.[a-z0-9]+$/i.exec(filename)?.[0] ?? '').toLowerCase();
  if (ZIP_KINDS[ext] && starts(bytes, 0x50, 0x4b, 0x03, 0x04)) return { contentType: ZIP_KINDS[ext], ext };
  if (ext === '.csv' || ext === '.txt') {
    // Text only: no NUL bytes in the first 8 KB.
    if (!bytes.subarray(0, 8192).includes(0)) return { contentType: ext === '.csv' ? 'text/csv' : 'text/plain', ext };
  }
  return null;
}

export const ACCEPTED_DESCRIPTION = 'PDF, PNG, JPEG, WebP, Excel (.xlsx), Word (.docx), CSV or text';

async function assertTarget(ex: Executor, orgId: number, type: AttachableType, id: number) {
  const { table, label } = ATTACHABLE[type];
  const idCol = 'id';
  const orgCol = type === 'organization' ? 'id' : 'org_id';
  const row = await ex
    .selectFrom(table as 'invoices')
    .select('id')
    .where(idCol, '=', id)
    .where(orgCol as 'org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound(`That ${label} was not found.`);
}

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedAt: string;
}

const view = (r: {
  id: number; filename: string; content_type: string; size_bytes: number | string;
  uploaded_by: string | null; created_at: Date | string;
}): AttachmentView => ({
  id: String(r.id),
  filename: r.filename,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  uploadedBy: r.uploaded_by,
  uploadedAt: new Date(r.created_at).toISOString(),
});

export async function listAttachments(ex: Executor, orgId: number, type: AttachableType, id: number) {
  const rows = await ex
    .selectFrom('files as f')
    .leftJoin('users as u', 'u.id', 'f.uploaded_by_user_id')
    .select(['f.id', 'f.filename', 'f.content_type', 'f.size_bytes', 'f.created_at', 'u.name as uploaded_by'])
    .where('f.org_id', '=', orgId)
    .where('f.attached_to_type', '=', type)
    .where('f.attached_to_id', '=', id)
    .where('f.deleted_at', 'is', null)
    .orderBy('f.created_at')
    .orderBy('f.id')
    .execute();
  return rows.map(view);
}

/**
 * Store a file and attach it. The bytes are written first and the row second;
 * if the row fails the bytes are removed, so the store never holds a file the
 * index does not know about.
 */
export async function attachFile(
  trx: Trx, orgId: number, userId: number | null,
  input: { type: AttachableType; targetId: number; filename: string; bytes: Buffer },
): Promise<AttachmentView> {
  if (input.bytes.length === 0) throw badRequest('That file is empty.');
  if (input.bytes.length > MAX_FILE_BYTES) {
    throw badRequest(`Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB. This one is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB.`);
  }
  const kind = sniff(input.bytes, input.filename);
  if (!kind) throw badRequest(`That kind of file is not accepted. Attach a ${ACCEPTED_DESCRIPTION} file.`);
  await assertTarget(trx, orgId, input.type, input.targetId);

  const now = new Date();
  const key = `${orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}${kind.ext}`;
  const filename = input.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 255) || `attachment${kind.ext}`;

  await fileStore().put(key, input.bytes);
  try {
    const id = Number((await trx.insertInto('files').values({
      org_id: orgId,
      storage_key: key,
      filename,
      content_type: kind.contentType,
      size_bytes: input.bytes.length,
      checksum_sha256: createHash('sha256').update(input.bytes).digest('hex'),
      attached_to_type: input.type,
      attached_to_id: input.targetId,
      uploaded_by_user_id: userId,
    }).executeTakeFirstOrThrow()).insertId);
    const [row] = (await listAttachments(trx, orgId, input.type, input.targetId)).filter((a) => a.id === String(id));
    return row;
  } catch (err) {
    await fileStore().remove(key).catch(() => {});
    throw err;
  }
}

export async function attachmentRow(ex: Executor, orgId: number, fileId: number) {
  const row = await ex
    .selectFrom('files')
    .selectAll()
    .where('id', '=', fileId)
    .where('org_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row || !row.attached_to_type || !(row.attached_to_type in ATTACHABLE)) throw notFound('That file was not found.');
  return { ...row, type: row.attached_to_type as AttachableType };
}

export async function readAttachment(ex: Executor, orgId: number, fileId: number) {
  const row = await attachmentRow(ex, orgId, fileId);
  return { row, bytes: await fileStore().get(row.storage_key) };
}

/** Take an attachment off its record. The bytes stay, as evidence. */
export async function removeAttachment(trx: Trx, orgId: number, userId: number | null, fileId: number) {
  const row = await attachmentRow(trx, orgId, fileId);
  await trx.updateTable('files')
    .set({ deleted_at: new Date(), deleted_by_user_id: userId })
    .where('id', '=', fileId)
    .execute();
  if (row.type === 'organization') {
    await trx.updateTable('organizations').set({ logo_file_id: null })
      .where('id', '=', orgId).where('logo_file_id', '=', fileId).execute();
  }
  return row;
}
