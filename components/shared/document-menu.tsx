'use client';

// The "⋯" on a row of quotes, orders, challans, credit notes, retainers,
// receipts, purchase orders, vendor credits and payments: print it or save it
// as a PDF, email it (with mail set up), send it on WhatsApp or from your own
// mail app, copy a link to it, and clone the ones that can be cloned — what
// Zoho Books offers on each of these documents.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Copy, CopyPlus, Loader2, Mail, MessageCircle, MoreHorizontal, Pencil, Printer, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Column } from '@/components/shared/data-table';
import { api, payments as paymentsApi, salesDocuments, type EditableSalesKind } from '@/lib/api/client';
import { formatINR } from '@/lib/money';
import { usePermission } from '@/lib/store/hooks';
import { whatsappNumber } from '@/components/sales/send-invoice';
import { CLONABLE, EMAILABLE, PRINT_NOUN, PRINT_SIDE, type PrintDoc, type PrintKind } from '@/lib/print-doc';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The documents Zoho Books lets you delete from here, and how. */
const DELETABLE: Partial<Record<PrintKind, (id: string, reason?: string) => Promise<unknown>>> = {
  estimate: (id, r) => salesDocuments.remove('estimate', id, r),
  'sales-order': (id, r) => salesDocuments.remove('sales-order', id, r),
  challan: (id, r) => salesDocuments.remove('challan', id, r),
  'credit-note': (id, r) => salesDocuments.remove('credit-note', id, r),
  'payment-received': (id, r) => paymentsApi.remove(id, r),
  'payment-made': (id, r) => paymentsApi.remove(id, r),
};
/** Edit opens the form; kinds a page edits itself are shown by its onEdit. */
export const EDITABLE_KINDS: PrintKind[] = ['estimate', 'sales-order', 'challan', 'credit-note', 'payment-received', 'payment-made'];
export type { EditableSalesKind };

/** Zoho's Delete, asked once: what happens, and an optional reason kept with the record. */
export function DeleteDocumentDialog({ kind, id, number, open, onOpenChange, onDeleted }: {
  kind: PrintKind; id: string; number: string; open: boolean; onOpenChange: (v: boolean) => void; onDeleted?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = DELETABLE[kind];
  const posted = kind === 'credit-note' || kind === 'payment-received' || kind === 'payment-made';
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setError(null); setReason(''); } }}>
      <DialogContent onClick={(e) => e.stopPropagation()} data-slot="delete-document-dialog">
        <DialogHeader>
          <DialogTitle>Delete {PRINT_NOUN[kind]} {number}?</DialogTitle>
          <DialogDescription>
            {posted
              ? 'It is removed and its entry is reversed in the ledger; whatever it settled is open again. The audit trail keeps a copy of it as it was.'
              : 'It is removed. Nothing was posted for it, so the ledger does not change. The audit trail keeps a copy of it as it was.'}
          </DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): raised in error" data-slot="delete-document-reason" />
        {error && <p className="text-sm text-destructive" data-slot="delete-document-error">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive" disabled={busy || !del} data-slot="delete-document-confirm" className="gap-1.5"
            onClick={async () => {
              if (!del) return;
              setBusy(true); setError(null);
              try {
                await del(id, reason.trim() || undefined);
                toast.success(`${cap(PRINT_NOUN[kind])} ${number} deleted`);
                onOpenChange(false);
                onDeleted?.();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally { setBusy(false); }
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sending, sharing and cloning one document; shared by the row menu and the print screen. A sales order can go as its proforma invoice. */
function useDocumentActions(kind: PrintKind, id: string, onChanged?: () => void, proforma = false) {
  const noun = proforma ? 'proforma invoice' : PRINT_NOUN[kind];
  const router = useRouter();
  const area = PRINT_SIDE[kind] === 'customer' ? 'sales' : 'purchases';
  const canShare = usePermission(area, 'export');
  const canSend = usePermission(area, 'create');
  const [busy, setBusy] = useState(false);
  const [mailReady, setMailReady] = useState<boolean | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  const checkMail = () => {
    if (mailReady !== null) return;
    api.get<{ configured: boolean }>('/api/email', { docType: kind, docId: id }).then((r) => setMailReady(r.configured)).catch(() => setMailReady(false));
  };
  const link = async () => {
    const r = await api.post<{ path: string }>('/api/share', { document: { kind, id, ...(proforma ? { proforma } : {}) } });
    return `${window.location.origin}${r.path}`;
  };
  const doc = () => api.get<PrintDoc>(`/api/print/${kind}/${id}`, proforma ? { as: 'proforma' } : undefined);
  const message = (d: PrintDoc, url: string) =>
    `Dear ${d.party.name}, please find ${noun} ${d.number} for ${formatINR(d.totalPaise)}: ${url}\n— ${d.seller.name}`;

  return {
    busy, canShare, canSend, mailReady, checkMail,
    canClone: canSend && CLONABLE[kind] && !proforma,
    canEmail: canSend && EMAILABLE[kind],
    emailNow: () => run(async () => {
      const r = await api.post<{ to: string[] }>('/api/email', { kind: 'document', docKind: kind, id, ...(proforma ? { proforma } : {}) });
      toast.success('Emailed', { description: `To ${r.to.join(', ')}, with a link to view and download it.` });
      onChanged?.();
    }),
    whatsapp: () => run(async () => {
      const [d, url] = await Promise.all([doc(), link()]);
      window.open(`https://wa.me/${whatsappNumber(d.party.phone)}?text=${encodeURIComponent(message(d, url))}`, '_blank', 'noopener');
    }),
    mailApp: () => run(async () => {
      const [d, url] = await Promise.all([doc(), link()]);
      const subject = `${cap(noun)} ${d.number} from ${d.seller.name}`;
      window.open(`mailto:${encodeURIComponent(d.party.email ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(d, url))}`, '_self');
    }),
    copyLink: () => run(async () => {
      const url = await link();
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success('Link copied', { description: `It opens the ${noun} for thirty days, without signing in.` });
    }),
    canWithdraw: usePermission(area, 'edit'),
    withdraw: () => run(async () => {
      if (!window.confirm(`Stop every link to this ${noun} working? Anyone who has one will be told to ask for a new one.`)) return;
      const r = await api.patch<{ revoked: number }>('/api/share', { document: { kind, id } });
      toast.success(r.revoked ? `${r.revoked} link${r.revoked === 1 ? '' : 's'} withdrawn` : 'There were no live links');
    }),
    clone: () => run(async () => {
      const r = await api.post<{ id: string; number: string }>('/api/clone', { kind, id });
      toast.success(`${cap(PRINT_NOUN[kind])} ${r.number} made`, { description: 'A copy dated today, with the same lines and prices.' });
      onChanged?.();
      if (!onChanged) router.push(`/print/${kind}/${r.id}`);
    }),
  };
}

export function DocumentMenu({ kind, id, number, onChanged, onEdit, canChange = true }: {
  kind: PrintKind; id: string; number: string; onChanged?: () => void;
  /** Zoho's Edit, where the page offers it (its own dialog or form). */
  onEdit?: () => void;
  /** The row's own state allows a change (not void, say). */
  canChange?: boolean;
}) {
  const a = useDocumentActions(kind, id, onChanged);
  const area = PRINT_SIDE[kind] === 'customer' ? 'sales' : 'purchases';
  const mayEdit = usePermission(area, 'edit');
  const mayDelete = usePermission(area, 'void') && !!DELETABLE[kind];
  const [deleting, setDeleting] = useState(false);
  return (
    <>
    <DeleteDocumentDialog kind={kind} id={id} number={number} open={deleting} onOpenChange={setDeleting} onDeleted={onChanged} />
    <DropdownMenu onOpenChange={(open) => { if (open) a.checkMail(); }}>
      <DropdownMenuTrigger
        className="inline-flex size-7 items-center justify-center rounded-[3px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`More for ${number}`} data-slot="document-menu" disabled={a.busy}
        onClick={(e) => e.stopPropagation()}
      >
        {a.busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52" onClick={(e) => e.stopPropagation()}>
        {onEdit && mayEdit && canChange && (
          <DropdownMenuItem onClick={() => onEdit()} data-slot="menu-edit"><Pencil className="mr-2 size-4" /> Edit</DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/print/${kind}/${id}`} data-slot="menu-print"><Printer className="mr-2 size-4" /> Print or PDF</Link>
        </DropdownMenuItem>
        {a.canShare && <SendItems a={a} separated />}
        {a.canClone && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void a.clone()} data-slot="menu-clone"><CopyPlus className="mr-2 size-4" /> Clone</DropdownMenuItem>
          </>
        )}
        {mayDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive focus:text-destructive" data-slot="menu-delete">
              <Trash2 className="mr-2 size-4" /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

function SendItems({ a, separated = false }: { a: ReturnType<typeof useDocumentActions>; separated?: boolean }) {
  return (
    <>
      {separated && <DropdownMenuSeparator />}
      {a.canEmail && a.mailReady && (
        <DropdownMenuItem onClick={() => void a.emailNow()} data-slot="menu-email"><Mail className="mr-2 size-4" /> Email now</DropdownMenuItem>
      )}
      {a.canEmail && (
        <>
          <DropdownMenuItem onClick={() => void a.mailApp()}><Mail className="mr-2 size-4" /> In my mail app</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void a.whatsapp()}><MessageCircle className="mr-2 size-4" /> On WhatsApp</DropdownMenuItem>
        </>
      )}
      <DropdownMenuItem onClick={() => void a.copyLink()} data-slot="menu-copy-link"><Copy className="mr-2 size-4" /> Copy a link</DropdownMenuItem>
      {a.canWithdraw && <DropdownMenuItem onClick={() => void a.withdraw()} data-slot="menu-withdraw"><Unlink className="mr-2 size-4" /> Withdraw links</DropdownMenuItem>}
    </>
  );
}

/** Send and Clone beside Print on the printed copy's screen. */
export function DocumentScreenActions({ kind, id, proforma = false }: { kind: PrintKind; id: string; proforma?: boolean }) {
  const a = useDocumentActions(kind, id, undefined, proforma);
  return (
    <>
      {a.canShare && (
        <DropdownMenu onOpenChange={(open) => { if (open) a.checkMail(); }}>
          <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-sm transition-colors hover:bg-accent" disabled={a.busy} data-slot="document-send">
            {a.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} Send
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52"><SendItems a={a} /></DropdownMenuContent>
        </DropdownMenu>
      )}
      {a.canClone && (
        <Button variant="outline" size="sm" onClick={() => void a.clone()} disabled={a.busy} data-slot="document-clone">
          <CopyPlus className="size-3.5" /> Clone
        </Button>
      )}
    </>
  );
}

/** For a list's selection: print every selected document in one go (Zoho's bulk print). */
export function BulkPrintButton({ kind, ids }: { kind: PrintKind | 'invoice'; ids: string[] }) {
  return (
    <Button size="xs" variant="outline" asChild className="gap-1" data-slot="bulk-print">
      <Link href={`/print/bulk?kind=${kind}&ids=${ids.slice(0, 100).join(',')}`}><Printer className="size-3" /> Print {ids.length}</Link>
    </Button>
  );
}

/** The "⋯" as the last column of a document list. */
export function documentMenuColumn<T extends { id: string; number: string; status?: string }>(
  kind: PrintKind, onChanged?: () => void,
  /** Zoho's Edit on the row: the page opens its form for it. */
  onEdit?: (row: T) => void,
): Column<T> {
  return {
    key: 'document-menu', header: '', align: 'right', className: 'w-8',
    cell: (r) => (
      <DocumentMenu kind={kind} id={r.id} number={r.number} onChanged={onChanged}
        onEdit={onEdit ? () => onEdit(r) : undefined} canChange={r.status !== 'void'} />
    ),
  };
}
