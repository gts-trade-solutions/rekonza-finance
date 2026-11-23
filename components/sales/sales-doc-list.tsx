'use client';

// The list of quotes, sales orders, delivery challans or credit notes, as
// Zoho Books lays each one out (recorded from Zoho's demo on 2026-11-23): its
// columns, its views ("All Estimates ▾", "Draft Estimates" …), "+ New", and the
// ⋯ with Sort by, Import, Export, Manage Custom Fields, Refresh List and Reset
// Column Width. A row opens the record beside the list (the split view).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Download, FileText, MoreHorizontal, Plus, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, resetColumnWidths, type Column } from '@/components/shared/data-table';
import { BulkPrintButton } from '@/components/shared/document-menu';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { downloadCsv } from '@/components/shared/report-shell';
import { salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { importHref, importModule } from '@/lib/imports/modules';
import { toRupees } from '@/lib/money';
import { SALES_DOC, VIEWS, zohoDay, zohoStatus, type SalesDocKindZ } from './sales-docs';

/** Each list's import module (lib/imports/modules.ts); a challan has none. */
const IMPORT_SLUG: Record<SalesDocKindZ, string | null> = { estimate: 'quotes', 'sales-order': 'sales-orders', challan: null, 'credit-note': 'credit-notes' };

const num = (r: SalesDocRow) => <span className="font-medium text-link">{r.number}</span>;

/** What the order's or the challan's invoicing has reached, as Zoho's INVOICED / INVOICE STATUS columns say it. */
function invoiceState(r: SalesDocRow): 'invoiced' | 'partially_invoiced' | 'not_invoiced' {
  if (r.status === 'invoiced') return 'invoiced';
  if (r.status === 'partially_invoiced' || (r.invoices?.length ?? 0) > 0) return 'partially_invoiced';
  return 'not_invoiced';
}

function columnsFor(kind: SalesDocKindZ): Column<SalesDocRow>[] {
  const z = (r: SalesDocRow) => zohoStatus(kind, r);
  const date: Column<SalesDocRow> = { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => zohoDay(r.date) };
  const ref: Column<SalesDocRow> = { key: 'reference', header: kind === 'sales-order' ? 'Reference#' : 'Reference Number', sortValue: (r) => r.reference ?? '', cell: (r) => r.reference ?? '' };
  const customer: Column<SalesDocRow> = { key: 'customer', header: 'Customer Name', sortValue: (r) => r.customerName, cell: (r) => r.customerName };
  const status: Column<SalesDocRow> = { key: 'status', header: 'Status', sortValue: (r) => z(r), cell: (r) => <StatusBadge status={z(r)} /> };
  const amount: Column<SalesDocRow> = { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> };
  switch (kind) {
    case 'estimate':
      return [date, { key: 'number', header: 'Estimate Number', sortValue: (r) => r.number, cell: num }, ref, customer, status, amount,
        { key: 'expiry', header: 'Expiry Date', defaultHidden: true, sortValue: (r) => r.expiry ?? '', cell: (r) => zohoDay(r.expiry) }];
    case 'sales-order':
      return [date, { key: 'number', header: 'Sales Order#', sortValue: (r) => r.number, cell: num }, ref, customer, status, amount,
        {
          key: 'invoiced', header: 'Invoiced', align: 'center', sortValue: (r) => invoiceState(r),
          cell: (r) => {
            const s = invoiceState(r);
            const tone = s === 'invoiced' ? 'bg-success' : s === 'partially_invoiced' ? 'bg-warning' : 'border border-muted-foreground/50';
            return <span title={s.replace(/_/g, ' ')} data-slot="invoiced-mark" data-state={s} className={`inline-block size-2.5 rounded-full ${tone}`} />;
          },
        },
        { key: 'invoicedAmount', header: 'Invoiced Amount', align: 'right', defaultHidden: true, sortValue: (r) => r.appliedPaise ?? 0, cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} /> },
        { key: 'shipment', header: 'Expected Shipment Date', defaultHidden: true, sortValue: (r) => r.detail ?? '', cell: (r) => zohoDay(r.detail) },
        { key: 'products', header: 'Products', defaultHidden: true, sortValue: (r) => r.items?.[0]?.name ?? '', cell: (r) => (r.items ?? []).map((i) => i.name).join(', ') },
      ];
    case 'challan':
      return [{ ...date, defaultHidden: true }, { key: 'number', header: 'Delivery Challan#', sortValue: (r) => r.number, cell: num }, ref, customer, status,
        { key: 'invoiceStatus', header: 'Invoice Status', sortValue: (r) => invoiceState(r), cell: (r) => <StatusBadge status={invoiceState(r)} /> },
        amount,
        { key: 'products', header: 'Products', defaultHidden: true, sortValue: (r) => r.items?.[0]?.name ?? '', cell: (r) => (r.items ?? []).map((i) => i.name).join(', ') },
      ];
    case 'credit-note':
      return [date, { key: 'number', header: 'Credit Note#', sortValue: (r) => r.number, cell: num }, ref, customer,
        { key: 'invoice', header: 'Invoice#', sortValue: (r) => r.linkedNumber ?? '', cell: (r) => r.linkedNumber ?? '' },
        status, amount,
        { key: 'balance', header: 'Balance', align: 'right', sortValue: (r) => r.totalPaise - (r.appliedPaise ?? 0), cell: (r) => <Money value={r.status === 'void' ? 0 : r.totalPaise - (r.appliedPaise ?? 0)} /> },
        { key: 'reason', header: 'Reason', defaultHidden: true, sortValue: (r) => r.detail ?? '', cell: (r) => r.detail ?? '' },
      ];
  }
}

/** Zoho's ⋯ → Sort by, for each list. */
const SORTS: Record<SalesDocKindZ, { key: string; label: string }[]> = {
  estimate: [{ key: 'created', label: 'Created Time' }, { key: 'date', label: 'Date' }, { key: 'number', label: 'Estimate Number' }, { key: 'customer', label: 'Customer Name' }, { key: 'amount', label: 'Amount' }],
  'sales-order': [{ key: 'created', label: 'Created Time' }, { key: 'date', label: 'Date' }, { key: 'number', label: 'Sales Order#' }, { key: 'customer', label: 'Customer Name' }, { key: 'amount', label: 'Amount' }],
  challan: [{ key: 'number', label: 'Delivery Challan#' }, { key: 'customer', label: 'Customer Name' }, { key: 'amount', label: 'Amount' }],
  'credit-note': [{ key: 'created', label: 'Created Time' }, { key: 'date', label: 'Date' }, { key: 'number', label: 'Credit Note#' }, { key: 'customer', label: 'Customer Name' }, { key: 'amount', label: 'Amount' }, { key: 'balance', label: 'Balance' }],
};

export function SalesDocList({ kind }: { kind: SalesDocKindZ }) {
  const info = SALES_DOC[kind];
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canExport = usePermission('sales', 'export');
  const state = useApi<SalesDocListResponse>(() => salesDocuments.list(kind, { limit: 500 }), [kind]);
  const [view, setView] = useState('all');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });
  const columns = useMemo(() => {
    const base = columnsFor(kind);
    // Created Time sorts by when it was entered; it is not a column of its own.
    return [...base, { key: 'created', header: 'Created Time', defaultHidden: true, sortValue: (r: SalesDocRow) => r.createdAt ?? '', cell: (r: SalesDocRow) => zohoDay(r.createdAt ?? null) } as Column<SalesDocRow>];
  }, [kind]);
  const views = VIEWS[kind];
  const rows = state.data?.documents ?? [];
  const shown = useMemo(() => {
    const keep = views.find((v) => v.value === view)?.keep ?? (() => true);
    return rows.filter((r) => keep(zohoStatus(kind, r)));
  }, [rows, view, views, kind]);
  const tabs = useMemo(() => views.map((v) => ({
    // The whole heading, as Zoho words it: "All Estimates", "Draft Estimates".
    value: v.value, label: v.label, title: v.value === 'all' ? `All ${info.viewNoun}` : `${v.label} ${info.viewNoun}`,
    count: rows.filter((r) => v.keep(zohoStatus(kind, r))).length,
  })), [views, rows, kind, info.viewNoun]);
  const mod = IMPORT_SLUG[kind] ? importModule(IMPORT_SLUG[kind]!) : null;
  const exportView = () => downloadCsv(`${info.plural.toLowerCase().replace(/\s+/g, '-')}.csv`, [
    ['Date', 'Number', 'Reference', 'Customer', 'Status', 'Amount'],
    ...shown.map((r) => [r.date, r.number, r.reference ?? '', r.customerName, zohoStatus(kind, r), toRupees(r.totalPaise)]),
  ]);

  return (
    <>
      <PageHeader
        title={info.plural}
        actions={
          <>
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href={`${info.base}/new`} data-slot="doc-new"><Plus className="size-4" /> New</Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More actions" data-slot="module-menu"
                className="grid size-8 place-items-center rounded-[3px] border bg-background transition-colors hover:bg-accent">
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-slot="list-sort">Sort by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-44">
                    {SORTS[kind].map((s) => (
                      <DropdownMenuItem key={s.key} data-slot="list-sort-by" data-value={s.key}
                        onClick={() => setSort((c) => ({ key: s.key, dir: c.key === s.key && c.dir === 'desc' ? 'asc' : 'desc' }))}>
                        {s.label}{sort.key === s.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {mod && canCreate && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger><Upload className="mr-2 size-4 text-primary" /> Import</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => router.push(importHref(mod.slug))} data-slot="module-import">Import {info.plural}</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {canExport && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger><Download className="mr-2 size-4 text-primary" /> Export</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {mod?.exportModule && <DropdownMenuItem onClick={() => router.push(`/settings/export?module=${mod.exportModule}`)} data-slot="module-export">Export {info.plural}</DropdownMenuItem>}
                      <DropdownMenuItem onClick={exportView} data-slot="export-view">Export Current View</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push('/settings?tab=custom-fields')}>Manage Custom Fields</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void state.refetch()}><RefreshCw className="mr-2 size-4 text-primary" /> Refresh List</DropdownMenuItem>
                <DropdownMenuItem onClick={() => resetColumnWidths()}>Reset Column Width</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.documents.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={`No ${info.plural.toLowerCase()} yet`}
              description={kind === 'credit-note' ? 'Raise one when goods come back or a price is corrected after the invoice went out.' : `Create your first ${info.lower}.`}
              action={canCreate && <Button asChild><Link href={`${info.base}/new`}>New {info.noun}</Link></Button>}
            />
          ) : (
            <DataTable
              key={`${sort.key}-${sort.dir}`}
              rows={shown}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => router.push(`${info.base}/${r.id}`)}
              tabs={tabs}
              activeTab={view}
              onTabChange={setView}
              initialSort={sort}
              selectable
              bulkActions={(selected) => <BulkPrintButton kind={kind} ids={selected.map((r) => r.id)} />}
              searchPlaceholder={`Search in ${info.plural}`}
              columnsKey={`sales-doc-${kind}`}
            />
          )
        }
      </AsyncPage>
    </>
  );
}
