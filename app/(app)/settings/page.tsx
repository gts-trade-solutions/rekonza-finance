'use client';

// Settings — the organisation, its branches, its people, and its numbering.
//
// A number series' counter is never edited. It is advanced by the database as
// documents are raised; letting somebody set the next number by hand is how a
// book ends up with two invoices sharing a number, which is a question at
// assessment rather than a display problem. Its prefix and padding can be.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Plug, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Field } from '@/components/shared/form-bits';
import { AsyncPage } from '@/components/shared/async-state';
import { BranchDialog, type EditableBranch } from '@/components/settings/branch-dialog';
import { IntegrationsPanel } from '@/components/settings/integrations-panel';
import { NumberingPanel, type SeriesRow } from '@/components/settings/numbering-panel';
import { BackupsPanel } from '@/components/settings/backups-panel';
import { PoliciesPanel } from '@/components/settings/policies-panel';
import { SignInsPanel } from '@/components/settings/sign-ins-panel';
import { TwoStepPanel } from '@/components/settings/two-step-panel';
import { ChangePasswordCard, UsersPanel } from '@/components/settings/users-panel';
import { PrivacyPanel } from '@/components/settings/privacy-panel';
import { DeveloperPanel } from '@/components/settings/developer-panel';
import { StatutoryPanel } from '@/components/settings/statutory-panel';
import { VoucherTypesPanel } from '@/components/settings/voucher-types-panel';
import { api } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { stateName } from '@/lib/tax/gst';

interface SettingsResponse {
  org: {
    id: string; name: string; legalName: string | null; pan: string | null; tan: string | null;
    lutArn: string | null; lutValidFrom: string | null; lutValidTo: string | null;
    email: string | null; phone: string | null; address: string | null;
    fiscalYearStartMonth: number; currency: string;
    gstRegistrationType: string; einvoiceApplicable: boolean;
  };
  branches: {
    id: string; name: string; gstin: string | null; stateCode: string;
    address: string | null;
    /** Both mandatory on every e-invoice and e-way bill, as their own fields. */
    city: string | null; pincode: string | null;
    isPrimary: boolean; isActive: boolean;
  }[];
  users: {
    id: string; name: string; email: string; role: string;
    branchName: string | null; isActive: boolean; lastLoginAt: string | null;
  }[];
  series: SeriesRow[];
  counts: { contacts: number; items: number; invoices: number; journalEntries: number };
}

const ROLE_MATRIX = [
  { role: 'Admin', scope: 'Everything, including settings, period locks and voiding documents.' },
  { role: 'Accountant', scope: 'Full books, banking, GST and journals. Cannot change org settings.' },
  { role: 'Sales', scope: 'Quotes, invoices and customers. Purchase costs and profit are hidden.' },
  { role: 'Staff', scope: 'Create documents only — no approvals, no reports.' },
  { role: 'Viewer', scope: 'Read-only across the app. For auditors and stakeholders.' },
];

/**
 * Things the screens exist for but the backend does not do yet. Listed plainly
 * rather than shown as switches that quietly save nothing — a settings page
 * that lies about what is connected is worse than one that admits the gap.
 */
const NOT_BUILT = [
  {
    name: 'Account Aggregator bank feeds',
    desc: 'Daily transaction sync straight from your banks.',
    why: 'Pulling from the AA framework needs a Financial Information User licence, which means being regulated by the RBI, SEBI, IRDAI or PFRDA. Statement upload is the honest route until a licensed partner is in place.',
  },
  {
    name: 'Email delivery',
    desc: 'Sending invoices and payment reminders.',
    why: 'No mail transport is wired up, so reminder schedules are configuration for something that does not run yet.',
  },
  {
    name: 'Payment links',
    desc: 'A pay-now button on the invoice, and settlement reconciliation.',
    why: 'Needs a payment gateway account and a webhook endpoint.',
  },
  {
    name: 'Custom fields, workflows and approvals',
    desc: 'Extra fields per document type, and rules that act on their own.',
    why: 'The tables exist; nothing reads or writes them yet.',
  },
  {
    name: 'Developer API',
    desc: 'Tokens and webhooks for your website or CRM.',
    why: 'The api_tokens table is in place but no token is issued or accepted.',
  },
];

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function SettingsPage() {
  const canEdit = usePermission('settings', 'edit');
  const canBilling = usePermission('billing', 'view');
  const currentUserId = useAppStore((s) => s.session?.userId);
  const state = useApi<SettingsResponse>(() => api.get('/api/settings'), []);

  const [form, setForm] = useState({ name: '', legalName: '', pan: '', tan: '', email: '', phone: '', address: '', lutArn: '', lutValidFrom: '', lutValidTo: '' });
  const [editingBranch, setEditingBranch] = useState<EditableBranch | null>(null);
  // Opened on a tab when linked to one — "Settings → Integrations" from the
  // e-invoice checklist. Read once, from the address.
  const [tab, setTab] = useState('org');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t) setTab(t);
  }, []);
  const save = useApiAction((input: unknown) => api.patch<{ id: string }>('/api/settings', input));

  useEffect(() => {
    const o = state.data?.org;
    if (!o) return;
    setForm({
      name: o.name,
      legalName: o.legalName ?? '',
      pan: o.pan ?? '',
      tan: o.tan ?? '',
      lutArn: o.lutArn ?? '',
      lutValidFrom: o.lutValidFrom ?? '',
      lutValidTo: o.lutValidTo ?? '',
      email: o.email ?? '',
      phone: o.phone ?? '',
      address: o.address ?? '',
    });
  }, [state.data]);

  const submit = async () => {
    const done = await save.run({
      name: form.name,
      legalName: form.legalName || null,
      pan: form.pan || null,
      tan: form.tan || null,
      lutArn: form.lutArn || null,
      lutValidFrom: form.lutValidFrom || null,
      lutValidTo: form.lutValidTo || null,
      email: form.email || null,
      phone: form.phone || null,
      address: form.address || null,
    });
    if (!done) {
      toast.error(save.error ?? 'The changes were not saved');
      return;
    }
    toast.success('Organisation settings saved');
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Organisation, users, numbering, and what is and is not connected."
      />

      <AsyncPage state={state}>
        {(d) => (
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="org">Organisation</TabsTrigger>
              <TabsTrigger value="statutory">Statutory</TabsTrigger>
              <TabsTrigger value="users">Users &amp; roles</TabsTrigger>
              <TabsTrigger value="numbering">Numbering</TabsTrigger>
              <TabsTrigger value="integrations">Integrations</TabsTrigger>
              <TabsTrigger value="backups">Backups</TabsTrigger>
              <TabsTrigger value="policies">Policies</TabsTrigger>
              <TabsTrigger value="sign-ins">Sign-ins</TabsTrigger>
              <TabsTrigger value="privacy">Privacy</TabsTrigger>
              {canEdit && <TabsTrigger value="developer">Developer</TabsTrigger>}
            </TabsList>

            {/* Organisation */}
            <TabsContent value="org" className="mt-4 space-y-4">
              <Card className="space-y-5 p-5">
                <h3 className="text-sm font-semibold">Organisation details</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Business name" required error={save.fieldErrors.name}>
                    <Input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Legal name" hint="As registered, if it differs">
                    <Input
                      value={form.legalName}
                      onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="PAN" error={save.fieldErrors.pan}>
                    <Input
                      value={form.pan}
                      onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
                      className="font-mono"
                      maxLength={10}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="TAN" hint="For TDS returns and challans" error={save.fieldErrors.tan}>
                    <Input
                      value={form.tan}
                      onChange={(e) => setForm({ ...form, tan: e.target.value.toUpperCase() })}
                      className="font-mono"
                      maxLength={10}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="LUT ARN" hint="Letter of Undertaking, for exports and SEZ supplies without IGST" error={save.fieldErrors.lutArn}>
                    <Input value={form.lutArn} onChange={(e) => setForm({ ...form, lutArn: e.target.value.toUpperCase() })} className="font-mono" maxLength={20} disabled={!canEdit} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="LUT valid from"><Input type="date" value={form.lutValidFrom} onChange={(e) => setForm({ ...form, lutValidFrom: e.target.value })} disabled={!canEdit} /></Field>
                    <Field label="to"><Input type="date" value={form.lutValidTo} onChange={(e) => setForm({ ...form, lutValidTo: e.target.value })} disabled={!canEdit} /></Field>
                  </div>
                  <Field label="Email" error={save.fieldErrors.email}>
                    <Input
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Phone">
                    <Input
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Address">
                    <Input
                      value={form.address}
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field
                    label="Financial year"
                    hint="Fixed once the books are open — every posted entry and every number series was produced under it"
                    className="sm:col-span-2"
                  >
                    <Input
                      value={`Starts ${MONTHS[d.org.fiscalYearStartMonth]} · ${d.org.currency} · ${d.org.gstRegistrationType} scheme`}
                      readOnly
                      className="bg-muted/40"
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Turnover above ₹5 crore</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Makes e-invoicing mandatory — B2B invoices must be registered with the IRP within 30 days. Change it under Statutory.
                    </p>
                  </div>
                  <Badge variant="outline" className={d.org.einvoiceApplicable ? 'border-emerald-500/40' : ''}>
                    {d.org.einvoiceApplicable ? 'Applicable' : 'Not applicable'}
                  </Badge>
                </div>
                {canEdit && (
                  <Button size="sm" onClick={submit} disabled={save.busy}>
                    {save.busy ? 'Saving…' : 'Save changes'}
                  </Button>
                )}
              </Card>

              <Card className="p-5">
                <h3 className="mb-3 text-sm font-semibold">Branches &amp; GST registrations</h3>
                <div className="space-y-2">
                  {d.branches.map((b) => {
                    // Named individually, because these are exactly the fields
                    // that stop an invoice being registered — and a user can
                    // act on "no PIN code" in a way they cannot act on a
                    // rejection code from the portal.
                    const missing = [
                      !b.gstin ? 'GSTIN' : null,
                      !b.city ? 'city' : null,
                      !b.pincode ? 'PIN code' : null,
                    ].filter(Boolean) as string[];

                    return (
                      <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                        <Building2 className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{b.name}</p>
                            {b.isPrimary && <Badge variant="secondary" className="text-[9px]">Primary</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {[b.address, b.city, b.pincode].filter(Boolean).join(', ') ||
                              stateName(b.stateCode)}
                          </p>
                          {missing.length > 0 && (
                            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                              No {missing.join(', no ')} — the GST portals require {missing.length === 1 ? 'it' : 'all of them'} on
                              every document, so nothing can be registered until {missing.length === 1 ? 'it is' : 'they are'} filled in.
                            </p>
                          )}
                        </div>
                        <Badge variant="outline" className="font-mono text-[10px]">{b.gstin ?? 'No GSTIN'}</Badge>
                        {canEdit && (
                          <Button
                            size="xs"
                            variant={missing.length > 0 ? 'default' : 'outline'}
                            onClick={() => setEditingBranch(b)}
                          >
                            Edit
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Each state you operate in needs its own GST registration, and each registration keeps its own
                  invoice number series. That&apos;s why branches sit at the heart of the app rather than being an
                  afterthought — and why portal credentials are per registration, not per business.
                </p>
              </Card>

              {canBilling && (
                <Card className="flex flex-wrap items-center gap-4 p-5" data-slot="settings-billing-link">
                  <Sparkles className="size-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">Billing &amp; AI</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Credits for the AI assistant, your plan, who has used it, and the invoice for every payment.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/settings/billing">Open</Link>
                  </Button>
                </Card>
              )}

              <Card className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">Import</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Customers, vendors, items, accounts, opening balances and vouchers from Excel or CSV, or a whole
                    company from Tally. Every import is checked first and goes in whole or not at all.
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings/import">Import data</Link>
                </Button>
              </Card>

              <Card className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">Invoice print</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Your logo, the bank account to pay into, a pay-by-UPI code for the balance, the standard terms
                    and the signatory&apos;s name.
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings/invoice-print">Set up</Link>
                </Button>
              </Card>

              <Card className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">HSN &amp; SAC codes</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    The approved code list your team may pick from on invoice lines. Nothing outside it can be
                    entered — the server rejects it — which is what keeps GSTR-1 from bouncing on an invalid code.
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings/hsn-codes">Manage codes</Link>
                </Button>
              </Card>

              <Card className="flex flex-wrap items-center gap-4 p-5">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">TDS &amp; TCS rates</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    The rate for each section by the date it took effect, with where it came from. Have your CA
                    check each one and mark it verified; until then every rate shows as to verify.
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings/tax-rates">Review rates</Link>
                </Button>
              </Card>

              <Card className="p-5">
                <h3 className="mb-3 text-sm font-semibold">What this book holds</h3>
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    { label: 'Contacts', value: d.counts.contacts },
                    { label: 'Items', value: d.counts.items },
                    { label: 'Invoices', value: d.counts.invoices },
                    { label: 'Journal entries', value: d.counts.journalEntries },
                  ].map((c) => (
                    <div key={c.label} className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">{c.label}</p>
                      <p className="mt-1 text-xl font-semibold tabular">{c.value}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </TabsContent>

            {/* Users */}
            <TabsContent value="users" className="mt-4 space-y-4">
              <UsersPanel canEdit={canEdit} currentUserId={currentUserId} branches={d.branches.filter((b) => b.isActive)} />

              <Card className="p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-primary" /> What each role can do
                </h3>
                <div className="space-y-2">
                  {ROLE_MATRIX.map((r) => (
                    <div key={r.role} className="flex gap-3 rounded-md border p-3">
                      <Badge variant="outline" className="h-fit shrink-0">{r.role}</Badge>
                      <p className="text-xs leading-relaxed text-muted-foreground">{r.scope}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  The same matrix is checked on the server for every request. Hiding a button is a courtesy; the
                  API refusing the call is the control.
                </p>
              </Card>
            </TabsContent>

            {/* Numbering */}
            <TabsContent value="numbering" className="mt-4">
              <NumberingPanel series={d.series} canEdit={canEdit} onChanged={() => void state.refetch()} />
              <VoucherTypesPanel canEdit={canEdit} />
            </TabsContent>

            {/* Honest gaps */}
            <TabsContent value="backups" className="mt-4">
              <BackupsPanel />
            </TabsContent>

            <TabsContent value="policies" className="mt-4">
              <PoliciesPanel canEdit={canEdit} />
            </TabsContent>

            <TabsContent value="statutory" className="mt-4">
              <StatutoryPanel canEdit={canEdit} />
            </TabsContent>

            <TabsContent value="sign-ins" className="mt-4 space-y-4">
              <TwoStepPanel />
              <ChangePasswordCard />
              <SignInsPanel />
            </TabsContent>

            <TabsContent value="privacy" className="mt-4">
              <PrivacyPanel canEdit={canEdit} />
            </TabsContent>

            {canEdit && (
              <TabsContent value="developer" className="mt-4">
                <DeveloperPanel />
              </TabsContent>
            )}

            <TabsContent value="integrations" className="mt-4 space-y-3">
              {/* The GST portals now have a real connection flow, so they are
                  no longer in the "not built" list below — the credentials a
                  customer creates on the portal are stored here. */}
              <IntegrationsPanel canEdit={canEdit} />

              <div className="pt-4">
                <h3 className="text-sm font-semibold">Still not connected</h3>
                <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
                  Everything below has a screen in the app but nothing behind it. Listed rather than shown as
                  switches that quietly save nothing — a settings page that claims to be connected when it is
                  not is worse than one that admits the gap.
                </p>
              </div>

              {NOT_BUILT.map((i) => (
                <Card key={i.name} className="flex flex-wrap items-start gap-3 p-4">
                  <div className="rounded-lg bg-muted p-2">
                    <Plug className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{i.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{i.desc}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">Why not yet:</span> {i.why}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">Not connected</Badge>
                </Card>
              ))}
            </TabsContent>
          </Tabs>
        )}
      </AsyncPage>

      <BranchDialog
        branch={editingBranch}
        onOpenChange={(v) => !v && setEditingBranch(null)}
        onSaved={() => {
          void state.refetch();
          setEditingBranch(null);
        }}
      />
    </>
  );
}
