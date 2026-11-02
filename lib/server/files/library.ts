import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The Documents workspace, as Zoho Books lays it out: an inbox of files not
// yet attached to anything, every file in the book in one list with what it
// is attached to, the bank statements imports were read from, and folders.
//
// A user sees a file only if they may see the record it is attached to — the
// same rule the record's own attachments follow (attachments.ts) — so a sales
// user's "All files" holds no payroll papers.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { hasPermission } from '../../rbac';
import type { RoleName } from '../../types';
import { ATTACHABLE, attachmentPermission, type AttachableType } from './attachments';

export interface LibraryFile {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  folder: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  attachedTo: { type: AttachableType; id: string; label: string; kind: string; href: string | null } | null;
}

export type LibraryView = 'inbox' | 'all' | 'statements' | 'folder';

/** How each kind of record is named and where it opens. */
const TARGET: Partial<Record<AttachableType, { table: string; label: string; href: (id: number) => string }>> = {
  invoice: { table: 'invoices', label: 'number', href: (id) => `/sales/invoices/${id}` },
  credit_note: { table: 'credit_notes', label: 'number', href: () => '/sales/credit-notes' },
  estimate: { table: 'estimates', label: 'number', href: () => '/sales/estimates' },
  sales_order: { table: 'sales_orders', label: 'number', href: () => '/sales/sales-orders' },
  challan: { table: 'delivery_challans', label: 'number', href: () => '/sales/challans' },
  bill: { table: 'bills', label: 'vendor_invoice_no', href: (id) => `/purchases/bills/${id}` },
  expense: { table: 'expenses', label: 'number', href: () => '/purchases/expenses' },
  vendor_credit: { table: 'vendor_credits', label: 'number', href: () => '/purchases/vendor-credits' },
  purchase_order: { table: 'purchase_orders', label: 'number', href: () => '/purchases/purchase-orders' },
  payment: { table: 'payments', label: 'number', href: (id) => `/purchases/payments/${id}` },
  journal: { table: 'journal_entries', label: 'entry_no', href: () => '/accountant/journals' },
  contact: { table: 'contacts', label: 'display_name', href: (id) => `/sales/customers/${id}` },
  goods_receipt: { table: 'goods_receipts', label: 'number', href: () => '/purchases/goods-receipts' },
  document: { table: 'documents', label: 'title', href: () => '/documents?tab=library' },
  bank_import: { table: 'bank_statement_imports', label: 'filename', href: () => '/banking/imports' },
  payroll_run: { table: 'payroll_runs', label: 'id', href: (id) => `/payroll/runs/${id}` },
};

const readable = (role: RoleName) =>
  (Object.keys(ATTACHABLE) as AttachableType[]).filter((t) => {
    const { module, action } = attachmentPermission(t, 'read');
    return hasPermission(role, module, action);
  });

export async function listLibrary(
  ex: Executor, orgId: number, role: RoleName,
  opts: { view: LibraryView; folder?: string | null; q?: string | null },
): Promise<{ files: LibraryFile[]; folders: { name: string; count: number }[]; counts: { inbox: number; all: number; statements: number } }> {
  const types = readable(role);
  if (!types.length) return { files: [], folders: [], counts: { inbox: 0, all: 0, statements: 0 } };

  let q = ex.selectFrom('files as f').leftJoin('users as u', 'u.id', 'f.uploaded_by_user_id')
    .select(['f.id', 'f.filename', 'f.content_type', 'f.size_bytes', 'f.folder', 'f.attached_to_type', 'f.attached_to_id', 'f.created_at', 'u.name as uploaded_by'])
    .where('f.org_id', '=', orgId).where('f.deleted_at', 'is', null)
    // The company logo is a setting, not a document.
    .where('f.attached_to_type', 'in', types.filter((t) => t !== 'organization'));
  if (opts.view === 'inbox') q = q.where('f.attached_to_type', '=', 'inbox');
  if (opts.view === 'statements') q = q.where('f.attached_to_type', '=', 'bank_import');
  if (opts.view === 'folder') q = q.where('f.folder', '=', opts.folder ?? '');
  if (opts.q?.trim()) q = q.where('f.filename', 'like', `%${opts.q.trim().replace(/[%_]/g, '\\$&')}%`);
  const rows = await q.orderBy('f.created_at', 'desc').orderBy('f.id', 'desc').limit(500).execute();

  // What each file is attached to, one query per kind of record.
  const labels = new Map<string, { label: string; kind?: string }>();
  const byType = new Map<AttachableType, number[]>();
  for (const r of rows) {
    const t = r.attached_to_type as AttachableType;
    if (TARGET[t] && r.attached_to_id) byType.set(t, [...(byType.get(t) ?? []), r.attached_to_id]);
  }
  for (const [t, ids] of byType) {
    const spec = TARGET[t]!;
    const extra = t === 'contact' ? sql`, kind` : t === 'payroll_run' ? sql`, month` : sql``;
    const found = await sql<{ id: number; label: string | number; kind?: string; month?: string }>`
      SELECT id, ${sql.ref(spec.label)} AS label ${extra} FROM ${sql.table(spec.table)}
       WHERE org_id = ${orgId} AND id IN (${sql.join(ids)})
    `.execute(ex);
    for (const f of found.rows) {
      const label = t === 'journal' ? `Journal #${f.label}` : t === 'payroll_run' ? `Payroll ${f.month ?? f.id}` : String(f.label);
      labels.set(`${t}:${f.id}`, { label, kind: f.kind });
    }
  }

  const files: LibraryFile[] = rows.map((r) => {
    const t = r.attached_to_type as AttachableType;
    const id = r.attached_to_id;
    const found = labels.get(`${t}:${id}`);
    const href = t === 'contact' && found?.kind === 'vendor' ? `/purchases/vendors/${id}` : id && TARGET[t] ? TARGET[t]!.href(id) : null;
    return {
      id: String(r.id),
      filename: r.filename,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      folder: r.folder,
      uploadedBy: r.uploaded_by,
      uploadedAt: new Date(r.created_at).toISOString(),
      attachedTo: t === 'inbox' || !id ? null : {
        type: t, id: String(id), kind: ATTACHABLE[t].label,
        label: found?.label ?? `${ATTACHABLE[t].label} #${id}`, href,
      },
    };
  });

  const [folders, counts] = await Promise.all([
    ex.selectFrom('files').select(['folder', sql<string>`COUNT(*)`.as('n')])
      .where('org_id', '=', orgId).where('deleted_at', 'is', null).where('folder', 'is not', null)
      .where('attached_to_type', 'in', types).groupBy('folder').orderBy('folder').execute(),
    ex.selectFrom('files').select([
      sql<string>`SUM(attached_to_type = 'inbox')`.as('inbox'),
      sql<string>`SUM(attached_to_type = 'bank_import')`.as('statements'),
      sql<string>`COUNT(*)`.as('all'),
    ]).where('org_id', '=', orgId).where('deleted_at', 'is', null)
      .where('attached_to_type', 'in', types.filter((t) => t !== 'organization')).executeTakeFirst(),
  ]);

  return {
    files,
    folders: folders.map((f) => ({ name: f.folder as string, count: Number(f.n) })),
    counts: { inbox: Number(counts?.inbox ?? 0), all: Number(counts?.all ?? 0), statements: Number(counts?.statements ?? 0) },
  };
}


/** Records a file can be attached to from Documents, searched by number or name. */
export const ATTACH_TARGETS: { type: AttachableType; label: string }[] = [
  { type: 'bill', label: 'Bill' },
  { type: 'expense', label: 'Expense' },
  { type: 'invoice', label: 'Invoice' },
  { type: 'payment', label: 'Payment' },
  { type: 'credit_note', label: 'Credit note' },
  { type: 'vendor_credit', label: 'Vendor credit' },
  { type: 'purchase_order', label: 'Purchase order' },
  { type: 'sales_order', label: 'Sales order' },
  { type: 'estimate', label: 'Estimate' },
  { type: 'journal', label: 'Journal' },
  { type: 'contact', label: 'Customer or vendor' },
];

export async function findTargets(ex: Executor, orgId: number, type: AttachableType, q: string) {
  const term = `%${q.trim().replace(/[%_]/g, '\\$&')}%`;
  const recent = !q.trim();
  switch (type) {
    case 'bill': {
      const r = await ex.selectFrom('bills as b').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
        .select(['b.id', 'b.vendor_invoice_no as label', 'b.internal_no', 'b.bill_date as d', 'b.total', 'c.display_name as party'])
        .where('b.org_id', '=', orgId).where('b.status', '<>', 'void')
        .$if(!recent, (x) => x.where((w) => w.or([w('b.vendor_invoice_no', 'like', term), w('b.internal_no', 'like', term), w('c.display_name', 'like', term)])))
        .orderBy('b.bill_date', 'desc').limit(20).execute();
      return r.map((x) => ({ id: String(x.id), label: `${x.label} (${x.internal_no})`, sub: `${x.party} · ${String(x.d).slice(0, 10)} · ₹${Number(x.total).toLocaleString('en-IN')}` }));
    }
    case 'invoice': case 'credit_note': case 'estimate': case 'sales_order': {
      const table = ({ invoice: 'invoices', credit_note: 'credit_notes', estimate: 'estimates', sales_order: 'sales_orders' } as const)[type];
      const dateCol = ({ invoice: 'invoice_date', credit_note: 'note_date', estimate: 'estimate_date', sales_order: 'order_date' } as const)[type];
      const { rows } = await sql<{ id: number; number: string; d: string; total: string; party: string }>`
        SELECT x.id, x.number, x.${sql.ref(dateCol)} AS d, x.total, c.display_name AS party
          FROM ${sql.table(table)} x JOIN contacts c ON c.id = x.customer_id
         WHERE x.org_id = ${orgId} ${recent ? sql`` : sql`AND (x.number LIKE ${term} OR c.display_name LIKE ${term})`}
         ORDER BY d DESC LIMIT 20`.execute(ex);
      return rows.map((x) => ({ id: String(x.id), label: x.number, sub: `${x.party} · ${String(x.d).slice(0, 10)} · ₹${Number(x.total).toLocaleString('en-IN')}` }));
    }
    case 'expense': case 'vendor_credit': case 'purchase_order': {
      const table = ({ expense: 'expenses', vendor_credit: 'vendor_credits', purchase_order: 'purchase_orders' } as const)[type];
      const dateCol = ({ expense: 'expense_date', vendor_credit: 'credit_date', purchase_order: 'order_date' } as const)[type];
      const { rows } = await sql<{ id: number; number: string; d: string; total: string; party: string | null }>`
        SELECT x.id, x.number, x.${sql.ref(dateCol)} AS d, x.total, c.display_name AS party
          FROM ${sql.table(table)} x LEFT JOIN contacts c ON c.id = x.vendor_id
         WHERE x.org_id = ${orgId} ${recent ? sql`` : sql`AND (x.number LIKE ${term} OR c.display_name LIKE ${term})`}
         ORDER BY d DESC LIMIT 20`.execute(ex);
      return rows.map((x) => ({ id: String(x.id), label: x.number, sub: `${x.party ?? '—'} · ${String(x.d).slice(0, 10)} · ₹${Number(x.total).toLocaleString('en-IN')}` }));
    }
    case 'payment': {
      const r = await ex.selectFrom('payments as p').leftJoin('contacts as c', 'c.id', 'p.contact_id')
        .select(['p.id', 'p.number', 'p.kind', 'p.payment_date as d', 'p.amount', 'c.display_name as party'])
        .where('p.org_id', '=', orgId)
        .$if(!recent, (x) => x.where((w) => w.or([w('p.number', 'like', term), w('c.display_name', 'like', term)])))
        .orderBy('p.payment_date', 'desc').limit(20).execute();
      return r.map((x) => ({ id: String(x.id), label: x.number, sub: `${x.kind === 'received' ? 'Received from' : 'Paid to'} ${x.party ?? '—'} · ${String(x.d).slice(0, 10)} · ₹${Number(x.amount).toLocaleString('en-IN')}` }));
    }
    case 'journal': {
      const r = await ex.selectFrom('journal_entries').select(['id', 'entry_no', 'entry_date', 'memo', 'total_debit'])
        .where('org_id', '=', orgId).where('source_type', '=', 'manual')
        .$if(!recent, (x) => x.where((w) => w.or([w('memo', 'like', term), w(sql<string>`CAST(entry_no AS CHAR)`, 'like', term)])))
        .orderBy('entry_date', 'desc').limit(20).execute();
      return r.map((x) => ({ id: String(x.id), label: `Journal #${x.entry_no}`, sub: `${x.memo ?? ''} · ${String(x.entry_date).slice(0, 10)}` }));
    }
    case 'contact': {
      const r = await ex.selectFrom('contacts').select(['id', 'display_name', 'kind', 'gstin'])
        .where('org_id', '=', orgId).where('erased_at', 'is', null)
        .$if(!recent, (x) => x.where('display_name', 'like', term))
        .orderBy('display_name').limit(20).execute();
      return r.map((x) => ({ id: String(x.id), label: x.display_name, sub: `${x.kind}${x.gstin ? ` · ${x.gstin}` : ''}` }));
    }
    default:
      return [];
  }
}
