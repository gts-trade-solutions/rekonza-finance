'use client';

// The "⋯" on a row of quotes, orders, challans, credit notes, retainers,
// receipts, purchase orders, vendor credits and payments: print it or save it
// as a PDF, email it (with mail set up), send it on WhatsApp or from your own
// mail app, copy a link to it, and clone the ones that can be cloned — what
// Zoho Books offers on each of these documents.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Copy, CopyPlus, Loader2, Mail, MessageCircle, MoreHorizontal, Printer, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Column } from '@/components/shared/data-table';
import { api } from '@/lib/api/client';
import { formatINR } from '@/lib/money';
import { usePermission } from '@/lib/store/hooks';
import { whatsappNumber } from '@/components/sales/send-invoice';
import { CLONABLE, EMAILABLE, PRINT_NOUN, PRINT_SIDE, type PrintDoc, type PrintKind } from '@/lib/print-doc';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Sending, sharing and cloning one document; shared by the row menu and the print screen. */
function useDocumentActions(kind: PrintKind, id: string, onChanged?: () => void) {
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
    const r = await api.post<{ path: string }>('/api/share', { document: { kind, id } });
    return `${window.location.origin}${r.path}`;
  };
  const doc = () => api.get<PrintDoc>(`/api/print/${kind}/${id}`);
  const message = (d: PrintDoc, url: string) =>
    `Dear ${d.party.name}, please find ${PRINT_NOUN[kind]} ${d.number} for ${formatINR(d.totalPaise)}: ${url}\n— ${d.seller.name}`;

  return {
    busy, canShare, canSend, mailReady, checkMail,
    canClone: canSend && CLONABLE[kind],
    canEmail: canSend && EMAILABLE[kind],
    emailNow: () => run(async () => {
      const r = await api.post<{ to: string[] }>('/api/email', { kind: 'document', docKind: kind, id });
      toast.success('Emailed', { description: `To ${r.to.join(', ')}, with a link to view and download it.` });
      onChanged?.();
    }),
    whatsapp: () => run(async () => {
      const [d, url] = await Promise.all([doc(), link()]);
      window.open(`https://wa.me/${whatsappNumber(d.party.phone)}?text=${encodeURIComponent(message(d, url))}`, '_blank', 'noopener');
    }),
    mailApp: () => run(async () => {
      const [d, url] = await Promise.all([doc(), link()]);
      const subject = `${cap(PRINT_NOUN[kind])} ${d.number} from ${d.seller.name}`;
      window.open(`mailto:${encodeURIComponent(d.party.email ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(d, url))}`, '_self');
    }),
    copyLink: () => run(async () => {
      const url = await link();
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success('Link copied', { description: `It opens the ${PRINT_NOUN[kind]} for thirty days, without signing in.` });
    }),
    canWithdraw: usePermission(area, 'edit'),
    withdraw: () => run(async () => {
      if (!window.confirm(`Stop every link to this ${PRINT_NOUN[kind]} working? Anyone who has one will be told to ask for a new one.`)) return;
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

export function DocumentMenu({ kind, id, number, onChanged }: { kind: PrintKind; id: string; number: string; onChanged?: () => void }) {
  const a = useDocumentActions(kind, id, onChanged);
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) a.checkMail(); }}>
      <DropdownMenuTrigger
        className="inline-flex size-7 items-center justify-center rounded-[3px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`More for ${number}`} data-slot="document-menu" disabled={a.busy}
        onClick={(e) => e.stopPropagation()}
      >
        {a.busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52" onClick={(e) => e.stopPropagation()}>
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
      </DropdownMenuContent>
    </DropdownMenu>
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
export function DocumentScreenActions({ kind, id }: { kind: PrintKind; id: string }) {
  const a = useDocumentActions(kind, id);
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
export function documentMenuColumn<T extends { id: string; number: string }>(kind: PrintKind, onChanged?: () => void): Column<T> {
  return {
    key: 'document-menu', header: '', align: 'right', className: 'w-8',
    cell: (r) => <DocumentMenu kind={kind} id={r.id} number={r.number} onChanged={onChanged} />,
  };
}
