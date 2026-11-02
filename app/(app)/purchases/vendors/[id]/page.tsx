'use client';

// A vendor's account page: who they are, what we owe them, the bills and
// payments behind that figure, and the statement to check against theirs.
//
// "Total paid" leaves out the TDS we withheld: that went to the government, not
// to the vendor, and the vendor's own ledger will not show it as received.

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Mail, Phone, Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { MergeContactButton } from '@/components/shared/merge-contact';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { Attachments } from '@/components/shared/attachments';
import { PartyStatementPanel } from '@/components/shared/party-statement';
import { CustomFieldsPanel } from '@/components/shared/custom-fields-panel';
import { ActivityPanel } from '@/components/shared/activity-panel';
import { ContactPersons } from '@/components/shared/contact-persons';
import { PortalAccess } from '@/components/shared/portal-access';
import { ContactAddresses } from '@/components/shared/contact-addresses';
import {
  contacts, type ContactDetail, type ContactStatementDoc, type ContactStatementPayment,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINRCompact } from '@/lib/money';
import { stateName } from '@/lib/tax/gst';
import { usePermission } from '@/lib/store/hooks';
import { ContactEditDialog } from '@/components/forms/contact-edit-dialog';

const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

const billCols: Column<ContactStatementDoc>[] = [
  { key: 'number', header: 'Bill #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
  { key: 'theirs', header: 'Their no.', sortValue: (r) => r.vendorInvoiceNo ?? '', cell: (r) => <span className="text-xs">{r.vendorInvoiceNo ?? '—'}</span> },
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
  { key: 'bank', header: 'Paid from', sortValue: (r) => r.bankName, cell: (r) => <span className="text-xs">{r.bankName}</span> },
  { key: 'tds', header: 'TDS withheld', align: 'right', sortValue: (r) => r.tdsPaise, cell: (r) => <Money value={r.tdsPaise} showZero={false} /> },
  { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise, cell: (r) => <Money value={r.amountPaise} /> },
];

export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const state = useApi<ContactDetail>(() => contacts.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const canEdit = usePermission('purchases', 'edit');

  return (
    <AsyncPage state={state}>
      {(d) => {
        const c = d.contact;
        const paid = d.payments.filter((p) => p.kind === 'made');
        const overdue = d.bills.filter((b) => b.balancePaise > 0 && b.dueDate < new Date().toISOString().slice(0, 10))
          .reduce((t, b) => t + b.balancePaise, 0);

        return (
          <>
            <PageHeader
              title={c.displayName}
              description={`${c.gstin ? `GSTIN ${c.gstin}` : c.gstTreatment.replace(/_/g, ' ')} · ${stateName(c.stateCode)}`}
              actions={
                <>
                  {canEdit && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>}
                  {canEdit && !c.mergedIntoId && <MergeContactButton contactId={c.id} name={c.displayName} side="vendor" />}
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/purchases/payments/new?vendor=${c.id}`}>Record payment</Link>
                  </Button>
                  <Button size="sm" asChild className="gap-1.5">
                    <Link href="/purchases/bills/new"><Plus className="size-4" /> New bill</Link>
                  </Button>
                </>
              }
            />

            {c.mergedIntoId && (
              <p className="rounded-[3px] border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-slot="merged-banner">
                This vendor was merged into another one; everything recorded under it moved there.{' '}
                <Link href={`/purchases/vendors/${c.mergedIntoId}`} className="font-medium underline underline-offset-2">Open it</Link>
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="We owe" value={formatINRCompact(d.summary.payablePaise)} tone={d.summary.payablePaise > 0 ? 'warning' : 'positive'} />
              <StatTile label="Overdue" value={formatINRCompact(overdue)} tone={overdue > 0 ? 'danger' : 'default'} />
              <StatTile label="Total billed" value={formatINRCompact(d.summary.billedPaise)} />
              <StatTile label="Total paid" value={formatINRCompact(d.summary.paidPaise)} tone="positive" />
            </div>

            <div className="grid gap-4 lg:grid-cols-4">
              <Card className="space-y-3 p-5">
                <h3 className="text-sm font-semibold">Contact</h3>
                <div className="space-y-2 text-sm">
                  <p className="flex items-center gap-2 text-muted-foreground"><Mail className="size-3.5" /> {c.email ?? '—'}</p>
                  <p className="flex items-center gap-2 text-muted-foreground"><Phone className="size-3.5" /> {c.phone ?? '—'}</p>
                </div>
                <div className="border-t pt-3 text-sm">
                  <p className="text-xs text-muted-foreground">Address</p>
                  <p className="mt-0.5 whitespace-pre-line">{c.billingAddress ?? 'Not on file'}</p>
                </div>
                {c.pan && (
                  <div className="border-t pt-3 text-sm">
                    <p className="text-xs text-muted-foreground">PAN</p>
                    <p className="mt-0.5 font-mono text-xs">{c.pan}</p>
                  </div>
                )}
                {c.bankAccountNo && (
                  <div className="border-t pt-3 text-sm">
                    <p className="text-xs text-muted-foreground">Bank</p>
                    <p className="mt-0.5 text-xs">{[c.bankName, c.bankAccountNo, c.bankIfsc].filter(Boolean).join(' · ')}</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 border-t pt-3">
                  {c.isMsme && <Badge variant="outline" className="border-amber-500/40 text-[11px] text-amber-700 dark:text-amber-300">MSME · pay within {c.msmeAgreementDays ?? 45} days</Badge>}
                  {c.tdsApplicable && c.tdsSection && <Badge variant="secondary" className="text-[11px]">TDS under {c.tdsSection}</Badge>}
                </div>
              </Card>

              <div className="space-y-4 lg:col-span-3">
                <CustomFieldsPanel entity="contact" id={c.id} canEdit={canEdit} />
                <Tabs defaultValue="bills">
                  <TabsList>
                    <TabsTrigger value="bills">Bills ({d.bills.length})</TabsTrigger>
                    <TabsTrigger value="payments">Payments ({paid.length})</TabsTrigger>
                    <TabsTrigger value="statement">Statement</TabsTrigger>
                    <TabsTrigger value="people">People &amp; portal</TabsTrigger>
                    <TabsTrigger value="activity">Comments</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>
                  <TabsContent value="bills" className="mt-4">
                    <DataTable rows={d.bills} columns={billCols} getRowId={(r) => r.id}
                      onRowClick={(r) => router.push(`/purchases/bills/${r.id}`)} searchable={false}
                      emptyMessage="No bills from this vendor yet." />
                  </TabsContent>
                  <TabsContent value="payments" className="mt-4">
                    <DataTable rows={paid} columns={payCols} getRowId={(r) => r.id} searchable={false}
                      emptyMessage="No payments made yet." />
                  </TabsContent>
                  <TabsContent value="people" className="mt-4 space-y-4">
                    <ContactPersons contactId={c.id} canEdit={canEdit} />
                    <ContactAddresses contactId={c.id} canEdit={canEdit} />
                    <PortalAccess contactId={c.id} side="vendor" defaultEmail={c.email ?? null} canEdit={canEdit} />
                  </TabsContent>
                  <TabsContent value="activity" className="mt-4">
                    <ActivityPanel targetType="contact" targetId={c.id} />
                  </TabsContent>
                  <TabsContent value="statement" className="mt-4">
                    <PartyStatementPanel contactId={c.id} side="vendor" />
                  </TabsContent>
                  <TabsContent value="files" className="mt-4">
                    <Attachments targetType="contact" targetId={c.id} canEdit={canEdit} title="Agreements, MSME certificate and other papers" />
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
