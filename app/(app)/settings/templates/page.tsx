'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Settings → PDF Templates, as Zoho Books lays it out: the kinds of document
// down the left (Quotes, Sales Orders … Vendor Payments), the chosen kind's
// templates as cards with the default marked, "+ New" for Zoho's gallery of
// twelve, and Edit for the colour, the logo, the signature and the footer.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { MoreHorizontal, Plus, Search, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { SettingsNav } from '@/components/settings/all-settings';
import { LogoUpload } from '@/components/settings/logo-upload';
import { sampleModel, TemplateGallery, TemplatePreview } from '@/components/settings/template-gallery';
import { pdfTemplates, type PdfTemplateSettings } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import {
  accentOf, DEFAULT_FORMAT_TITLE, formatTitle, INVOICE_FORMAT_LABEL, INVOICE_FORMATS, isInvoiceFormat, isTemplateDoc,
  layoutFor, layoutForInvoice, templateInfo, templatesOf, TEMPLATE_DOC_LABEL, TEMPLATE_DOC_SINGULAR, TEMPLATE_DOCS,
  type InvoiceFormat, type PrintTemplate, type TemplateDoc, type TemplateKey,
} from '@/lib/print-template';

export default function PdfTemplatesPage() {
  return <Suspense fallback={null}><Templates /></Suspense>;
}

function Templates() {
  const state = useApi(() => pdfTemplates.get(), []);
  const params = useSearchParams();
  const want = params.get('doc');
  const doc: TemplateDoc = isTemplateDoc(want) ? want : 'invoice';
  const wantFormat = params.get('format');
  const format: InvoiceFormat = isInvoiceFormat(wantFormat) ? wantFormat : 'goods';
  return (
    <div className="-m-4 flex min-h-[calc(100vh-56px)] bg-surface sm:-m-6" data-slot="pdf-templates">
      <SettingsNav href="/settings/templates" />
      <AsyncPage state={state} loading={<div className="flex-1 p-6"><LoadingRows rows={6} /></div>}>
        {(data) => <Body data={data} doc={doc} format={format} onSaved={() => void state.refetch()} />}
      </AsyncPage>
    </div>
  );
}

function Body({ data, doc, format, onSaved }: { data: PdfTemplateSettings; doc: TemplateDoc; format: InvoiceFormat; onSaved: () => void }) {
  const router = useRouter();
  const canEdit = usePermission('settings', 'edit');
  const [t, setT] = useState<PrintTemplate>(data.template);
  const [query, setQuery] = useState('');
  const [gallery, setGallery] = useState(false);
  const [editing, setEditing] = useState<TemplateKey | null>(null);
  // Invoices come in three formats (goods, services, export), each with its own default template and title.
  const invoice = doc === 'invoice';
  const title = invoice ? formatTitle(t, format) : null;
  const model = useMemo(() => sampleModel(data.business, doc, invoice ? format : undefined, title ?? undefined), [data.business, doc, invoice, format, title]);
  const def = invoice ? layoutForInvoice(t, format) : layoutFor(t, doc);
  const all = invoice ? [...new Set([def, ...templatesOf(t, doc)])] : templatesOf(t, doc);
  const list = all.filter((k) => templateInfo(k).name.toLowerCase().includes(query.trim().toLowerCase()));

  const save = async (next: PrintTemplate, done: string) => {
    const before = t;
    setT(next);
    try {
      const r = await pdfTemplates.save(next);
      setT(r.template);
      toast.success(done);
      onSaved();
    } catch (e) {
      setT(before);
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  const setDefault = (key: TemplateKey) => {
    // The old default stays in the list, as in Zoho.
    const added = { ...t.added, [doc]: [...new Set([...(t.added[doc] ?? []), def, key])] };
    if (invoice) {
      return save({ ...t, byFormat: { ...t.byFormat, [format]: key }, added }, `${templateInfo(key).name} is now the default for the ${INVOICE_FORMAT_LABEL[format].toLowerCase()}`);
    }
    const byDoc = { ...t.byDoc, [doc]: key };
    return save({ ...t, byDoc, added }, `${templateInfo(key).name} is now the default for ${TEMPLATE_DOC_LABEL[doc].toLowerCase()}`);
  };
  const saveTitle = (text: string) => {
    const clean = text.trim();
    const titles = { ...t.titles };
    if (!clean || clean.toLowerCase() === DEFAULT_FORMAT_TITLE[format].toLowerCase()) delete titles[format];
    else titles[format] = clean;
    return save({ ...t, titles }, `The ${INVOICE_FORMAT_LABEL[format].toLowerCase()} is now titled "${clean || DEFAULT_FORMAT_TITLE[format]}"`);
  };
  const use = async (key: TemplateKey) => {
    setGallery(false);
    await setDefault(key);
  };
  const remove = (key: TemplateKey) => save(
    { ...t, added: { ...t.added, [doc]: (t.added[doc] ?? []).filter((k) => k !== key) } },
    `${templateInfo(key).name} removed from the list`,
  );

  return (
    <>
      <nav className="w-[230px] shrink-0 border-r bg-background py-4" data-slot="template-docs">
        <h2 className="px-5 pb-3 text-[20px] font-normal">Templates</h2>
        {TEMPLATE_DOCS.map((d) => (
          <Link key={d} href={`/settings/templates?doc=${d}`} replace
            className={cn('block px-5 py-2 text-[13px]', d === doc ? 'bg-sidebar-accent font-medium' : 'hover:bg-row-hover')}
            aria-current={d === doc ? 'page' : undefined}>
            {TEMPLATE_DOC_LABEL[d]}
          </Link>
        ))}
      </nav>

      <div className="min-w-0 flex-1 bg-background">
        <div className="flex items-center justify-between border-b px-6 py-3.5">
          <h1 className="text-[20px] font-normal">{TEMPLATE_DOC_SINGULAR[doc]} Templates</h1>
          {canEdit && (
            <Button size="sm" className="gap-1" onClick={() => setGallery(true)} data-slot="template-new">
              <Plus className="size-4" /> New
            </Button>
          )}
        </div>
        {invoice && (
          <div className="border-b px-6" data-slot="invoice-formats">
            <div className="flex gap-6 text-[13.5px]" role="tablist" aria-label="Invoice format">
              {INVOICE_FORMATS.map((f) => (
                <Link key={f} href={`/settings/templates?doc=invoice&format=${f}`} replace role="tab" aria-selected={f === format}
                  className={cn('-mb-px border-b-2 py-3', f === format ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
                  data-slot={`invoice-format-${f}`}>
                  {INVOICE_FORMAT_LABEL[f]}
                </Link>
              ))}
            </div>
          </div>
        )}
        {invoice && (
          <FormatTitle key={format} format={format} title={title ?? ''} canEdit={canEdit} onSave={saveTitle} />
        )}
        <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Enter the Template Name" className="h-8 pl-8 text-[13px]" />
          </div>
          <span className="text-[13px] text-muted-foreground">Status : <span className="text-foreground">All</span></span>
        </div>

        <div className="flex flex-wrap gap-6 p-6">
          {list.map((key) => {
            const info = templateInfo(key);
            const isDefault = key === def;
            return (
              <div key={key} className="w-[288px]" data-slot={`template-card-${key}`}>
                <div className="group relative border bg-white p-3">
                  <TemplatePreview model={model} template={t} layout={key} width={262} />
                  {isDefault && (
                    <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-[2px] bg-[#fff4d6] px-2 py-0.5 text-[11px] font-semibold uppercase text-[#8a5a00]" data-slot="template-default">
                      <Star className="size-3 fill-[#f5a623] text-[#f5a623]" /> Default
                    </span>
                  )}
                  {canEdit && (
                    <div className="absolute inset-0 hidden items-center justify-center gap-2 bg-black/5 group-hover:flex">
                      <Button size="sm" onClick={() => setEditing(key)} data-slot="template-edit">Edit</Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label="More" className="grid size-8 place-items-center rounded-[3px] border bg-white shadow-sm"><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {!isDefault && <DropdownMenuItem onClick={() => void setDefault(key)}>Set as Default</DropdownMenuItem>}
                          <DropdownMenuItem onClick={() => router.push(previewHref(doc))}>Preview with a real document</DropdownMenuItem>
                          {!isDefault && <DropdownMenuItem className="text-destructive" onClick={() => void remove(key)}>Delete</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-[14px]">{info.name}</p>
              </div>
            );
          })}
          {canEdit && !query && (
            <button type="button" onClick={() => setGallery(true)}
              className="flex h-[400px] w-[288px] flex-col items-center justify-center gap-3 border border-dashed bg-white p-6 text-center hover:border-primary">
              <Plus className="size-8 text-primary" />
              <span className="text-[15px]">New Template</span>
              <span className="text-[12.5px] leading-snug text-muted-foreground">Click to add a template from our gallery. You can customize the template title, columns, and headers in line item table.</span>
            </button>
          )}
        </div>
      </div>

      <TemplateGallery open={gallery} onOpenChange={setGallery} model={model} template={t} current={all} onUse={(k) => void use(k)} />

      {editing && (
        <Customize
          template={t} layout={editing} model={model} business={data.business} orgId={data.business.orgId}
          onClose={() => setEditing(null)} onLogo={onSaved}
          onSave={async (next) => { await save(next, 'Template saved'); setEditing(null); }}
        />
      )}
    </>
  );
}

/** Which invoices print in a format, and the title they carry (Zoho's "Document Title"). */
function FormatTitle({ format, title, canEdit, onSave }: { format: InvoiceFormat; title: string; canEdit: boolean; onSave: (t: string) => Promise<void> }) {
  const [text, setText] = useState(title);
  const [busy, setBusy] = useState(false);
  const WHO: Record<InvoiceFormat, string> = {
    goods: 'Invoices for goods print in this format: the HSN column, quantities with their unit, and three copies (recipient, transporter, supplier).',
    services: 'Invoices for services print in this format: the SAC column, quantities without a unit, and two copies (recipient, supplier).',
    export: 'Exports print in this format: the LUT or IGST endorsement, the invoice currency, the country, port code and shipping bill.',
  };
  return (
    <div className="flex flex-wrap items-end gap-4 border-b bg-surface px-6 py-3" data-slot="invoice-format-title">
      <p className="min-w-[260px] flex-1 text-[12.5px] text-muted-foreground">{WHO[format]}</p>
      <label className="space-y-1">
        <span className="block text-[12px] font-medium">Document Title</span>
        <Input value={text} maxLength={60} disabled={!canEdit} onChange={(e) => setText(e.target.value)} className="h-8 w-56 text-[13px]" data-slot="format-title-input" />
      </label>
      {canEdit && (
        <Button size="sm" variant="outline" disabled={busy || text.trim() === title}
          onClick={async () => { setBusy(true); try { await onSave(text); } finally { setBusy(false); } }} data-slot="format-title-save">
          Save title
        </Button>
      )}
    </div>
  );
}

/** Where a real document of the kind can be seen in its template. */
function previewHref(doc: TemplateDoc) {
  const LIST: Record<TemplateDoc, string> = {
    invoice: '/sales/invoices', estimate: '/sales/estimates', 'sales-order': '/sales/sales-orders', challan: '/sales/challans',
    'credit-note': '/sales/credit-notes', 'purchase-order': '/purchases/purchase-orders', retainer: '/sales/retainers',
    'payment-received': '/sales/payments', bill: '/purchases/bills', 'vendor-credit': '/purchases/vendor-credits', 'payment-made': '/purchases/payments',
  };
  return LIST[doc];
}

/** Edit: what every template shares — the theme colour, the logo, the signature, the footer line. */
function Customize({ template, layout, model, business, orgId, onClose, onSave, onLogo }: {
  template: PrintTemplate; layout: TemplateKey; model: ReturnType<typeof sampleModel>; business: PdfTemplateSettings['business'];
  orgId: string; onClose: () => void; onSave: (t: PrintTemplate) => Promise<void>; onLogo: () => void;
}) {
  const [f, setF] = useState<PrintTemplate>(template);
  const [busy, setBusy] = useState(false);
  const accent = accentOf(f, layout);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[94vh] max-w-5xl overflow-y-auto sm:max-w-5xl" data-slot="template-customize">
        <DialogHeader>
          <DialogTitle>Edit Template · {templateInfo(layout).name}</DialogTitle>
          <DialogDescription>The colour, logo, signature and footer apply to every template. What a document says (Rule 46) does not change with the look.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Organization Logo</h3>
              <LogoUpload orgId={orgId} logoFileId={business.logoFileId} canEdit onChanged={onLogo} />
              <label className="flex items-center gap-2 text-[13px]">
                <Switch checked={f.showLogo} onCheckedChange={(v) => setF({ ...f, showLogo: v })} /> Show the logo on documents
              </label>
            </section>
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Theme Colour</h3>
              <div className="flex items-center gap-3">
                <input type="color" value={accent} onChange={(e) => setF({ ...f, accent: e.target.value })}
                  className="h-9 w-16 cursor-pointer rounded-md border" aria-label="Theme colour" />
                <span className="font-mono text-[12px]">{accent}</span>
                {f.accent && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, accent: null })}>Use the template&apos;s own</Button>}
              </div>
            </section>
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Signature</h3>
              <label className="flex items-center gap-2 text-[13px]">
                <Switch checked={f.showSignature} onCheckedChange={(v) => setF({ ...f, showSignature: v })} /> Print the Authorized Signature line
              </label>
              <p className="text-[12px] text-muted-foreground">The signatory&apos;s name is set in <Link className="text-link hover:underline" href="/settings/invoice-print">Bank, UPI and Terms on PDFs</Link>.</p>
            </section>
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">Footer</h3>
              <Input value={f.footer ?? ''} maxLength={300} placeholder="A registered office, a CIN, a thank-you" onChange={(e) => setF({ ...f, footer: e.target.value || null })} />
            </section>
          </div>
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-2 text-[12px] text-muted-foreground">Preview</p>
            <TemplatePreview model={{ ...model, footer: f.footer }} template={f} layout={layout} width={272} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={async () => { setBusy(true); try { await onSave(f); } finally { setBusy(false); } }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
