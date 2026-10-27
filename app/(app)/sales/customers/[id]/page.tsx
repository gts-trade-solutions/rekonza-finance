'use client';

// A customer's account page: who they are, what they owe, and the documents
// behind that figure.
//
// "Total received" adds back the tax a customer withheld. They did pay it —
// straight to the government, on our behalf — and the invoice is settled by it,
// so leaving it out would make every TDS customer look like a slow payer.

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Mail, Phone, Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import {
  contacts, type ContactDetail, type ContactStatementDoc, type ContactStatementPayment,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINRCompact } from '@/lib/money';
import { stateName } from '@/lib/tax/gst';
import { usePermission } from '@/lib/store/hooks';
import { ContactEditDialog } from '@/components/forms/contact-edit-dialog';
import { Attachments } from '@/components/shared/attachments';

const TERMS: Record<string, string> = {
  due_on_receipt: 'Due on receipt',
  net_15: 'Net 15 days',
  net_30: 'Net 30 days',
  net_45: 'Net 45 days',
  net_60: 'Net 60 days',
};

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const invCols: Column<ContactStatementDoc>[] = [
  { key: 'number', header: 'Invoice #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
  { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
  { key: 'due', header: 'Due', sortValue: (r) => r.dueDate, cell: (r) => short(r.dueDate) },
  { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
  { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
  { key: 'balance', header: 'Balance', align: 'right', sortValue: (r) => r.balancePaise, cell: (r) => <Money value={r.balancePaise} showZero={false} /> },
];

const payCols: Column<ContactStatementPayment>[] = [
  { key: 'number', header: 'Payment #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
  { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
  { key: 'mode', header: 'Mode', sortValue: (r) => r.mode, cell: (r) => <span className="text-xs uppercase">{r.mode}</span> },
  { key: 'bank', header: 'Deposited to', sortValue: (r) => r.bankName, cell: (r) => <span className="text-xs">{r.bankName}</span> },
  { key: 'tds', header: 'TDS withheld', align: 'right', sortValue: (r) => r.tdsPaise, cell: (r) => <Money value={r.tdsPaise} showZero={false} /> },
  { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise, cell: (r) => <Money value={r.amountPaise} /> },
];

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const state = useApi<ContactDetail>(() => contacts.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const canEdit = usePermission('sales', 'edit');

  return (
    <AsyncPage state={state}>
      {(d) => {
        const c = d.contact;
        const receipts = d.payments.filter((p) => p.kind === 'received');
        const overLimit = c.creditLimitPaise > 0 && d.summary.receivablePaise > c.creditLimitPaise;

        return (
          <>
            <PageHeader
              title={c.displayName}
              description={`${c.gstin ? `GSTIN ${c.gstin}` : c.gstTreatment.replace(/_/g, ' ')} · ${stateName(c.stateCode)}`}
              actions={
                <>
                  {canEdit && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>}
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/sales/payments/new?customer=${c.id}`}>Record payment</Link>
                  </Button>
                  <Button size="sm" asChild className="gap-1.5">
                    <Link href="/sales/invoices/new"><Plus className="size-4" /> New invoice</Link>
                  </Button>
                </>
              }
            />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Outstanding"
                value={formatINRCompact(d.summary.receivablePaise)}
                tone={d.summary.receivablePaise > 0 ? 'warning' : 'positive'}
              />
              <StatTile label="Total invoiced" value={formatINRCompact(d.summary.invoicedPaise)} />
              <StatTile label="Total received" value={formatINRCompact(d.summary.receivedPaise)} tone="positive" />
              <StatTile
                label="Credit limit"
                value={c.creditLimitPaise ? formatINRCompact(c.creditLimitPaise) : 'None'}
                sub={overLimit ? 'Exceeded' : undefined}
                tone={overLimit ? 'danger' : 'default'}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-4">
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">Contact</h3>
                <div className="space-y-2 text-sm">
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="size-3.5" /> {c.email ?? '—'}
                  </p>
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="size-3.5" /> {c.phone ?? '—'}
                  </p>
                </div>
                <div className="border-t pt-3 text-sm">
                  <p className="text-xs text-muted-foreground">Billing address</p>
                  <p className="mt-0.5 whitespace-pre-line">{c.billingAddress ?? 'Not on file'}</p>
                </div>
                <div className="border-t pt-3 text-sm">
                  <p className="text-xs text-muted-foreground">Payment terms</p>
                  <p className="mt-0.5">{TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms ?? 'Not set'}</p>
                </div>
                {c.pan && (
                  <div className="border-t pt-3 text-sm">
                    <p className="text-xs text-muted-foreground">PAN</p>
                    <p className="mt-0.5 font-mono text-xs">{c.pan}</p>
                  </div>
                )}
                {c.tdsSection && (
                  <Badge variant="secondary" className="w-full justify-center text-[11px]">
                    Deducts TDS under {c.tdsSection}
                  </Badge>
                )}
              </Card>

              <div className="lg:col-span-3">
                <Tabs defaultValue="invoices">
                  <TabsList>
                    <TabsTrigger value="invoices">Invoices ({d.invoices.length})</TabsTrigger>
                    <TabsTrigger value="payments">Payments ({receipts.length})</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>
                  <TabsContent value="invoices" className="mt-4">
                    <DataTable
                      rows={d.invoices}
                      columns={invCols}
                      getRowId={(r) => r.id}
                      onRowClick={(r) => router.push(`/sales/invoices/${r.id}`)}
                      searchable={false}
                      emptyMessage="No invoices for this customer yet."
                    />
                  </TabsContent>
                  <TabsContent value="payments" className="mt-4">
                    <DataTable
                      rows={receipts}
                      columns={payCols}
                      getRowId={(r) => r.id}
                      searchable={false}
                      emptyMessage="No payments recorded yet."
                    />
                  </TabsContent>
                  <TabsContent value="files" className="mt-4">
                    <Attachments targetType="contact" targetId={c.id} canEdit={canEdit} title="Agreements, KYC and other papers" />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
            <ContactEditDialog contact={editing ? c : null} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void state.refetch(); }} />
          </>
        );
      }}
    </AsyncPage>
  );
}
